// Gaussian splat の読み手と、描く前の下ごしらえ（純関数・main で動く・node で検定できる）。@ortho-earth/plugin-splat。
//   読み手（.ply／.splat／.spz／.ksplat／.sog）は file の局所座標の SplatData（crs "local"・単位 m・軸は file の約束＝axes）を返す。
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
export type SplatFormat = "ply" | "splat" | "spz" | "ksplat" | "sog";
/** readerFor／format の検めで使う一覧（globe の SPLAT_FORMATS と同じ） */
export const SPLAT_FORMATS: readonly SplatFormat[] = Object.freeze(["ply", "splat", "spz", "ksplat", "sog"]);
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
	/** "local" only: a column-major 4×4 that takes the file's coordinates (meters) to ECEF (meters), e.g. a glTF node matrix × a 3D Tiles tile transform. Replaces origin / upAxis / orientation / scale; the splats are placed at absolute altitude */
	transform?: ArrayLike<number>;
}
/** 読み手の戻り＝n・crs "local"・axes が必ず入った SplatData */
export interface LocalSplatData extends SplatData { n: number; crs: "local"; axes: SplatAxes }
/** [heading (clockwise from north), pitch, roll] degrees */
export type Hpr = [number, number?, number?];
export type Origin = [number, number, number?];
export interface ToEnuOptions { origin?: Origin; upAxis?: SplatAxes; orientation?: Hpr; scale?: number; opacity?: number; /** crs "local": file → ECEF (column-major 4×4; wins over data.transform) */ transform?: ArrayLike<number> | null }
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
// ---- .ksplat（GaussianSplats3D の SplatBuffer＝頭 4096 byte・節の頭 1024 byte ずつ・圧縮 0／1／2・節ごとのバケツ・SH 次数 0〜2）＝軸は .ply と同じ "-y" ----
//   圧縮 0：中心 f32×3・尺 f32×3（線形）・回転 f32×4（w x y z）・RGBA・SH f32。圧縮 1：中心 u16×3（バケツの中心からの差＝(v−range)×(block/2/range)）・尺／回転／SH f16。圧縮 2：SH だけ u8（頭の min〜max に伸ばす）。
//   SH の並びは帯ごとに色が先（帯 1＝R の k0..2・G・B／帯 2＝R の k3..7・G・B）→ 係数が先（sh[k*3+c]）に並べ替える（.ply と同じ目）。
/** IEEE 半精度 → 数 */
export const f16 = (h: number): number => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
interface KsplatSection { n: number; bucketSize: number; bucketCount: number; sf: number; range: number; full: number; partial: number; deg: number; stride: number; base: number; buckets: number; data: number }
export function parseKsplat(buf: BinSource): LocalSplatData {
	const u8 = toU8(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.length < 4096 + 1024) throw new Error("plugin-splat: not a .ksplat file (too short)");
	const major = u8[0], sections = dv.getUint32(4, true), level = dv.getUint16(20, true);
	if (major !== 0 || level > 2) throw new Error(`plugin-splat: .ksplat version ${major}.${u8[1]} / compression level ${level} is not supported`);
	if (sections < 1 || sections > 1024 || 4096 + sections * 1024 > u8.length) throw new Error("plugin-splat: .ksplat section count is out of range");
	const shMin = dv.getFloat32(36, true) || -1.5, shMax = dv.getFloat32(40, true) || 1.5;
	const secs: KsplatSection[] = []; let total = 0, at = 4096 + sections * 1024, maxDeg = 0;
	for (let s = 0; s < sections; s++) {
		const h = 4096 + s * 1024, n = dv.getUint32(h + 4, true), bucketSize = dv.getUint32(h + 8, true), bucketCount = dv.getUint32(h + 12, true), block = dv.getFloat32(h + 16, true);
		const bucketBytes = dv.getUint16(h + 20, true) || (level ? 12 : 0), range = dv.getUint32(h + 24, true) || (level ? 32767 : 1), full = dv.getUint32(h + 32, true), partial = dv.getUint32(h + 36, true), deg = dv.getUint16(h + 40, true);
		if (deg > 2) throw new Error(`plugin-splat: .ksplat sh degree ${deg} is not supported (0–2)`);
		if (level && (!bucketSize || bucketBytes < 12)) throw new Error("plugin-splat: .ksplat section has no buckets");
		const shComp = [0, 9, 24][deg], stride = level === 0 ? 44 + 4 * shComp : level === 1 ? 24 + 2 * shComp : 24 + shComp, metaBytes = partial * 4, bucketsBytes = bucketBytes * bucketCount + metaBytes;
		secs.push({ n, bucketSize, bucketCount, sf: block / 2 / range, range, full, partial, deg, stride, base: at, buckets: at + metaBytes, data: at + bucketsBytes });
		at += stride * n + bucketsBytes; total += n; maxDeg = Math.max(maxDeg, deg);
	}
	if (at > u8.length) throw new Error("plugin-splat: .ksplat is truncated");
	const positions = new Float32Array(total * 3), scales = new Float32Array(total * 3), rotations = new Float32Array(total * 4), colors = new Uint8Array(total * 4);
	const K = [0, 3, 8][maxDeg], sh = K ? new Float32Array(total * K * 3) : null;
	let i = 0;
	for (const sc of secs) {
		const lens: number[] = []; for (let p = 0; p < sc.partial; p++) lens.push(dv.getUint32(sc.base + p * 4, true));
		const fullEnd = sc.full * sc.bucketSize; let pStart = fullEnd, pIdx = 0;
		const shComp = [0, 9, 24][sc.deg];
		for (let j = 0; j < sc.n; j++, i++) {
			const o = sc.data + j * sc.stride;
			let w: number, x: number, y: number, z: number, shAt = 0;
			if (level === 0) {
				for (let k = 0; k < 3; k++) { positions[i * 3 + k] = dv.getFloat32(o + k * 4, true); scales[i * 3 + k] = dv.getFloat32(o + 12 + k * 4, true); }
				w = dv.getFloat32(o + 24, true); x = dv.getFloat32(o + 28, true); y = dv.getFloat32(o + 32, true); z = dv.getFloat32(o + 36, true);
				colors.set(u8.subarray(o + 40, o + 44), i * 4); shAt = o + 44;
			} else {
				let b: number;
				if (j < fullEnd) b = Math.floor(j / sc.bucketSize);
				else { while (pIdx < lens.length - 1 && j >= pStart + lens[pIdx]) pStart += lens[pIdx++]; b = sc.full + pIdx; }
				if (b >= sc.bucketCount) throw new Error("plugin-splat: .ksplat bucket index is out of range");
				const bb = sc.buckets + b * 12;
				for (let k = 0; k < 3; k++) { positions[i * 3 + k] = (dv.getUint16(o + k * 2, true) - sc.range) * sc.sf + dv.getFloat32(bb + k * 4, true); scales[i * 3 + k] = f16(dv.getUint16(o + 6 + k * 2, true)); }
				w = f16(dv.getUint16(o + 12, true)); x = f16(dv.getUint16(o + 14, true)); y = f16(dv.getUint16(o + 16, true)); z = f16(dv.getUint16(o + 18, true));
				colors.set(u8.subarray(o + 20, o + 24), i * 4); shAt = o + 24;
			}
			const l = Math.hypot(x, y, z, w) || 1; rotations.set([x / l, y / l, z / l, w / l], i * 4);
			if (sh && shComp) {
				const base = i * K * 3;
				for (let m = 0; m < shComp; m++) {
					const v = level === 0 ? dv.getFloat32(shAt + m * 4, true) : level === 1 ? f16(dv.getUint16(shAt + m * 2, true)) : u8[shAt + m] / 255 * (shMax - shMin) + shMin;
					const c = m < 9 ? Math.floor(m / 3) : Math.floor((m - 9) / 5), k = m < 9 ? m % 3 : 3 + (m - 9) % 5;
					sh[base + k * 3 + c] = v;
				}
			}
		}
	}
	return { n: total, crs: "local", axes: "-y", positions, scales, rotations, colors, ...(sh ? { sh } : {}) };
}

// ---- .sog（PlayCanvas の Spatially Ordered Gaussians v2＝zip の束・meta.json＋WebP の画・符号帳）＝軸は RUB（右・上・後）"y" ----
//   画は 8 bit の生の値（means_l/means_u＝位置 16 bit を 2 枚・quats＝最小 3 成分＋mode・scales／sh0＝符号帳の添字・shN＝重心の palette＋添字）。
//   画の解き手（WebP → RGBA）は差し替えられる（node の検定は PNG）。既定は createImageBitmap → WebGL2 の texture → readPixels（premultiply しない＝sh0 の A が小さくても RGB の添字が崩れない）。WebGL2 が無ければ 2D canvas（A の小さい画素の RGB が丸まる）。
/** 画 → RGBA（width × height × 4・8 bit・上の行が先） */
export interface RgbaImage { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
export type ImageDecoder = (bytes: Uint8Array, name: string) => Promise<RgbaImage>;
export interface SogOptions { /** WebP の bytes → RGBA。既定は createImageBitmap（browser／worker） */ decodeImage?: ImageDecoder }
interface ZipEntry { name: string; method: number; csize: number; off: number }
/** zip の中央目録（末尾の EOCD から）→ 項目の一覧 */
export function zipEntries(u8: Uint8Array): ZipEntry[] {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	let e = -1;
	for (let p = u8.length - 22; p >= Math.max(0, u8.length - 22 - 65535); p--) if (dv.getUint32(p, true) === 0x06054b50) { e = p; break; }
	if (e < 0) throw new Error("plugin-splat: .sog is not a zip file (no end of central directory)");
	const count = dv.getUint16(e + 10, true), cd = dv.getUint32(e + 16, true);
	if (count === 0xffff || cd === 0xffffffff) throw new Error("plugin-splat: zip64 .sog is not supported");
	const out: ZipEntry[] = []; let p = cd;
	for (let k = 0; k < count; k++) {
		if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("plugin-splat: .sog central directory is broken");
		const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
		out.push({ name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl)), method, csize, off });
		p += 46 + nl + xl + cl;
	}
	return out;
}
/** raw deflate を解く（素の DecompressionStream） */
export async function inflateRaw(u8: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === "undefined") throw new Error("plugin-splat: DecompressionStream is not available");
	const s = new Blob([u8 as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}
async function zipRead(u8: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (e.off + 30 > u8.length || dv.getUint32(e.off, true) !== 0x04034b50) throw new Error(`plugin-splat: .sog entry ${e.name} is broken`);
	const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
	if (start + e.csize > u8.length) throw new Error(`plugin-splat: .sog entry ${e.name} is truncated`);
	const data = u8.subarray(start, start + e.csize);
	if (e.method === 0) return data;
	if (e.method === 8) return inflateRaw(data);
	throw new Error(`plugin-splat: .sog entry ${e.name} uses zip method ${e.method} (only stored / deflate)`);
}
/** 既定の画の解き手（browser／worker）＝createImageBitmap → WebGL2 の readPixels（正確）か 2D canvas（A の小さい画素は丸まる） */
export async function decodeImageDefault(bytes: Uint8Array, name: string): Promise<RgbaImage> {
	if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") throw new Error(`plugin-splat: no image decoder for ${name} here; pass splatPlugin({ decoders: { sog } }) or parseSog(bytes, { decodeImage })`);
	const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
	try {
		const { width, height } = bmp, data = new Uint8Array(width * height * 4), cv = new OffscreenCanvas(width, height);
		const gl = cv.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: false, antialias: false }) as WebGL2RenderingContext | null;
		if (gl) {
			const tex = gl.createTexture(), fb = gl.createFramebuffer();
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
			gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
			const okFb = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
			if (okFb) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
			gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.getExtension("WEBGL_lose_context")?.loseContext();
			if (okFb) return { width, height, data };
		}
		const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
		if (!ctx) throw new Error(`plugin-splat: cannot decode ${name} (no canvas)`);
		ctx.drawImage(bmp, 0, 0);
		return { width, height, data: ctx.getImageData(0, 0, width, height).data };
	} finally { bmp.close(); }
}
interface SogMeta { version?: number; count?: number; means?: { mins?: number[]; maxs?: number[]; files?: string[] }; scales?: { codebook?: number[]; files?: string[] }; quats?: { files?: string[] }; sh0?: { codebook?: number[]; files?: string[] }; shN?: { count?: number; bands?: number; codebook?: number[]; files?: string[] } }
export async function parseSog(buf: BinSource, { decodeImage = decodeImageDefault }: SogOptions = {}): Promise<LocalSplatData> {
	const u8 = toU8(buf);
	if (!(u8[0] === 0x50 && u8[1] === 0x4b)) throw new Error("plugin-splat: .sog must be the zip bundle (meta.json and the webp images inside)");
	const byName = new Map<string, ZipEntry>();
	for (const e of zipEntries(u8)) { if (!e.name.endsWith("/")) { byName.set(e.name, e); const base = e.name.slice(e.name.lastIndexOf("/") + 1); if (!byName.has(base)) byName.set(base, e); } }
	const file = async (name: unknown, what: string): Promise<Uint8Array> => { const e = typeof name === "string" ? byName.get(name) ?? byName.get(name.slice(name.lastIndexOf("/") + 1)) : undefined; if (!e) throw new Error(`plugin-splat: .sog has no ${what} file ${JSON.stringify(name)}`); return zipRead(u8, e); };
	const meta = JSON.parse(new TextDecoder().decode(await file("meta.json", "meta.json"))) as SogMeta;
	if (meta.version !== 2) throw new Error(`plugin-splat: .sog version ${meta.version} is not supported (2 is)`);
	const n = meta.count ?? 0;
	if (!Number.isInteger(n) || n < 0) throw new Error("plugin-splat: .sog count");
	const book = (b: unknown, what: string): number[] => { if (!Array.isArray(b) || b.length !== 256 || !b.every(Number.isFinite)) throw new Error(`plugin-splat: .sog ${what} codebook must have 256 numbers`); return b as number[]; };
	const vec3 = (v: unknown, what: string): number[] => { if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`plugin-splat: .sog means.${what}`); return v as number[]; };
	const mins = vec3(meta.means?.mins, "mins"), maxs = vec3(meta.means?.maxs, "maxs"), scaleBook = book(meta.scales?.codebook, "scales"), dcBook = book(meta.sh0?.codebook, "sh0");
	const img = async (name: unknown, what: string, min: number): Promise<RgbaImage> => {
		const im = await decodeImage(await file(name, what), String(name));
		if (!im || im.data.length !== im.width * im.height * 4) throw new Error(`plugin-splat: .sog image ${what} decoded to the wrong size`);
		if (im.width * im.height < min) throw new Error(`plugin-splat: .sog image ${what} holds ${im.width * im.height} pixels for ${min} gaussians`);
		return im;
	};
	const [ml, mu, qu, sc, dc] = await Promise.all([img(meta.means?.files?.[0], "means_l", n), img(meta.means?.files?.[1], "means_u", n), img(meta.quats?.files?.[0], "quats", n), img(meta.scales?.files?.[0], "scales", n), img(meta.sh0?.files?.[0], "sh0", n)]);
	const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
	const unlog = (v: number): number => Math.sign(v) * (Math.exp(Math.abs(v)) - 1), qc = (b: number): number => (b / 255 - 0.5) * 2 / Math.SQRT2;
	for (let i = 0; i < n; i++) {
		const p = i * 4;
		for (let k = 0; k < 3; k++) { const q = ml.data[p + k] | (mu.data[p + k] << 8); positions[i * 3 + k] = unlog(mins[k] + (maxs[k] - mins[k]) * q / 65535); scales[i * 3 + k] = Math.exp(scaleBook[sc.data[p + k]]); }
		const a = qc(qu.data[p]), b = qc(qu.data[p + 1]), c = qc(qu.data[p + 2]), mode = qu.data[p + 3] - 252, d = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
		if (mode < 0 || mode > 3) throw new Error(`plugin-splat: .sog quaternion mode ${qu.data[p + 3]} (252–255 expected)`);
		const q = mode === 0 ? [d, a, b, c] : mode === 1 ? [a, d, b, c] : mode === 2 ? [a, b, d, c] : [a, b, c, d];   // w x y z
		const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; rotations.set([q[1] / l, q[2] / l, q[3] / l, q[0] / l], i * 4);
		for (let k = 0; k < 3; k++) colors[i * 4 + k] = clamp255((0.5 + SH_C0 * dcBook[dc.data[p + k]]) * 255);
		colors[i * 4 + 3] = dc.data[p + 3];
	}
	let sh: Float32Array | null = null;
	if (meta.shN) {
		const bands = meta.shN.bands ?? 0, K = [0, 3, 8, 15][bands];
		if (!K) throw new Error(`plugin-splat: .sog shN.bands ${bands} (1–3 expected)`);
		const count = meta.shN.count ?? 0, acBook = book(meta.shN.codebook, "shN");
		const [ce, la] = await Promise.all([img(meta.shN.files?.[0], "shN_centroids", 0), img(meta.shN.files?.[1], "shN_labels", n)]);
		if (ce.width < 64 * K || ce.width * ce.height < count * K) throw new Error("plugin-splat: .sog shN_centroids is too small for shN.count");
		sh = new Float32Array(n * K * 3);
		for (let i = 0; i < n; i++) {
			const label = la.data[i * 4] | (la.data[i * 4 + 1] << 8);
			if (label >= count) throw new Error(`plugin-splat: .sog shN label ${label} ≥ count ${count}`);
			const row = Math.floor(label / 64) * ce.width + (label % 64) * K, base = i * K * 3;
			for (let k = 0; k < K; k++) { const px = (row + k) * 4; for (let ch = 0; ch < 3; ch++) sh[base + k * 3 + ch] = acBook[ce.data[px + ch]]; }
		}
	}
	return { n, crs: "local", axes: "y", positions, scales, rotations, colors, ...(sh ? { sh } : {}) };
}

/** URL／ファイル名 → format（拡張子） */
// ---- .spz の書き手（v2・SH つき）＝3D Tiles 化（apps/ortho-globe/scripts/splat-tiles.mjs）と検定の往復に。gzip は呼び手（node＝zlib・browser＝CompressionStream）----
/** SplatData（局所・axes は .spz の約束＝RUB "y" で渡す）→ .spz v2 の中身（gzip 前）。frac＝位置の小数の bit 数（既定 12＝±2048 m・0.24 mm 刻み）。尺は 1/16 の log・色は 0.15 の目・回転は 3 byte（w≧0）・SH は 8 bit（×128） */
export function encodeSpzRaw(d: SplatData & { n: number }, { frac = 12 }: { frac?: number } = {}): Uint8Array<ArrayBuffer> {
	const n = d.n, perSplat = d.sh && n ? d.sh.length / n : 0, shDeg = shDegreeOf(perSplat), shN = [0, 9, 24, 45][shDeg];
	if (frac < 0 || frac > 23) throw new RangeError("plugin-splat: encodeSpz frac must be 0–23");
	const b = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 3 + shN)), dv = new DataView(b.buffer), f = 1 << frac, lim = 0x7fffff;
	dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, 2, true); dv.setUint32(8, n, true); b[12] = shDeg; b[13] = frac;
	let o = 16;
	for (let i = 0; i < n * 3; i++, o += 3) { const q = Math.max(-lim - 1, Math.min(lim, Math.round(d.positions[i] * f))) & 0xffffff; b[o] = q & 255; b[o + 1] = (q >> 8) & 255; b[o + 2] = (q >> 16) & 255; }
	for (let i = 0; i < n; i++, o++) b[o] = d.colors[i * 4 + 3];
	for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++, o++) b[o] = clamp255(((d.colors[i * 4 + k] / 255 - 0.5) / SH_C0 * 0.15 + 0.5) * 255);
	for (let i = 0; i < n * 3; i++, o++) { const s = d.scales[i]; b[o] = s > 0 ? clamp255((Math.log(s) + 10) * 16) : 0; }
	for (let i = 0; i < n; i++) { const neg = d.rotations[i * 4 + 3] < 0 ? -1 : 1; for (let k = 0; k < 3; k++, o++) b[o] = clamp255((neg * d.rotations[i * 4 + k] + 1) * 127.5); }
	if (shN) for (let i = 0; i < n * shN; i++, o++) b[o] = clamp255(d.sh![i] * 128 + 128);
	return b;
}
export const formatOf = (u: unknown): SplatFormat | null => { const m = String(u).match(/\.(ply|splat|spz|ksplat|sog)(\?|#|$)/i); return m ? m[1].toLowerCase() as SplatFormat : null; };

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
//   local＋transform（列優先 4×4・file → ECEF・3D Tiles の glTF＝タイル変換×ノード）＝錨は重心を ECEF に写した経緯度、中心は倍精度で 錨からの東北上（ECEF の float32 を通さない＝0.5m のガタつきを出さない）、
//     共分散と SH の向きは T＝東北上の基底 × transform の 3×3（回転も尺も transform の物）。origin／upAxis／orientation／scale は見ない
export function toEnu(d: SplatData & { n: number }, { origin, upAxis, orientation, scale = 1, opacity = 1, transform }: ToEnuOptions = {}): EnuSplats {
	const n = d.n, P = d.positions, ctr = new Float32Array(n * 3), cov = new Float32Array(n * 6);
	let anchor: [number, number, number], T: Mat3;
	const M = d.crs === "local" ? (transform ?? d.transform ?? null) : null;
	if (M) {
		if (M.length < 16) throw new Error("plugin-splat: transform must be a column-major 4×4 (16 numbers)");
		const lin: Mat3 = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];   // 列優先 → 行優先の 3×3
		let sx = 0, sy = 0, sz = 0; for (let i = 0; i < n; i++) { sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2]; }
		const c = n ? [sx / n, sy / n, sz / n] : [0, 0, 0];
		const a = [lin[0] * c[0] + lin[1] * c[1] + lin[2] * c[2] + M[12], lin[3] * c[0] + lin[4] * c[1] + lin[5] * c[2] + M[13], lin[6] * c[0] + lin[7] * c[1] + lin[8] * c[2] + M[14]];   // 重心（ECEF）
		if (!a.every(Number.isFinite)) throw new Error("plugin-splat: transform must be finite");
		anchor = ecefToLngLat(a[0], a[1], a[2]); T = mul3(enuBasis(anchor[0], anchor[1]), lin);
		for (let i = 0; i < n; i++) { const x = P[i * 3] - c[0], y = P[i * 3 + 1] - c[1], z = P[i * 3 + 2] - c[2]; ctr[i * 3] = T[0] * x + T[1] * y + T[2] * z; ctr[i * 3 + 1] = T[3] * x + T[4] * y + T[5] * z; ctr[i * 3 + 2] = T[6] * x + T[7] * y + T[8] * z; }
	} else if (d.crs === "local") {
		if (!origin || !Number.isFinite(+origin[0]) || !Number.isFinite(+origin[1])) throw new Error("plugin-splat: a .ply/.splat/.spz source needs opts.origin [lng, lat, alt?] (or opts.transform)");
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
	if (d.transform != null) checkTransform(d.transform);
	return { ...d, n, crs };
}
/** transform（列優先 4×4・file → ECEF）の形＝16 個の有限な数 */
export function checkTransform(m: unknown): number[] {
	const a = m != null && typeof m === "object" && typeof (m as ArrayLike<number>).length === "number" ? Array.from(m as ArrayLike<number>, Number) : null;
	if (!a || a.length !== 16 || !a.every(Number.isFinite)) throw new TypeError("plugin-splat: transform must be a column-major 4×4 (16 finite numbers, file meters → ECEF meters)");
	return a;
}
/** format → 読み手（表の添字引きではなく switch＝外から来た名前で任意のメソッドへ飛ばない・知らない名前は投げる） */
export function readerFor(format: SplatFormat): (bytes: Uint8Array) => LocalSplatData | Promise<LocalSplatData> {
	switch (format) {
		case "ply": return parsePly;
		case "splat": return parseSplat;
		case "spz": return parseSpz;
		case "ksplat": return parseKsplat;
		case "sog": return (b: Uint8Array) => parseSog(b);
		default: throw new Error(`plugin-splat: format must be ${SPLAT_FORMATS.join(" | ")} (got ${JSON.stringify(format)})`);
	}
}
/** 下ごしらえの一式＝描き手に渡す物（index.ts の main 経路と splat-reader.ts の worker 経路で同じ） */
export interface Prepared { n: number; crs: SplatCrs; anchor: [number, number, number]; ctr: Float32Array<ArrayBuffer>; cov: Float32Array<ArrayBuffer>; rgba: Uint8Array; radius: number; rot: Float32Array; sh: PackedSh | null; rank: Uint32Array<ArrayBuffer> | null }
export interface PrepareOptions extends ToEnuOptions { shDegree?: number; lod?: boolean }
/** SplatData（検め済み）→ Prepared（東北上・SH の詰め・LoD の順位）。copyColors＝渡した人の配列を手放さない（transfer する時は写し） */
export function prepare(d: SplatData & { n: number; crs: SplatCrs }, o: PrepareOptions, copyColors: boolean): Prepared {
	const e = toEnu(d, { origin: o.origin, upAxis: o.upAxis, orientation: o.orientation, scale: o.scale ?? 1, opacity: o.opacity ?? 1, transform: o.transform ?? null });
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
