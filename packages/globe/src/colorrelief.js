// MapLibre の color-relief 層（raster-dem を標高の段で塗る・#114・2026-09-29）。hillshade.js と同じ作り＝raster-dem のタイルを取って色の画像タイルを作り、
// 画像タイル層の port プロバイダ（raster-src.js の契約＝info 1 通・{id,z,x,y}→{id,bitmap}）として render worker に渡す＝エンジンの描く経路は無改修。
// 意味は本物（MapLibre 6.11.2 の ColorReliefStyleLayer と colorRelief のシェーダ）に合わせる：
//   ・色の段は interpolate（-hcl・-lab も）の時だけ＝段の標高（labels）で色を評価して事前乗算で持ち、段の間は線形（曲線・色空間に依らない）。
//   ・step・match・定数色は段の表が空＝透明。範囲の外は端の色。段が 1 つなら +1m に同じ色を足す。
//   ・color-relief-opacity は画像タイル層の不透明度（タイルを作り直さない）。resampling（linear/nearest）は読まない（画素ごとに色を引く）。
// 隣のタイルは要らない（勾配を取らない）＝hillshade より単純。
import { evalExpr, decodeDEM, normalizeDemSpec } from "@ortho-earth/core";

const INTERP = new Set(["interpolate", "interpolate-hcl", "interpolate-lab"]);
const at = h => ({ zoom: 0, props: {}, geom: null, vars: { elevation: h }, origin: "ml" });

// 段の表：{ elev: Float64Array（昇順）, rgba: Float32Array（事前乗算 0〜1・段ごとに 4）, n }
export function reliefRamp(expr) {
	const elev = [], rgba = [];
	if (Array.isArray(expr) && INTERP.has(expr[0])) {
		for (let i = 3; i + 1 < expr.length; i += 2) {
			const h = +expr[i], c = evalExpr(["to-rgba", expr], at(h));   // 段の標高で式を評価＝その段の色（MapLibre と同じ＝段の間の曲線は使わない）
			if (!Number.isFinite(h) || !Array.isArray(c)) continue;
			const a = c[3] ?? 1;
			elev.push(h); rgba.push(c[0] / 255 * a, c[1] / 255 * a, c[2] / 255 * a, a);
		}
	}
	if (!elev.length) { elev.push(0); rgba.push(0, 0, 0, 0); }   // interpolate でない＝透明
	if (elev.length < 2) { elev.push(elev[0] + 1); rgba.push(rgba[0], rgba[1], rgba[2], rgba[3]); }
	return { elev: Float64Array.from(elev), rgba: Float32Array.from(rgba), n: elev.length };
}

// 標高 h の色（事前乗算 0〜1）。範囲の外は端の色・NaN（無効）は透明
export function reliefAt(R, h) {
	const { elev, rgba, n } = R;
	if (!(h === h)) return [0, 0, 0, 0];
	const pick = i => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]];
	if (h <= elev[0]) return pick(0);
	if (h >= elev[n - 1]) return pick(n - 1);
	let l = 0, r = n - 1;
	while (r - l > 1) { const m = (l + r) >> 1; if (h < elev[m]) r = m; else l = m; }
	const t = (h - elev[l]) / (elev[r] - elev[l]), a = l * 4, b = r * 4;
	return [rgba[a] + (rgba[b] - rgba[a]) * t, rgba[a + 1] + (rgba[b + 1] - rgba[a + 1]) * t, rgba[a + 2] + (rgba[b + 2] - rgba[a + 2]) * t, rgba[a + 3] + (rgba[b + 3] - rgba[a + 3]) * t];
}

// 1 タイルの色（h＝標高の画素・n×n）→ RGBA（事前乗算を戻した 0〜255＝ImageData）
export function reliefTile(h, n, R) {
	const out = new Uint8ClampedArray(n * n * 4);
	for (let i = 0; i < n * n; i++) {
		const [r, g, b, a] = reliefAt(R, h[i]);
		if (a > 1e-6) { const o = i * 4; out[o] = r / a * 255; out[o + 1] = g / a * 255; out[o + 2] = b / a * 255; out[o + 3] = a * 255; }
	}
	return out;
}

// port プロバイダ。dem＝raster-dem の spec（tiles 済み）・color＝color-relief-color の式・fetchFn＝取得（requester）。戻り＝{ port（render worker へ transfer）, stats, close }
// 色を変える時は呼び手が作り直す（setPaintProperty → 層を載せ直す＝hillshade と同じ）
export function createColorReliefProvider({ dem, color, fetchFn = (u, init) => fetch(u, init), name = "color-relief", attribution = null }) {
	const spec = normalizeDemSpec(dem), R = reliefRamp(color);
	const ch = new MessageChannel(), port = ch.port1;
	const stats = { req: 0, ok: 0, empty: 0, err: 0, last: null, stops: R.n };   // 切り分けの窓（dbgHost.__colorRelief）
	const acs = new Map();
	let dctx = null;
	const tpls = spec.tiles.map(u => u.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));
	const url = (z, x, y) => tpls[(x + y) % tpls.length].replace("{z}", z).replace("{x}", x).replace("{y}", y);
	port.postMessage({ type: "info", info: { tileSize: spec.tileSize, minZoom: spec.minzoom, maxZoom: spec.maxzoom, bbox: spec.bounds, attribution, name } });
	port.onmessage = async e => {
		const { id, z, x, y, abort } = e.data || {};
		if (abort) { acs.delete(id); return; }
		acs.set(id, true); stats.req++; stats.last = `${z}/${x}/${y}`;
		try {
			const r = await fetchFn(url(z, x, y), { credentials: spec.credentials, ...(spec.headers ? { headers: spec.headers } : {}) });
			if (!acs.has(id)) return;   // 中断された
			if (!r.ok) { stats.empty++; port.postMessage({ id, bitmap: null }); return; }
			const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
			const n = bmp.width;
			dctx ??= new OffscreenCanvas(n, n).getContext("2d", { willReadFrequently: true });
			if (dctx.canvas.width !== n) { dctx.canvas.width = n; dctx.canvas.height = n; }
			dctx.clearRect(0, 0, n, n); dctx.drawImage(bmp, 0, 0); bmp.close?.();
			const h = decodeDEM(dctx.getImageData(0, 0, n, n).data, spec.encoding, spec);
			if (!acs.has(id)) return;
			const bitmap = await createImageBitmap(new ImageData(reliefTile(h, n, R), n, n), { premultiplyAlpha: "none" });
			stats.ok++; port.postMessage({ id, bitmap }, [bitmap]);
		} catch (err) { stats.err++; stats.lastErr = String(err?.message || err); port.postMessage({ id, bitmap: null, error: String(err?.message || err) }); }
		finally { acs.delete(id); }
	};
	return { port: ch.port2, stats, close() { port.close(); ch.port2.close(); } };
}
