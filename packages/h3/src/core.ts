// @ortho-earth/h3 の計算部分（DOM・地図無し＝Node の検定 tests/t-h3.mjs が直接読む）。deck.gl 差分の計画 段 A1〜A2（2026-10-11）。
//   ・cellsToGeoJSON(cells, props)：H3 のセル id → GeoJSON の面（±180° を跨ぐセルは経度を東へ伸ばす＝MapLibre の geojson は 180 超の経度を受ける）
//   ・binPoints(points, { res, weight, agg })：点を H3 のセルへ集約（count・sum・mean・min・max）。weight は数か (props)→数 か MapLibre の式
//   ・resForZoom(zoom, { edgePx })：表示のズーム（256px 世界の z）で六角の辺が約 edgePx になる解像度（0〜15）
// h3-js は ES（vite）と CJS（node の main）の両方があり、名前付き export が両方で取れるとは限らない＝namespace の既定を見る
import * as h3ns from "h3-js";
export type H3Lib = typeof h3ns;
const ns = h3ns as Partial<H3Lib> & { default?: H3Lib };   // 名前付きが無い組み方（CJS）では default に本体
export const h3: H3Lib = ns.latLngToCell ? ns as H3Lib : ns.default!;

/** 1 点＝経度・緯度と属性（GeoJSON の Feature から拾った時は properties） */
export interface H3Point { lon: number; lat: number; props?: Record<string, unknown> | null }
/** 点の列の入口＝GeoJSON（FeatureCollection・Feature・Feature の配列）か [{ lon, lat, props }] */
export interface H3Geometry { type: string; coordinates?: unknown }
export interface H3Feature { type?: string; geometry?: H3Geometry | null; properties?: Record<string, unknown> | null }
export interface H3FeatureCollection { type?: string; features?: H3Feature[] }
export type H3PointSource = H3Point[] | H3Feature[] | H3FeatureCollection | H3Feature | null | undefined;
/** 式の評価器（@ortho-earth/core/expr の evalExpr と同じ形＝globe が渡す） */
export type H3EvalExpr = (expr: unknown[], ctx: { zoom: number; props: Record<string, unknown>; geom: string; vars: Record<string, unknown>; origin: string }) => unknown;
/** 重み＝数・属性名・(props, point)→数・MapLibre の式（evalExpr を渡した時だけ）。無し＝1 */
export type H3Weight = number | string | ((props: Record<string, unknown> | null | undefined, p: H3Point) => unknown) | unknown[] | null | undefined;
/** 1 セルの集約 */
export type H3Bin = { h3: string; res: number; count: number; sum: number; mean: number; min: number; max: number };
export interface H3BinOptions { res?: number; weight?: H3Weight; evalExpr?: H3EvalExpr | null }
/** cellsToGeoJSON の入口＝id の配列・{ h3, … } の配列・Map(id → props)・{ id: props } */
export type H3CellSource = string[] | { h3: string; [k: string]: unknown }[] | Map<string, unknown> | Record<string, unknown> | null | undefined;
export type H3PropsFn = (cell: string, i: number, p: unknown) => Record<string, unknown> | null | undefined;
export interface H3CellFeature { type: "Feature"; id: number; properties: Record<string, unknown>; geometry: { type: "Polygon"; coordinates: [number, number][][] } }
export interface H3CellCollection { type: "FeatureCollection"; features: H3CellFeature[] }

export const D2R = Math.PI / 180;
// 六角の平均の辺の長さ（m）＝H3 の公式表（getHexagonEdgeLengthAvg(res, "m") と同じ値・表で持つ＝wasm を呼ばない）
export const EDGE_M = [1281256.011, 483056.8391, 182512.9565, 68979.22179, 26071.75968, 9854.090990, 3724.532667, 1406.475763, 531.414010, 200.786148, 75.863783, 28.663897, 10.830188, 4.092010, 1.546100, 0.584169];
const MPX0 = 2 * Math.PI * 6378137 / 256;   // z0 の 1px＝赤道で約 156km（256px 世界）

// 表示のズームでセルの辺が約 edgePx（既定 40px）になる解像度。lat を渡すとその緯度の縮尺で（正射の地図は同じ z＝同じ倍率なので既定は赤道）
export function resForZoom(zoom: number, { edgePx = 40, min = 0, max = 15 }: { edgePx?: number; min?: number; max?: number } = {}): number {
	const mPx = MPX0 / 2 ** zoom, want = edgePx * mPx;
	let best = min, bd = Infinity;
	for (let r = min; r <= max; r++) { const d = Math.abs(Math.log(EDGE_M[r] / want)); if (d < bd) { bd = d; best = r; } }
	return best;
}

// 点の列＝GeoJSON（FeatureCollection・Feature・配列）か [{ lon, lat, props }]。Point/MultiPoint を 1 点ずつ
export function pointsOf(src: H3PointSource): H3Point[] {
	if (Array.isArray(src) && src.length && src[0] && "lon" in src[0]) return src as H3Point[];
	const feats: H3Feature[] = Array.isArray(src) ? src as H3Feature[] : src?.type === "FeatureCollection" ? (src as H3FeatureCollection).features ?? [] : src?.type === "Feature" ? [src as H3Feature] : (src as H3FeatureCollection | null | undefined)?.features || [];
	const out: H3Point[] = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		if (g.type === "Point") { const c = g.coordinates as number[]; out.push({ lon: c[0], lat: c[1], props: f.properties || {} }); }
		else if (g.type === "MultiPoint") for (const c of g.coordinates as number[][]) out.push({ lon: c[0], lat: c[1], props: f.properties || {} });
	}
	return out;
}

// 重み＝数・(props, point)→数・MapLibre の式（evalExpr を渡した時だけ）。無し＝1
export function weightFn(weight: H3Weight, evalExpr?: H3EvalExpr | null): (p: H3Point) => number {
	if (weight == null) return () => 1;
	if (typeof weight === "number") return () => weight;
	if (typeof weight === "function") return (p) => +(weight(p.props, p) as number) || 0;   // 旧来どおり + の強制（返りは数のはず）
	if (Array.isArray(weight) && evalExpr) return (p) => { const v = evalExpr(weight, { zoom: 0, props: p.props || {}, geom: "Point", vars: {}, origin: "ml" }); return Number.isFinite(+(v as number)) ? +(v as number) : 0; };
	if (typeof weight === "string") return (p) => { const v = +(p.props?.[weight] as number); return Number.isFinite(v) ? v : 0; };   // 属性名
	return () => 1;
}

// 点をセルへ：Map(cell → { h3, res, count, sum, mean, min, max })。agg＝残す統計の名前（既定は全部）
export function binPoints(points: H3PointSource, { res = 7, weight = null, evalExpr = null }: H3BinOptions = {}): Map<string, H3Bin> {
	const pts = pointsOf(points), w = weightFn(weight, evalExpr), out = new Map<string, H3Bin>();
	for (const p of pts) {
		if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
		const cell = h3.latLngToCell(p.lat, p.lon, res), v = w(p);
		let a = out.get(cell);
		if (!a) out.set(cell, a = { h3: cell, res, count: 0, sum: 0, mean: 0, min: Infinity, max: -Infinity });
		a.count++; a.sum += v; if (v < a.min) a.min = v; if (v > a.max) a.max = v;
	}
	for (const a of out.values()) a.mean = a.count ? a.sum / a.count : 0;
	return out;
}

// セルの境界（GeoJSON の [lon, lat]・閉じた環）。±180° を跨ぐ（経度の幅が 180 超）セルは負の経度に 360 を足す＝一つの面のまま東へ伸ばす
export function cellRing(cell: string): [number, number][] {
	const ring = h3.cellToBoundary(cell, true);   // [[lng, lat], …]・最後が最初と同じ（GeoJSON）
	let lo = Infinity, hi = -Infinity;
	for (const [x] of ring) { if (x < lo) lo = x; if (x > hi) hi = x; }
	if (hi - lo > 180) for (const c of ring) if (c[0] < 0) c[0] += 360;
	return ring;
}
// cells＝id の配列・Map(id → props)・{ id: props }。props＝(cell, i)→属性 か 固定の属性
export function cellsToGeoJSON(cells: H3CellSource, props: H3PropsFn | Record<string, unknown> | null = null): H3CellCollection {
	const entries: [string, unknown][] = cells instanceof Map ? [...cells.entries()] : Array.isArray(cells) ? cells.map(c => [typeof c === "string" ? c : c.h3, typeof c === "string" ? null : c]) : Object.entries(cells || {});
	const features: H3CellFeature[] = [];
	entries.forEach(([cell, p], i) => {
		if (!h3.isValidCell(cell)) return;
		const extra = typeof props === "function" ? props(cell, i, p) : props;
		features.push({ type: "Feature", id: i, properties: { h3: cell, ...(p && typeof p === "object" ? p : {}), ...(extra || {}) }, geometry: { type: "Polygon", coordinates: [cellRing(cell)] } });
	});
	return { type: "FeatureCollection", features };
}
// 親・子（解像度の変換）＝h3 の薄い写し（アプリが h3-js を直接 import せずに済む）
export const cellToParent = (cell: string, res: number): string => h3.cellToParent(cell, res);
export const cellToChildren = (cell: string, res: number): string[] => h3.cellToChildren(cell, res);
export const latLngToCell = (lat: number, lng: number, res: number): string => h3.latLngToCell(lat, lng, res);
export const cellToLatLng = (cell: string): [number, number] => h3.cellToLatLng(cell);
export const polygonToCells = (ring: number[][] | number[][][], res: number): string[] => h3.polygonToCells(ring, res, true);   // ring＝[[lng, lat], …]（GeoJSON の並び）
