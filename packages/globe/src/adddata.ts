// map.addData（deck.gl の Layer props／accessor の相当・差分 PR-4・2026-10-12）の焼き：配列＋accessor → typed array。
// deck.gl と同じ流儀＝accessor は (d, i) → 値 か 定数、色は [r, g, b, a?]（0〜255）、更新は差分でなく全焼き。
// 点（getPosition/getColor/getRadius[px]）→ points-gl の layer、弧（getSourcePosition/getTargetPosition/getSourceColor/getTargetColor/getWidth[px]/getHeight[弦長比]）→ arcs-gl の layer、
// 面・線・柱（getPolygon/getPath/getPosition＋getRadius[m]・getFillColor/getLineColor/getLineWidth/getElevation[m]）→ GeoJSON＝既存の層経路（fill／line／fill-extrusion・H3 と同じ）。
// 位置は β 単位球の xyz を倍精度で求め、重心を原点に原点相対（RTE）で f32 へ＝points-gl/arcs-gl の origin。純関数（DOM 無し）＝node の検定 tests/arcs.mjs が読む。
import { lonlatTo3D, ellNormal3D, worldRadiusM } from "@ortho-earth/core/camera";
import type { GeoJSONFeatureCollection } from "../globe.d.ts";

type F32 = Float32Array<ArrayBuffer>;
/** 入りの 1 件（配列の要素・GeoJSON の Feature・何でも＝accessor が読む） */
type Datum = { geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null; [k: string]: unknown } | null | undefined;
/** accessor＝(d, i) → 値 */
export type Accessor<T> = (d: Datum, i: number) => T;
/** 位置（[lon, lat, h?]） */
type Pos = ArrayLike<number>;
/** 色（[r, g, b, a?] 0〜255） */
type Color = ArrayLike<number> | null | undefined;
/** addData の props（deck.gl の Layer props の相当・accessor か定数） */
export interface AddDataProps {
	getPosition?: unknown; getColor?: unknown; getRadius?: unknown; getFilterValue?: unknown;
	getSourcePosition?: unknown; getTargetPosition?: unknown; getSourceColor?: unknown; getTargetColor?: unknown; getWidth?: unknown; getHeight?: unknown;
	getPath?: unknown; getTimestamps?: unknown;
	getPolygon?: unknown; getFillColor?: unknown; getLineColor?: unknown; getLineWidth?: unknown; getElevation?: unknown; getProperties?: unknown; diskResolution?: number;
	[k: string]: unknown;
}
/** 点 → points-gl へ送る焼き（RTE の原点からの相対・origin＝点が無ければ null） */
export interface BakedPoints { n: number; pos: F32; rgba: Uint8Array<ArrayBuffer> | null; size: F32 | null; f: F32 | null; origin: number[] | null; lngLat: Float64Array<ArrayBuffer> }
/** 弧 → arcs-gl */
export interface BakedArcs { n: number; src: F32; dst: F32; theta: F32; rgba: Uint8Array<ArrayBuffer> | null; rgba2: Uint8Array<ArrayBuffer> | null; width: F32 | null; height: F32 | null; f: F32 | null; origin: number[] | null }
/** 軌跡 → trips-gl */
export interface BakedTrips {
	n: number; nv: number; ni: number; pos: F32; oth: F32; side: F32; time: F32; id: Uint32Array<ArrayBuffer>; index: Uint32Array<ArrayBuffer>; rgba: Uint8Array<ArrayBuffer> | null; width: F32 | null; f: F32 | null; origin: number[] | null;
	tMin: number; tMax: number; trips: Array<{ i: number; lngLat: number[]; t0: number; t1: number }>;
}
/** 焼く前の軌跡 1 本 */
interface Trip { d: Datum; i: number; xyz: number[][]; t: number[]; lngLat: number[]; color: Color; width: number; f: number; index?: number }

export const accessor = <T>(a: unknown, dflt?: T): Accessor<T> => typeof a === "function" ? a as Accessor<T> : a === undefined ? (() => dflt as T) : (() => a as T);
const items = (data: unknown): Datum[] => Array.isArray(data) ? data : (data as { features?: Datum[] } | null)?.features ? (data as { features: Datum[] }).features : Array.from((data ?? []) as Iterable<Datum>);   // 配列・GeoJSON FeatureCollection・iterable
const posOf = (d: Datum, i: number, get: Accessor<unknown>, dflt?: (d: Datum) => unknown): Pos | null => { const p = get(d, i) ?? dflt?.(d); return (Array.isArray(p) || (p && typeof (p as Pos).length === "number")) && (p as Pos).length >= 2 ? p as Pos : null; };
const fcPos = (d: Datum): unknown => d?.geometry?.type === "Point" ? d.geometry.coordinates : null;   // GeoJSON の Feature なら位置の既定は geometry
const putColor = (out: Uint8Array, i: number, c: Color): void => { out[i * 4] = c?.[0] ?? 0; out[i * 4 + 1] = c?.[1] ?? 0; out[i * 4 + 2] = c?.[2] ?? 0; out[i * 4 + 3] = c?.[3] ?? 255; };
// 位置の集合の重心（単位球の上）＝原点。空なら [0,0,0]（原点無し）
export function originOf(xyz: ArrayLike<number>, n: number): number[] | null {
	if (!n) return null;
	let x = 0, y = 0, z = 0; for (let i = 0; i < n; i++) { x += xyz[i * 3]; y += xyz[i * 3 + 1]; z += xyz[i * 3 + 2]; }
	const r = Math.hypot(x, y, z); if (r < 1e-9) return [xyz[0], xyz[1], xyz[2]];
	return [x / r, y / r, z / r];
}
const relative = (xyz: ArrayLike<number>, n: number, o: number[]): F32 => { const f = new Float32Array(n * 3); for (let i = 0; i < n * 3; i += 3) { f[i] = xyz[i] - o[0]; f[i + 1] = xyz[i + 1] - o[1]; f[i + 2] = xyz[i + 2] - o[2]; } return f; };

// 点 → { n, pos, rgba?, size?, origin, lngLat（Float64Array n*2・pick の返し用）}
export function bakePoints(data: unknown, { getPosition, getColor, getRadius, getFilterValue }: AddDataProps = {}): BakedPoints {
	const arr = items(data), gp = accessor<unknown>(getPosition, null), gc = getColor !== undefined ? accessor<Color>(getColor) : null, gr = getRadius !== undefined ? accessor<number>(getRadius) : null, gf = getFilterValue !== undefined ? accessor<number>(getFilterValue) : null;
	const xyz = new Float64Array(arr.length * 3), ll = new Float64Array(arr.length * 2), rgba = gc ? new Uint8Array(arr.length * 4) : null, size = gr ? new Float32Array(arr.length) : null, f = gf ? new Float32Array(arr.length) : null;
	let n = 0;
	for (let i = 0; i < arr.length; i++) {
		const d = arr[i], p = posOf(d, i, gp, fcPos); if (!p) continue;
		const u = lonlatTo3D(+p[0], +p[1]); xyz[n * 3] = u[0]; xyz[n * 3 + 1] = u[1]; xyz[n * 3 + 2] = u[2]; ll[n * 2] = +p[0]; ll[n * 2 + 1] = +p[1];
		if (rgba) putColor(rgba, n, gc!(d, i)); if (size) size[n] = +gr!(d, i) || 0; if (f) f[n] = +gf!(d, i) || 0;
		n++;
	}
	const origin = originOf(xyz, n);
	return { n, pos: n ? relative(xyz, n, origin!) : new Float32Array(0), rgba: rgba?.subarray(0, n * 4) ?? null, size: size?.subarray(0, n) ?? null, f: f?.subarray(0, n) ?? null, origin, lngLat: ll.subarray(0, n * 2) };
}
// 弧 → { n, src, dst, theta, rgba?, rgba2?, width?, height?, origin }
export function bakeArcs(data: unknown, { getSourcePosition, getTargetPosition, getSourceColor, getTargetColor, getColor, getWidth, getHeight, getFilterValue }: AddDataProps = {}): BakedArcs {
	const arr = items(data), gs = accessor<unknown>(getSourcePosition, null), gt = accessor<unknown>(getTargetPosition, null);
	const gc0 = getSourceColor !== undefined ? accessor<Color>(getSourceColor) : getColor !== undefined ? accessor<Color>(getColor) : null, gc1 = getTargetColor !== undefined ? accessor<Color>(getTargetColor) : null;
	const gw = getWidth !== undefined ? accessor<number>(getWidth) : null, gh = getHeight !== undefined ? accessor<number>(getHeight) : null, gf = getFilterValue !== undefined ? accessor<number>(getFilterValue) : null;
	const N = arr.length, sx = new Float64Array(N * 3), dx = new Float64Array(N * 3), theta = new Float32Array(N);
	const rgba = gc0 ? new Uint8Array(N * 4) : null, rgba2 = gc1 ? new Uint8Array(N * 4) : null, width = gw ? new Float32Array(N) : null, height = gh ? new Float32Array(N) : null, f = gf ? new Float32Array(N) : null;
	let n = 0;
	for (let i = 0; i < N; i++) {
		const d = arr[i], a = posOf(d, i, gs), b = posOf(d, i, gt); if (!a || !b) continue;
		const A = lonlatTo3D(+a[0], +a[1]), B = lonlatTo3D(+b[0], +b[1]);
		for (let k = 0; k < 3; k++) { sx[n * 3 + k] = A[k]; dx[n * 3 + k] = B[k]; }
		theta[n] = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));   // 開き角は倍精度で（f32 の acos は近い 2 点で崩れる）
		if (rgba) putColor(rgba, n, gc0!(d, i)); if (rgba2) putColor(rgba2, n, gc1!(d, i)); if (width) width[n] = +gw!(d, i) || 0; if (height) height[n] = +gh!(d, i) || 0; if (f) f[n] = +gf!(d, i) || 0;
		n++;
	}
	const all = new Float64Array(n * 6); all.set(sx.subarray(0, n * 3)); all.set(dx.subarray(0, n * 3), n * 3);
	const origin = originOf(all, n * 2);
	return { n, src: n ? relative(sx, n, origin!) : new Float32Array(0), dst: n ? relative(dx, n, origin!) : new Float32Array(0), theta: theta.subarray(0, n), rgba: rgba?.subarray(0, n * 4) ?? null, rgba2: rgba2?.subarray(0, n * 4) ?? null, width: width?.subarray(0, n) ?? null, height: height?.subarray(0, n) ?? null, f: f?.subarray(0, n) ?? null, origin };
}
// 軌跡（deck.gl の TripsLayer・PR-6）→ trips-gl の layer：線分ごとに 4 頂点（両端×両側）・6 索引。頂点＝{ pos（原点相対）, oth（同じ線分のもう一方の端）, side（±1・|2|＝oth が前の点）, time, rgba?, width?, f?, id（軌跡の番号 1〜）}
//   getPath → [[lon, lat, h?], …]（h＝m・楕円体の法線に沿って持ち上げる）、getTimestamps → [t, …]（同じ長さ・単位は自由＝currentTime/trailLength と同じ）
export function bakeTrips(data: unknown, { getPath, getTimestamps, getColor, getWidth, getFilterValue }: AddDataProps = {}): BakedTrips {
	const arr = items(data), gp = accessor<number[][] | null>(getPath, null), gt = accessor<unknown[] | null>(getTimestamps, null), gc = getColor !== undefined ? accessor<Color>(getColor) : null, gw = getWidth !== undefined ? accessor<number>(getWidth) : null, gf = getFilterValue !== undefined ? accessor<number>(getFilterValue) : null;
	const R = worldRadiusM(), trips: Trip[] = [];
	let nseg = 0;
	for (let i = 0; i < arr.length; i++) {
		const d = arr[i], path = gp(d, i) ?? (d?.geometry?.type === "LineString" ? d.geometry.coordinates as number[][] : null), ts = (gt(d, i) ?? d?.properties?.timestamps ?? null) as unknown[] | null;
		if (!path || path.length < 2) continue;
		const xyz = path.map(c => { const p = lonlatTo3D(+c[0], +c[1]); if (c[2]) { const nrm = ellNormal3D(+c[0], +c[1]), k = +c[2] / R; p[0] += nrm[0] * k; p[1] += nrm[1] * k; p[2] += nrm[2] * k; } return p; });
		const t = ts && ts.length === path.length ? ts.map(Number) : path.map((_, k) => k);   // 時刻が無ければ頂点番号
		trips.push({ d, i, xyz, t, lngLat: [+path[0][0], +path[0][1]], color: gc ? gc(d, i) : null, width: gw ? +gw(d, i) || 0 : 0, f: gf ? +gf(d, i) || 0 : 0 });
		nseg += path.length - 1;
	}
	const all = new Float64Array(trips.reduce((s, tr) => s + tr.xyz.length, 0) * 3); let o = 0; for (const tr of trips) for (const p of tr.xyz) { all[o++] = p[0]; all[o++] = p[1]; all[o++] = p[2]; }
	const origin = originOf(all, all.length / 3);
	const nv = nseg * 4, pos = new Float32Array(nv * 3), oth = new Float32Array(nv * 3), side = new Float32Array(nv), time = new Float32Array(nv), id = new Uint32Array(nv), index = new Uint32Array(nseg * 6);
	const rgba = gc ? new Uint8Array(nv * 4) : null, width = gw ? new Float32Array(nv) : null, f = gf ? new Float32Array(nv) : null;
	let v = 0, q = 0, tMin = Infinity, tMax = -Infinity;
	const put = (k: number, p: number[], other: number[], sd: number, tt: number, tr: Trip): void => { pos[k * 3] = p[0] - origin![0]; pos[k * 3 + 1] = p[1] - origin![1]; pos[k * 3 + 2] = p[2] - origin![2]; oth[k * 3] = other[0] - origin![0]; oth[k * 3 + 1] = other[1] - origin![1]; oth[k * 3 + 2] = other[2] - origin![2]; side[k] = sd; time[k] = tt; id[k] = tr.i + 1; if (rgba) putColor(rgba, k, tr.color); if (width) width[k] = tr.width; if (f) f[k] = tr.f; };
	trips.forEach((tr, ti) => { tr.index = ti; for (let k = 0; k + 1 < tr.xyz.length; k++) {
		const A = tr.xyz[k], B = tr.xyz[k + 1], ta = tr.t[k], tb = tr.t[k + 1];
		if (ta < tMin) tMin = ta; if (tb > tMax) tMax = tb;
		put(v, A, B, -1, ta, tr); put(v + 1, A, B, 1, ta, tr); put(v + 2, B, A, -2, tb, tr); put(v + 3, B, A, 2, tb, tr);   // |side| 2＝oth は前の点（接線の向きを反転）
		index[q++] = v; index[q++] = v + 1; index[q++] = v + 2; index[q++] = v + 1; index[q++] = v + 3; index[q++] = v + 2;
		v += 4;
	} });
	return { n: trips.length, nv, ni: index.length, pos, oth, side, time, id, index, rgba, width, f, origin, tMin: trips.length ? tMin : 0, tMax: trips.length ? tMax : 0, trips: trips.map(tr => ({ i: tr.i, lngLat: tr.lngLat, t0: tr.t[0], t1: tr.t[tr.t.length - 1] })) };
}
// マスク（deck.gl の MaskExtension・PR-6）＝多角形を経緯度の bbox に張った R8 の画像に焼く（偶奇の走査線・純 JS＝node の検定が読む）。polygon＝環 [[lon,lat],…]・環の列・GeoJSON Polygon/MultiPolygon/Feature
export function rasterMask(polygon: unknown, { w = 1024, h = 1024, pad = 0.02 }: { w?: number; h?: number; pad?: number } = {}): { bbox: number[]; w: number; h: number; data: Uint8Array<ArrayBuffer> } | null {
	let rings = ((polygon as { type?: string } | null)?.type === "Feature" ? (polygon as { geometry: unknown }).geometry : polygon) as MaskRings;
	if (rings?.type === "Polygon") rings = rings.coordinates as MaskRings; else if (rings?.type === "MultiPolygon") rings = (rings.coordinates as number[][][][]).flat() as MaskRings; else if (rings && typeof (rings[0]?.[0] as unknown) === "number") rings = [rings] as unknown as MaskRings;
	if (!rings?.length) return null;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const r of rings) for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
	const px = (x1 - x0) * pad || 1e-6, py = (y1 - y0) * pad || 1e-6; x0 -= px; x1 += px; y0 -= py; y1 += py;
	const data = new Uint8Array(w * h), sx = w / (x1 - x0), sy = h / (y1 - y0);
	for (let j = 0; j < h; j++) {
		const y = y0 + (j + 0.5) / sy, xs: number[] = [];
		for (const r of rings) for (let k = 0, m = r.length - 1; k < r.length; m = k++) { const a = r[k], b = r[m]; if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) { const i0 = Math.max(0, Math.ceil((xs[k] - x0) * sx - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) * sx - 0.5)); for (let i = i0; i <= i1; i++) data[j * w + i] = 255; }
	}
	return { bbox: [x0, y0, x1, y1], w, h, data };
}
// 面・線・柱 → GeoJSON FeatureCollection（properties に色・幅・高さを文字列／数で持つ＝層の paint は ["get", …]）
type MaskRings = number[][][] & { type?: string; coordinates?: unknown };
type GeomIn = number[][] & { type?: string; coordinates?: unknown };
const css = (c: Color): string | null => c ? `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${((c[3] ?? 255) / 255).toFixed(3)})` : null;
const ringsOf = (poly: unknown): number[][][] | null => (!poly ? null : typeof (poly as unknown[][])[0]?.[0] === "number" ? [poly as number[][]] : poly as number[][][]);   // [[lon,lat],…]（1 環）か [[[lon,lat],…],…]（環の列）
const closed = (ring: number[][]): number[][] => { const r = ring.map(p => [+p[0], +p[1]]); const a = r[0], z = r[r.length - 1]; if (a && (a[0] !== z[0] || a[1] !== z[1])) r.push([a[0], a[1]]); return r; };
export function columnRing(lon: number, lat: number, radiusM: number, k = 20, R = 6378137): number[][] {
	const dLat = radiusM / R * 180 / Math.PI, dLon = dLat / Math.max(1e-6, Math.cos(lat * Math.PI / 180)), ring: number[][] = [];
	for (let i = 0; i <= k; i++) { const a = i / k * 2 * Math.PI; ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
	return ring;
}
export function toGeoJSON(data: unknown, kind: string, { getPolygon, getPath, getPosition, getRadius, getFillColor, getLineColor, getLineWidth, getElevation, getProperties, diskResolution = 20 }: AddDataProps = {}): GeoJSONFeatureCollection {
	const arr = items(data), gf = getFillColor !== undefined ? accessor<Color>(getFillColor) : null, gl = getLineColor !== undefined ? accessor<Color>(getLineColor) : null, gw = getLineWidth !== undefined ? accessor<number>(getLineWidth) : null, ge = getElevation !== undefined ? accessor<number>(getElevation) : null, gpr = getProperties !== undefined ? accessor<Record<string, unknown> | null>(getProperties) : null;
	const gpoly = accessor<GeomIn | null>(getPolygon, null), gpath = accessor<GeomIn | null>(getPath, null), gpos = accessor<unknown>(getPosition, null), grad = accessor<number>(getRadius, 100);
	if (kind !== "polygons" && kind !== "paths" && kind !== "columns") throw new Error(`addData: unknown kind "${kind}"`);
	const features: GeoJSONFeatureCollection["features"] = [];
	for (let i = 0; i < arr.length; i++) {
		const d = arr[i]; let geometry: { type: string; coordinates: unknown } | null = null;
		if (kind === "polygons") { const p = gpoly(d, i) ?? (d?.geometry?.type === "Polygon" || d?.geometry?.type === "MultiPolygon" ? d.geometry as GeomIn : null); if (!p) continue; geometry = p.type ? p as { type: string; coordinates: unknown } : { type: "Polygon", coordinates: ringsOf(p)!.map(closed) }; }
		else if (kind === "paths") { const p = gpath(d, i) ?? (d?.geometry?.type === "LineString" || d?.geometry?.type === "MultiLineString" ? d.geometry as GeomIn : null); if (!p) continue; geometry = p.type ? p as { type: string; coordinates: unknown } : { type: "LineString", coordinates: p.map(q => [+q[0], +q[1]]) }; }
		else if (kind === "columns") { const p = posOf(d, i, gpos, fcPos); if (!p) continue; geometry = { type: "Polygon", coordinates: [columnRing(+p[0], +p[1], +grad(d, i) || 0, diskResolution)] }; }
		const properties: Record<string, unknown> = { ...(gpr ? gpr(d, i) : (d?.properties && !Array.isArray(d) ? d.properties : {})), _i: i };
		if (gf) properties._fill = css(gf(d, i)); if (gl) properties._line = css(gl(d, i)); if (gw) properties._lw = +gw(d, i) || 0; if (ge) properties._h = +ge(d, i) || 0;
		features.push({ type: "Feature", id: i, geometry, properties });
	}
	return { type: "FeatureCollection", features };
}
