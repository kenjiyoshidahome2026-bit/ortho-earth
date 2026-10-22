// 点の集約（クラスタ）とヒートマップの計算部分（DOM・オーバーレイ無し＝Node の検定からも読める）。描画側は gadgets/aggregate.ts。
import { evalExpr, originOfLayer, ML_CZ0_KEY, ML_CZ1_KEY, ML_CEZ_KEY } from "@ortho-earth/core";
import { evalColor } from "./model.ts";
import type { ExprContext } from "@ortho-earth/core";

/** 層の出自（"ml"＝MapLibre の層・undefined＝ネイティブ） */
type Origin = ReturnType<typeof originOfLayer>;
/** 地図の global-state（#173 段 3b） */
type GlobalState = Record<string, unknown> | null | undefined;
type Props = Record<string, unknown>;
/** 点 1 つ（属性は元の参照・id＝元の地物の id） */
export interface AggPoint { lon: number; lat: number; props: Props; id?: string | number }
/** 集約の 1 段の 1 項（x・y＝世界メルカトル [0,1]・n＝束ねた点の数・i＝単点の添字・ez＝ばらける段・cid＝cluster_id・agg＝clusterProperties の値） */
export interface ClusterItem { x: number; y: number; n: number; i?: number; ez: number; agg: Props | null; cid?: number }
/** 段ごとの集約（levels[z - minLevel]） */
export interface Clusters { levels: ClusterItem[][]; minLevel: number; maxLevel: number }
/** heatStyle の戻り（radius・intensity＝zStep 刻みのズームの表・ramp＝heatmap-color の 256 段 RGBA） */
export interface HeatStyle { radius: number[]; intensity: number[]; zStep: number; opacity: number; ramp: Uint8Array }

export const D2R = Math.PI / 180;
const mercY = (lat: number) => { const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const unMercY = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;
export const ctxOf = (zoom: number, props: Props | null | undefined, origin: Origin, gs: GlobalState): ExprContext => ({ zoom, props: props || {}, geom: "Point", vars: {}, gs, origin });   // gs＝地図の global-state（#173 段 3b）   // origin＝"ml"（MapLibre の層）

/** pointsOf が読む地物（Point／MultiPoint だけ拾う） */
interface PointFeature { geometry?: { type?: string; coordinates?: unknown } | null; properties?: Props | null; id?: string | number }
/** pointsOf が受ける物（地物の配列・FeatureCollection・Feature・features を持つ物） */
type PointsSrc = { type?: unknown; features?: Array<PointFeature | null | undefined> } | null | undefined;
// 点の列＝Point/MultiPoint を 1 点ずつ（属性は元の参照）
export function pointsOf(src: unknown): AggPoint[] {
	const feats = (Array.isArray(src) ? src : (src as PointsSrc)?.type === "FeatureCollection" ? (src as PointsSrc)!.features : (src as PointsSrc)?.type === "Feature" ? [src] : (src as PointsSrc)?.features || []) as Array<PointFeature | null | undefined>;
	const out: AggPoint[] = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const id = f!.id != null ? { id: f!.id } : {};
		if (g.type === "Point") out.push({ lon: (g.coordinates as number[])[0], lat: (g.coordinates as number[])[1], props: f!.properties || {}, ...id });
		else if (g.type === "MultiPoint") for (const c of g.coordinates as number[][]) out.push({ lon: c[0], lat: c[1], props: f!.properties || {}, ...id });
	}
	return out;
}
// ["heatmap-density"] を変数へ差し替えた式（評価器は heatmap-density を知らない＝var で渡す）
const withDensity = (e: unknown): unknown => Array.isArray(e) ? (e[0] === "heatmap-density" ? ["var", "__hd"] : e.map(withDensity)) : e;
const HEAT_DEFAULT_COLOR = ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0, 0, 255, 0)", 0.1, "royalblue", 0.3, "cyan", 0.5, "lime", 0.7, "yellow", 1, "red"];
export function heatStyle(paint: Props = {}, zoomNow = 10, origin: Origin = undefined, gs: GlobalState = undefined): HeatStyle {
	const ZS = 0.5, zs: number[] = []; for (let z = 0; z <= 24; z += ZS) zs.push(z);
	const tab = (e: unknown, def: number) => Float32Array.from(zs.map(z => { const v = evalExpr(e ?? def, ctxOf(z, {}, origin, gs)); return +((v === undefined && origin ? def : v) as number); }));   // ML の評価エラー（undefined）＝既定値・ネイティブは従来どおり
	const ce = withDensity(paint["heatmap-color"] ?? HEAT_DEFAULT_COLOR), ramp = new Uint8Array(256 * 4);
	for (let i = 0; i < 256; i++) {
		const c = evalColor(ce, { zoom: zoomNow, props: {}, geom: "Point", vars: { __hd: i / 255 }, origin }) || [0, 0, 0, 0];
		ramp[i * 4] = Math.round(c[0]); ramp[i * 4 + 1] = Math.round(c[1]); ramp[i * 4 + 2] = Math.round(c[2]); ramp[i * 4 + 3] = Math.round((c[3] ?? 1) * 255);
	}
	return { radius: [...tab(paint["heatmap-radius"], 30)], intensity: [...tab(paint["heatmap-intensity"], 1)], zStep: ZS, opacity: (v => +((v === undefined && origin ? 1 : v) as number))(evalExpr(paint["heatmap-opacity"] ?? 1, ctxOf(zoomNow, {}, origin, gs))), ramp };
}

/** buildClusters のオプション（clusterProperties＝MapLibre の { 名前: [畳み方, 写し方] }） */
export interface BuildClustersOpts { clusterRadius?: number; clusterMaxZoom?: number; minZoom?: number; clusterProperties?: Record<string, unknown> | null; gs?: GlobalState }
// 集約（supercluster と同じ考え方）：最も細かい段（clusterMaxZoom+1）＝ばらした点。そこから 1 段ずつ粗く、
// 半径 clusterRadius px（その段の 256·2^z px 世界）以内の近所を重み付き重心へ束ねる（格子で近所を引く＝O(n)）。
// ez＝その集約がばらける段（クリックで寄る先）。
export function buildClusters(pts: AggPoint[], { clusterRadius = 50, clusterMaxZoom = 14, minZoom = 0, clusterProperties = null, gs = undefined }: BuildClustersOpts = {}): Clusters {
	clusterMaxZoom = Math.round(clusterMaxZoom); minZoom = Math.floor(minZoom);   // 段は整数（目盛り "mercator" の dz は小数＝14→15.36 で new Array が投げた・2026-09-27）
	const top = clusterMaxZoom + 1;
	// clusterProperties（MapLibre）＝{ 名前: [畳み方, 写し方] }。写し方＝単点の属性からの式・畳み方＝"+"・"max" 等の演算子名か ["accumulated"]・["get", 名前] を使う式（段 6）
	const cp = clusterProperties ? Object.entries(clusterProperties as Record<string, [unknown, unknown]>).map(([k, [op, mapE]]) => [k, Array.isArray(op) ? op : [op, ["var", "a"], ["var", "b"]], Array.isArray(op), mapE] as [string, unknown[], boolean, unknown]) : [];
	const ctxM = (props: Props | null | undefined, vars: Props = {}): ExprContext => ({ zoom: 0, props: props || {}, geom: "Point", vars, gs, origin: "ml" });
	const aggOf = (p: AggPoint) => cp.length ? Object.fromEntries(cp.map(([k, , , mapE]) => [k, evalExpr(mapE, ctxM(p.props))])) : null;
	const fold = (a: Props | null, b: Props | null): Props | null => { if (!a) return b; const out = { ...a }; for (const [k, redE, isExpr] of cp) out[k] = isExpr ? evalExpr(redE, ctxM({ [k]: b![k] }, { accumulated: a[k] })) : evalExpr(redE, ctxM({}, { a: a[k], b: b![k] })); return out; };
	let nextId = 0;
	let items: ClusterItem[] = pts.map((p, i) => ({ x: (p.lon + 180) / 360, y: mercY(p.lat), n: 1, i, ez: top, agg: aggOf(p) }));
	const levels: ClusterItem[][] = new Array(top - minZoom + 1);
	levels[top - minZoom] = items;
	for (let z = clusterMaxZoom; z >= minZoom; z--) {
		const r = clusterRadius / (256 * 2 ** z), grid = new Map<number, number[]>(), used = new Uint8Array(items.length), out: ClusterItem[] = [];
		const key = (cx: number, cy: number) => cx * 1e7 + cy;
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
/** clusterFeatures の戻り（points＝点の数・counts＝段ごとの丸と単点の数・fc＝全段の丸と単点・byCid＝cluster_id → ばらける段） */
export interface ClusterSource { points: number; counts: number[]; fc: { type: "FeatureCollection"; features: Array<{ type: "Feature"; id?: string | number; properties: Props; geometry: { type: "Point"; coordinates: number[] } }> }; byCid: Map<number, number> }
// 集約を source の地物へ（cluster as data・2026-10-22）＝全段の丸と単点を 1 つの FeatureCollection に。段をまたいで変わらない項は 1 地物
//（buildClusters は束ねなかった項を同じ物のまま次の段へ渡す）。居る段は隠しの属性 [ML_CZ0_KEY, ML_CZ1_KEY)＝エンジンの z（端の段はその先も）。
// 段の選び方は floor(zoom)（MapLibre と同じ）。描く側は層の filter に段の条件を足すだけ＝MapLibre の circle／symbol の層がそのまま効く（丸は gint・件数は注記層）
export function clusterFeatures(pts: AggPoint[], cl: Clusters): ClusterSource {
	const span = new Map<ClusterItem, [number, number]>(), last = cl.levels.length - 1, BIG = 1e9;
	cl.levels.forEach((L, li) => { for (const it of L || []) { const s = span.get(it); if (s) s[1] = li; else span.set(it, [li, li]); } });
	const features: ClusterSource["fc"]["features"] = [], byCid = new Map<number, number>();
	for (const [it, [lo, hi]] of span) {
		const z = { [ML_CZ0_KEY]: lo === 0 ? -BIG : cl.minLevel + lo, [ML_CZ1_KEY]: hi === last ? BIG : cl.minLevel + hi + 1 };
		if (it.i != null) { const p = pts[it.i]; features.push({ type: "Feature", ...(p.id != null ? { id: p.id } : {}), properties: { ...p.props, ...z }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }); continue; }
		byCid.set(it.cid!, it.ez);
		features.push({ type: "Feature", id: it.cid, properties: { cluster: true, cluster_id: it.cid, point_count: it.n, point_count_abbreviated: abbr(it.n), ...(it.agg || {}), ...z, [ML_CEZ_KEY]: it.ez },
			geometry: { type: "Point", coordinates: [it.x * 360 - 180, unMercY(it.y)] } });
	}
	return { points: pts.length, counts: cl.levels.map(L => L.length), fc: { type: "FeatureCollection", features }, byCid };
}
export const abbr = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
// 集約の既定（MapLibre の公式例の配色・map.gadget.cluster の層の paint の下敷き）
export const CLUSTER_DEFAULT = {
	paint: { "circle-color": ["step", ["get", "point_count"], "#51bbd6", 100, "#f1f075", 750, "#f28cb1"], "circle-radius": ["step", ["get", "point_count"], 20, 100, 30, 750, 40], "circle-stroke-width": 0, "circle-stroke-color": "#fff", "circle-opacity": 0.9 },
	unclustered: { paint: { "circle-color": "#11b4da", "circle-radius": 4, "circle-stroke-width": 1, "circle-stroke-color": "#fff" } },
	text: { color: "#222", size: 12 },
};
