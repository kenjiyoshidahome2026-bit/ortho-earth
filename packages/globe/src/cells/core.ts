// セルの算法（deck.gl の GridLayer／GeohashLayer／QuadkeyLayer／S2Layer 相当・差分 PR-5・2026-10-12）。純 JS・依存ゼロ・DOM 無し＝node の検定 tests/cells.mjs が読む。
// 共通の形：kind ごとに { encode(lon, lat, res) → id, ring(id) → [[lon, lat], …]（閉じた環）, res(id) → 解像度 } を持ち、
//   binPoints(points, kind, res, weight) → Map(id → { id, kind, res, count, sum, mean, min, max })、cellsToGeoJSON(cells, kind, props) → FeatureCollection。描くのは既存の層経路（cells/layer.js）。
// kind：
//   grid    経緯度の格子。res＝{ dLon, dLat（度）, lon0=-180, lat0=-90 } か セル幅 m（中心緯度で度に直す＝gridRes(m, lat)）。id＝"ix:iy"
//   mesh    日本の地域メッシュ（JIS X 0410）1 次（4 桁・40'×1°）・2 次（6 桁・5'×7.5'）・3 次（8 桁・30"×45"）。res＝1|2|3。id＝メッシュコード
//   geohash base32 の geohash（res＝文字数 1〜12）
//   quadkey Bing の quadkey（メルカトルのタイル・res＝z 1〜23）
//   s2      S2 のセル（res＝level 0〜30）。id＝token（16 進・末尾の 0 を落とす）。id の算法は S2 geometry の FromFaceIJ／ToFaceIJOrientation と同じ（Hilbert 曲線の表を BigInt で）
import type { evalExpr as EvalExprFn } from "@ortho-earth/core";
export const D2R = Math.PI / 180, R2D = 180 / Math.PI, EARTH_R = 6378137;

type Props = Record<string, unknown>;
/** 閉じた環（[lon, lat] の列） */
export type CellRing = number[][];
/** 点の列の 1 つ（pointsOf の戻り） */
export interface CellPoint { lon: number; lat: number; props: Props }
/** pointsOf が受ける形の 1 つ＝[lon, lat]・{ lon, lat }・GeoJSON の Feature */
export type PointLike = number[] | { lon?: number; lat?: number; props?: Props; properties?: Props; geometry?: { type: string; coordinates: unknown } | null; [k: string]: unknown } | null | undefined;
/** pointsOf が受ける形＝配列・FeatureCollection・Feature */
export type PointSrc = PointLike[] | { type?: string; features?: PointLike[]; [k: string]: unknown } | null | undefined;
/** 重み＝定数・属性名・式・関数 */
export type CellWeight = number | string | unknown[] | ((props: Props, p: CellPoint) => unknown) | null | undefined;
/** grid の解像度＝度の幅（と原点）か セル幅 m */
export interface GridSpec { dLon: number; dLat: number; lon0: number; lat0: number }
export type CellRes = number | Partial<GridSpec>;
/** kind ごとの算法の共通の形 */
export interface CellKind { encode(lon: number, lat: number, res?: CellRes): string | null; ring(id: string, res?: CellRes): CellRing; res(id: string, res?: CellRes): CellRes | undefined; needsRes?: boolean }
/** binPoints の 1 セル */
export interface CellAgg { id: string; kind: string; res: CellRes | undefined; count: number; sum: number; mean: number; min: number; max: number }
/** S2 のセルの (face, i0, j0, size) */
export interface S2Cell { id: bigint; level: number; face: number; i0: number; j0: number; size: number }

// ── 点の列・重み（h3/core.js と同じ流儀＝@ortho-earth/h3 を読まずに済むよう小さく写す）
export function pointsOf(src: PointSrc): CellPoint[] {
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.features || [];
	const out: CellPoint[] = [];
	for (const f of feats as PointLike[]) {
		if (Array.isArray(f)) { out.push({ lon: +f[0], lat: +f[1], props: {} }); continue; }   // [lon, lat]
		if (f && typeof f.lon === "number" && typeof f.lat === "number") { out.push({ lon: f.lon, lat: f.lat, props: f.props || f.properties || f }); continue; }
		const g = f?.geometry; if (!g) continue;
		if (g.type === "Point") out.push({ lon: (g.coordinates as number[])[0], lat: (g.coordinates as number[])[1], props: f.properties || {} });
		else if (g.type === "MultiPoint") for (const c of g.coordinates as number[][]) out.push({ lon: c[0], lat: c[1], props: f.properties || {} });
	}
	return out;
}
export function weightFn(weight: CellWeight, evalExpr?: typeof EvalExprFn | null): (p: CellPoint) => number {
	if (weight == null) return () => 1;
	if (typeof weight === "number") return () => weight;
	if (typeof weight === "function") return p => +(weight(p.props, p) as number) || 0;
	if (Array.isArray(weight) && evalExpr) return p => { const v = evalExpr<number>(weight, { zoom: 0, props: p.props || {}, geom: "Point", vars: {}, origin: "ml" }); return Number.isFinite(+v) ? +v : 0; };
	if (typeof weight === "string") return p => { const v = +(p.props?.[weight] as number); return Number.isFinite(v) ? v : 0; };
	return () => 1;
}

// ── grid（経緯度の格子）
export const gridRes = (cellM: number, lat = 0): GridSpec => { const dLat = cellM / (EARTH_R * D2R); return { dLon: dLat / Math.max(0.05, Math.cos(lat * D2R)), dLat, lon0: -180, lat0: -90 }; };
const gridSpec = (r: CellRes): GridSpec => typeof r === "number" ? gridRes(r, 0) : { dLon: r.dLon ?? r.dLat ?? 1, dLat: r.dLat ?? r.dLon ?? 1, lon0: r.lon0 ?? -180, lat0: r.lat0 ?? -90 };
export const grid = {
	encode(lon: number, lat: number, r: CellRes) { const g = gridSpec(r); return `${Math.floor((lon - g.lon0) / g.dLon)}:${Math.floor((lat - g.lat0) / g.dLat)}`; },
	ring(id: string, r: CellRes) { const g = gridSpec(r), [ix, iy] = id.split(":").map(Number), x0 = g.lon0 + ix * g.dLon, y0 = g.lat0 + iy * g.dLat, x1 = x0 + g.dLon, y1 = Math.min(90, y0 + g.dLat); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]; },
	res: (_id: string, r: CellRes) => r,
	needsRes: true,
};

// ── mesh（日本の地域メッシュ・JIS X 0410）。1 次＝緯度 40'（lat×1.5 の整数）＋経度の整数−100、2 次＝8 分割、3 次＝10 分割
export const mesh = {
	encode(lon: number, lat: number, level = 3) {
		const p = Math.floor(lat * 1.5), u = Math.floor(lon) - 100;
		if (p < 0 || p > 99 || u < 0 || u > 99) return null;
		let code = String(p).padStart(2, "0") + String(u).padStart(2, "0");
		if (level >= 2) { const q = Math.floor((lat * 1.5 - p) * 8), v = Math.floor((lon - Math.floor(lon)) * 8); code += q + "" + v; if (level >= 3) { const r = Math.floor(((lat * 1.5 - p) * 8 - q) * 10), w = Math.floor(((lon - Math.floor(lon)) * 8 - v) * 10); code += r + "" + w; } }
		return code;
	},
	ring(code: string) {
		const p = +code.slice(0, 2), u = +code.slice(2, 4); let lat0 = p / 1.5, lon0 = u + 100, dLat = 1 / 1.5, dLon = 1;
		if (code.length >= 6) { lat0 += +code[4] * dLat / 8; lon0 += +code[5] * dLon / 8; dLat /= 8; dLon /= 8; }
		if (code.length >= 8) { lat0 += +code[6] * dLat / 10; lon0 += +code[7] * dLon / 10; dLat /= 10; dLon /= 10; }
		return [[lon0, lat0], [lon0 + dLon, lat0], [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat], [lon0, lat0]];
	},
	res: (code: string) => code.length === 4 ? 1 : code.length === 6 ? 2 : 3,
};

// ── geohash
const GH = "0123456789bcdefghjkmnpqrstuvwxyz";
export const geohash = {
	encode(lon: number, lat: number, prec = 7) {
		let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180, out = "", bit = 0, ch = 0, even = true;
		while (out.length < prec) {
			if (even) { const mid = (minLon + maxLon) / 2; if (lon >= mid) { ch |= 1 << (4 - bit); minLon = mid; } else maxLon = mid; }
			else { const mid = (minLat + maxLat) / 2; if (lat >= mid) { ch |= 1 << (4 - bit); minLat = mid; } else maxLat = mid; }
			even = !even;
			if (++bit === 5) { out += GH[ch]; bit = 0; ch = 0; }
		}
		return out;
	},
	bbox(hash: string): number[] {
		let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180, even = true;
		for (const c of hash.toLowerCase()) {
			const v = GH.indexOf(c); if (v < 0) throw new Error(`geohash: bad char "${c}"`);
			for (let b = 4; b >= 0; b--) {
				const on = (v >> b) & 1;
				if (even) { const mid = (minLon + maxLon) / 2; if (on) minLon = mid; else maxLon = mid; } else { const mid = (minLat + maxLat) / 2; if (on) minLat = mid; else maxLat = mid; }
				even = !even;
			}
		}
		return [minLon, minLat, maxLon, maxLat];
	},
	ring(hash: string): CellRing { const [x0, y0, x1, y1] = geohash.bbox(hash); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]; },
	res: (hash: string) => hash.length,
};

// ── quadkey（Bing・メルカトルのタイル）
const mercY = (lat: number) => { const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const unMercY = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * R2D;
export const quadkey = {
	encode(lon: number, lat: number, z = 10) {
		const n = 1 << z, x = Math.min(n - 1, Math.floor(((lon + 180) / 360 + 1) % 1 * n)), y = Math.min(n - 1, Math.floor(mercY(lat) * n));
		let k = ""; for (let i = z - 1; i >= 0; i--) k += ((x >> i) & 1) | (((y >> i) & 1) << 1);
		return k;
	},
	tile(key: string): { x: number; y: number; z: number } { let x = 0, y = 0; for (const c of key) { const d = +c; x = x * 2 + (d & 1); y = y * 2 + (d >> 1); } return { x, y, z: key.length }; },
	bbox(key: string): number[] { const { x, y, z } = quadkey.tile(key), n = 1 << z; return [x / n * 360 - 180, unMercY((y + 1) / n), (x + 1) / n * 360 - 180, unMercY(y / n)]; },
	ring(key: string): CellRing { const [x0, y0, x1, y1] = quadkey.bbox(key); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]; },
	res: (key: string) => key.length,
};

// ── S2（S2 geometry のセル id・token）。xyz は S2 の並び（z が北極）。四分木の Hilbert 曲線の表は S2 の init_lookup_cell と同じ
const S2_MAX = 30, S2_LOOKUP_BITS = 4, S2_SWAP = 1, S2_INVERT = 2;
const kPosToOrientation = [S2_SWAP, 0, 0, S2_SWAP | S2_INVERT];
const kPosToIJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const lookupPos = new Uint16Array(1 << (2 * S2_LOOKUP_BITS + 2)), lookupIj = new Uint16Array(1 << (2 * S2_LOOKUP_BITS + 2));
function initLookup(level: number, i: number, j: number, origOrientation: number, pos: number, orientation: number): void {
	if (level === S2_LOOKUP_BITS) { const ij = (i << S2_LOOKUP_BITS) + j; lookupPos[(ij << 2) + origOrientation] = (pos << 2) + orientation; lookupIj[(pos << 2) + origOrientation] = (ij << 2) + orientation; return; }
	level++; i <<= 1; j <<= 1; pos <<= 2;
	const r = kPosToIJ[orientation];
	for (let k = 0; k < 4; k++) initLookup(level, i + (r[k] >> 1), j + (r[k] & 1), origOrientation, pos + k, orientation ^ kPosToOrientation[k]);
}
for (const o of [0, S2_SWAP, S2_INVERT, S2_SWAP | S2_INVERT]) initLookup(0, 0, 0, o, 0, o);
const stToUV = (s: number) => s >= 0.5 ? (1 / 3) * (4 * s * s - 1) : (1 / 3) * (1 - 4 * (1 - s) * (1 - s));
const uvToST = (u: number) => u >= 0 ? 0.5 * Math.sqrt(1 + 3 * u) : 1 - 0.5 * Math.sqrt(1 - 3 * u);
const faceUVtoXYZ = (f: number, u: number, v: number) => [[1, u, v], [-u, 1, v], [-u, -v, 1], [-1, -v, -u], [v, -1, -u], [v, u, -1]][f];
function xyzToFaceUV(p: number[]) {
	const a = [Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])], ax = a[0] > a[1] ? (a[0] > a[2] ? 0 : 2) : (a[1] > a[2] ? 1 : 2), f = p[ax] < 0 ? ax + 3 : ax;
	const [x, y, z] = p;
	const uv = [[y / x, z / x], [-x / y, z / y], [-x / z, -y / z], [z / x, y / x], [z / y, -x / y], [-y / z, -x / z]][f];
	return { face: f, u: uv[0], v: uv[1] };
}
const llToXYZ = (lon: number, lat: number) => { const a = lon * D2R, b = lat * D2R, c = Math.cos(b); return [c * Math.cos(a), c * Math.sin(a), Math.sin(b)]; };
const xyzToLL = (p: number[]) => [Math.atan2(p[1], p[0]) * R2D, Math.atan2(p[2], Math.hypot(p[0], p[1])) * R2D];
const stToIJ = (s: number) => Math.max(0, Math.min((1 << S2_MAX) - 1, Math.floor(s * (1 << S2_MAX))));
function s2FromFaceIJ(face: number, i: number, j: number, level = S2_MAX): bigint {
	let n = BigInt(face) << 60n, bits = face & S2_SWAP;
	for (let k = 7; k >= 0; k--) {
		const mask = (1 << S2_LOOKUP_BITS) - 1;
		bits += ((i >> (k * S2_LOOKUP_BITS)) & mask) << (S2_LOOKUP_BITS + 2);
		bits += ((j >> (k * S2_LOOKUP_BITS)) & mask) << 2;
		bits = lookupPos[bits];
		n |= BigInt(bits >> 2) << BigInt(k * 2 * S2_LOOKUP_BITS);
		bits &= S2_SWAP | S2_INVERT;
	}
	let id = n * 2n + 1n;   // 葉（level 30）
	if (level < S2_MAX) { const lsb = 1n << BigInt(2 * (S2_MAX - level)); id = (id & ~(lsb - 1n)) | lsb; }
	return id;
}
function s2ToFaceIJ(id: bigint) {
	const face = Number(id >> 61n); let bits = face & S2_SWAP, i = 0, j = 0;
	for (let k = 7; k >= 0; k--) {
		const nbits = k === 7 ? S2_MAX - 7 * S2_LOOKUP_BITS : S2_LOOKUP_BITS;
		bits += Number((id >> BigInt(k * 2 * S2_LOOKUP_BITS + 1)) & BigInt((1 << (2 * nbits)) - 1)) << 2;
		bits = lookupIj[bits];
		i += (bits >> (S2_LOOKUP_BITS + 2)) << (k * S2_LOOKUP_BITS);
		j += ((bits >> 2) & ((1 << S2_LOOKUP_BITS) - 1)) << (k * S2_LOOKUP_BITS);
		bits &= S2_SWAP | S2_INVERT;
	}
	return { face, i, j };
}
const s2Level = (id: bigint) => { let n = 0; while (((id >> BigInt(n)) & 1n) === 0n) n++; return S2_MAX - n / 2; };
const s2Token = (id: bigint) => { if (id === 0n) return "X"; let s = id.toString(16).padStart(16, "0"); while (s.endsWith("0")) s = s.slice(0, -1); return s; };
const s2FromToken = (t: string) => t === "X" || t === "x" ? 0n : BigInt("0x" + t.padEnd(16, "0"));
export const s2 = {
	encode(lon: number, lat: number, level = 10) { const { face, u, v } = xyzToFaceUV(llToXYZ(lon, lat)); return s2Token(s2FromFaceIJ(face, stToIJ(uvToST(u)), stToIJ(uvToST(v)), level)); },
	// セルの (face, i0, j0, size)＝ij の範囲。中心の ij は id の末尾の 1 ビットの位置から
	cell(token: string | bigint): S2Cell { const id = typeof token === "bigint" ? token : s2FromToken(token), level = s2Level(id), { face, i, j } = s2ToFaceIJ(id), size = 1 << (S2_MAX - level); return { id, level, face, i0: i & -size, j0: j & -size, size }; },
	// 境界（GeoJSON の [lon, lat]・閉じた環）。辺は S2 では大円＝大きなセル（level ≤ 5）は辺を k 分割して追う。±180° を跨ぐ環は負の経度に 360 を足す（h3/core と同じ）
	ring(token: string | bigint, k?: number): CellRing {
		const c = s2.cell(token), n = k ?? (c.level <= 2 ? 8 : c.level <= 5 ? 4 : 1), ring: CellRing = [];
		const corners = [[c.i0, c.j0], [c.i0 + c.size, c.j0], [c.i0 + c.size, c.j0 + c.size], [c.i0, c.j0 + c.size]];
		for (let e = 0; e < 4; e++) { const a = corners[e], b = corners[(e + 1) % 4]; for (let t = 0; t < n; t++) { const f = t / n, ii = a[0] + (b[0] - a[0]) * f, jj = a[1] + (b[1] - a[1]) * f; ring.push(xyzToLL(faceUVtoXYZ(c.face, stToUV(ii / (1 << S2_MAX)), stToUV(jj / (1 << S2_MAX))))); } }
		ring.push([ring[0][0], ring[0][1]]);
		let lo = Infinity, hi = -Infinity; for (const p of ring) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0]; }
		if (hi - lo > 180) for (const p of ring) if (p[0] < 0) p[0] += 360;
		const polar = c.face === 2 || c.face === 5;
		if (polar && c.level === 0) { const lat = c.face === 2 ? 90 : -90; return [[-180, lat], [180, lat], [180, c.face === 2 ? 35.26 : -35.26], [-180, c.face === 2 ? 35.26 : -35.26], [-180, lat]]; }   // 極の面 level 0＝経度全周の帽子（近似）
		return ring;
	},
	center(token: string | bigint): number[] { const c = s2.cell(token); return xyzToLL(faceUVtoXYZ(c.face, stToUV((c.i0 + c.size / 2) / (1 << S2_MAX)), stToUV((c.j0 + c.size / 2) / (1 << S2_MAX)))); },
	parent(token: string | bigint, level: number): string { const c = s2.cell(token); if (level >= c.level) return s2Token(c.id); const lsb = 1n << BigInt(2 * (S2_MAX - level)); return s2Token((c.id & ~(lsb - 1n)) | lsb); },
	res: (token: string) => s2Level(s2FromToken(token)),
	level: s2Level, token: s2Token, fromToken: s2FromToken,
};

export const KINDS = { grid, mesh, geohash, quadkey, s2 };
// 点をセルへ：Map(id → { id, kind, res, count, sum, mean, min, max })
export function binPoints(points: PointSrc, kind: string, res: CellRes, { weight = null, evalExpr = null }: { weight?: CellWeight; evalExpr?: typeof EvalExprFn | null } = {}): Map<string, CellAgg> {
	const K = (KINDS as Record<string, CellKind>)[kind]; if (!K) throw new Error(`cells: unknown kind "${kind}"`);
	const pts = pointsOf(points), w = weightFn(weight, evalExpr), out = new Map<string, CellAgg>();
	for (const p of pts) {
		if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
		const id = K.encode(p.lon, p.lat, res); if (id == null) continue;
		const v = w(p); let a = out.get(id);
		if (!a) out.set(id, a = { id, kind, res: typeof res === "object" ? undefined : res, count: 0, sum: 0, mean: 0, min: Infinity, max: -Infinity });
		a.count++; a.sum += v; if (v < a.min) a.min = v; if (v > a.max) a.max = v;
	}
	for (const a of out.values()) a.mean = a.count ? a.sum / a.count : 0;
	return out;
}
// cells＝id の配列・Map(id → props)・{ id: props }。res＝grid の時だけ要る（セルの幅）。props＝(id, i, p) → 属性 か 固定
export function cellsToGeoJSON(cells: Map<string, unknown> | (string | { id: string })[] | Record<string, unknown> | null | undefined, kind: string, res?: CellRes, props: Props | ((id: string, i: number, p: unknown) => Props | null | undefined) | null = null) {
	const K = (KINDS as Record<string, CellKind>)[kind]; if (!K) throw new Error(`cells: unknown kind "${kind}"`);
	const entries: [string, unknown][] = cells instanceof Map ? [...cells.entries()] : Array.isArray(cells) ? cells.map(c => [typeof c === "string" ? c : c.id, typeof c === "string" ? null : c]) : Object.entries(cells || {});
	const features: { type: "Feature"; id: number; properties: Props; geometry: { type: "Polygon"; coordinates: CellRing[] } }[] = [];
	entries.forEach(([id, p], i) => {
		let ring: CellRing; try { ring = K.ring(id, res); } catch { return; }
		const extra = typeof props === "function" ? props(id, i, p) : props;
		features.push({ type: "Feature", id: i, properties: { cell: id, kind, res: K.res(id, res), ...(p && typeof p === "object" ? p : {}), ...(extra || {}) }, geometry: { type: "Polygon", coordinates: [ring] } });
	});
	return { type: "FeatureCollection" as const, features };
}
// 表示のズーム → 解像度（セルが約 edgePx になる）。kind ごとの 1 セルの幅の目安（m）から
export function resForZoom(kind: string, zoom: number, { edgePx = 40, lat = 35 }: { edgePx?: number; lat?: number } = {}): number | GridSpec {
	const mPerPx = 156543.03 * Math.cos(lat * D2R) / Math.pow(2, zoom), want = edgePx * mPerPx;
	if (kind === "s2") { for (let l = 0; l <= 30; l++) if (EARTH_R * Math.PI / 2 / Math.pow(2, l) <= want) return Math.max(0, l); return 30; }
	if (kind === "quadkey") { for (let z = 1; z <= 23; z++) if (40075016 / Math.pow(2, z) <= want) return z; return 23; }
	if (kind === "geohash") { const W = [5000e3, 1250e3, 156e3, 39.1e3, 4.89e3, 1.22e3, 153, 38.2, 4.77, 1.19, 0.149, 0.0372]; for (let i = 0; i < W.length; i++) if (W[i] <= want) return i + 1; return 12; }
	if (kind === "mesh") return want > 20e3 ? 1 : want > 2e3 ? 2 : 3;
	return gridRes(Math.max(1, want), lat);   // grid＝m を度に
}
