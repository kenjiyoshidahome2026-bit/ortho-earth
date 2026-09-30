// MapLibre の hillshade 層（raster-dem から 2D の陰影）＝公式例の門 3 巡目（2026-09-27）。
// この地図の陰影は傾けた時の地形面だけ（真俯瞰は平面）＝MapLibre の hillshade（真俯瞰でも陰影の画像を重ねる）が無かった。
// 作り＝raster-dem のタイルを取って MapLibre と同じ式（hillshade_prepare＋hillshade の fragment・method "standard"）で陰影の画像タイルを作り、
// 画像タイル層の port プロバイダ（raster-src.js の契約＝info 1 通・{id,z,x,y}→{id,bitmap}）として render worker に渡す＝エンジンの描く経路は無改修。
// 端の勾配は隣のタイル（東西南北）を使う＝タイルの継ぎ目に筋が出ない（MapLibre は隣で縁を埋める）。DEM のタイルは在庫（demtiles.js）に持つ＝隣は次のタイルで使い回し、同じ source の color-relief とも共有（#114 段 3）。
// method は MapLibre 6.11.2 の 5 つ（standard・basic・combined・igor・multidirectional）を fragment のまま写す（2026-09-30・旧＝standard だけ）。
// 2026-09-30 本物の式に揃えた 4 点（公式例の門で斜面が 20〜70 階調暗かった）：勾配×DEM の実寸（旧＝512 固定）・頭打ち ±4（中間画像の 0..1＝deriv/8+0.5・旧 ±1）・standard の傾き atan(0.625·|d|)（旧 1.25）・向き atan(d.y, −d.x)（旧は 45° の線で折り返した形＝光が 315° の時だけ一致）。
import { createDemTiles } from "./demtiles.js";

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

// paint（評価済みの数と色）→ 計算に使う形。光は配列（multidirectional）＝MapLibre の getIlluminationProperties と同じく一番長い本数に揃え、足りない分は最後の値で埋める
const METHODS = ["standard", "basic", "combined", "igor", "multidirectional"];
export function hillshadeParams(paint = {}, evalNum = x => x) {
	const isColorList = v => Array.isArray(v) && v.length > 0 && v.every(c => typeof c === "string" && !/^[a-z-]+$/.test(c) || Array.isArray(c));   // ["#f40","#ff0"]（式 ["get",…] は数えない）
	const nums = (k, d) => { const v = paint[k]; const list = Array.isArray(v) && v.length && v.every(x => typeof x === "number") ? v : [v]; const out = list.map(x => { if (x == null) return d; const n = +evalNum(x); return Number.isFinite(n) ? n : d; }); return out.length ? out : [d]; };
	const cols = (k, d) => { const v = paint[k]; return (isColorList(v) ? v : [v]).map(c => cssColor(c, d)); };
	const direction = nums("hillshade-illumination-direction", 335), altitude = nums("hillshade-illumination-altitude", 45);
	const shadow = cols("hillshade-shadow-color", [0, 0, 0, 1]), highlight = cols("hillshade-highlight-color", [1, 1, 1, 1]);
	const N = Math.max(direction.length, altitude.length, shadow.length, highlight.length), pad = a => a.concat(Array(N - a.length).fill(a[a.length - 1]));
	const method = METHODS.includes(paint["hillshade-method"]) ? paint["hillshade-method"] : "standard";
	return {
		exaggeration: Math.max(0, Math.min(1, nums("hillshade-exaggeration", 0.5)[0])),
		direction: pad(direction)[0], directions: pad(direction), altitudes: pad(altitude),
		shadow: pad(shadow)[0], highlight: pad(highlight)[0], shadows: pad(shadow), highlights: pad(highlight),
		accent: cssColor(paint["hillshade-accent-color"], [0, 0, 0, 1]),
		method,
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
	// prepare：deriv＝Sobel×tileSize÷2^(exaggeration＋28.2562−z)（tileSize＝DEM の実寸 n）→ 中間画像（RGBA8）へ deriv/8＋128/255 を 0..1 に詰める＝±4 で頭打ち・1/255 刻み（MapLibre 6.11.2 のまま）
	const ef = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3, ex = z < 15 ? (z - 15) * ef : 0, k0 = n / Math.pow(2, ex + (28.2562 - z)), mid = 128 / 255;
	const pack = d => Math.round(Math.max(0, Math.min(1, d / 8 + mid)) * 255) / 255;   // 中間画像の 8 ビット
	const I = p.exaggeration, method = p.method || "standard";
	const shadows = p.shadows || [p.shadow], highlights = p.highlights || [p.highlight], azs = (p.directions || [p.direction]).map(d => d * PI / 180), alts = (p.altitudes || [45]).map(d => d * PI / 180);
	const L = Math.max(shadows.length, highlights.length, azs.length, alts.length);
	const pm = c => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];   // MapLibre の色は事前乗算
	const S = shadows.map(pm), H = highlights.map(pm), A = pm(p.accent), k = Math.max(0, Math.min(1, I * 2));
	const base = 1.875 - I * 1.75, maxV = 0.5 * PI, pb = Math.pow(base, maxV) - 1;
	const aspectOf = (dx, dy) => dx !== 0 ? Math.atan2(dy, -dx) : PI / 2 * (dy > 0 ? 1 : -1);   // get_aspect
	const shadeOf = (aspect, az) => Math.abs(((((aspect + az + PI) / PI + 0.5) % 2) + 2) % 2 - 1);   // abs(mod((aspect+azimuth)/PI+0.5, 2)−1)・GLSL の mod は負でも 0..2
	const o4 = [0, 0, 0, 0];
	const add = (c, w) => { o4[0] += c[0] * w; o4[1] += c[1] * w; o4[2] += c[2] * w; o4[3] += c[3] * w; };
	for (let y = 0; y < n; y++) {
		// 緯度の縮み（u_latrange＝タイルの上端と下端の緯度・行ごとに補間）
		const lat = lat0 + (lat1 - lat0) * (y + 0.5) / n, scale = Math.cos(lat * PI / 180);
		for (let x = 0; x < n; x++) {
			const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1), d = at(x - 1, y), f = at(x + 1, y), g = at(x - 1, y + 1), hh = at(x, y + 1), i = at(x + 1, y + 1);
			// fragment：deriv＝(画素−128/255)×8÷scaleFactor
			let dx = (pack(((c + f + f + i) - (a + d + d + g)) * k0) - mid) * 8 / scale, dy = (pack(((g + hh + hh + i) - (a + b + b + c)) * k0) - mid) * 8 / scale;
			o4[0] = o4[1] = o4[2] = o4[3] = 0;
			if (method === "standard") {
				const slope = Math.atan(0.625 * Math.hypot(dx, dy)), aspect = aspectOf(dx, dy);
				const scaled = I !== 0.5 ? ((Math.pow(base, slope) - 1) / pb) * maxV : slope;
				const accentK = (1 - Math.cos(scaled)) * k, shade = shadeOf(aspect, azs[0]), sk = Math.sin(scaled) * k;
				const sc = [0, 1, 2, 3].map(j => (S[0][j] + (H[0][j] - S[0][j]) * shade) * sk);   // mix(shadow, highlight, shade)×sin×k
				for (let j = 0; j < 4; j++) o4[j] = A[j] * accentK * (1 - sc[3]) + sc[j];   // accent×(1−shade.a)＋shade
			} else if (method === "igor") {
				dx *= I * 2; dy *= I * 2;
				const aspect = aspectOf(dx, dy), slopeS = Math.atan(Math.hypot(dx, dy)) * 2 / PI;
				const aspS = 1 - Math.abs(((((aspect + azs[0] + PI) / PI + 0.5) % 2) + 2) % 2 - 1);
				add(S[0], slopeS * aspS); add(H[0], slopeS * (1 - aspS));
			} else {   // basic・combined・multidirectional＝光の角度（高度・方位）で cos を取る
				dx *= I * 2; dy *= I * 2;
				const nrm = Math.sqrt(1 + dx * dx + dy * dy);
				if (method === "multidirectional") {
					for (let l = 0; l < L; l++) {
						const az = azs[Math.min(l, azs.length - 1)], alt = alts[Math.min(l, alts.length - 1)];
						const cosAz = -Math.cos(az), sinAz = -Math.sin(az), cosAlt = Math.cos(alt), sinAlt = Math.sin(alt);
						const sh = Math.max(0, Math.min(1, (sinAlt - (dy * cosAz * cosAlt - dx * sinAz * cosAlt)) / nrm));
						if (sh > 0.5) add(H[Math.min(l, H.length - 1)], (2 * sh - 1) / L); else add(S[Math.min(l, S.length - 1)], (1 - 2 * sh) / L);
					}
				} else {
					const az = azs[0] + PI, cosAz = Math.cos(az), sinAz = Math.sin(az), cosAlt = Math.cos(alts[0]), sinAlt = Math.sin(alts[0]);
					const cang0 = (sinAlt - (dy * cosAz * cosAlt - dx * sinAz * cosAlt)) / nrm;
					if (method === "basic") { const sh = Math.max(0, Math.min(1, cang0)); if (sh > 0.5) add(H[0], 2 * sh - 1); else add(S[0], 1 - 2 * sh); }
					else {   // combined
						const cang = Math.max(0, Math.min(PI / 2, Math.acos(Math.max(-1, Math.min(1, cang0))))), sl = Math.atan(Math.hypot(dx, dy));
						add(S[0], cang * sl * 4 / PI / PI); add(H[0], (PI / 2 - cang) * sl * 4 / PI / PI);
					}
				}
			}
			const oa = Math.max(0, Math.min(1, o4[3])), o = (y * n + x) * 4;
			if (oa > 1e-6) { out[o] = o4[0] / oa * 255; out[o + 1] = o4[1] / oa * 255; out[o + 2] = o4[2] / oa * 255; out[o + 3] = oa * 255; }   // 事前乗算を戻す
		}
	}
	return out;
}

const tileLat = (y, z) => { const t = PI - 2 * PI * y / (1 << z); return 180 / PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t))); };

// port プロバイダ。dem＝raster-dem の spec（tiles 済み）・paint＝評価済み・fetchFn＝取得（requester）・tiles＝共有の DEM の在庫（createDemTiles・無ければ自前）。戻り＝{ port（render worker へ transfer）, setPaint, close }
export function createHillshadeProvider({ dem, paint = {}, fetchFn = (u, init) => fetch(u, init), name = "hillshade", attribution = null, warn = null, tiles = null }) {
	const store = tiles ?? createDemTiles(dem, { fetchFn }), spec = store.spec, nDecl = spec.tileSize;   // 勾配は画像の実寸で取る（MapLibre は DEM の画素そのまま＝tileSize に縮めない。縮めると勾配が実寸比で増え陰影が強すぎる＝3 巡目の轍）
	let p = hillshadeParams(paint);
	const ch = new MessageChannel(), port = ch.port1;
	const stats = { req: 0, ok: 0, empty: 0, err: 0, last: null };   // 切り分けの窓（dbgHost.__hillshade）
	const acs = new Map();
	const tile = store.tile;
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
