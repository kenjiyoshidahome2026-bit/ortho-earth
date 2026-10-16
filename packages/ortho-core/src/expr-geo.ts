// 式の地理の演算子（C2・2026-10-12）＝MapLibre の ["within", geojson]・["distance", geojson] の中身。
// 地物の形は 2 つの渡し方：ctx.geojson（main の GeoJSON geometry）か、ctx.feat（タイルのフラット geom {coords, ends}・type）＋ctx.tile（{z, x, y, E}）＝遅延で経緯度へ。
// within＝MapLibre の約束：Point は境界の上・外で偽、LineString はどこかが外・境界と交わる・端が境界の上で偽（面・Multi* は偽）。
// distance＝地物と入力の最短距離 m。点どうしは haversine（authalic 球）・点と辺は局所の等距離射影の近似（都市の尺度で 0.1% 以内）。面の中の点は 0。
import { tileLocalToLonLat } from "./tile.ts";
import { AUTHALIC_R } from "./geodesic.ts";

/** [lon, lat]（度） */
export type Position = number[];
/** GeoJSON の形（この評価器が読む分） */
export type GeoJSONGeometry =
	| { type: "Point"; coordinates: Position }
	| { type: "MultiPoint"; coordinates: Position[] }
	| { type: "LineString"; coordinates: Position[] }
	| { type: "MultiLineString"; coordinates: Position[][] }
	| { type: "Polygon"; coordinates: Position[][] }
	| { type: "MultiPolygon"; coordinates: Position[][][] };
/** タイルの地物（{ type, geom: { coords, ends } }）＝geojson の代わり（worker） */
export interface GeoCtxFeat { type: string | undefined; geom: { coords: ArrayLike<number>; ends: number[] } | null }
export interface GeoCtxTile { z: number; x: number; y: number; E?: number }
/** featureGeomLL が読む ctx の項 */
export interface GeoCtx { geojson?: GeoJSONGeometry | null; feat?: GeoCtxFeat | null; tile?: GeoCtxTile | null }

const D2R = Math.PI / 180;
// ctx → GeoJSON geometry（経緯度）。無ければ null
export function featureGeomLL(ctx: GeoCtx): GeoJSONGeometry | null {
	if (ctx.geojson) return ctx.geojson;
	const f = ctx.feat, t = ctx.tile; if (!f?.geom || !t) return null;
	const { coords: c, ends } = f.geom, E = t.E || 4096, ll = (i: number): Position => tileLocalToLonLat(t.x, t.y, t.z, c[i], c[i + 1], E);
	if (f.type === "Point") { const pts: Position[] = []; for (let i = 0; i < c.length; i += 2) pts.push(ll(i)); return pts.length === 1 ? { type: "Point", coordinates: pts[0] } : { type: "MultiPoint", coordinates: pts }; }
	const parts: Position[][] = []; let s = 0; for (const e of ends) { const r: Position[] = []; for (let i = s; i < e; i += 2) r.push(ll(i)); parts.push(r); s = e; }
	if (f.type === "LineString") return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
	return { type: "Polygon", coordinates: parts };   // 輪の外・穴の区別は within/distance には要らない（偶奇）
}
// 入力の GeoJSON（Polygon・MultiPolygon・Feature・FeatureCollection・Geometry）→ 輪の列（面の分）と、距離の的（点・線・輪）
type GeoAny = { type?: string; coordinates?: unknown; geometry?: unknown; geometries?: unknown; features?: unknown };
const geomsOf = (g: unknown): GeoJSONGeometry[] => {
	if (!g || typeof g !== "object") return [];
	const o = g as GeoAny;
	if (o.type === "FeatureCollection") return ((o.features as unknown[]) || []).flatMap(geomsOf);
	if (o.type === "Feature") return geomsOf(o.geometry);
	if (o.type === "GeometryCollection") return ((o.geometries as unknown[]) || []).flatMap(geomsOf);
	return o.coordinates ? [o as GeoJSONGeometry] : [];
};
export const ringsOf = (g: unknown): Position[][] => geomsOf(g).flatMap(x => x.type === "Polygon" ? x.coordinates : x.type === "MultiPolygon" ? x.coordinates.flat() : []);
const inRings = (p: Position, rings: Position[][]): boolean => { let inside = false; for (const r of rings) { for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } } return inside; };
const onSeg = (p: Position, a: Position, b: Position): boolean => { const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (Math.abs(cr) > 1e-12) return false; return p[0] >= Math.min(a[0], b[0]) - 1e-12 && p[0] <= Math.max(a[0], b[0]) + 1e-12 && p[1] >= Math.min(a[1], b[1]) - 1e-12 && p[1] <= Math.max(a[1], b[1]) + 1e-12; };
const onBoundary = (p: Position, rings: Position[][]): boolean => rings.some(r => { for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (onSeg(p, r[i], r[j])) return true; return false; });
const segX = (p: Position, q: Position, a: Position, b: Position): boolean => {   // 線分が交わる（端で触れるのも交わり＝MapLibre の lineIntersectPolygon と同じ厳しさ）
	const d = (x: Position, y: Position, u: Position): number => (y[0] - x[0]) * (u[1] - x[1]) - (y[1] - x[1]) * (u[0] - x[0]);
	const o1 = Math.sign(d(p, q, a)), o2 = Math.sign(d(p, q, b)), o3 = Math.sign(d(a, b, p)), o4 = Math.sign(d(a, b, q));
	if (o1 !== o2 && o3 !== o4) return true;
	return onSeg(a, p, q) || onSeg(b, p, q) || onSeg(p, a, b) || onSeg(q, a, b);
};
export function withinGeom(g: GeoJSONGeometry | null | undefined, rings: Position[][]): boolean {
	if (!g || !rings.length) return false;
	if (g.type === "Point") { const p = g.coordinates; return inRings(p, rings) && !onBoundary(p, rings); }
	if (g.type === "LineString") {
		const L = g.coordinates; if (L.length < 2) return false;
		for (const p of L) if (!inRings(p, rings) || onBoundary(p, rings)) return false;
		for (let i = 0; i + 1 < L.length; i++) for (const r of rings) for (let k = 0, j = r.length - 1; k < r.length; j = k++) if (segX(L[i], L[i + 1], r[k], r[j])) return false;
		return true;
	}
	return false;   // Polygon・Multi*＝MapLibre も偽
}
// ── 距離 m ──
const hav = (p: Position, q: Position): number => { const f1 = p[1] * D2R, f2 = q[1] * D2R, dl = (q[0] - p[0]) * D2R, a = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2; return 2 * AUTHALIC_R * Math.asin(Math.min(1, Math.sqrt(a))); };
const ptSeg = (p: Position, a: Position, b: Position): number => {   // 点と辺（局所の等距離射影＝辺の中緯度で経度を縮める）
	const k = Math.cos((a[1] + b[1] + p[1]) / 3 * D2R), ax = a[0] * k, bx = b[0] * k, px = p[0] * k;
	const dx = bx - ax, dy = b[1] - a[1], l2 = dx * dx + dy * dy;
	const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
	return hav(p, [a[0] + t * (b[0] - a[0]), a[1] + t * dy]);
};
const pointsOf = (g: GeoJSONGeometry): Position[] => g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates : g.type === "LineString" ? g.coordinates : g.type === "MultiLineString" ? g.coordinates.flat() : g.type === "Polygon" ? g.coordinates.flat() : g.type === "MultiPolygon" ? g.coordinates.flat(2) : [];
const segsOf = (g: GeoJSONGeometry): Position[][] => g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
const isArea = (g: GeoJSONGeometry): boolean => g.type === "Polygon" || g.type === "MultiPolygon";
const minPtToGeom = (pts: Position[], h: GeoJSONGeometry): number => {   // 点の列 → 形 h の最短
	let best = Infinity;
	const hp = pointsOf(h), hs = segsOf(h);
	for (const p of pts) {
		if (hs.length) for (const L of hs) for (let i = 0, j = L.length - 1; i < L.length; j = i++) { if (!isArea(h) && i === 0) continue; const d = ptSeg(p, L[j], L[i]); if (d < best) best = d; }   // 線は閉じない（j=末尾→i=0 の辺は面だけ）
		else for (const q of hp) { const d = hav(p, q); if (d < best) best = d; }
	}
	return best;
};
export function distanceGeom(g: GeoJSONGeometry | null | undefined, target: unknown): number | null {
	const hs = geomsOf(target); if (!g || !hs.length) return null;
	let best = Infinity;
	const gp = pointsOf(g), gRings: Position[][] | null = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat(1) : null;
	for (const h of hs) {
		const hRings: Position[][] | null = h.type === "Polygon" ? h.coordinates : h.type === "MultiPolygon" ? h.coordinates.flat() : null;
		if (hRings && gp.some(p => inRings(p, hRings))) return 0;   // 地物の点が入力の面の中
		if (gRings && pointsOf(h).some(p => inRings(p, gRings))) return 0;   // 入力の点が地物の面の中
		best = Math.min(best, minPtToGeom(gp, h), minPtToGeom(pointsOf(h), g));
	}
	return Number.isFinite(best) ? best : null;
}
