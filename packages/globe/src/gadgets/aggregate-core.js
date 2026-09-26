// 点の集約（クラスタ）とヒートマップの計算部分（DOM・オーバーレイ無し＝Node の検定からも読める）。描画側は gadgets/aggregate.js。
import { evalExpr, originOfLayer } from "@ortho-earth/core";
import { evalColor } from "./model.js";

export const D2R = Math.PI / 180;
const mercY = lat => { const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const unMercY = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;
export const ctxOf = (zoom, props, origin) => ({ zoom, props: props || {}, geom: "Point", vars: {}, origin });   // origin＝"ml"（MapLibre の層）

// 点の列＝Point/MultiPoint を 1 点ずつ（属性は元の参照）
export function pointsOf(src) {
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.features || [];
	const out = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		if (g.type === "Point") out.push({ lon: g.coordinates[0], lat: g.coordinates[1], props: f.properties || {} });
		else if (g.type === "MultiPoint") for (const c of g.coordinates) out.push({ lon: c[0], lat: c[1], props: f.properties || {} });
	}
	return out;
}
// ["heatmap-density"] を変数へ差し替えた式（評価器は heatmap-density を知らない＝var で渡す）
const withDensity = e => Array.isArray(e) ? (e[0] === "heatmap-density" ? ["var", "__hd"] : e.map(withDensity)) : e;
export const HEAT_DEFAULT_COLOR = ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0, 0, 255, 0)", 0.1, "royalblue", 0.3, "cyan", 0.5, "lime", 0.7, "yellow", 1, "red"];
export function heatStyle(paint = {}, zoomNow = 10, origin = undefined) {
	const ZS = 0.5, zs = []; for (let z = 0; z <= 24; z += ZS) zs.push(z);
	const tab = (e, def) => Float32Array.from(zs.map(z => { const v = evalExpr(e ?? def, ctxOf(z, {}, origin)); return +(v === undefined && origin ? def : v); }));   // ML の評価エラー（undefined）＝既定値・ネイティブは従来どおり
	const ce = withDensity(paint["heatmap-color"] ?? HEAT_DEFAULT_COLOR), ramp = new Uint8Array(256 * 4);
	for (let i = 0; i < 256; i++) {
		const c = evalColor(ce, { zoom: zoomNow, props: {}, geom: "Point", vars: { __hd: i / 255 }, origin }) || [0, 0, 0, 0];
		ramp[i * 4] = Math.round(c[0]); ramp[i * 4 + 1] = Math.round(c[1]); ramp[i * 4 + 2] = Math.round(c[2]); ramp[i * 4 + 3] = Math.round((c[3] ?? 1) * 255);
	}
	return { radius: [...tab(paint["heatmap-radius"], 30)], intensity: [...tab(paint["heatmap-intensity"], 1)], zStep: ZS, opacity: (v => +(v === undefined && origin ? 1 : v))(evalExpr(paint["heatmap-opacity"] ?? 1, ctxOf(zoomNow, {}, origin))), ramp };
}

// 集約（supercluster と同じ考え方）：最も細かい段（clusterMaxZoom+1）＝ばらした点。そこから 1 段ずつ粗く、
// 半径 clusterRadius px（その段の 256·2^z px 世界）以内の近所を重み付き重心へ束ねる（格子で近所を引く＝O(n)）。
// ez＝その集約がばらける段（クリックで寄る先）。
export function buildClusters(pts, { clusterRadius = 50, clusterMaxZoom = 14, minZoom = 0, clusterProperties = null } = {}) {
	const top = clusterMaxZoom + 1;
	// clusterProperties（MapLibre）＝{ 名前: [畳み方, 写し方] }。写し方＝単点の属性からの式・畳み方＝"+"・"max" 等の演算子名か ["accumulated"]・["get", 名前] を使う式（段 6）
	const cp = clusterProperties ? Object.entries(clusterProperties).map(([k, [op, mapE]]) => [k, Array.isArray(op) ? op : [op, ["var", "a"], ["var", "b"]], Array.isArray(op), mapE]) : [];
	const ctxM = (props, vars = {}) => ({ zoom: 0, props: props || {}, geom: "Point", vars, origin: "ml" });
	const aggOf = p => cp.length ? Object.fromEntries(cp.map(([k, , , mapE]) => [k, evalExpr(mapE, ctxM(p.props))])) : null;
	const fold = (a, b) => { if (!a) return b; const out = { ...a }; for (const [k, redE, isExpr] of cp) out[k] = isExpr ? evalExpr(redE, ctxM({ [k]: b[k] }, { accumulated: a[k] })) : evalExpr(redE, ctxM({}, { a: a[k], b: b[k] })); return out; };
	let nextId = 0;
	let items = pts.map((p, i) => ({ x: (p.lon + 180) / 360, y: mercY(p.lat), n: 1, i, ez: top, agg: aggOf(p) }));
	const levels = new Array(top - minZoom + 1);
	levels[top - minZoom] = items;
	for (let z = clusterMaxZoom; z >= minZoom; z--) {
		const r = clusterRadius / (256 * 2 ** z), grid = new Map(), used = new Uint8Array(items.length), out = [];
		const key = (cx, cy) => cx * 1e7 + cy;
		items.forEach((it, k) => { const g = key(Math.floor(it.x / r), Math.floor(it.y / r)); let a = grid.get(g); if (!a) grid.set(g, a = []); a.push(k); });
		for (let k = 0; k < items.length; k++) {
			if (used[k]) continue;
			used[k] = 1;
			const it = items[k], cx = Math.floor(it.x / r), cy = Math.floor(it.y / r);
			let sx = it.x * it.n, sy = it.y * it.n, n = it.n, m = 1, agg = it.agg;
			for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) for (const j of grid.get(key(gx, gy)) || []) {
				if (used[j]) continue;
				const o = items[j];
				if (Math.hypot(o.x - it.x, o.y - it.y) > r) continue;
				used[j] = 1; sx += o.x * o.n; sy += o.y * o.n; n += o.n; m++; if (cp.length) agg = fold(agg, o.agg);
			}
			out.push(m === 1 ? it : { x: sx / n, y: sy / n, n, ez: z + 1, agg, cid: nextId++ });   // cid＝cluster_id（MapLibre）
		}
		items = out;
		levels[z - minZoom] = items;
	}
	return { levels, minLevel: minZoom, maxLevel: top };
}
export const abbr = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
export const CLUSTER_DEFAULT = {
	paint: { "circle-color": ["step", ["get", "point_count"], "#51bbd6", 100, "#f1f075", 750, "#f28cb1"], "circle-radius": ["step", ["get", "point_count"], 20, 100, 30, 750, 40], "circle-stroke-width": 0, "circle-stroke-color": "#fff", "circle-opacity": 0.9 },
	unclustered: { paint: { "circle-color": "#11b4da", "circle-radius": 4, "circle-stroke-width": 1, "circle-stroke-color": "#fff" } },
	text: { color: "#222", size: 12 },
};
const css = q => `rgba(${Math.round(q[0])},${Math.round(q[1])},${Math.round(q[2])},${q[3] ?? 1})`;   // q＝evalColor の [r,g,b（0-255）, a（0-1）]
// 段ごとの丸（描画用）＝式をその段のズームで評価
export function clusterDraw(pts, cl, opts = {}) {
	const origin = originOfLayer(opts);
	const cp = { ...CLUSTER_DEFAULT.paint, ...(opts.paint || {}) }, up = { ...CLUSTER_DEFAULT.unclustered.paint, ...(opts.unclustered?.paint || {}) }, tx = { ...CLUSTER_DEFAULT.text, ...(opts.text || {}) };
	return cl.levels.map((items, li) => {
		const z = cl.minLevel + li;
		return items.map(it => {
			const lon = it.x * 360 - 180, lat = unMercY(it.y);
			const single = it.n === 1, props = single ? pts[it.i].props : { cluster: true, cluster_id: it.cid, point_count: it.n, point_count_abbreviated: abbr(it.n), ...(it.agg || {}) };
			const P = single ? up : cp, c = ctxOf(z, props, origin);
			const e = (k, d) => evalExpr(P[k] ?? d, c);
			return { lon, lat, n: it.n, ez: it.ez, i: single ? it.i : -1, cid: it.cid, agg: it.agg, r: +e("circle-radius", 5), fill: css(evalColor(P["circle-color"] ?? "#000", c) || [0, 0, 0, 1]),
				stroke: css(evalColor(P["circle-stroke-color"] ?? "#000", c) || [0, 0, 0, 1]), sw: +e("circle-stroke-width", 0), op: +e("circle-opacity", 1),
				text: single ? "" : props.point_count_abbreviated, tc: tx.color, ts: tx.size };
		});
	});
}

