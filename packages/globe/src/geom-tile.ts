// 3D Tiles の Geometry タイル（.geom・Cesium の Geometry3DTileContent・実験的な vctr 形式）＝分類用の閉じた立体（箱・円柱・楕円体・球）。
// 中身＝28 バイトの頭（magic "geom"・version 1・byteLength・特徴表 JSON／binary・batch table JSON／binary）
//   特徴表：BOXES_LENGTH＋BOXES（1 個 19 float＝寸法 xyz＋行列 16）・CYLINDERS（18＝半径・長さ＋行列）・ELLIPSOIDS（19＝半径 xyz＋行列）・SPHERES（4＝半径＋中心 xyz）、
//   *_BATCH_IDS（無ければ 箱→円柱→楕円体→球 の順に 0 から）・RTC_CENTER（精度のためだけ＝置き場所は行列が決める）。
// 単位の形は Cesium と同じ（箱＝±0.5・円柱＝半径 1・長さ 1（z ±0.5）・楕円体／球＝半径 1）。位置＝タイルの変換 × 立体の行列 × 単位の形。
// 出力＝地物ごとの閉じた三角形（外向きに反時計回り・ECEF を center からの差で）＝分類の柱（core の set("classify")）と同じ使い方。
import { batchTableOf, type PropertyTable } from "./mesh-features.ts";

export interface GeomPart {
	/** 地物の番号（batch id） */ id: number; /** ECEF（m）−center の頂点 */ pos: Float32Array; idx: Uint32Array;
	/** 内外の判定：shape（0 箱・1 円柱・2 楕円体／球・-1＝判定しない＝vctr の多角形の柱）と ECEF → 単位の形の座標（列優先 4x4・逆行列）＝点群の分類（点ごとに内側か） */ shape: number; inv: Float64Array;
}
export interface GeomOut { center: number[]; parts: GeomPart[]; table: PropertyTable | null }

type BinRef = { byteOffset: number };
interface GeomFeatureTable { BOXES_LENGTH?: number; CYLINDERS_LENGTH?: number; ELLIPSOIDS_LENGTH?: number; SPHERES_LENGTH?: number; BOXES?: BinRef; CYLINDERS?: BinRef; ELLIPSOIDS?: BinRef; SPHERES?: BinRef;
	BOX_BATCH_IDS?: BinRef; CYLINDER_BATCH_IDS?: BinRef; ELLIPSOID_BATCH_IDS?: BinRef; SPHERE_BATCH_IDS?: BinRef; RTC_CENTER?: number[] }
const td = new TextDecoder();
const jsonAt = (ab: ArrayBuffer, off: number, len: number): Record<string, unknown> | null => len ? JSON.parse(td.decode(new Uint8Array(ab, off, len)).replace(/[\0\s]+$/, "")) : null;

// 単位の形（頂点・三角形）＝凸なので、向きは三角形ごとに「重心から外へ」で揃える
interface Unit { pos: Float64Array; idx: Uint32Array }
function outward(pos: number[], tri: number[]): Unit {
	for (let i = 0; i < tri.length; i += 3) {
		const a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3;
		const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const mx = pos[a] + pos[b] + pos[c], my = pos[a + 1] + pos[b + 1] + pos[c + 1], mz = pos[a + 2] + pos[b + 2] + pos[c + 2];
		if (nx * mx + ny * my + nz * mz < 0) { const t = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = t; }
	}
	return { pos: Float64Array.from(pos), idx: Uint32Array.from(tri) };
}
let units: { box: Unit; cyl: Unit; ell: Unit } | null = null;
function unitShapes() {
	if (units) return units;
	const bp: number[] = []; for (let i = 0; i < 8; i++) bp.push(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5);
	const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]], bt: number[] = [];
	for (const [a, b, c, d] of quads) bt.push(a, b, c, a, c, d);
	const S = 32, cp: number[] = [0, 0, -0.5, 0, 0, 0.5], ct: number[] = [];
	for (let i = 0; i < S; i++) { const t = i / S * 2 * Math.PI; cp.push(Math.cos(t), Math.sin(t), -0.5, Math.cos(t), Math.sin(t), 0.5); }
	for (let i = 0; i < S; i++) { const j = (i + 1) % S, b0 = 2 + i * 2, b1 = 2 + j * 2; ct.push(0, b1, b0, 1, b0 + 1, b1 + 1, b0, b1, b1 + 1, b0, b1 + 1, b0 + 1); }
	const NS = 16, NW = 32, ep: number[] = [], et: number[] = [];
	for (let r = 0; r <= NS; r++) { const p = r / NS * Math.PI, sp = Math.sin(p), cz = Math.cos(p); for (let c = 0; c < NW; c++) { const l = c / NW * 2 * Math.PI; ep.push(sp * Math.cos(l), sp * Math.sin(l), cz); } }
	for (let r = 0; r < NS; r++) for (let c = 0; c < NW; c++) {
		const a = r * NW + c, b = r * NW + (c + 1) % NW, d = a + NW, e = b + NW;
		if (r > 0) et.push(a, b, e);   // 極の縮んだ三角形は抜く（面積 0）
		if (r < NS - 1) et.push(a, e, d);
	}
	return units = { box: outward(bp, bt), cyl: outward(cp, ct), ell: outward(ep, et) };
}

// 列優先 4x4 の積と点
const mul4 = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
// アフィンの 4x4（最後の行 0 0 0 1）の逆＝3x3 の逆と平行移動
function inv4(m: ArrayLike<number>): Float64Array | null {
	const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
	const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
	if (!(Math.abs(det) > 1e-30)) return null;
	const r = [A, -(b * k - c * h), b * f - c * e, B, a * k - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);   // 行優先の逆
	const o = new Float64Array(16);
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[j * 4 + i] = r[i * 3 + j];
	for (let i = 0; i < 3; i++) o[12 + i] = -(r[i * 3] * m[12] + r[i * 3 + 1] * m[13] + r[i * 3 + 2] * m[14]);
	o[15] = 1;
	return o;
}
/** 単位の形の座標（x,y,z）が内側か（shape＝GeomPart.shape） */
export const insideUnit = (shape: number, x: number, y: number, z: number): boolean => shape === 0 ? Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5 && Math.abs(z) <= 0.5
	: shape === 1 ? x * x + y * y <= 1 && Math.abs(z) <= 0.5 : x * x + y * y + z * z <= 1;
const det3 = (m: ArrayLike<number>) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/** .geom の中身 → 地物ごとの閉じた立体（null＝何も無い）。transform＝タイルの変換（列優先 4x4・ECEF へ） */
export function decodeGeom(ab: ArrayBuffer, transform: ArrayLike<number> | null | undefined): GeomOut | null {
	const dv = new DataView(ab);
	if (dv.getUint32(4, true) !== 1) throw new Error(`geom: version ${dv.getUint32(4, true)} (only 1)`);
	const ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
	const J = (jsonAt(ab, 28, ftJ) || {}) as GeomFeatureTable, binOff = 28 + ftJ;
	const nBox = (J.BOXES_LENGTH ?? 0) | 0, nCyl = (J.CYLINDERS_LENGTH ?? 0) | 0, nEll = (J.ELLIPSOIDS_LENGTH ?? 0) | 0, nSph = (J.SPHERES_LENGTH ?? 0) | 0, total = nBox + nCyl + nEll + nSph;
	if (!total) return null;
	const at = (key: keyof GeomFeatureTable, bytes: number) => { const r = J[key] as { byteOffset?: number } | undefined, o = binOff + (r?.byteOffset ?? 0); return r?.byteOffset != null ? ab.slice(o, o + bytes) : null; };
	const f32 = (key: keyof GeomFeatureTable, n: number) => { const b = at(key, n * 4); return b ? new Float32Array(b) : null; };
	const ids = (key: keyof GeomFeatureTable, n: number) => { const b = at(key, n * 2); return b ? new Uint16Array(b) : null; };
	let next = 0;
	const seq = (n: number) => Uint16Array.from({ length: n }, () => next++);
	const given = [ids("BOX_BATCH_IDS", nBox), ids("CYLINDER_BATCH_IDS", nCyl), ids("ELLIPSOID_BATCH_IDS", nEll), ids("SPHERE_BATCH_IDS", nSph)];
	const [bId, cId, eId, sId] = given.some(Boolean) ? given.map((g, k) => g ?? new Uint16Array([nBox, nCyl, nEll, nSph][k])) : [seq(nBox), seq(nCyl), seq(nEll), seq(nSph)];
	const T = transform && transform.length === 16 ? transform : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	const rtc = J.RTC_CENTER, rc = rtc ? [T[0] * rtc[0] + T[4] * rtc[1] + T[8] * rtc[2] + T[12], T[1] * rtc[0] + T[5] * rtc[1] + T[9] * rtc[2] + T[13], T[2] * rtc[0] + T[6] * rtc[1] + T[10] * rtc[2] + T[14]] : null;
	const center = rc ?? [T[12], T[13], T[14]];
	const U = unitShapes(), parts: GeomPart[] = [];
	const put = (u: Unit, P: Float64Array, id: number, shape: number) => {
		const M = mul4(T, P), n = u.pos.length / 3, pos = new Float32Array(n * 3), flip = det3(M) < 0, inv = inv4(M);
		if (!inv) return;   // 潰れた立体（寸法 0）
		for (let i = 0; i < n; i++) {
			const x = u.pos[i * 3], y = u.pos[i * 3 + 1], z = u.pos[i * 3 + 2];
			pos[i * 3] = M[0] * x + M[4] * y + M[8] * z + M[12] - center[0];
			pos[i * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13] - center[1];
			pos[i * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14] - center[2];
		}
		const idx = u.idx.slice(); if (flip) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
		parts.push({ id, pos, idx, shape, inv });
	};
	const scaled = (m: ArrayLike<number>, sx: number, sy: number, sz: number) => { const o = Float64Array.from(m); for (let r = 0; r < 4; r++) { o[r] *= sx; o[4 + r] *= sy; o[8 + r] *= sz; } return o; };
	const B = f32("BOXES", nBox * 19), C = f32("CYLINDERS", nCyl * 18), E = f32("ELLIPSOIDS", nEll * 19), Sp = f32("SPHERES", nSph * 4);
	for (let i = 0; B && i < nBox; i++) { const o = i * 19; put(U.box, scaled(B.subarray(o + 3, o + 19), B[o], B[o + 1], B[o + 2]), bId[i], 0); }
	for (let i = 0; C && i < nCyl; i++) { const o = i * 18; put(U.cyl, scaled(C.subarray(o + 2, o + 18), C[o], C[o], C[o + 1]), cId[i], 1); }
	for (let i = 0; E && i < nEll; i++) { const o = i * 19; put(U.ell, scaled(E.subarray(o + 3, o + 19), E[o], E[o + 1], E[o + 2]), eId[i], 2); }
	for (let i = 0; Sp && i < nSph; i++) { const o = i * 4, r = Sp[o]; put(U.ell, Float64Array.of(r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, Sp[o + 1], Sp[o + 2], Sp[o + 3], 1), sId[i], 2); }
	const BT = jsonAt(ab, 28 + ftJ + ftB, btJ);
	const table = BT ? batchTableOf(BT, btB ? new Uint8Array(ab, 28 + ftJ + ftB + btJ, btB) : null, total) : null;
	return { center, parts, table };
}
