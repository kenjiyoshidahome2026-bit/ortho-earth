// MapLibre の hillshade 層（raster-dem から 2D の陰影）＝公式例の門 3 巡目（2026-09-27）。
// この地図の陰影は傾けた時の地形面だけ（真俯瞰は平面）＝MapLibre の hillshade（真俯瞰でも陰影の画像を重ねる）が無かった。
// 作り＝raster-dem のタイルを取って MapLibre と同じ式（hillshade_prepare＋hillshade の fragment・method "standard"）で陰影の画像タイルを作り、
// 画像タイル層の port プロバイダ（raster-src.js の契約＝info 1 通・{id,z,x,y}→{id,bitmap}）として render worker に渡す＝エンジンの描く経路は無改修。
// 端の勾配は隣のタイル（東西南北）を使う＝タイルの継ぎ目に筋が出ない（MapLibre は隣で縁を埋める）。DEM のタイルは LRU に持つ（隣は次のタイルで使い回す）。
// 未対応＝method "basic"/"combined"/"igor"/"multidirectional"（standard で描く・警告 1 回）。
import { decodeDEM, normalizeDemSpec } from "@ortho-earth/core";

const PI = Math.PI;
let cctx = null;
// CSS の色（名前・hsl・rgba…）→ [r,g,b,a]（0..1）。canvas に塗って読む＝ブラウザの解釈そのまま
export function cssColor(c, d = [0, 0, 0, 1]) {
	if (Array.isArray(c) && c.length >= 3) return [c[0] / (c[0] > 1 || c[1] > 1 || c[2] > 1 ? 255 : 1), c[1] / (c[1] > 1 ? 255 : 1), c[2] / (c[2] > 1 ? 255 : 1), c[3] ?? 1];
	if (typeof c !== "string") return d;
	try {
		cctx ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
		cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = "#000"; cctx.fillStyle = c; cctx.fillRect(0, 0, 1, 1);
		const p = cctx.getImageData(0, 0, 1, 1).data;
		if (p[3] === 0) return [0, 0, 0, 0];
		return [p[0] / p[3], p[1] / p[3], p[2] / p[3], p[3] / 255];   // 事前乗算を戻す
	} catch { return d; }
}

// paint（評価済みの数と色）→ 計算に使う形
export function hillshadeParams(paint = {}, evalNum = x => x) {
	const first = v => Array.isArray(v) && v.length && (typeof v[0] === "number" || (typeof v[0] === "string" && !/^[a-z-]+$/.test(v[0]) || v.length > 1 && typeof v[1] === "string" && /^#/.test(v[1]))) ? v[0] : v;   // multidirectional の配列（色・向き）＝最初の光だけで描く（standard）
	const num = (k, d) => { const v = first(paint[k]); if (v == null) return d; const n = +evalNum(v); return Number.isFinite(n) ? n : d; };
	return {
		exaggeration: Math.max(0, Math.min(1, num("hillshade-exaggeration", 0.5))),
		direction: num("hillshade-illumination-direction", 335),
		shadow: cssColor(first(paint["hillshade-shadow-color"]), [0, 0, 0, 1]),
		highlight: cssColor(first(paint["hillshade-highlight-color"]), [1, 1, 1, 1]),
		accent: cssColor(first(paint["hillshade-accent-color"]), [0, 0, 0, 1]),
		method: paint["hillshade-method"] ?? "standard",
	};
}

// 1 タイルの陰影（MapLibre の hillshade_prepare＋hillshade fragment を画素で）。h＝タイル本体・N/S/E/W＝隣（無ければ端を伸ばす）。
// n＝タイルの幅（px）・z＝タイルの z・lat0/lat1＝タイルの上端/下端の緯度（度）。戻り＝RGBA（事前乗算なし）
export function shadeTile({ h, n, hN, hS, hE, hW, z, lat0, lat1, p }) {
	const out = new Uint8ClampedArray(n * n * 4);
	const at = (x, y) => {   // 隣へはみ出す読み（無ければ端の値）。NaN（無効）は 0 と見る
		let v;
		if (y < 0) v = hN ? hN[(n - 1) * n + Math.max(0, Math.min(n - 1, x))] : h[Math.max(0, Math.min(n - 1, x))];
		else if (y >= n) v = hS ? hS[Math.max(0, Math.min(n - 1, x))] : h[(n - 1) * n + Math.max(0, Math.min(n - 1, x))];
		else if (x < 0) v = hW ? hW[y * n + n - 1] : h[y * n];
		else if (x >= n) v = hE ? hE[y * n] : h[y * n + n - 1];
		else v = h[y * n + x];
		return v === v ? v : 0;
	};
	// prepare：勾配（3×3・Sobel 風）÷ 2^(exaggeration + 19.2562 − z)。exaggeration＝z<15 で (z−15)×係数（MapLibre の式のまま）
	const ef = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3, ex = z < 15 ? (z - 15) * ef : 0, denom = Math.pow(2, ex + (19.2562 - z));
	const azimuth = p.direction * PI / 180 + PI, I = p.exaggeration, base = 1.875 - I * 1.75, maxV = 0.5 * PI, k = Math.max(0, Math.min(1, I * 2));
	const pb = Math.pow(base, maxV) - 1;
	const [sr, sg, sb, sa] = p.shadow, [hr, hg, hb, ha] = p.highlight, [ar, ag, ab, aa] = p.accent;
	for (let y = 0; y < n; y++) {
		// 緯度の縮み（MapLibre の u_latrange＝タイルの上端と下端の緯度・行ごとに補間）
		const lat = lat0 + (lat1 - lat0) * (y + 0.5) / n, scale = Math.cos(lat * PI / 180);
		for (let x = 0; x < n; x++) {
			const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1), d = at(x - 1, y), f = at(x + 1, y), g = at(x - 1, y + 1), hh = at(x, y + 1), i = at(x + 1, y + 1);
			let dx = ((c + f + f + i) - (a + d + d + g)) / denom, dy = ((g + hh + hh + i) - (a + b + b + c)) / denom;
			// fragment：deriv は 0..1 に詰めて戻す（clamp＝MapLibre の中間テクスチャの精度と同じ切れ方）
			dx = Math.max(-1, Math.min(1, dx)); dy = Math.max(-1, Math.min(1, dy));
			const slope = Math.atan(1.25 * Math.hypot(dx, dy) / scale);
			const aspect = dy !== 0 ? Math.atan2(dx, -dy) : PI / 2 * (dx > 0 ? 1 : -1);
			const scaled = I !== 0.5 ? ((Math.pow(base, slope) - 1) / pb) * maxV : slope;
			const accentK = (1 - Math.cos(scaled)) * k, shade = Math.abs(((aspect + azimuth) / PI + 0.5) % 2 - 1), sk = Math.sin(scaled) * k;
			// accent_color＝(1−cos)×accent×k／shade_color＝mix(shadow, highlight, shade)×sin×k／out＝accent×(1−shade.a)＋shade（事前乗算の合成）
			const acr = ar * aa * accentK, acg = ag * aa * accentK, acb = ab * aa * accentK, aca = aa * accentK;
			const mr = sr * sa + (hr * ha - sr * sa) * shade, mg = sg * sa + (hg * ha - sg * sa) * shade, mb = sb * sa + (hb * ha - sb * sa) * shade, ma = sa + (ha - sa) * shade;
			const scr = mr * sk, scg = mg * sk, scb = mb * sk, sca = ma * sk;
			const oa = aca * (1 - sca) + sca, orr = acr * (1 - sca) + scr, og = acg * (1 - sca) + scg, ob = acb * (1 - sca) + scb;
			const o = (y * n + x) * 4;
			if (oa > 1e-6) { out[o] = orr / oa * 255; out[o + 1] = og / oa * 255; out[o + 2] = ob / oa * 255; out[o + 3] = oa * 255; }
		}
	}
	return out;
}

const tileLat = (y, z) => { const t = PI - 2 * PI * y / (1 << z); return 180 / PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t))); };

// port プロバイダ。dem＝raster-dem の spec（tiles 済み）・paint＝評価済み・fetchFn＝取得（requester）。戻り＝{ port（render worker へ transfer）, setPaint, close }
export function createHillshadeProvider({ dem, paint = {}, fetchFn = (u, init) => fetch(u, init), name = "hillshade", attribution = null, warn = null }) {
	const spec = normalizeDemSpec(dem), nDecl = spec.tileSize;   // 勾配は画像の実寸で取る（MapLibre は DEM の画素そのまま＝tileSize に縮めない。縮めると勾配が実寸比で増え陰影が強すぎる＝3 巡目の轍）
	let p = hillshadeParams(paint);
	if (p.method !== "standard") warn?.(`hillshade-method "${p.method}" is drawn as "standard"`);
	const ch = new MessageChannel(), port = ch.port1;
	const tiles = new Map();   // "z/x/y" → Promise<Float32Array|null>（直近 128 枚）
	const stats = { req: 0, ok: 0, empty: 0, err: 0, last: null };   // 切り分けの窓（dbgHost.__hillshade）
	const acs = new Map();
	let dctx = null;
	const tpls = spec.tiles.map(u => u.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));   // new URL(...).href で括弧が %7B に化けた型紙も読む
	const url = (z, x, y) => tpls[(x + y) % tpls.length].replace("{z}", z).replace("{x}", x).replace("{y}", y);
	const tile = (z, x, y) => {
		const m = 1 << z; x = ((x % m) + m) % m;
		if (y < 0 || y >= m) return Promise.resolve(null);
		const k = `${z}/${x}/${y}`;
		if (tiles.has(k)) { const v = tiles.get(k); tiles.delete(k); tiles.set(k, v); return v; }
		const pr = (async () => {
			const r = await fetchFn(url(z, x, y), { credentials: spec.credentials, ...(spec.headers ? { headers: spec.headers } : {}) });
			if (!r.ok) return null;
			const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
			const n = bmp.width;
			dctx ??= new OffscreenCanvas(n, n).getContext("2d", { willReadFrequently: true });
			if (dctx.canvas.width !== n) { dctx.canvas.width = n; dctx.canvas.height = n; }
			dctx.clearRect(0, 0, n, n); dctx.drawImage(bmp, 0, 0); bmp.close?.();
			return { h: decodeDEM(dctx.getImageData(0, 0, n, n).data, spec.encoding, spec), n };
		})().catch(() => null);
		tiles.set(k, pr);
		if (tiles.size > 128) tiles.delete(tiles.keys().next().value);
		return pr;
	};
	port.postMessage({ type: "info", info: { tileSize: nDecl, minZoom: spec.minzoom, maxZoom: spec.maxzoom, bbox: spec.bounds, attribution, name } });
	port.onmessage = async e => {
		const { id, z, x, y, abort } = e.data || {};
		if (abort) { acs.delete(id); return; }
		acs.set(id, true); stats.req++; stats.last = `${z}/${x}/${y}`; (stats.zs ??= {})[z] = (stats.zs[z] || 0) + 1;
		try {
			const [t, tN, tS, tE, tW] = await Promise.all([tile(z, x, y), tile(z, x, y - 1), tile(z, x, y + 1), tile(z, x + 1, y), tile(z, x - 1, y)]);
			if (!acs.has(id)) return;   // 中断された
			if (!t) { stats.empty++; port.postMessage({ id, bitmap: null }); return; }
			const n = t.n, nb = q => (q && q.n === n ? q.h : null);   // 隣は同じ実寸の物だけ（違えば端を伸ばす）
			const rgba = shadeTile({ h: t.h, n, hN: nb(tN), hS: nb(tS), hE: nb(tE), hW: nb(tW), z, lat0: tileLat(y, z), lat1: tileLat(y + 1, z), p });
			const bitmap = await createImageBitmap(new ImageData(rgba, n, n), { premultiplyAlpha: "none" });
			stats.ok++; port.postMessage({ id, bitmap }, [bitmap]);
		} catch (err) { stats.err++; stats.lastErr = String(err?.message || err); port.postMessage({ id, bitmap: null, error: String(err?.message || err) }); }
		finally { acs.delete(id); }
	};
	return { port: ch.port2, stats, setPaint(pt) { p = hillshadeParams(pt); }, close() { port.close(); ch.port2.close(); } };
}
