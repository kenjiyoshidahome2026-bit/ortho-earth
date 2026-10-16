// 等高線（deck.gl の ContourLayer 相当・差分 PR-5・2026-10-12）。純 JS・DOM 無し＝node の検定 tests/contour.mjs が読む。
// 点 → 格子の場（gridField：セルごとの count/sum/mean…）→ 等値線（isolines＝marching squares・辺の上で線形補間・線分を繋いで折れ線）／等値帯（isobands＝セルの四角を 2 つの閾値で切る＝辺の線形補間と同じ答え）。
// 場の値はセルの中心に置く（格子点＝セル中心・deck.gl と同じ）。GeoJSON（[lon, lat]）で返す＝既存の line／fill の層経路で描く。
import { pointsOf, weightFn, gridRes, D2R } from "./core.ts";
import type { CellWeight, PointSrc } from "./core.ts";
import type { evalExpr as EvalExprFn } from "@ortho-earth/core";

/** 点の場（gridField の戻り）。values・counts＝nx*ny（行＝緯度 j・列＝経度 i） */
export interface ContourField { nx: number; ny: number; lon0: number; lat0: number; dLon: number; dLat: number; values: Float64Array; counts: Float64Array; agg: string }
export interface GridFieldOptions { cellSize?: number | { dLon?: number; dLat?: number }; weight?: CellWeight; evalExpr?: typeof EvalExprFn | null; agg?: string; bbox?: ArrayLike<number> | null; pad?: number }
/** 等値線の 1 本（threshold ごと） */
export interface Isoline { threshold: number; coordinates: number[][][] }
/** 等値帯の 1 つ（[lo, hi] ごと） */
export interface Isoband { lo: number; hi: number; coordinates: number[][][][] }
type Props = Record<string, unknown>;
export type ContourFeature = { type: "Feature"; id: number; properties: Props; geometry: { type: "MultiLineString" | "MultiPolygon"; coordinates: unknown } };

// 点 → 場 { nx, ny, lon0, lat0, dLon, dLat, values: Float64Array(nx*ny)（行＝緯度 j・列＝経度 i）, counts }。cellSize＝m（中心緯度で度へ）か { dLon, dLat }。agg＝count|sum|mean|max|min
export function gridField(points: PointSrc, { cellSize = 1000, weight = null, evalExpr = null, agg = "count", bbox = null, pad = 1 }: GridFieldOptions = {}): ContourField {
	const pts = pointsOf(points).filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat)), w = weightFn(weight, evalExpr);
	if (!pts.length) return { nx: 0, ny: 0, lon0: 0, lat0: 0, dLon: 1, dLat: 1, values: new Float64Array(0), counts: new Float64Array(0), agg };
	let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
	for (const p of pts) { if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon; if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat; }
	if (bbox) [minLon, minLat, maxLon, maxLat] = bbox as number[];
	const g = typeof cellSize === "number" ? gridRes(cellSize, (minLat + maxLat) / 2) : { dLon: cellSize.dLon ?? cellSize.dLat!, dLat: cellSize.dLat ?? cellSize.dLon! };
	const lon0 = Math.floor(minLon / g.dLon) * g.dLon - pad * g.dLon, lat0 = Math.floor(minLat / g.dLat) * g.dLat - pad * g.dLat;
	const nx = Math.max(1, Math.ceil((maxLon - lon0) / g.dLon) + 1 + pad), ny = Math.max(1, Math.ceil((maxLat - lat0) / g.dLat) + 1 + pad);
	if (nx * ny > 4e6) throw new Error(`gridField: too many cells (${nx}×${ny}); use a larger cellSize`);
	const sum = new Float64Array(nx * ny), counts = new Float64Array(nx * ny), mx = new Float64Array(nx * ny).fill(-Infinity), mn = new Float64Array(nx * ny).fill(Infinity);
	for (const p of pts) {
		const i = Math.floor((p.lon - lon0) / g.dLon), j = Math.floor((p.lat - lat0) / g.dLat); if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
		const k = j * nx + i, v = w(p); counts[k]++; sum[k] += v; if (v > mx[k]) mx[k] = v; if (v < mn[k]) mn[k] = v;
	}
	const values = new Float64Array(nx * ny);
	for (let k = 0; k < values.length; k++) values[k] = agg === "sum" ? sum[k] : agg === "mean" ? (counts[k] ? sum[k] / counts[k] : 0) : agg === "max" ? (counts[k] ? mx[k] : 0) : agg === "min" ? (counts[k] ? mn[k] : 0) : counts[k];
	return { nx, ny, lon0, lat0, dLon: g.dLon, dLat: g.dLat, values, counts, agg };
}
// 場の値を格子で滑らかに（任意・3×3 の箱平均を n 回）＝点の集約がざらつく時に
export function smooth(field: ContourField, n = 1): ContourField {
	let v = field.values; const { nx, ny } = field;
	for (let it = 0; it < n; it++) {
		const o = new Float64Array(nx * ny);
		for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let s = 0, c = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue; s += v[jj * nx + ii]; c++; } o[j * nx + i] = s / c; }
		v = o;
	}
	return { ...field, values: v };
}
const cx = (f: ContourField, i: number) => f.lon0 + (i + 0.5) * f.dLon, cy = (f: ContourField, j: number) => f.lat0 + (j + 0.5) * f.dLat;   // 格子点＝セル中心
// 辺の上の交点（a→b で値 va→vb が t を跨ぐ）
const lerp = (pa: number[], pb: number[], va: number, vb: number, t: number) => { const f = vb === va ? 0.5 : (t - va) / (vb - va); return [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f]; };
// 等値線：thresholds の各値 → MultiLineString（線分を端点で繋いで折れ線に）。marching squares（16 通り・鞍点は中心の値で分ける）
export function isolines(field: ContourField, thresholds: Iterable<number>): Isoline[] {
	const { nx, ny, values: V } = field, out: Isoline[] = [];
	for (const t of thresholds) {
		const segs: number[][][] = [];
		for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
			const v00 = V[j * nx + i], v10 = V[j * nx + i + 1], v11 = V[(j + 1) * nx + i + 1], v01 = V[(j + 1) * nx + i];
			const c = (v00 >= t ? 1 : 0) | (v10 >= t ? 2 : 0) | (v11 >= t ? 4 : 0) | (v01 >= t ? 8 : 0);
			if (c === 0 || c === 15) continue;
			const p00 = [cx(field, i), cy(field, j)], p10 = [cx(field, i + 1), cy(field, j)], p11 = [cx(field, i + 1), cy(field, j + 1)], p01 = [cx(field, i), cy(field, j + 1)];
			const B = () => lerp(p00, p10, v00, v10, t), R = () => lerp(p10, p11, v10, v11, t), T = () => lerp(p01, p11, v01, v11, t), L = () => lerp(p00, p01, v00, v01, t);
			switch (c) {
				case 1: case 14: segs.push([L(), B()]); break;
				case 2: case 13: segs.push([B(), R()]); break;
				case 3: case 12: segs.push([L(), R()]); break;
				case 4: case 11: segs.push([R(), T()]); break;
				case 6: case 9: segs.push([B(), T()]); break;
				case 7: case 8: segs.push([L(), T()]); break;
				case 5: case 10: { const mid = (v00 + v10 + v11 + v01) / 4 >= t; if ((c === 5) === mid) { segs.push([L(), T()]); segs.push([B(), R()]); } else { segs.push([L(), B()]); segs.push([R(), T()]); } break; }
			}
		}
		out.push({ threshold: t, coordinates: joinSegments(segs) });
	}
	return out;
}
// 線分 → 折れ線（端点が一致する物を繋ぐ・座標は 1e-9 で丸めて鍵に）
export function joinSegments(segs: number[][][]): number[][][] {
	const key = (p: number[]) => `${Math.round(p[0] * 1e9)},${Math.round(p[1] * 1e9)}`, byEnd = new Map<string, number[]>(), lines: number[][][] = [];
	const used = new Uint8Array(segs.length);
	segs.forEach((s, k) => { for (const e of [0, 1]) { const kk = key(s[e]); (byEnd.get(kk) ?? byEnd.set(kk, []).get(kk)!).push(k); } });
	for (let k = 0; k < segs.length; k++) {
		if (used[k]) continue; used[k] = 1;
		const line = [segs[k][0], segs[k][1]];
		for (const dir of [1, -1]) {   // 前へ・後ろへ伸ばす
			for (;;) {
				const end = dir === 1 ? line[line.length - 1] : line[0], cand = (byEnd.get(key(end)) || []).find(q => !used[q]);
				if (cand == null) break;
				used[cand] = 1; const s = segs[cand], nxt = key(s[0]) === key(end) ? s[1] : s[0];
				if (dir === 1) line.push(nxt); else line.unshift(nxt);
				if (key(nxt) === key(dir === 1 ? line[0] : line[line.length - 1])) break;   // 閉じた
			}
		}
		lines.push(line);
	}
	return lines;
}
// 四角（値付き）を v ≥ t（keepAbove）か v ≤ t で切る（Sutherland–Hodgman・辺の上で線形補間）
function clipPoly(poly: number[][], t: number, keepAbove: boolean): number[][] {
	const out: number[][] = [], n = poly.length, inside = (p: number[]) => keepAbove ? p[2] >= t : p[2] <= t;
	for (let k = 0; k < n; k++) {
		const a = poly[k], b = poly[(k + 1) % n], ia = inside(a), ib = inside(b);
		if (ia) out.push(a);
		if (ia !== ib) { const f = (t - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t]); }
	}
	return out;
}
// 等値帯：bands＝[[lo, hi], …] → MultiPolygon（セルごとの切り出し＝隣のセルとは辺で接する）
export function isobands(field: ContourField, bands: Iterable<ArrayLike<number>>): Isoband[] {
	const { nx, ny, values: V } = field, out: Isoband[] = [];
	for (const [lo, hi] of bands as Iterable<number[]>) {
		const polys: number[][][][] = [];
		for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
			const v00 = V[j * nx + i], v10 = V[j * nx + i + 1], v11 = V[(j + 1) * nx + i + 1], v01 = V[(j + 1) * nx + i];
			const mn = Math.min(v00, v10, v11, v01), mx = Math.max(v00, v10, v11, v01);
			if (mx < lo || mn > hi) continue;
			let poly = [[cx(field, i), cy(field, j), v00], [cx(field, i + 1), cy(field, j), v10], [cx(field, i + 1), cy(field, j + 1), v11], [cx(field, i), cy(field, j + 1), v01]];
			if (mn < lo) poly = clipPoly(poly, lo, true);
			if (mx > hi && poly.length) poly = clipPoly(poly, hi, false);
			if (poly.length >= 3) { const ring = poly.map(p => [p[0], p[1]]); ring.push([ring[0][0], ring[0][1]]); polys.push([ring]); }
		}
		out.push({ lo, hi, coordinates: polys });
	}
	return out;
}
export function contourGeoJSON(field: ContourField, { thresholds = null, bands = null, props = null }: { thresholds?: Iterable<number> | null; bands?: Iterable<ArrayLike<number>> | null; props?: Props | ((item: Isoline | Isoband, k: number) => Props | null | undefined) | null } = {}) {
	const features: ContourFeature[] = [];
	if (thresholds) for (const [k, L] of isolines(field, thresholds).entries()) if (L.coordinates.length) features.push({ type: "Feature", id: features.length, properties: { threshold: L.threshold, index: k, ...(typeof props === "function" ? props(L, k) : props || {}) }, geometry: { type: "MultiLineString", coordinates: L.coordinates } });
	if (bands) for (const [k, B] of isobands(field, bands).entries()) if (B.coordinates.length) features.push({ type: "Feature", id: features.length, properties: { lo: B.lo, hi: B.hi, index: k, ...(typeof props === "function" ? props(B, k) : props || {}) }, geometry: { type: "MultiPolygon", coordinates: B.coordinates } });
	return { type: "FeatureCollection" as const, features };
}
// 等間隔の閾値（場の最大から n 本）
export const autoThresholds = (field: ContourField, n = 5): number[] => { let mx = 0; for (const v of field.values) if (v > mx) mx = v; const out: number[] = []; for (let k = 1; k <= n; k++) out.push(mx * k / (n + 1)); return out; };
export { D2R };
