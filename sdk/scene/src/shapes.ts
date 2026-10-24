// 形（instanced の素の mesh）と glb の素朴な読み手＝純関数（DOM も worker も触らない・node の検定 tests/t-scene.mjs が読む）。
// 局所の軸＝x 東・y 北・z 上（m）。箱・円柱・円錐は底が z=0（地面に立つ）、球は中心が z=0.5（直径 1 で地面に載る）。
// 返す形＝{ pos: Float32Array(v*3), nrm: Float32Array(v*3), idx: Uint32Array, col?: Uint8Array(v*4) }。

/** 利用者が渡す mesh（局所 m・x 東 y 北 z 上）：nrm が無ければ面から作る・idx が無ければ 3 頂点ずつ・col は RGBA8（任意） */
export interface Mesh { pos: Float32Array | number[]; idx?: Uint32Array | Uint16Array | number[]; nrm?: Float32Array | number[]; col?: Uint8Array | Float32Array | number[] }
/** 整えた mesh（normMesh・box などの戻り） */
export interface NormalizedMesh { pos: Float32Array; nrm: Float32Array; idx: Uint32Array; col?: Uint8Array }
export type ShapeName = "box" | "cylinder" | "cone" | "sphere";
export interface AtlasRect { x: number; y: number; w: number; h: number }
export interface AtlasLayout { w: number; h: number; rects: AtlasRect[] }

export function box(): NormalizedMesh {
	const P: number[] = [], N: number[] = [], I: number[] = [];
	const face = (n: number[], u: number[], v: number[]): void => {   // 面の中心 n/2・軸 u, v（各 ±0.5）
		const b = P.length / 3;
		for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			P.push(n[0] * 0.5 + u[0] * 0.5 * a + v[0] * 0.5 * c, n[1] * 0.5 + u[1] * 0.5 * a + v[1] * 0.5 * c, n[2] * 0.5 + u[2] * 0.5 * a + v[2] * 0.5 * c + 0.5);
			N.push(n[0], n[1], n[2]);
		}
		I.push(b, b + 1, b + 2, b, b + 2, b + 3);
	};
	face([1, 0, 0], [0, 1, 0], [0, 0, 1]); face([-1, 0, 0], [0, 0, 1], [0, 1, 0]);
	face([0, 1, 0], [0, 0, 1], [1, 0, 0]); face([0, -1, 0], [1, 0, 0], [0, 0, 1]);
	face([0, 0, 1], [1, 0, 0], [0, 1, 0]); face([0, 0, -1], [0, 1, 0], [1, 0, 0]);
	return { pos: Float32Array.from(P), nrm: Float32Array.from(N), idx: Uint32Array.from(I) };
}
// 円柱（cone=true で円錐）＝半径 0.5・高さ 1・側面 seg 枚＋上下の蓋
export function cylinder(seg = 24, cone = false): NormalizedMesh {
	const P: number[] = [], N: number[] = [], I: number[] = [], rTop = cone ? 0 : 0.5, slope = cone ? 0.5 : 0, nz = slope / Math.hypot(1, slope), nr = 1 / Math.hypot(1, slope);
	for (let i = 0; i <= seg; i++) {
		const a = i / seg * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
		P.push(0.5 * c, 0.5 * s, 0, rTop * c, rTop * s, 1); N.push(c * nr, s * nr, nz, c * nr, s * nr, nz);
		if (i < seg) { const b = i * 2; I.push(b, b + 2, b + 3, b, b + 3, b + 1); }
	}
	for (const [z, n] of cone ? [[0, -1]] : [[0, -1], [1, 1]]) {
		const c0 = P.length / 3; P.push(0, 0, z); N.push(0, 0, n);
		for (let i = 0; i <= seg; i++) { const a = i / seg * 2 * Math.PI; P.push(0.5 * Math.cos(a), 0.5 * Math.sin(a), z); N.push(0, 0, n); }
		for (let i = 0; i < seg; i++) n > 0 ? I.push(c0, c0 + 1 + i, c0 + 2 + i) : I.push(c0, c0 + 2 + i, c0 + 1 + i);
	}
	return { pos: Float32Array.from(P), nrm: Float32Array.from(N), idx: Uint32Array.from(I) };
}
export const cone = (seg = 24): NormalizedMesh => cylinder(seg, true);
export function sphere(seg = 16, rings = 12): NormalizedMesh {
	const P: number[] = [], N: number[] = [], I: number[] = [];
	for (let j = 0; j <= rings; j++) {
		const t = j / rings * Math.PI, st = Math.sin(t), ct = Math.cos(t);
		for (let i = 0; i <= seg; i++) { const a = i / seg * 2 * Math.PI, x = st * Math.cos(a), y = st * Math.sin(a); P.push(0.5 * x, 0.5 * y, 0.5 + 0.5 * ct); N.push(x, y, ct); }
	}
	for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) { const a = j * (seg + 1) + i, b = a + seg + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
	return { pos: Float32Array.from(P), nrm: Float32Array.from(N), idx: Uint32Array.from(I) };
}
export const SHAPES: Record<ShapeName, () => NormalizedMesh> = { box, cylinder: () => cylinder(), cone: () => cone(), sphere: () => sphere() };
export function shapeMesh(shape: ShapeName | Mesh | string): NormalizedMesh {
	if (typeof shape === "string") { const f = (SHAPES as Partial<Record<string, () => NormalizedMesh>>)[shape]; if (!f) throw new Error(`scene: unknown shape "${shape}" (box/cylinder/cone/sphere, a mesh { pos, nrm?, idx? } or a .glb)`); return f(); }
	if (shape && shape.pos) return normMesh(shape);
	throw new Error("scene: shape must be a name, a mesh { pos, nrm?, idx? } or a .glb (ArrayBuffer / URL)");
}
// 利用者の mesh＝pos（局所 m）・nrm（無ければ面から作る）・idx（無ければ 3 頂点ずつ）・col（RGBA8・任意）
export function normMesh(m: Mesh): NormalizedMesh {
	const pos = m.pos instanceof Float32Array ? m.pos : Float32Array.from(m.pos);
	if (pos.length % 3 || !pos.length) throw new Error("scene: mesh.pos must be xyz triples");
	const v = pos.length / 3;
	const idx = m.idx ? (m.idx instanceof Uint32Array ? m.idx : Uint32Array.from(m.idx)) : Uint32Array.from({ length: v }, (_, i) => i);
	for (let i = 0; i < idx.length; i++) if (idx[i] >= v) throw new Error(`scene: mesh.idx[${i}] = ${idx[i]} is out of range (${v} vertices)`);
	const nrm = m.nrm ? (m.nrm instanceof Float32Array ? m.nrm : Float32Array.from(m.nrm)) : faceNormals(pos, idx);
	const col = m.col ? (m.col instanceof Uint8Array ? m.col : Uint8Array.from(m.col)) : null;
	return { pos, nrm, idx, ...(col ? { col } : {}) };
}
export function faceNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
	const n = new Float32Array(pos.length);
	for (let t = 0; t + 2 < idx.length; t += 3) {
		const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
		const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
	}
	for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
	return n;
}
// glb の素朴な読み手（instanced の複製用）＝既定の scene の node を辿り（TRS / matrix）、三角形の primitive の POSITION・NORMAL・indices と
// 材質の baseColorFactor（頂点色に焼く）を 1 つの mesh に束ねる。glTF の y 上 → 局所（x 東・y 北＝−z・z 上＝y）。
// テクスチャ・アニメ・skin は読まない（模型そのものは map.gadget.model で）。Draco / meshopt の圧縮は投げる。
type AttrArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;
type AttrCtor = { new (length: number): AttrArray; readonly BYTES_PER_ELEMENT: number };
// glb の JSON（この読み手が見る欄だけ）
interface GlbAccessor { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }
interface GlbBufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface GlbPrimitive { attributes?: Record<string, number | undefined>; indices?: number; material?: number; mode?: number }
interface GlbNode { mesh?: number; children?: number[]; matrix?: number[]; rotation?: number[]; scale?: number[]; translation?: number[] }
interface GlbJson {
	scene?: number; scenes?: Array<{ nodes: number[] }>; nodes: GlbNode[]; meshes: Array<{ primitives: GlbPrimitive[] }>;
	materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>; accessors: GlbAccessor[]; bufferViews: GlbBufferView[]; extensionsRequired?: string[];
}
const CT: Record<number, AttrCtor | undefined> = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NC: Record<string, number | undefined> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
export function parseGlb(ab: ArrayBuffer | ArrayBufferView): NormalizedMesh & { col: Uint8Array } {
	const buf = ab instanceof ArrayBuffer ? ab : ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
	const dv = new DataView(buf);
	if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) throw new Error("scene: not a glb (magic)");
	let json: GlbJson | null = null, bin: Uint8Array | null = null;
	for (let o = 12; o + 8 <= dv.byteLength;) {
		const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
		if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o + 8, len))) as GlbJson;
		else if (type === 0x004E4942) bin = new Uint8Array(buf, o + 8, len);
		o += 8 + len;
	}
	if (!json) throw new Error("scene: glb without JSON chunk");
	for (const e of json.extensionsRequired || []) if (/draco|meshopt/i.test(e)) throw new Error(`scene: compressed glb (${e}) is not supported for instancing; load it with map.gadget.model or pass an uncompressed glb`);
	const read = (ai: number, want?: AttrCtor): AttrArray => {
		const a = json.accessors[ai], bv = json.bufferViews[a.bufferView], C = CT[a.componentType], nc = NC[a.type];
		if (!C || !nc) throw new Error(`scene: accessor ${ai} has an unsupported type`);
		if (bv.buffer !== 0 || !bin) throw new Error("scene: only the glb binary chunk is supported");
		const es = C.BYTES_PER_ELEMENT, stride = bv.byteStride || es * nc, base = (bv.byteOffset || 0) + (a.byteOffset || 0), out = new (want || C)(a.count * nc);
		const v = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
		const get: (p: number) => number = ({ 1: (p: number) => C === Int8Array ? v.getInt8(p) : v.getUint8(p), 2: (p: number) => C === Int16Array ? v.getInt16(p, true) : v.getUint16(p, true), 4: (p: number) => C === Float32Array ? v.getFloat32(p, true) : v.getUint32(p, true) } as Record<number, (p: number) => number>)[es];
		for (let i = 0; i < a.count; i++) for (let k = 0; k < nc; k++) out[i * nc + k] = get(base + i * stride + k * es);
		return out;
	};
	const P: number[] = [], N: number[] = [], I: number[] = [], COL: number[] = [];
	const mul = (A: number[], B: number[]): number[] => { const o = new Array<number>(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return o; };
	const local = (n: GlbNode): number[] => {
		if (n.matrix) return n.matrix.slice();
		const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
		return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
	};
	const visit = (ni: number, parent: number[]): void => {
		const n = json.nodes[ni], M = mul(parent, local(n));
		if (n.mesh != null) for (const pr of json.meshes[n.mesh].primitives) {
			if ((pr.mode ?? 4) !== 4 || pr.attributes?.POSITION == null) continue;
			const pos = read(pr.attributes.POSITION, Float32Array), nv = pos.length / 3, b = P.length / 3;
			const nrm = pr.attributes.NORMAL != null ? read(pr.attributes.NORMAL, Float32Array) : null;
			const f = (pr.material != null ? json.materials?.[pr.material] : undefined)?.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
			for (let i = 0; i < nv; i++) {
				const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
				const gx = M[0] * x + M[4] * y + M[8] * z + M[12], gy = M[1] * x + M[5] * y + M[9] * z + M[13], gz = M[2] * x + M[6] * y + M[10] * z + M[14];
				P.push(gx, -gz, gy);
				if (nrm) { const a = nrm[i * 3], c = nrm[i * 3 + 1], d = nrm[i * 3 + 2]; N.push(M[0] * a + M[4] * c + M[8] * d, -(M[2] * a + M[6] * c + M[10] * d), M[1] * a + M[5] * c + M[9] * d); }
				COL.push(...f.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)));
			}
			if (!nrm) for (let i = 0; i < nv * 3; i++) N.push(NaN);   // 後で面から作る印
			const idx = pr.indices != null ? read(pr.indices, Uint32Array) : Uint32Array.from({ length: nv }, (_, i) => i);
			const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]);
			for (let t = 0; t + 2 < idx.length; t += 3) det < 0 ? I.push(b + idx[t], b + idx[t + 2], b + idx[t + 1]) : I.push(b + idx[t], b + idx[t + 1], b + idx[t + 2]);   // 鏡映の node は巻きを戻す（y↔z の入れ替えでも巻きは保つ＝回転のみ）
		}
		for (const c of n.children || []) visit(c, M);
	};
	const scene = json.scenes?.[json.scene ?? 0];
	const roots = scene ? scene.nodes : (json.nodes || []).map((_, i) => i);
	for (const r of roots) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	if (!I.length) throw new Error("scene: the glb has no triangles");
	const pos = Float32Array.from(P), idx = Uint32Array.from(I);
	const nrm = Float32Array.from(N);
	if (nrm.some(Number.isNaN)) { const fn = faceNormals(pos, idx); for (let i = 0; i < nrm.length; i++) if (Number.isNaN(nrm[i])) nrm[i] = fn[i]; }
	for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
	return { pos, nrm, idx, col: Uint8Array.from(COL) };
}
// 画像を 1 枚の束（atlas）に並べる＝棚詰め（高さの順・2 px の余白）。sizes＝[{ w, h }] → { w, h, rects:[{ x, y, w, h }] }（w は 2 の冪・最大 max）
export function packAtlas(sizes: Array<{ w: number; h: number }>, { max = 4096, pad = 2 }: { max?: number; pad?: number } = {}): AtlasLayout {
	const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w);
	const area = sizes.reduce((s, r) => s + (r.w + pad) * (r.h + pad), 0), widest = Math.max(0, ...sizes.map(s => s.w + pad * 2));
	let W = 64; while (W < max && (W * W < area || W < widest)) W *= 2;
	if (widest > W) throw new Error(`scene: an image is wider than the atlas (${widest} > ${max})`);
	const rects = new Array<AtlasRect>(sizes.length);
	let x = pad, y = pad, rowH = 0;
	for (const i of order) {
		const s = sizes[i];
		if (x + s.w + pad > W) { x = pad; y += rowH + pad; rowH = 0; }
		rects[i] = { x, y, w: s.w, h: s.h };
		x += s.w + pad; rowH = Math.max(rowH, s.h);
	}
	let H = 1; const need = y + rowH + pad; while (H < need) H *= 2;
	if (H > max) throw new Error(`scene: images do not fit in a ${max}px atlas`);
	return { w: W, h: H, rects };
}
