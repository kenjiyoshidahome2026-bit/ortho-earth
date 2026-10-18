// Gaussian splat の読み手と、描く前の下ごしらえ（純関数・main で動く・node で検定できる）。@ortho-earth/plugin-splat。
//   読み手（.ply／.splat／.spz）は file の局所座標の SplatData（crs "local"・単位 m・軸は file の約束＝axes）を返す。
//   下ごしらえ（toEnu）は SplatData（lnglat／ecef／local）を「錨（経度・緯度・高さ）＋東北上 m の中心＋東北上の共分散（6 個）＋RGBA」にする＝worker はこれだけ描く。
// 四元数は x,y,z,w（契約＝globe の SplatData）。scales は楕円の各軸の σ（m・線形）。colors の A は不透明度。
// sh＝DC より上の球面調和の係数（n × K×3・係数が先・色が後＝sh[i*K*3 + k*3 + c]・K＝3／8／15＝次数 1／2／3・.spz と同じ並び。.ply の f_rest_* は色が先なので読む時に並べ替える）。
//   WebGPU の描き手が視線の向きで色を変える（splat-gpu.ts）。WebGL2 の描き手は DC だけ。packSh が 8 bit に詰める（.spz と同じ目）。
// LoD＝importanceRank が「大きくて濃い splat が先」の順位を付ける（0 が一番重い）。遠くから見る時は描き手が先頭の N 個だけ描く（splat-gpu.ts）。
// 読み手・下ごしらえ・順位は splat-reader.ts（worker）で回す＝main は止まらない。worker が立たない器では index.ts が main で同じ関数を呼ぶ。
export const SH_C0 = 0.28209479177387814;
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

// ---- 公開の型 ----
export type SplatCrs = "lnglat" | "ecef" | "local";
export type SplatAxes = "z" | "y" | "-y";
export type SplatFormat = "ply" | "splat" | "spz";
/** the SplatData contract of @ortho-earth/globe, plus crs "local" for file sources (meters, axes as in the file) */
export interface SplatData {
	n?: number;
	/** crs "lnglat" (default): [lng, lat, alt m]; "ecef": earth-centered meters; "local": meters in the file's axes */
	positions: Float32Array;
	/** sigma of each ellipsoid axis in meters (linear) */
	scales: Float32Array;
	/** quaternion x, y, z, w (local ENU for "lnglat", ECEF for "ecef", file axes for "local") */
	rotations: Float32Array;
	/** RGBA 0..255; A is the opacity */
	colors: Uint8Array;
	/** spherical harmonics beyond DC: n × K×3, coefficient-major (sh[i*K*3 + k*3 + c]), K = 3 / 8 / 15 for degree 1 / 2 / 3. Drawn by the WebGPU renderer */
	sh?: Float32Array;
	crs?: SplatCrs;
	/** "local" only: which file axis is up ("z"; "y" = right-up-back; "-y" = right-down-forward) */
	axes?: SplatAxes;
}
/** 読み手の戻り＝n・crs "local"・axes が必ず入った SplatData */
export interface LocalSplatData extends SplatData { n: number; crs: "local"; axes: SplatAxes }
/** [heading (clockwise from north), pitch, roll] degrees */
export type Hpr = [number, number?, number?];
export type Origin = [number, number, number?];
export interface ToEnuOptions { origin?: Origin; upAxis?: SplatAxes; orientation?: Hpr; scale?: number; opacity?: number }
/** SplatData → what the overlay draws: an anchor, ENU centers (m), ENU covariances (m², xx xy xz yy yz zz), and rot = the 3×3 (row-major) that takes an ENU direction back into the data's frame (for the SH) */
export interface EnuSplats { n: number; anchor: [number, number, number]; ctr: Float32Array<ArrayBuffer>; cov: Float32Array<ArrayBuffer>; rgba: Uint8Array; radius: number; rot: Float32Array }
/** packSh の戻り＝8 bit に詰めた SH（4 個／u32・係数が先・色が後）・その目（係数＝snorm × scale）・次数 */
export interface PackedSh { shq: Uint32Array<ArrayBuffer>; shScale: number; shDeg: 1 | 2 | 3; words: number }
type Mat3 = number[];
type BinSource = ArrayBuffer | Uint8Array | ArrayLike<number>;
const toU8 = (buf: BinSource): Uint8Array => buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);

// ---- .ply（3D Gaussian Splatting の書き出し＝binary_little_endian・x y z・f_dc_0..2・opacity（logit）・scale_0..2（log）・rot_0..3（w x y z）・f_rest_*） ----
type DvGetter = "getInt8" | "getUint8" | "getInt16" | "getUint16" | "getInt32" | "getUint32" | "getFloat32" | "getFloat64";
const PLY_TYPES: Record<string, [DvGetter, number]> = { char: ["getInt8", 1], int8: ["getInt8", 1], uchar: ["getUint8", 1], uint8: ["getUint8", 1], short: ["getInt16", 2], int16: ["getInt16", 2], ushort: ["getUint16", 2], uint16: ["getUint16", 2], int: ["getInt32", 4], int32: ["getInt32", 4], uint: ["getUint32", 4], uint32: ["getUint32", 4], float: ["getFloat32", 4], float32: ["getFloat32", 4], double: ["getFloat64", 8], float64: ["getFloat64", 8] };
interface PlyProp { name: string; get: DvGetter; size: number }
interface PlyElement { name: string; count: number; props: PlyProp[] }
export function parsePly(buf: BinSource): LocalSplatData {
	const u8 = toU8(buf);
	const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 65536)));
	const end = head.indexOf("end_header");
	if (!head.startsWith("ply") || end < 0) throw new Error("plugin-splat: not a PLY file");
	const lines = head.slice(0, end).split(/\r?\n/), body = end + "end_header".length + (head[end + 10] === "\r" ? 2 : 1);
	if (!lines.some(l => /^format\s+binary_little_endian\b/.test(l))) throw new Error("plugin-splat: only binary_little_endian PLY is supported");
	const elements: PlyElement[] = []; let el: PlyElement | null = null;
	for (const l of lines) {
		const w = l.trim().split(/\s+/);
		if (w[0] === "element") elements.push(el = { name: w[1], count: +w[2], props: [] });
		else if (w[0] === "property" && el) { if (w[1] === "list") throw new Error("plugin-splat: PLY list properties are not supported"); const t = PLY_TYPES[w[1]]; if (!t) throw new Error(`plugin-splat: PLY type ${w[1]}`); el.props.push({ name: w[2], get: t[0], size: t[1] }); }
	}
	let off = body;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	for (const e of elements) {
		const stride = e.props.reduce((s, p) => s + p.size, 0);
		if (e.name !== "vertex") { off += stride * e.count; continue; }
		const n = e.count, at: Record<string, { o: number; get: DvGetter } | undefined> = {}; let o = 0;
		for (const p of e.props) { at[p.name] = { o, get: p.get }; o += p.size; }
		if (!at.x || !at.y || !at.z) throw new Error("plugin-splat: PLY vertex needs x y z");
		if (off + stride * n > u8.length) throw new Error("plugin-splat: PLY is truncated");
		const rd = (i: number, name: string, d = 0): number => { const a = at[name]; return a ? dv[a.get](off + i * stride + a.o, true) : d; };
		const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
		const gs = !!at.scale_0, hasRot = !!at.rot_0, dc = !!at.f_dc_0, rgb = !!at.red;
		const rest = Object.keys(at).filter(k => /^f_rest_\d+$/.test(k)).sort((a, b) => +a.slice(7) - +b.slice(7));
		const sh = rest.length ? new Float32Array(n * rest.length) : null, shK = rest.length % 3 === 0 ? rest.length / 3 : 0;
		for (let i = 0; i < n; i++) {
			positions[i * 3] = rd(i, "x"); positions[i * 3 + 1] = rd(i, "y"); positions[i * 3 + 2] = rd(i, "z");
			if (gs) for (let k = 0; k < 3; k++) scales[i * 3 + k] = Math.exp(rd(i, "scale_" + k));
			else scales.fill(0.01, i * 3, i * 3 + 3);   // 点群の PLY＝小さな丸
			let qw = 1, qx = 0, qy = 0, qz = 0;
			if (hasRot) { qw = rd(i, "rot_0"); qx = rd(i, "rot_1"); qy = rd(i, "rot_2"); qz = rd(i, "rot_3"); }
			const ql = Math.hypot(qx, qy, qz, qw) || 1; rotations.set([qx / ql, qy / ql, qz / ql, qw / ql], i * 4);
			if (dc) for (let k = 0; k < 3; k++) colors[i * 4 + k] = clamp255((0.5 + SH_C0 * rd(i, "f_dc_" + k)) * 255);
			else if (rgb) { colors[i * 4] = rd(i, "red"); colors[i * 4 + 1] = rd(i, "green"); colors[i * 4 + 2] = rd(i, "blue"); }
			else colors.fill(200, i * 4, i * 4 + 3);
			colors[i * 4 + 3] = at.opacity ? clamp255(sigmoid(rd(i, "opacity")) * 255) : at.alpha ? rd(i, "alpha") : 255;
			if (sh) { if (shK) for (let k = 0; k < shK; k++) for (let c = 0; c < 3; c++) sh[i * rest.length + k * 3 + c] = rd(i, rest[c * shK + k]); else for (let k = 0; k < rest.length; k++) sh[i * rest.length + k] = rd(i, rest[k]); }   // f_rest は色が先（R の 15 個・G の 15 個・B の 15 個）＝係数が先の並びへ
		}
		return { n, crs: "local", axes: "-y", positions, scales, rotations, colors, ...(sh ? { sh } : {}) };
	}
	throw new Error("plugin-splat: PLY has no vertex element");
}

// ---- .splat（32 byte／個＝位置 f32×3・尺 f32×3（線形）・RGBA u8×4・回転 u8×4（w x y z を (v−128)/128）） ----
export function parseSplat(buf: BinSource): LocalSplatData {
	const u8 = toU8(buf);
	if (u8.length % 32) throw new Error("plugin-splat: .splat length must be a multiple of 32");
	const n = u8.length / 32, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const b = i * 32;
		for (let k = 0; k < 3; k++) { positions[i * 3 + k] = dv.getFloat32(b + k * 4, true); scales[i * 3 + k] = dv.getFloat32(b + 12 + k * 4, true); }
		colors.set(u8.subarray(b + 24, b + 28), i * 4);
		const w = (u8[b + 28] - 128) / 128, x = (u8[b + 29] - 128) / 128, y = (u8[b + 30] - 128) / 128, z = (u8[b + 31] - 128) / 128, l = Math.hypot(x, y, z, w) || 1;
		rotations.set([x / l, y / l, z / l, w / l], i * 4);
	}
	return { n, crs: "local", axes: "-y", positions, scales, rotations, colors };
}

// ---- .spz（Niantic の gzip 圧縮の形・v2／v3）＝gzip は素の DecompressionStream で解く（WASM は要らない）。軸は RUB（右・上・後）＝axes "y" ----
export async function gunzip(buf: BinSource): Promise<Uint8Array> {
	const u8 = toU8(buf);
	if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;   // 既に解いた中身
	if (typeof DecompressionStream === "undefined") throw new Error("plugin-splat: DecompressionStream is not available; pass splatPlugin({ decoders: { spz } })");
	const s = new Blob([u8 as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function parseSpz(buf: BinSource): Promise<LocalSplatData> { return decodeSpz(await gunzip(buf)); }
export function decodeSpz(u8: Uint8Array): LocalSplatData {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.length < 16 || dv.getUint32(0, true) !== 0x5053474e) throw new Error("plugin-splat: not an SPZ file (magic)");
	const version = dv.getUint32(4, true), n = dv.getUint32(8, true), shDeg = u8[12], frac = u8[13];
	if (version < 2 || version > 3) throw new Error(`plugin-splat: SPZ version ${version} is not supported (2 and 3 are)`);
	if (shDeg > 3) throw new Error(`plugin-splat: SPZ sh degree ${shDeg}`);
	const shN = [0, 3, 8, 15][shDeg] * 3, rotB = version >= 3 ? 4 : 3;
	const need = 16 + n * (9 + 1 + 3 + 3 + rotB + shN);
	if (u8.length < need) throw new Error("plugin-splat: SPZ is truncated");
	let o = 16;
	const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4), sh = shN ? new Float32Array(n * shN) : null;
	const fs = 1 / (1 << frac);
	for (let i = 0; i < n * 3; i++, o += 3) { let v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); if (v & 0x800000) v |= ~0xffffff; positions[i] = v * fs; }
	for (let i = 0; i < n; i++, o++) colors[i * 4 + 3] = u8[o];
	for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++, o++) colors[i * 4 + k] = clamp255((0.5 + SH_C0 * ((u8[o] / 255 - 0.5) / 0.15)) * 255);
	for (let i = 0; i < n * 3; i++, o++) scales[i] = Math.exp(u8[o] / 16 - 10);
	for (let i = 0; i < n; i++) {
		let q: number[] = [0, 0, 0, 0];
		if (version >= 3) {   // 最大成分を落とした 3 成分（各 9 bit＋符号）＋最大成分の番号 2 bit
			let c = dv.getUint32(o, true); o += 4;
			const big = c >>> 30; let ss = 0;
			for (let k = 3; k >= 0; k--) { if (k === big) continue; const mag = c & 511, neg = (c >>> 9) & 1; c >>>= 10; const v = Math.SQRT1_2 * mag / 511; q[k] = neg ? -v : v; ss += v * v; }
			q[big] = Math.sqrt(Math.max(0, 1 - ss));
		} else {
			const x = u8[o] / 127.5 - 1, y = u8[o + 1] / 127.5 - 1, z = u8[o + 2] / 127.5 - 1; o += 3;
			q = [x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))];
		}
		const l = Math.hypot(...q) || 1; rotations.set(q.map(v => v / l), i * 4);
	}
	if (sh) for (let i = 0; i < n * shN; i++, o++) sh[i] = (u8[o] - 128) / 128;
	return { n, crs: "local", axes: "y", positions, scales, rotations, colors, ...(sh ? { sh } : {}) };
}
export const formatOf = (u: unknown): SplatFormat | null => { const m = String(u).match(/\.(ply|splat|spz)(\?|#|$)/i); return m ? m[1].toLowerCase() as SplatFormat : null; };

// ---- 下ごしらえ ----
const R_SPHERE = 6371000, WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
const D2R = Math.PI / 180;
// 四元数（x,y,z,w）→ 3×3（行優先）
export function quatMat(x: number, y: number, z: number, w: number): number[] {
	return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
		2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
		2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
const mul3 = (A: ArrayLike<number>, B: ArrayLike<number>): Mat3 => { const C: number[] = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
// file の軸 → 東北上（x 東 y 北 z 上）。"z"＝そのまま、"y"＝y が上・z が後（RUB）、"-y"＝y が下・z が前（RDF＝3DGS の .ply／.splat）
export const AXES: Readonly<Record<SplatAxes, number[]>> = Object.freeze({ z: [1, 0, 0, 0, 1, 0, 0, 0, 1], y: [1, 0, 0, 0, 0, -1, 0, 1, 0], "-y": [1, 0, 0, 0, 0, 1, 0, -1, 0] });
// heading（北から時計回り）・pitch・roll（度）×大きさ＝東北上の中の向き
export function placeMat(axes: SplatAxes = "z", [hd = 0, pt = 0, rl = 0]: Hpr | [] = [], scale = 1): number[] {
	const A = (AXES as Partial<Record<string, number[]>>)[axes]; if (!A) throw new Error(`plugin-splat: upAxis must be ${Object.keys(AXES).join(" | ")}`);
	const h = -hd * D2R, p = pt * D2R, r = rl * D2R;
	const Rz = [Math.cos(h), -Math.sin(h), 0, Math.sin(h), Math.cos(h), 0, 0, 0, 1], Rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)], Ry = [Math.cos(r), 0, Math.sin(r), 0, 1, 0, -Math.sin(r), 0, Math.cos(r)];
	return mul3(mul3(mul3(Rz, Rx), Ry), A).map(v => v * scale);
}
// 共分散（6 個＝xx xy xz yy yz zz）＝(T·R·S)(T·R·S)ᵀ
function covOf(T: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>, out: Float32Array, k: number): void {
	const R = quatMat(q[0], q[1], q[2], q[3]), M = mul3(T, R);
	for (let c = 0; c < 3; c++) { M[c] *= s[c]; M[3 + c] *= s[c]; M[6 + c] *= s[c]; }
	const d = (a: number, b: number): number => M[a * 3] * M[b * 3] + M[a * 3 + 1] * M[b * 3 + 1] + M[a * 3 + 2] * M[b * 3 + 2];
	out[k] = d(0, 0); out[k + 1] = d(0, 1); out[k + 2] = d(0, 2); out[k + 3] = d(1, 1); out[k + 4] = d(1, 2); out[k + 5] = d(2, 2);
}
const enuBasis = (lon: number, lat: number): Mat3 => { const l = lon * D2R, f = lat * D2R, sl = Math.sin(l), cl = Math.cos(l), sf = Math.sin(f), cf = Math.cos(f); return [-sl, cl, 0, -sf * cl, -sf * sl, cf, cf * cl, cf * sl, sf]; };   // 行＝東・北・上（ECEF）
export function ecefToLngLat(x: number, y: number, z: number): [number, number, number] {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - WGS_E2)), h = 0;
	for (let i = 0; i < 6; i++) { const s = Math.sin(lat), N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - WGS_E2 * N / (N + h))); }
	return [lon / D2R, lat / D2R, h];
}
// SplatData（lnglat／ecef／local）→ { n, anchor:[lng,lat,alt], ctr: Float32Array(n*3)（東北上 m）, cov: Float32Array(n*6)（東北上 m²）, rgba, radius（m） }
//   local＝origin（[lng,lat,alt]）・upAxis（既定は file の axes）・orientation（[heading,pitch,roll] 度）・scale で置く。lnglat の回転は東北上の中の向き、ecef の回転は地心直交の中の向き
export function toEnu(d: SplatData & { n: number }, { origin, upAxis, orientation, scale = 1, opacity = 1 }: ToEnuOptions = {}): EnuSplats {
	const n = d.n, P = d.positions, ctr = new Float32Array(n * 3), cov = new Float32Array(n * 6);
	let anchor: [number, number, number], T: Mat3;
	if (d.crs === "local") {
		if (!origin || !Number.isFinite(+origin[0]) || !Number.isFinite(+origin[1])) throw new Error("plugin-splat: a .ply/.splat/.spz source needs opts.origin [lng, lat, alt?]");
		anchor = [+origin[0], +origin[1], +(origin[2] as number) || 0]; T = placeMat(upAxis ?? d.axes ?? "z", orientation, scale);
		for (let i = 0; i < n; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; ctr[i * 3] = T[0] * x + T[1] * y + T[2] * z; ctr[i * 3 + 1] = T[3] * x + T[4] * y + T[5] * z; ctr[i * 3 + 2] = T[6] * x + T[7] * y + T[8] * z; }
	} else if (d.crs === "ecef") {
		let sx = 0, sy = 0, sz = 0; for (let i = 0; i < n; i++) { sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2]; }
		const a = n ? [sx / n, sy / n, sz / n] : [WGS_A, 0, 0]; anchor = ecefToLngLat(a[0], a[1], a[2]); T = enuBasis(anchor[0], anchor[1]);
		for (let i = 0; i < n; i++) { const x = P[i * 3] - a[0], y = P[i * 3 + 1] - a[1], z = P[i * 3 + 2] - a[2]; ctr[i * 3] = T[0] * x + T[1] * y + T[2] * z; ctr[i * 3 + 1] = T[3] * x + T[4] * y + T[5] * z; ctr[i * 3 + 2] = T[6] * x + T[7] * y + T[8] * z; }
	} else {
		let sl = 0, sb = 0, sh = 0; for (let i = 0; i < n; i++) { sl += P[i * 3]; sb += P[i * 3 + 1]; sh += P[i * 3 + 2]; }
		anchor = n ? [sl / n, sb / n, sh / n] : [0, 0, 0]; T = [1, 0, 0, 0, 1, 0, 0, 0, 1];
		const ce = Math.cos(anchor[1] * D2R) * D2R * R_SPHERE, cn = D2R * R_SPHERE;
		for (let i = 0; i < n; i++) { const e = (P[i * 3] - anchor[0]) * ce, nn = (P[i * 3 + 1] - anchor[1]) * cn; ctr[i * 3] = e; ctr[i * 3 + 1] = nn; ctr[i * 3 + 2] = P[i * 3 + 2] - anchor[2] - (e * e + nn * nn) / (2 * R_SPHERE); }   // 丸みの落ち込みも入れる
	}
	const S = d.scales, Q = d.rotations, s = [0, 0, 0], q = [0, 0, 0, 1];
	let r2 = 0;
	for (let i = 0; i < n; i++) {
		s[0] = S[i * 3]; s[1] = S[i * 3 + 1]; s[2] = S[i * 3 + 2]; q[0] = Q[i * 4]; q[1] = Q[i * 4 + 1]; q[2] = Q[i * 4 + 2]; q[3] = Q[i * 4 + 3];
		covOf(T, q, s, cov, i * 6);
		r2 = Math.max(r2, ctr[i * 3] ** 2 + ctr[i * 3 + 1] ** 2 + ctr[i * 3 + 2] ** 2);
	}
	let rgba = d.colors;
	if (opacity !== 1) { rgba = rgba.slice(); for (let i = 3; i < rgba.length; i += 4) rgba[i] = clamp255(rgba[i] * opacity); }
	// SH の向き＝東北上の視線を元の軸へ戻す回転（T の列を正規化した R の転置・行優先）。lnglat＝そのまま、ecef＝地心直交へ、local＝file の軸へ
	const rot = new Float32Array(9);
	for (let c = 0; c < 3; c++) { const l = Math.hypot(T[c], T[3 + c], T[6 + c]) || 1; rot[c * 3] = T[c] / l; rot[c * 3 + 1] = T[3 + c] / l; rot[c * 3 + 2] = T[6 + c] / l; }
	return { n, anchor, ctr, cov, rgba, radius: Math.sqrt(r2), rot };
}
/** SH の次数（1 個あたりの係数の数 9／24／45 → 1／2／3・他は 0＝使わない） */
export const shDegreeOf = (perSplat: number): 0 | 1 | 2 | 3 => perSplat === 9 ? 1 : perSplat === 24 ? 2 : perSplat === 45 ? 3 : 0;
// SH を 8 bit に詰める（.spz と同じ目＝snorm8・4 個を u32 に）。目（scale）は層の最大の絶対値＝描き手が unpack4x8snorm × scale で戻す。maxDeg で次数を落とせる（係数の先頭だけ残す）
export function packSh(sh: Float32Array, n: number, maxDeg = 3): PackedSh | null {
	if (!n || !sh?.length || sh.length % n) return null;
	const per = sh.length / n, deg = Math.min(shDegreeOf(per), maxDeg) as 0 | 1 | 2 | 3;
	if (!deg) return null;
	const K = [0, 3, 8, 15][deg] * 3, words = Math.ceil(K / 4);
	let mx = 0; for (let i = 0; i < n; i++) for (let k = 0; k < K; k++) { const a = Math.abs(sh[i * per + k]); if (a > mx) mx = a; }
	const shScale = mx > 1e-6 ? mx : 1, inv = 127 / shScale, shq = new Uint32Array(n * words), b = new Uint8Array(shq.buffer);
	for (let i = 0; i < n; i++) for (let k = 0; k < K; k++) { let q = Math.round(sh[i * per + k] * inv); if (q > 127) q = 127; else if (q < -127) q = -127; b[i * words * 4 + k] = q & 255; }
	return { shq, shScale, shDeg: deg, words };
}
// 中心の経緯度（当たりの答え用・近似＝錨の東北上から）
export function enuToLngLat(anchor: ArrayLike<number>, e: number, n: number): [number, number] { return [anchor[0] + e / (Math.cos(anchor[1] * D2R) * D2R * R_SPHERE), anchor[1] + n / (D2R * R_SPHERE)]; }

/** LoD の順位＝大きくて濃い splat が先（0 が一番重い）。重さ＝不透明度 × 尺の幾何平均（m）。数え上げ（16 bit の桶・対数）で O(n) */
export function importanceRank(scales: Float32Array, colors: Uint8Array, n: number): Uint32Array<ArrayBuffer> {
	const rank = new Uint32Array(n);
	if (!n) return rank;
	const key = new Float32Array(n);
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < n; i++) {
		const a = colors[i * 4 + 3] / 255, v = Math.abs(scales[i * 3] * scales[i * 3 + 1] * scales[i * 3 + 2]);
		const k = Math.log(a * Math.cbrt(v) + 1e-12); key[i] = k; if (k < lo) lo = k; if (k > hi) hi = k;
	}
	const B = 65536, sc = hi > lo ? (B - 1) / (hi - lo) : 0, counts = new Uint32Array(B + 1), q = new Uint16Array(n);
	for (let i = 0; i < n; i++) { const b = B - 1 - Math.min(B - 1, Math.max(0, Math.round((key[i] - lo) * sc))); q[i] = b; counts[b + 1]++; }   // 重い物が小さい桶
	for (let b = 0; b < B; b++) counts[b + 1] += counts[b];
	for (let i = 0; i < n; i++) rank[i] = counts[q[i]]++;
	return rank;
}

// 契約の形（globe の normSplat と同じ検め＝plugin を直に呼んだ時・worker の中でも）
export const checkEnum = <T>(v: T, list: readonly string[], name: string): T => { if (!list.some(x => x === v)) throw new Error(`plugin-splat: ${name} must be ${list.join(" | ")} (got ${JSON.stringify(v)})`); return v; };
export function checkSplatData(d: SplatData): SplatData & { n: number; crs: SplatCrs } {
	if (!d || typeof d !== "object") throw new TypeError("plugin-splat: data must be SplatData or a .ply/.splat/.spz URL");
	const n = d.n ?? (d.positions instanceof Float32Array ? d.positions.length / 3 : NaN), crs = d.crs ?? "lnglat";
	if (!Number.isInteger(n) || n < 0) throw new RangeError("plugin-splat: n must be a non-negative integer");
	checkEnum(crs, ["lnglat", "ecef", "local"], "crs");
	const f = (v: unknown, nm: string, len: number): void => { if (!(v instanceof Float32Array) || v.length !== len) throw new TypeError(`plugin-splat: ${nm} must be a Float32Array of length ${len}`); };
	f(d.positions, "positions", n * 3); f(d.scales, "scales", n * 3); f(d.rotations, "rotations", n * 4);
	if (!(d.colors instanceof Uint8Array) || d.colors.length !== n * 4) throw new TypeError(`plugin-splat: colors must be a Uint8Array of length ${n * 4}`);
	return { ...d, n, crs };
}
/** format → 読み手（表の添字引きではなく switch＝外から来た名前で任意のメソッドへ飛ばない・知らない名前は投げる） */
export function readerFor(format: SplatFormat): (bytes: Uint8Array) => LocalSplatData | Promise<LocalSplatData> {
	switch (format) {
		case "ply": return parsePly;
		case "splat": return parseSplat;
		case "spz": return parseSpz;
		default: throw new Error(`plugin-splat: format must be ply | splat | spz (got ${JSON.stringify(format)})`);
	}
}
/** 下ごしらえの一式＝描き手に渡す物（index.ts の main 経路と splat-reader.ts の worker 経路で同じ） */
export interface Prepared { n: number; crs: SplatCrs; anchor: [number, number, number]; ctr: Float32Array<ArrayBuffer>; cov: Float32Array<ArrayBuffer>; rgba: Uint8Array; radius: number; rot: Float32Array; sh: PackedSh | null; rank: Uint32Array<ArrayBuffer> | null }
export interface PrepareOptions extends ToEnuOptions { shDegree?: number; lod?: boolean }
/** SplatData（検め済み）→ Prepared（東北上・SH の詰め・LoD の順位）。copyColors＝渡した人の配列を手放さない（transfer する時は写し） */
export function prepare(d: SplatData & { n: number; crs: SplatCrs }, o: PrepareOptions, copyColors: boolean): Prepared {
	const e = toEnu(d, { origin: o.origin, upAxis: o.upAxis, orientation: o.orientation, scale: o.scale ?? 1, opacity: o.opacity ?? 1 });
	const rgba = copyColors && e.rgba === d.colors ? e.rgba.slice() : e.rgba;
	const sh = d.sh && (o.shDegree ?? 3) > 0 ? packSh(d.sh, e.n, o.shDegree ?? 3) : null;
	const rank = o.lod !== false ? importanceRank(d.scales, rgba, e.n) : null;
	return { n: e.n, crs: d.crs, anchor: e.anchor, ctr: e.ctr, cov: e.cov, rgba, radius: e.radius, rot: e.rot, sh, rank };
}
/** transfer する buffer（Prepared の配列の裏）＝worker → main → 描き手で同じ一覧 */
export function transferables(p: Prepared): ArrayBuffer[] {
	const out: ArrayBuffer[] = [p.ctr.buffer, p.cov.buffer, p.rgba.buffer as ArrayBuffer];
	if (p.sh) out.push(p.sh.shq.buffer);
	if (p.rank) out.push(p.rank.buffer);
	return [...new Set(out)];
}
