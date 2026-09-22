// gint v2 の薄い1枚（gishub / gishub-jp 共用）。ortho-japan エンジン（v2）の上で「GeoPBF を1枚見せる」だけを持つ。
// 旧＝ortho-map（v1）の createRemoteLayer({type:"gint"}).set("gint", unPackGint) ＋ zoomToFeature ＋ autoRotate。
// 新＝map.addGint(pbf)（v2 spec §4 の顔）＋ flyTo ＋ cam 直書きの自転。エンジンの口はこのファイルの外へ漏らさない
// （gint draw spec §10.2「消費側は薄いモジュール1枚に封じる」）。エンジン本体の読み込み（dev=ソース直／本番=/japan/lib/）は
// ビルド構成に依存するので各アプリ側が持ち、出来上がった map をここへ渡す。
//
// 使い方：
//   const view = createGintView(map, { overviewZoom });
//   await view.show(pbf, { tipHtml: (fid, props) => html|null, popHtml: (fid, props) => html|null, fill: true|false });
//   view.clear();  view.spin(true|false);  view.home();
//   const off = await view.showRasterMeshes(meshes, { id, name, attribution, opacity });   // L03-b_r 型（経緯度矩形の画像群）

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrapLon = l => ((l + 540) % 360 + 360) % 360 - 180;

// 待ち受けの自転（旧 v1 の autoRotate）。公開のカメラ setter は flyTo（アニメ）だけ＝map.cam を直に回して requestDraw
// （render が毎フレーム cam を読む）。戻り値＝spin(on)。www トップの背景も使う
export function createSpin(map, degPerSec = 4) {
	let raf = 0, t0 = 0;
	const step = t => {
		const dt = Math.min(0.1, (t - t0) / 1000); t0 = t;
		const c = map.cam.center;
		map.cam.center = [wrapLon(c[0] + degPerSec * dt), c[1]];
		map.requestDraw();
		raf = requestAnimationFrame(step);
	};
	return on => {
		if (!on) { cancelAnimationFrame(raf); raf = 0; return; }
		if (raf) return;
		t0 = performance.now();
		raf = requestAnimationFrame(step);
	};
}

export function createGintView(map, { overviewZoom = 1.5, minZoom = 2, spinDegPerSec = 4 } = {}) {
	const tip = map.gadget.tip();   // カーソル追従（エンジンが起動時に搭載済み＝同じ setter が返る）
	const pop = map.gadget.pop();   // 地点に錨を打つ吹き出し
	let layer = null, token = 0;

	// ---- 1枚見せる ----
	async function show(pbf, { tipHtml = null, popHtml = null, fit = true, fill = true } = {}) {   // fill:false＝面を塗らず輪郭だけ
		clear();
		const my = ++token;
		if (!pbf?.length) return null;
		// geopbf() は既定で gint を焼く。焼かずに来た物（{gint:false} 等）だけここで焼く
		if (!pbf.unPackGint && typeof pbf.gint === "function") await pbf.gint();
		if (my !== token) return null;   // 焼いている間に次のデータ／閉じるが来た
		if (!pbf.unPackGint) { console.error("[gintView] no gint buffer (unPackGint) = cannot draw", pbf.name?.()); return null; }
		spin(false);
		layer = map.addGint(pbf, { minZoom, ...(fill ? {} : { fillMaxEdges: 0 }) });   // fillMaxEdges:0＝エンジンの塗り切り（国境層と同じ口）
		layer.on("hover", f => tip(f && tipHtml ? tipHtml(f.fid, f.properties) || null : null));
		layer.on("click", e => {
			if (e.fid == null || !popHtml) return;
			const html = popHtml(e.fid, e.properties);
			if (!html) return;
			const [lng, lat] = e.lngLat, [x, y] = map.projectLL(lng, lat);   // 箱の初期位置＝クリック点の画面座標
			pop(html, { x, y, lng, lat });
		});
		map.requestDraw();
		if (fit) fitTo(pbf);
		await layer.ready;
		return layer;
	}

	// ---- データへ寄る（旧 zoomToFeature の置き換え）----
	function fitTo(pbf) {
		const [w, s, e, n] = pbf.bbox ?? [];
		if (![w, s, e, n].every(Number.isFinite)) return;
		let lon, lat, zoom;
		if (e - w > 300) {
			// bbox がほぼ全球（±180 付近）→ bbox 中心は 0° 付近になる誤り。feature bbox 中心の 3D 平均で真の重心を出す
			let sx = 0, sy = 0, sz = 0; const pts = [];
			pbf.forEach(i => {
				const b = pbf.getBbox(i);
				if (!b || !isFinite(b[0])) return;
				const lng = (b[0] + b[2]) / 2, la = (b[1] + b[3]) / 2;
				pts.push([lng, la]);
				sx += Math.cos(la * D2R) * Math.cos(lng * D2R); sy += Math.cos(la * D2R) * Math.sin(lng * D2R); sz += Math.sin(la * D2R);
			});
			const norm = Math.hypot(sx, sy, sz);
			if (!(norm > 0)) return;
			lon = Math.atan2(sy, sx) * R2D; lat = Math.asin(sz / norm) * R2D;
			// 全球を覆う単一フィーチャ（ne_10m_ocean 等）＝点1つ＝広がり0＝地球全体の概観へ
			if (pts.length < 2) zoom = overviewZoom;
			else {   // 重心まわりへ経度を開いて（±180 跨ぎ）広がりを測る
				let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
				for (const [px, py] of pts) { const d = wrapLon(px - lon); x0 = Math.min(x0, d); x1 = Math.max(x1, d); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
				zoom = Math.max(overviewZoom, map.fitZoomForBbox([lon + x0, y0, lon + x1, y1]));
			}
		} else {
			lon = (w + e) / 2; lat = (s + n) / 2;
			zoom = Math.min(17, map.fitZoomForBbox([w, s, e, n]));   // 点1つ＝広がり0は最大ズームへ張り付くので頭打ち
		}
		return map.flyTo(lon, lat, zoom, 0, 0);
	}

	function clear() {
		token++;
		tip(null); pop.clear(true);
		if (layer) { layer.remove(); layer = null; }
		map.requestDraw();
	}

	// ---- 待ち受けの自転（旧 autoRotate）----
	const spinner = createSpin(map, spinDegPerSec);
	const spin = on => spinner(on);
	// 待ち受けへ戻る（真俯瞰・概観ズームへ飛んでから自転）。飛行中に次の show が来たら自転しない
	async function home(lat = 0) {
		const my = ++token;
		await map.flyTo(map.cam.center[0], lat, overviewZoom, 0, 0);
		if (my === token) spin(true);
	}

	return { show, clear, fitTo, spin, home, get layer() { return layer; }, tip, pop };
}

// ---- 経緯度矩形の画像群（L03-b_r のメッシュ画像）を map.raster のタイル供給へ ----
// v1 は image レイヤに bbox 付き画像を直に置いていた。v2 の画像層は XYZ タイル（ウェブメルカトル）契約＝
// MessagePort のプロバイダ（raster-src.js の port 契約：info を1通→{id,z,x,y} に {id,bitmap} で返す）で供給する。
// タイルは画素ごとに元画像から最近傍で拾う（行ごとに正確なメルカトル緯度・列ごとに経度）。
//   旧実装（drawImage を帯に分けて貼る）は端数座標の縁がアンチエイリアスで半透明になり、
//   隣り合うメッシュの境目に細い筋が出た（東京湾で東経140°・北緯35°20′の線＝2026-09-21 実データで確認）。
//   画素ごとに拾えば継ぎ目は原理的に出ない。土地利用は分類値＝補間しない（最近傍）ので境界もにじまない。
// 解像度の段：z≤6＝全メッシュの縮約モザイク1枚（0.02°/px）／z7-8＝メッシュを 1/4 に縮めた画素／z≥9＝原寸。
// 画素は LRU で持つ（原寸 800×800＝2.5MB/枚）。
// 入力（Map の値）は2通り：
//   { bbox, classes, width, height } … 分類コード（画素値 0..255）を deflate-raw した物＝真実源。palette で塗る（推奨）
//   { bbox, webpData|bytes, mime }   … 画像。palette があれば最寄りの色へ吸着（非可逆画像では分類が崩れ得る＝近似）
// palette＝分類の色表 [{ code(画素値), rgb:[r,g,b], label }]。戻り値の .query(lon, lat) はその地点の分類（palette の要素）。
export async function showRasterMeshes(map, meshes, { id = "meshes", name = null, attribution = null, opacity = 0.85, maxZoom = 15, palette = null } = {}) {
	const list = [...meshes].map(([key, m]) => ({ key, bbox: m.bbox, bytes: m.webpData ?? m.bytes, mime: m.mime || "image/webp",
		classes: m.classes?.byteLength ? m.classes : null, cw: m.width, ch: m.height }))
		.filter(m => Array.isArray(m.bbox) && m.bbox.length === 4 && m.bbox.every(Number.isFinite) && m.bbox[2] > m.bbox[0] && m.bbox[3] > m.bbox[1]
			&& ((m.classes && m.cw > 0 && m.ch > 0) || m.bytes?.byteLength));
	if (!list.length) return () => {};
	const bb = list.reduce((a, m) => [Math.min(a[0], m.bbox[0]), Math.min(a[1], m.bbox[1]), Math.max(a[2], m.bbox[2]), Math.max(a[3], m.bbox[3])], [180, 90, -180, -90]);

	// 分類色への吸着（色→吸着後の色を覚える＝圧縮のゆらぎは数百色程度なので実質タダ）
	const pal = palette?.length ? palette.map(p => ({ ...p, u32: (255 << 24 | p.rgb[2] << 16 | p.rgb[1] << 8 | p.rgb[0]) >>> 0 })) : null;
	const snapMemo = new Map();
	const nearest = v => {
		const r = v & 255, g = v >>> 8 & 255, b = v >>> 16 & 255;
		let best = 0, bd = Infinity;
		for (let k = 0; k < pal.length; k++) { const q = pal[k].rgb, d = (r - q[0]) ** 2 + (g - q[1]) ** 2 + (b - q[2]) ** 2; if (d < bd) { bd = d; best = k; } }
		return best;
	};
	const snap = px => {
		if (!pal) return px;
		for (let i = 0; i < px.length; i++) {
			const v = px[i];
			if ((v >>> 24) < 128) { px[i] = 0; continue; }   // 解析範囲外（透明）
			const key = v & 0xffffff;
			let o = snapMemo.get(key);
			if (o === undefined) { o = pal[nearest(v)].u32; snapMemo.set(key, o); }
			px[i] = o;
		}
		return px;
	};
	// 分類コード→色（palette の code が画素値。表に無い値＝透明）
	const lut = new Uint32Array(256);
	if (pal) for (const p of pal) if (p.code >= 0 && p.code < 256) lut[p.code] = p.u32;
	const inflate = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
	// 入力→画素（RGBA を Uint32 で。scale<1＝縮めて持つ＝最近傍で間引き）
	const pixelsOf = async (m, scale = 1) => {
		if (m.classes && pal) {
			const idx = await inflate(m.classes), W0 = m.cw, H0 = m.ch;
			const W = Math.max(1, Math.round(W0 * scale)), H = Math.max(1, Math.round(H0 * scale)), px = new Uint32Array(W * H);
			const sxs = new Int32Array(W);
			for (let x = 0; x < W; x++) sxs[x] = Math.min(W0 - 1, ((x + 0.5) / W * W0) | 0);
			for (let y = 0; y < H; y++) {
				const r = Math.min(H0 - 1, ((y + 0.5) / H * H0) | 0) * W0, o = y * W;
				for (let x = 0; x < W; x++) px[o + x] = lut[idx[r + sxs[x]]];
			}
			return { W, H, px };
		}
		const b = await createImageBitmap(new Blob([m.bytes], { type: m.mime }));
		const W = Math.max(1, Math.round(b.width * scale)), H = Math.max(1, Math.round(b.height * scale));
		const cv = new OffscreenCanvas(W, H), cx = cv.getContext("2d", { willReadFrequently: true });
		cx.imageSmoothingEnabled = false;
		cx.drawImage(b, 0, 0, W, H);
		b.close();
		return { W, H, px: snap(new Uint32Array(cx.getImageData(0, 0, W, H).data.buffer)) };
	};
	// メッシュ画素の LRU（段ごとに別鍵）。バイト数で上限＝原寸なら約 32 枚
	const LRU_BYTES = 96 << 20, lru = new Map();
	let lruBytes = 0;
	const meshPixels = (m, scale) => {
		const k = m.key + "@" + scale;
		let e = lru.get(k);
		if (e) { lru.delete(k); lru.set(k, e); return e.p; }
		e = { p: pixelsOf(m, scale).catch(() => null), bytes: 0 };
		e.p.then(r => { if (r && lru.get(k) === e) { e.bytes = r.px.byteLength; lruBytes += e.bytes; trim(); } });
		lru.set(k, e);
		return e.p;
	};
	const trim = () => {
		for (const [k, e] of lru) { if (lruBytes <= LRU_BYTES || lru.size <= 4) break; lru.delete(k); lruBytes -= e.bytes; }
	};
	// 低ズーム用の縮約モザイク（0.02°/px ≒ 2km）＝一度だけ作る。メッシュは1枚ずつ解いて描いて閉じる
	const MOSAIC_DEG = 0.02;
	let mosaicP = null;
	const mosaic = () => mosaicP ??= (async () => {
		const W = Math.ceil((bb[2] - bb[0]) / MOSAIC_DEG), H = Math.ceil((bb[3] - bb[1]) / MOSAIC_DEG), px = new Uint32Array(W * H);
		for (const m of list) {   // 1枚ずつ縮めて拾って捨てる（全部を同時に持たない）
			const [w, s, e, n] = m.bbox;
			// 整数画素の矩形へ最近傍で写す＝モザイク内にも継ぎ目を作らない
			const x0 = Math.round((w - bb[0]) / MOSAIC_DEG), x1 = Math.round((e - bb[0]) / MOSAIC_DEG);
			const y0 = Math.round((bb[3] - n) / MOSAIC_DEG), y1 = Math.round((bb[3] - s) / MOSAIC_DEG);
			const rw = Math.max(1, x1 - x0), rh = Math.max(1, y1 - y0);
			const src = await pixelsOf(m, rw / (m.classes ? m.cw : (m.cw || 800))).catch(() => null);
			if (!src) continue;
			for (let y = 0; y < rh; y++) {
				const ty = y0 + y; if (ty < 0 || ty >= H) continue;
				const sr = Math.min(src.H - 1, ((y + 0.5) / rh * src.H) | 0) * src.W;
				for (let x = 0; x < rw; x++) {
					const tx = x0 + x; if (tx < 0 || tx >= W) continue;
					const v = src.px[sr + Math.min(src.W - 1, ((x + 0.5) / rw * src.W) | 0)];
					if (v >>> 24) px[ty * W + tx] = v;
				}
			}
		}
		return { W, H, px, bbox: [bb[0], bb[3] - H * MOSAIC_DEG, bb[0] + W * MOSAIC_DEG, bb[3]] };
	})();

	const TS = 256;
	const mercLat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * R2D;   // t＝タイル座標/2^z（0=北端）
	const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
	// 1枚の等緯度経度画像から、タイルの画素へ最近傍で拾う（透明画素は下を残す＝重なりは後勝ち）
	function sample(out, src, [w, s, e, n], lons, lats) {
		const { W, H, px } = src;
		const cols = new Int32Array(TS);
		let any = false;
		for (let i = 0; i < TS; i++) {
			const lon = lons[i];
			cols[i] = lon >= w && lon < e ? Math.min(W - 1, ((lon - w) / (e - w) * W) | 0) : -1;
			if (cols[i] >= 0) any = true;
		}
		if (!any) return;
		for (let j = 0; j < TS; j++) {
			const lat = lats[j];
			if (!(lat >= s && lat < n)) continue;
			const row = Math.min(H - 1, ((n - lat) / (n - s) * H) | 0) * W, o = j * TS;
			for (let i = 0; i < TS; i++) {
				const c = cols[i];
				if (c < 0) continue;
				const v = px[row + c];
				if (v >>> 24) out[o + i] = v;   // α>0 だけ（リトルエンディアン＝最上位バイトが α）
			}
		}
	}
	async function renderTile(z, x, y) {
		const n2 = 1 << z, lon0 = x / n2 * 360 - 180, lon1 = (x + 1) / n2 * 360 - 180;
		const tb = [lon0, mercLat((y + 1) / n2), lon1, mercLat(y / n2)];
		if (!overlaps(tb, bb)) return null;
		const lons = new Float64Array(TS), lats = new Float64Array(TS);
		for (let i = 0; i < TS; i++) { lons[i] = lon0 + (i + 0.5) / TS * (lon1 - lon0); lats[i] = mercLat((y + (i + 0.5) / TS) / n2); }   // 画素中心
		const out = new Uint32Array(TS * TS);
		if (z <= 6) {
			const mo = await mosaic();
			sample(out, mo, mo.bbox, lons, lats);
		} else {
			const hit = list.filter(m => overlaps(tb, m.bbox));
			if (!hit.length) return null;
			const scale = z <= 8 ? 0.25 : 1;
			const srcs = await Promise.all(hit.map(m => meshPixels(m, scale)));
			hit.forEach((m, k) => srcs[k] && sample(out, srcs[k], m.bbox, lons, lats));
		}
		return createImageBitmap(new ImageData(new Uint8ClampedArray(out.buffer), TS, TS), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
	}

	const ch = new MessageChannel(), port = ch.port1;
	port.onmessage = async ev => {
		const { id: rid, z, x, y, abort } = ev.data || {};
		if (abort) return;   // 描きかけは捨てるだけ（相手は既に reject 済み＝遅着は向こうが閉じる）
		try { const bitmap = await renderTile(z, x, y); port.postMessage({ id: rid, bitmap }, bitmap ? [bitmap] : []); }
		catch (e) { port.postMessage({ id: rid, error: String(e?.message || e) }); }
	};
	port.postMessage({ type: "info", info: { tileSize: TS, minZoom: 0, maxZoom, bbox: bb, name, attribution } });
	await map.raster.add(id, { port: ch.port2, name, attribution }, { order: "over", opacity, hideFills: false });
	map.requestDraw();
	const remove = () => {
		map.raster.remove(id);
		port.onmessage = null; port.close();
		lru.clear(); lruBytes = 0;
		mosaicP = null;
	};
	// 地点の分類（原寸の画素から。重なりは後勝ち＝描画と同じ）
	remove.query = async (lon, lat) => {
		if (!pal) return null;
		let hit = null;
		for (const m of list) {
			const [w, s, e, n] = m.bbox;
			if (!(lon >= w && lon < e && lat >= s && lat < n)) continue;
			const src = await meshPixels(m, 1);
			if (!src) continue;
			const v = src.px[Math.min(src.H - 1, ((n - lat) / (n - s) * src.H) | 0) * src.W + Math.min(src.W - 1, ((lon - w) / (e - w) * src.W) | 0)];
			if (v >>> 24) hit = pal.find(p => p.u32 === v) ?? null;
		}
		return hit;
	};
	return remove;
}
