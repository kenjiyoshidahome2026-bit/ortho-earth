// glTF の rigid アニメ（第 3 波 W4・2026-10-12）＝ノード変換（translation／rotation／scale）の補間を、焼いた頂点に掛ける「バッチごとの剛体変換」に直す純関数。
//   worker（meshdecode.decodeModel）は、アニメの掛かるノードごとに束（バッチ）を分け、rig（ノードの親子と静止の TRS・アニメの channel の数列）と
//   place（glTF のローカル → ECEF の affine G と、ECEF → 単位球の世界座標の局所線形化 F）を返す。main（gadgets/model.js）は時計のたびに
//   samplePose → batchXf で各バッチの L（3x3・列優先）と xt（バッチ原点相対の平行移動）を出し、renderer の "meshXf" に渡す＝頂点を焼き直さない。
//   頂点は静止の world 行列 W0 で焼いてある＝アニメ後の world 行列 W(t) との差 W(t)·W0⁻¹ をローカル空間の剛体変換とし、G・F で世界座標の
//   変換へ写す（A_w = F·G·(W·W0⁻¹)·G⁻¹·F⁻¹）。skin（頂点の重み）と morph（頂点の差分）は頂点を焼き直す別の段＝capabilities は spec のまま。
//   DOM 無し＝tests/gltf-anim.mjs。

/** 静止のノード（parent＝親の番号・−1＝根・t/r/s＝TRS・matrix＝glTF の matrix（あれば TRS より優先）） */
export interface RigNode { parent: number; t: number[]; r: number[]; s: number[]; matrix: Float64Array | null }
/** アニメの channel（times・values は sampler の数列・stride＝成分の数（rotation 4・他 3）） */
export interface RigChannel { node: number; path: "translation" | "rotation" | "scale"; interpolation: string; times: Float32Array; values: Float32Array; stride: number }
export interface RigAnimation { name: string; duration: number; channels: RigChannel[] }
/** rig（worker の rigFromGltf）＝ノードの親子・静止の TRS・アニメの channel の数列・animated＝動くノード（と子孫）の番号 */
export interface GltfRig { nodes: RigNode[]; animations: RigAnimation[]; animated?: number[] }
/** place＝glTF のローカル → ECEF（G）と、ECEF → 世界座標の局所線形化（F） */
export interface GltfPlace { G: { A: ArrayLike<number>; T: ArrayLike<number> }; F: { L: ArrayLike<number>; t: ArrayLike<number> } }
/** 全ノードの world 行列（アニメ後 W と静止 W0） */
export interface GltfPose { W: Float64Array[]; W0: Float64Array[] }
/** 世界座標の affine（L＝3x3 列優先・t＝平行移動） */
export interface WorldXf { L: Float64Array; t: number[] }
/** rigFromGltf が読む glTF（postProcessGLTF の後）＝nodes の children は実体（番号の物も）・animations は生・accessors の value は型付き配列 */
export interface AnimGltf {
	nodes?: Array<{ children?: unknown[]; translation?: ArrayLike<number> & Iterable<number>; rotation?: ArrayLike<number> & Iterable<number>; scale?: ArrayLike<number> & Iterable<number>; matrix?: ArrayLike<number> }>;
	animations?: Array<{ name?: unknown; channels?: Array<{ sampler: number; target?: { node?: number; path?: string } }>; samplers?: Array<{ input: number; output: number; interpolation?: string }> }>;
	accessors?: Array<{ value?: ArrayLike<number> | null } | null>;
}
type M4 = ArrayLike<number>;

// ── 4x4（列優先・glTF の並び）───────────────────────────────────────────────
export const I4 = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
export const m4mul = (a: M4, b: M4): Float64Array => {
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
	return o;
};
export const m4trs = (t: ArrayLike<number> = [0, 0, 0], q: ArrayLike<number> = [0, 0, 0, 1], s: ArrayLike<number> = [1, 1, 1]): Float64Array => {
	const [x, y, z, w] = q as [number, number, number, number], xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
	return Float64Array.of(
		(1 - 2*(yy+zz)) * s[0], 2*(xy+wz) * s[0], 2*(xz-wy) * s[0], 0,
		2*(xy-wz) * s[1], (1 - 2*(xx+zz)) * s[1], 2*(yz+wx) * s[1], 0,
		2*(xz+wy) * s[2], 2*(yz-wx) * s[2], (1 - 2*(xx+yy)) * s[2], 0,
		t[0], t[1], t[2], 1);
};
// affine（4x4 の下の行が 0 0 0 1）の逆＝線形部の逆と平行移動
export function m4affineInv(m: M4): Float64Array | null {
	const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
	const A = e*i - f*h, B = -(d*i - f*g), C = d*h - e*g, det = a*A + b*B + c*C;
	if (!(Math.abs(det) > 1e-300)) return null;
	const iv = 1 / det;
	const L = [A*iv, B*iv, C*iv, -(b*i - c*h)*iv, (a*i - c*g)*iv, -(a*h - b*g)*iv, (b*f - c*e)*iv, -(a*f - c*d)*iv, (a*e - b*d)*iv];   // 列優先 3x3
	const tx = m[12], ty = m[13], tz = m[14];
	return Float64Array.of(L[0], L[1], L[2], 0, L[3], L[4], L[5], 0, L[6], L[7], L[8], 0,
		-(L[0]*tx + L[3]*ty + L[6]*tz), -(L[1]*tx + L[4]*ty + L[7]*tz), -(L[2]*tx + L[5]*ty + L[8]*tz), 1);
}
const m4fromLT = (L: ArrayLike<number>, t: ArrayLike<number>) => Float64Array.of(L[0], L[1], L[2], 0, L[3], L[4], L[5], 0, L[6], L[7], L[8], 0, t[0], t[1], t[2], 1);   // 3x3（列優先）＋平行移動 → 4x4

// ── rig の抽出（worker・postProcessGLTF の後の gltf）─────────────────────────
// loaders.gl の postProcessGLTF は nodes（children・mesh を実体へ）と accessors（value＝型付き配列）を解決するが animations は生のまま＝sampler の
// input/output は accessor の番号で引く。戻り＝{ nodes: [{ parent, t, r, s, matrix }], animations: [{ name, duration, channels: [{ node, path, interpolation, times, values, stride }] }] }
// animated＝アニメの channel が掛かるノードと、その子孫（親が動けば子も動く）の番号の集合。アニメが無ければ null。
export function rigFromGltf(gltf: AnimGltf | null | undefined): GltfRig | null {
	const nodes = gltf?.nodes || [], anims = gltf?.animations || [];
	if (!anims.length || !nodes.length) return null;
	const idx = new Map<unknown, number>(nodes.map((n, i) => [n, i]));
	const parent = new Int32Array(nodes.length).fill(-1);
	nodes.forEach((n, i) => { for (const c of n.children || []) { const k = typeof c === "number" ? c : idx.get(c); if (k != null && k !== i) parent[k] = i; } });
	const rigNodes = nodes.map((n, i) => ({ parent: parent[i], t: n.translation ? [...n.translation] : [0, 0, 0], r: n.rotation ? [...n.rotation] : [0, 0, 0, 1], s: n.scale ? [...n.scale] : [1, 1, 1], matrix: n.matrix ? Float64Array.from(n.matrix) : null }));
	const acc = (i: number) => gltf!.accessors?.[i]?.value || null;
	const animated = new Set<number>();
	const animations = anims.map((a, index) => {
		let duration = 0; const channels: RigChannel[] = [];
		for (const ch of a.channels || []) {
			const sm = a.samplers?.[ch.sampler]; const node = ch.target?.node, path = ch.target?.path;
			if (!sm || typeof node !== "number" || !["translation", "rotation", "scale"].includes(path!)) continue;   // weights（morph）はこの段では読まない
			const times = acc(sm.input), values = acc(sm.output); if (!times || !values || !times.length) continue;
			const interpolation = sm.interpolation || "LINEAR", stride = path === "rotation" ? 4 : 3;
			const per = interpolation === "CUBICSPLINE" ? stride * 3 : stride;
			if (values.length < times.length * per) continue;
			channels.push({ node, path: path as RigChannel["path"], interpolation, times: Float32Array.from(times), values: Float32Array.from(values), stride });
			if (times[times.length - 1] > duration) duration = times[times.length - 1];
			animated.add(node);
		}
		return { name: typeof a.name === "string" && a.name ? a.name : `animation${index}`, duration, channels };
	});
	// 子孫へ伝える
	let grew = true;
	while (grew) { grew = false; for (let i = 0; i < nodes.length; i++) if (!animated.has(i) && parent[i] >= 0 && animated.has(parent[i])) { animated.add(i); grew = true; } }
	return { nodes: rigNodes, animations, animated: [...animated].sort((a, b) => a - b) };
}

// ── 補間 ──────────────────────────────────────────────────────────────
const slerp = (a: ArrayLike<number>, b: ArrayLike<number>, t: number, o: number[]) => {   // 四元数（a・b は長さ 1 とみなす）
	let d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3], s = 1;
	if (d < 0) { d = -d; s = -1; }
	let wa, wb;
	if (d > 0.9995) { wa = 1 - t; wb = t * s; }
	else { const th = Math.acos(Math.min(1, d)), sn = Math.sin(th); wa = Math.sin((1 - t) * th) / sn; wb = Math.sin(t * th) / sn * s; }
	for (let i = 0; i < 4; i++) o[i] = a[i] * wa + b[i] * wb;
	const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1; for (let i = 0; i < 4; i++) o[i] /= l;
	return o;
};
export function sampleChannel(ch: RigChannel, time: number): number[] {   // → 配列（stride）。時刻は端で留める（巻き戻しは samplePose が loop で畳む）
	const { times, values, stride, interpolation } = ch, n = times.length, out: number[] = new Array(stride);
	const cub = interpolation === "CUBICSPLINE", per = cub ? stride * 3 : stride;
	const pick = (k: number, o?: number[]) => { for (let i = 0; i < stride; i++) out[i] = values[k * per + (cub ? stride : 0) + i]; return o ?? out; };
	if (n === 1 || time <= times[0]) return pick(0);
	if (time >= times[n - 1]) return pick(n - 1);
	let lo = 0, hi = n - 1;
	while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= time) lo = m; else hi = m; }
	const t0 = times[lo], t1 = times[hi], dt = t1 - t0 || 1, u = (time - t0) / dt;
	if (interpolation === "STEP") return pick(lo);
	if (cub) {   // glTF の cubic spline＝p(u) = (2u³−3u²+1)p0 + dt(u³−2u²+u)m0 + (−2u³+3u²)p1 + dt(u³−u²)m1（m0＝p0 の出口接線・m1＝p1 の入口接線）
		const u2 = u * u, u3 = u2 * u, h00 = 2*u3 - 3*u2 + 1, h10 = u3 - 2*u2 + u, h01 = -2*u3 + 3*u2, h11 = u3 - u2;
		for (let i = 0; i < stride; i++) {
			const p0 = values[lo * per + stride + i], m0 = values[lo * per + 2 * stride + i], p1 = values[hi * per + stride + i], m1 = values[hi * per + i];
			out[i] = h00 * p0 + h10 * dt * m0 + h01 * p1 + h11 * dt * m1;
		}
		if (stride === 4) { const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1; for (let i = 0; i < 4; i++) out[i] /= l; }
		return out;
	}
	if (stride === 4) { const a = values.subarray(lo * 4, lo * 4 + 4), b = values.subarray(hi * 4, hi * 4 + 4); return slerp(a, b, u, out); }
	for (let i = 0; i < stride; i++) { const a = values[lo * stride + i], b = values[hi * stride + i]; out[i] = a + (b - a) * u; }
	return out;
}
// 再生の時刻 → アニメの時刻（loop＝duration で畳む・それ以外は端で留める）
export const wrapTime = (time: number, duration: number, loop: boolean): number => !(duration > 0) ? 0 : loop ? ((time % duration) + duration) % duration : Math.min(Math.max(time, 0), duration);

// pose＝全ノードの world 行列（アニメ後 W と静止 W0）。animIndex のアニメを時刻 time（秒・既に畳んだ値）で標本化
export function samplePose(rig: GltfRig, animIndex: number, time: number): GltfPose | null {
	const anim = rig.animations[animIndex]; if (!anim) return null;
	const n = rig.nodes.length, local: Float64Array[] = new Array(n), over = new Map<number, Partial<Record<RigChannel["path"], number[]>>>();
	for (const ch of anim.channels) { let o = over.get(ch.node); if (!o) over.set(ch.node, o = {}); o[ch.path] = sampleChannel(ch, time); }
	for (let i = 0; i < n; i++) {
		const nd = rig.nodes[i], o = over.get(i);
		local[i] = o ? m4trs(o.translation || (nd.matrix ? [nd.matrix[12], nd.matrix[13], nd.matrix[14]] : nd.t), o.rotation || nd.r, o.scale || nd.s) : (nd.matrix || m4trs(nd.t, nd.r, nd.s));
	}
	const W: Float64Array[] = new Array(n), W0: Float64Array[] = new Array(n);
	const world = (i: number, arr: Float64Array[], loc: (k: number) => Float64Array): Float64Array => { if (arr[i]) return arr[i]; const p = rig.nodes[i].parent; return arr[i] = p >= 0 && p !== i ? m4mul(world(p, arr, loc), loc(i)) : loc(i); };
	for (let i = 0; i < n; i++) { world(i, W, k => local[k]); world(i, W0, k => rig.nodes[k].matrix || m4trs(rig.nodes[k].t, rig.nodes[k].r, rig.nodes[k].s)); }
	return { W, W0 };
}

// ── バッチの変換 ───────────────────────────────────────────────────────────
// place＝{ G: { A: 3x3 列優先, T: [x,y,z] }（glTF のローカル → ECEF）, F: { L: 3x3 列優先, t: [x,y,z] }（ECEF → 世界座標の局所線形化） }
// 戻り＝{ L: Float64Array(9), t: [x,y,z] }（世界座標の affine）。ノードが動いていなければ null
export function worldXf(pose: GltfPose, node: number, place: GltfPlace): WorldXf | null {
	const W = pose.W[node], W0 = pose.W0[node]; if (!W || !W0) return null;
	const inv0 = m4affineInv(W0); if (!inv0) return null;
	const Al = m4mul(W, inv0);   // ローカル空間の剛体変換
	let same = true; for (let i = 0; i < 16 && same; i++) if (Math.abs(Al[i] - I4[i]) > 1e-9) same = false;
	if (same) return null;
	const G = m4fromLT(place.G.A, place.G.T), Gi = m4affineInv(G), F = m4fromLT(place.F.L, place.F.t), Fi = m4affineInv(F);
	if (!Gi || !Fi) return null;
	const M = m4mul(F, m4mul(G, m4mul(Al, m4mul(Gi, Fi))));
	return { L: Float64Array.of(M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]), t: [M[12], M[13], M[14]] };
}
// renderer に渡す 12 個＝L（9・列優先）と xt（バッチ原点 O 相対の平行移動＝L·O + t − O）。頂点 v = O + a_pos → v' = L·v + t = O + (L·a_pos + xt)
export function batchXf(xf: WorldXf | null, origin: ArrayLike<number> | null | undefined): Float32Array | null {
	if (!xf) return null;
	const { L, t } = xf, O = origin || [0, 0, 0], out = new Float32Array(12);
	for (let i = 0; i < 9; i++) out[i] = L[i];
	out[9] = L[0]*O[0] + L[3]*O[1] + L[6]*O[2] + t[0] - O[0];
	out[10] = L[1]*O[0] + L[4]*O[1] + L[7]*O[2] + t[1] - O[1];
	out[11] = L[2]*O[0] + L[5]*O[1] + L[8]*O[2] + t[2] - O[2];
	return out;
}
