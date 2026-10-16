// 基準点で歪みを直した IIIF の地図画像を z/x/y の画像タイルに焼いて配るプロバイダ worker（#177・imagequad-worker の兄弟）。
// 画像タイル層（ortho-core/raster-src の "port" 契約）へ流す＝地形へのドレープ・透明度・重ね順は既存のラスタ層がそのまま受け持つ（本人裁定＝地面に貼るだけ）。
// 所有者は main（入れ子 worker 禁止）。main が MessageChannel を作り、port1 をここへ・port2 を render worker へ。
//
// 受け口（main → ここ）: { type:"open", maps: [parseGeoreference の 1 枚…], name?, attribution?, port }
// 返事（ここ → main）:   { type:"opened", info } | { type:"error", error }
// 焼き方：タイルを 16×16 の升に割り、升の角（17×17）だけ逆写像（メルカトル → 画像の画素＝geopbf/georef の当てはめ）を計算して間は双一次で補う
//        （TPS でもタイルあたり 289 回）。足跡（画像画素 / タイル画素）で IIIF の段を選び、掛かる IIIF タイルだけを取って双一次で標本化。
//        画像の外・枠（resourceMask）の外は透明。IIIF タイルは解いた画素で 128 枚まで控える（古い順に捨てる）。
import { georefMapping, iiifImage, infoUrl } from "geopbf/georef";

const TS = 256, G = 16, CACHE_MAX = 128;

const tileCache = new Map();   // url → Promise<{ w, h, d }>（LRU＝Map の順）
function getTile(url) {
	let p = tileCache.get(url);
	if (p) { tileCache.delete(url); tileCache.set(url, p); return p; }
	p = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.blob(); }).then(createImageBitmap).then(bm => {
		const cv = new OffscreenCanvas(bm.width, bm.height), g = cv.getContext("2d", { willReadFrequently: true });
		g.drawImage(bm, 0, 0); bm.close?.();
		return { w: cv.width, h: cv.height, d: g.getImageData(0, 0, cv.width, cv.height).data };
	});
	p.catch(() => tileCache.delete(url));
	tileCache.set(url, p);
	while (tileCache.size > CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
	return p;
}
// 点が多角形の内か（偶奇）
const inside = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };

async function openMap(g) {
	const iu = infoUrl(g.image.id);
	const info = await fetch(iu).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).catch(e => { throw new Error(`iiif: cannot read ${iu} (${e.message || e})`); });
	const img = iiifImage(info, { base: iu });
	const gg = { ...g, image: { ...g.image, width: g.image.width || img.width, height: g.image.height || img.height } };
	const m = georefMapping(gg);
	const [x0, y0, x1, y1] = m.worldBox;
	const nativeZ = Math.log2(Math.max(img.width, img.height) / Math.max(x1 - x0, y1 - y0) / TS);
	return { img, m, box: m.worldBox, nativeZ, mask: m.mask, residuals: m.residuals, attribution: img.attribution };
}

async function renderMap(M, z, tx, ty, o) {
	const n = 2 ** z, bx0 = tx / n, by0 = ty / n, px = 1 / (n * TS);
	const [mx0, my0, mx1, my1] = M.box;
	if (bx0 + 1 / n < mx0 || bx0 > mx1 || by0 + 1 / n < my0 || by0 > my1) return false;
	// 升の角の逆写像（17×17）
	const K = G + 1, gx = new Float64Array(K * K), gy = new Float64Array(K * K);
	let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
	for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) {
		const [x, y] = M.m.toResource([bx0 + (i * TS / G) * px, by0 + (j * TS / G) * px]);
		gx[j * K + i] = x; gy[j * K + i] = y;
		if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
	}
	const W = M.img.width, H = M.img.height;
	if (rx1 < 0 || ry1 < 0 || rx0 > W || ry0 > H) return false;
	// 足跡＝升の辺の長さ（画像画素）/ 升の画素 → 段
	const c = (G >> 1) * K + (G >> 1), foot = Math.max(Math.hypot(gx[c + 1] - gx[c], gy[c + 1] - gy[c]), Math.hypot(gx[c + K] - gx[c], gy[c + K] - gy[c])) / (TS / G);
	const L = M.img.levelFor(foot);
	const need = M.img.tilesIn(L, [rx0 - 2 * L.scale, ry0 - 2 * L.scale, rx1 + 2 * L.scale, ry1 + 2 * L.scale]);
	if (!need.length) return false;
	const tiles = new Map();
	await Promise.all(need.map(async ([cc, rr]) => { const t = M.img.tile(L, cc, rr); try { tiles.set(`${cc},${rr}`, { t, px: await getTile(t.url) }); } catch (e) { console.warn("[iiif] tile", t.url, e.message || e); } }));
	// 段の画素 (ix, iy) の色（タイルを跨いで引く）
	const lw = Math.ceil(W / L.scale), lh = Math.ceil(H / L.scale);
	const tw = L.tiled ? L.tw : lw, th = L.tiled ? L.th : lh;
	const pix = (ix, iy, out) => {
		ix = Math.max(0, Math.min(lw - 1, ix)); iy = Math.max(0, Math.min(lh - 1, iy));
		const e = tiles.get(L.tiled ? `${(ix / tw) | 0},${(iy / th) | 0}` : "0,0"); if (!e) return false;
		const P = e.px, lx = L.tiled ? ix - ((ix / tw) | 0) * tw : Math.round(ix * P.w / lw), ly = L.tiled ? iy - ((iy / th) | 0) * th : Math.round(iy * P.h / lh);
		const k = (Math.min(P.h - 1, ly) * P.w + Math.min(P.w - 1, lx)) * 4;
		out[0] = P.d[k]; out[1] = P.d[k + 1]; out[2] = P.d[k + 2]; out[3] = P.d[k + 3]; return true;
	};
	const a = [0, 0, 0, 0], b = [0, 0, 0, 0], cc2 = [0, 0, 0, 0], d = [0, 0, 0, 0], mask = M.mask;
	let any = false;
	for (let j = 0; j < TS; j++) {
		const gj = j * G / TS, j0 = Math.min(G - 1, gj | 0), fj = gj - j0;
		for (let i = 0; i < TS; i++) {
			const gi = i * G / TS, i0 = Math.min(G - 1, gi | 0), fi = gi - i0, k = j0 * K + i0;
			const x = (gx[k] * (1 - fi) + gx[k + 1] * fi) * (1 - fj) + (gx[k + K] * (1 - fi) + gx[k + K + 1] * fi) * fj;
			const y = (gy[k] * (1 - fi) + gy[k + 1] * fi) * (1 - fj) + (gy[k + K] * (1 - fi) + gy[k + K + 1] * fi) * fj;
			if (!(x >= 0 && y >= 0 && x <= W && y <= H)) continue;
			if (mask && !inside(x, y, mask)) continue;
			const fx = x / L.scale - 0.5, fy = y / L.scale - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
			if (!pix(ix, iy, a) || !pix(ix + 1, iy, b) || !pix(ix, iy + 1, cc2) || !pix(ix + 1, iy + 1, d)) continue;
			const q = (j * TS + i) * 4;
			for (let ch = 0; ch < 4; ch++) { const top = a[ch] + (b[ch] - a[ch]) * ax, bot = cc2[ch] + (d[ch] - cc2[ch]) * ax; o[q + ch] = top + (bot - top) * ay; }
			any = true;
		}
	}
	return any;
}

self.onmessage = async e => {
	const m = e.data || {};
	if (m.type !== "open") return;
	try {
		if (!m.maps?.length) throw new Error("iiif: no georeferenced image in the annotation");
		const maps = await Promise.all(m.maps.map(openMap));
		const box = maps.reduce((b, M) => [Math.min(b[0], M.box[0]), Math.min(b[1], M.box[1]), Math.max(b[2], M.box[2]), Math.max(b[3], M.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
		const toLL = ([x, y]) => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
		const [w, n] = toLL([box[0], box[1]]), [ee, s] = toLL([box[2], box[3]]);
		const attribution = m.attribution || maps.map(M => M.attribution).filter(Boolean).join(" · ") || m.fallbackAttribution || null;   // 注記/manifest → info.json → ホスト名
		const info = { tileSize: TS, minZoom: 0, maxZoom: Math.max(0, Math.min(22, Math.ceil(Math.max(...maps.map(M => M.nativeZ))))), bbox: [w, s, ee, n], name: m.name || "iiif", attribution,
			residuals: maps.map(M => M.residuals) };   // 基準点の残差（メートル・地図ごと）＝main が stats に出す
		const out = new OffscreenCanvas(TS, TS), og = out.getContext("2d");
		const render = async (z, x, y) => {
			const img = og.createImageData(TS, TS);
			let any = false;
			for (const M of maps) if (await renderMap(M, z, x, y, img.data)) any = true;   // 後ろの地図が上（注記の並び順）
			if (!any) return null;
			og.clearRect(0, 0, TS, TS); og.putImageData(img, 0, 0);
			return out.transferToImageBitmap();
		};
		const port = m.port;
		port.onmessage = async ev => {
			const q = ev.data || {};
			if (q.abort || q.id == null) return;
			try { const bmp = await render(q.z, q.x, q.y); port.postMessage({ id: q.id, bitmap: bmp }, bmp ? [bmp] : []); }
			catch (err) { port.postMessage({ id: q.id, error: String(err && err.message || err) }); }
		};
		port.postMessage({ type: "info", info });
		self.postMessage({ type: "opened", info });
	} catch (err) {
		self.postMessage({ type: "error", error: String(err && err.message || err) });
	}
};
