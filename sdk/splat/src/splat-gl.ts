// Gaussian splat の WebGL2 の描き手（同一フレームのオーバーレイ＝map.overlay・render worker の中で地球と同じ rAF・同じ cam）。@ortho-earth/splat。
// 2026-10-18 から WebGPU の描き手（splat-gpu.ts＝SH・GPU の並べ替え）が主で、こちらは WebGPU の無い器の逃げ道（splat-draw.ts が選ぶ）＝DC の色だけ・CPU の並べ替え。
// ⚠ 依存ゼロ（実行時の import 文なし・型だけの import は消える）＝render worker が URL で import() する。深度の GLSL は host.depthGLSL を貼る（建物・地形に隠れる）。
// 一つの map の全部の層を一つのオーバーレイ＝一つの WebGL 文脈で描く（render worker の文脈は Chrome で 4 つまで）。当たりの答えに layer: q（本体の addLayerId と組む）。
// message { type:"layer", q, n, anchor:[lng,lat,alt], alt:"relative"|"absolute", ctr: Float32Array(n*3)（錨からの東北上 m）, cov: Float32Array(n*6)（東北上 m²＝xx xy xz yy yz zz）,
//           rgba: Uint8Array(n*4), radius（m）, depthTest, properties? }／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }／{ type:"probe", id }（検定）
// 描き方＝中心と共分散を浮動小数のテクスチャに置き、一つの四角を個数ぶん instancing。頂点で 3D の共分散を画面の 2D に写し（mvp の Jacobian・EWA）、固有値で楕円の軸を出す。
// 順＝視線の奥から手前（w の降順）に並べ替えた番号の列を instanced 属性で渡す。向きが変わった時だけ並べ直す（数え上げの並べ替え・16 bit）。混ぜ＝前乗せの α。深度は書かない（本体の深度で隠れるだけ）。
// 当たり＝番号を RGBA8 に焼く別パス（同じ順＝手前が後に描かれて勝つ・不透明度が 0.2 未満の所は当たらない）。
import type { OverlayFrameApi } from "@ortho-earth/globe";

type GL = WebGL2RenderingContext;
interface Program { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
/** init の第 3 引数（render worker が渡す）＝深度の GLSL・描き直しの依頼・main への返事 */
export interface OverlayHost { depthGLSL?: string | null; requestDraw?(): void; post?(d: unknown): void; gpuDevice?(): GPUDevice | null }
/** frame の camState（render worker の内部の形＝この描き手が読む欄だけ） */
export interface CamState { mvp: ArrayLike<number>; eye?: ArrayLike<number> | null }
/** frame の api＝OverlayFrameApi のうち、この描き手が読む欄（pick の ctx.api は depth: null） */
export type SplatApi = Pick<OverlayFrameApi, "rAx" | "elevM" | "liftScale"> & { depth?: OverlayFrameApi["depth"] };
export interface PickContext { s: CamState; api: SplatApi; size: { w: number; h: number } }
export type SplatAltitude = "relative" | "absolute";
/** main（index.ts）から届く層の中身（type・q は手綱が足す） */
/** rot・shq・shScale・shDeg・shWords＝SH、rank・lod＝LoD（WebGPU の描き手だけが読む・splat-gpu.ts）。この WebGL2 の描き手は DC だけ・全部描く */
export interface SplatLayerBody { n: number; anchor: [number, number, number]; alt?: SplatAltitude; on?: boolean; ctr: Float32Array; cov: Float32Array; rgba: Uint8Array; radius?: number; depthTest?: boolean; properties?: Record<string, unknown> | null; rot?: Float32Array | null; shq?: Uint32Array | null; shScale?: number; shDeg?: number; shWords?: number;
	/** LoD の順位（0 が一番重い・importanceRank）。lod＝画面の 1 px² あたり描く個数（0＝全部描く） */
	rank?: Uint32Array | null; lod?: number }
export type SplatMessage = ({ type: "layer"; q: string } & SplatLayerBody) | { type: "remove"; q: string } | { type: "vis"; q: string; on: boolean } | { type: "clear" } | { type: "probe"; id: unknown };
/** pick の答え（統一 picking が layer で手綱に配る） */
export interface SplatPickResult { id: number; q: string; layer: string; index: number; distance: number; lngLat: [number, number]; properties: Record<string, unknown> & { index: number } }
export interface EnuBasis { E: number[]; N: number[]; U: number[]; u: number[] }

const DEPTH_STUB = `highp float sceneOcclusion(highp vec2 uv, highp float w) { return 0.0; }`;
const VS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in uint a_idx;
uniform sampler2D u_ctr; uniform sampler2D u_cov; uniform sampler2D u_col;
uniform mat4 u_mvp;      // mvp×平行移動(錨)×東北上→単位球（倍精度で掛けてから f32）
uniform vec2 u_vp; uniform int u_tw; uniform highp uint u_base;
out vec4 v_col; out vec2 v_p; out float v_w;
flat out highp uint v_id;
const float K = 3.0;     // 3σ まで描く
void main() {
	int i = int(a_idx); ivec2 t = ivec2(i % u_tw, i / u_tw);
	vec3 c = texelFetch(u_ctr, t, 0).xyz;
	vec4 clip = u_mvp * vec4(c, 1.0);
	gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
	if (clip.w <= 1e-9) return;
	vec2 ndc = clip.xy / clip.w;
	if (any(greaterThan(abs(ndc), vec2(1.3)))) return;
	vec4 a = texelFetch(u_cov, ivec2(t.x * 2, t.y), 0), b = texelFetch(u_cov, ivec2(t.x * 2 + 1, t.y), 0);
	mat3 S = mat3(a.x, a.y, a.z, a.y, a.w, b.x, a.z, b.x, b.y);
	vec3 rx = vec3(u_mvp[0][0], u_mvp[1][0], u_mvp[2][0]), ry = vec3(u_mvp[0][1], u_mvp[1][1], u_mvp[2][1]), rw = vec3(u_mvp[0][3], u_mvp[1][3], u_mvp[2][3]);
	float iw = 1.0 / clip.w;
	vec3 jx = (rx - ndc.x * rw) * iw * 0.5 * u_vp.x, jy = (ry - ndc.y * rw) * iw * 0.5 * u_vp.y;   // 画素の Jacobian（2×3）
	vec3 sx = S * jx, sy = S * jy;
	float xx = dot(jx, sx) + 0.3, xy = dot(jx, sy), yy = dot(jy, sy) + 0.3;   // 画素の低域（0.3）＝細すぎる楕円がちらつかない
	float mid = 0.5 * (xx + yy), rad = length(vec2(0.5 * (xx - yy), xy)), l1 = mid + rad, l2 = mid - rad;
	if (l2 <= 0.0) return;
	vec2 e1 = abs(xy) < 1e-12 ? (xx >= yy ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(xy, l1 - xx));
	vec2 e2 = vec2(-e1.y, e1.x);
	float s1 = min(sqrt(l1), 1024.0), s2 = min(sqrt(l2), 1024.0);
	vec2 off = (a_corner.x * s1 * e1 + a_corner.y * s2 * e2) * K;
	gl_Position = vec4(ndc + off * 2.0 / u_vp, 0.0, 1.0);
	v_p = a_corner * K; v_w = clip.w;
	v_col = texelFetch(u_col, t, 0); v_id = u_base + uint(i);
}`;
const FS = (depthGLSL: string, pick: boolean): string => `#version 300 es
precision highp float;
uniform vec2 u_vp; uniform float u_occl;
${depthGLSL}
in vec4 v_col; in vec2 v_p; in float v_w;
flat in highp uint v_id;
out vec4 o;
void main() {
	float r2 = dot(v_p, v_p); if (r2 > 9.0) discard;
	if (u_occl > 0.5 && sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;
	float a = exp(-0.5 * r2) * v_col.a;
	${pick ? `if (a < 0.2) discard; o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;` : `if (a < 1.0 / 255.0) discard; o = vec4(v_col.rgb * a, a);`}
}`;
// 層（GPU に載せた物）
interface Layer {
	n: number; ctr: Float32Array; anchor: [number, number, number]; alt: SplatAltitude; radius: number; occl: boolean; properties: Record<string, unknown> | null;
	tC: WebGLTexture; tV: WebGLTexture; tP: WebGLTexture; vao: WebGLVertexArrayObject; ib: WebGLBuffer; order: Uint32Array; keys: Uint16Array;
	dir: number[] | null; sortedAt: number; on: boolean; base: number; timer?: ReturnType<typeof setTimeout> | 0; dist: number;   // dist＝目から錨まで（層を奥から描く順）
}
let glc: GL | null = null, host: OverlayHost | null = null, prog: Program | null = null, pickProg: Program | null = null, quad: WebGLBuffer | null = null, wantDepth = false, dummyTex: WebGLTexture | null = null;
let pickFbo: WebGLFramebuffer | null = null, pickTex: WebGLTexture | null = null, pickW = 0, pickH = 0;
const layers = new Map<string, Layer>(), probes: unknown[] = [];
const R_SPHERE = 6371000, R_ELL = 6378137, TW = 2048;
function compile(vs: string, fs: string): Program {
	const gl = glc!;
	const mk = (type: number, src: string): WebGLShader => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s))); return s; };
	const p = gl.createProgram()!; gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)));
	const u: Record<string, WebGLUniformLocation | null> = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number; i < n; i++) { const nm = gl.getActiveUniform(p, i)!.name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
export function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null): { depth: true } | undefined {
	host = h;
	const gl = glc = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (splat overlay)");
	wantDepth = opts.depth !== false && !!h?.depthGLSL;
	const dg = wantDepth && h?.depthGLSL ? h.depthGLSL : DEPTH_STUB;
	prog = compile(VS, FS(dg, false));
	try { pickProg = compile(VS, FS(dg, true)); } catch (e) { pickProg = null; console.warn("[splat] pick pass unavailable", (e as { message?: string } | null)?.message); }
	quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
	return wantDepth ? { depth: true } : undefined;
}
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * Math.PI / 180; let b = lat * Math.PI / 180; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
// 錨の東北上 m → 単位球（列＝東・北・上×1/R）
export function enuBasis(lon: number, lat: number, rAx = 1): EnuBasis {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	return { E: E.map(v => v * k), N: N.map(v => v * k), U: u.map(v => v * k), u };
}
// 奥から手前の順（w の降順）＝数え上げの並べ替え（16 bit の桶）。row＝mvp の w 行の東北上の成分（定数項は順に効かない）
export function sortOrder(ctr: ArrayLike<number>, n: number, row: ArrayLike<number>, out: Uint32Array = new Uint32Array(n), keys: Uint16Array = new Uint16Array(n), counts: Uint32Array = new Uint32Array(65536)): Uint32Array {
	let lo = Infinity, hi = -Infinity;
	const d = new Float32Array(n);
	for (let i = 0; i < n; i++) { const v = row[0] * ctr[i * 3] + row[1] * ctr[i * 3 + 1] + row[2] * ctr[i * 3 + 2]; d[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
	const sc = hi > lo ? 65535 / (hi - lo) : 0;
	counts.fill(0);
	for (let i = 0; i < n; i++) { const k = ((hi - d[i]) * sc) | 0; keys[i] = k; counts[k]++; }   // 奥（w が大）が小さい鍵
	for (let k = 1; k < 65536; k++) counts[k] += counts[k - 1];
	for (let i = n - 1; i >= 0; i--) out[--counts[keys[i]]] = i;
	return out;
}
const tex = (internal: number, fmt: number, type: number, w: number, h: number, data: ArrayBufferView): WebGLTexture => {
	const gl = glc!;
	const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, data);
	for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
	return t;
};
function build(d: SplatLayerBody): Layer {
	const gl = glc!;
	const n = d.n, th = Math.max(1, Math.ceil(n / TW));
	const C = new Float32Array(TW * th * 4), V = new Float32Array(TW * th * 8), P = new Uint8Array(TW * th * 4);
	for (let i = 0; i < n; i++) {
		C[i * 4] = d.ctr[i * 3]; C[i * 4 + 1] = d.ctr[i * 3 + 1]; C[i * 4 + 2] = d.ctr[i * 3 + 2];
		V.set(d.cov.subarray(i * 6, i * 6 + 6), i * 8);
	}
	P.set(d.rgba.subarray(0, n * 4));
	const tC = tex(gl.RGBA32F, gl.RGBA, gl.FLOAT, TW, th, C), tV = tex(gl.RGBA32F, gl.RGBA, gl.FLOAT, TW * 2, th, V), tP = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, TW, th, P);
	const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	const ib = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, ib);
	const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
	gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(1, 1);
	gl.bindVertexArray(null);
	return { n, ctr: d.ctr, anchor: d.anchor, alt: d.alt || "relative", radius: d.radius || 0, occl: d.depthTest !== false, properties: d.properties ?? null, tC, tV, tP, vao, ib, order, keys: new Uint16Array(n), dir: null, sortedAt: 0, on: d.on !== false, base: 0, dist: 0 };
}
const drop = (L: Layer | undefined): void => { if (!L) return; const gl = glc!; clearTimeout(L.timer); gl.deleteTexture(L.tC); gl.deleteTexture(L.tV); gl.deleteTexture(L.tP); gl.deleteBuffer(L.ib); gl.deleteVertexArray(L.vao); };
function rebase(): void { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
export function message(d: SplatMessage): void {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!glc) return;
	if (d.type === "layer") { drop(layers.get(d.q)); layers.set(d.q, build(d)); rebase(); host?.requestDraw?.(); }
	else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
}
// 錨の位置（relative＝地形の高さ×持ち上げ＋高さ・毎フレーム 1 点だけ引く）と、層の mvp（倍精度で掛けてから f32）
const mvpL = new Float32Array(16);
function place(L: Layer, s: CamState, api: SplatApi | null | undefined): boolean {
	const rAx = api?.rAx || 1, [lon, lat, alt] = L.anchor, B = enuBasis(lon, lat, rAx), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const ls = L.alt !== "absolute" ? (api?.liftScale || 0) : 0, r = 1 + (ls > 0 ? (api!.elevM(lon, lat) || 0) * ls : 0) + (alt || 0) * k;
	const o = [B.u[0] * r, B.u[1] * r, B.u[2] * r], M = s.mvp, cols = [B.E, B.N, B.U];
	for (let j = 0; j < 3; j++) for (let row = 0; row < 4; row++) mvpL[j * 4 + row] = M[row] * cols[j][0] + M[4 + row] * cols[j][1] + M[8 + row] * cols[j][2];
	for (let row = 0; row < 4; row++) mvpL[12 + row] = M[row] * o[0] + M[4 + row] * o[1] + M[8 + row] * o[2] + M[12 + row];
	const E = s.eye, rr = L.radius * k;   // 地平線の向こう（錨の半径ぶんの余裕）
	L.dist = E ? Math.hypot(E[0] - o[0], E[1] - o[1], E[2] - o[2]) : 0;
	const behind = E ? o[0] * (E[0] - o[0]) + o[1] * (E[1] - o[1]) + o[2] * (E[2] - o[2]) < -rr * Math.hypot(...o) - 1e-9 : false;
	return !behind;
}
const SORT_EVERY = 200000;   // これより多い層は並べ直しを 0.1 秒おきに間引く（間は描き直しを頼む）
function sortIfTurned(L: Layer): void {
	const gl = glc!;
	const row = [mvpL[3], mvpL[7], mvpL[11]], l = Math.hypot(...row) || 1, dir = row.map(v => v / l);
	if (L.dir && dir[0] * L.dir[0] + dir[1] * L.dir[1] + dir[2] * L.dir[2] > 0.99995) return;
	const now = performance.now();
	if (L.n > SORT_EVERY && L.dir && now - L.sortedAt < 100) { if (!L.timer) L.timer = setTimeout(() => { L.timer = 0; host?.requestDraw?.(); }, 100); return; }
	sortOrder(L.ctr, L.n, dir, L.order, L.keys);
	gl.bindBuffer(gl.ARRAY_BUFFER, L.ib); gl.bufferSubData(gl.ARRAY_BUFFER, 0, L.order);
	L.dir = dir; L.sortedAt = now;
}
function bindDepth(P: Program, api: SplatApi | null | undefined): void {
	const gl = glc!;
	if (!wantDepth) return;
	if (api?.depth) { api.depth.bind(gl, P.p, 3); return; }
	if (P.u.u_sceneDepthOn) gl.uniform1f(P.u.u_sceneDepthOn, 0);
	if (P.u.u_sceneDepth) { if (!dummyTex) dummyTex = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 1, 1, new Uint8Array(4)); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P.u.u_sceneDepth, 3); }
}
function drawAll(pick: boolean, s: CamState, api: SplatApi | null | undefined, w: number, h: number): void {
	const gl = glc!;
	const P = (pick ? pickProg : prog)!;
	gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
	if (pick) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
	gl.useProgram(P.p); bindDepth(P, api);
	gl.uniform2f(P.u.u_vp, w, h); gl.uniform1i(P.u.u_tw, TW);
	gl.uniform1i(P.u.u_ctr, 0); gl.uniform1i(P.u.u_cov, 1); gl.uniform1i(P.u.u_col, 2);
	const vis: Layer[] = [];
	for (const L of layers.values()) if (L.on && L.n && place(L, s, api)) vis.push(L);
	vis.sort((a, b) => b.dist - a.dist);   // 層は奥から（3D Tiles のタイルごとの層が重なる所・当たりは手前の層が勝つ）
	for (const L of vis) {
		place(L, s, api);   // mvpL をこの層の物に
		if (!pick) sortIfTurned(L);
		gl.uniformMatrix4fv(P.u.u_mvp, false, mvpL);
		gl.uniform1ui(P.u.u_base, L.base); gl.uniform1f(P.u.u_occl, L.occl ? 1 : 0);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, L.tC);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L.tV);
		gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, L.tP);
		gl.bindVertexArray(L.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, L.n);
	}
	gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(null);
}
function answerProbes(w: number, h: number): void {
	if (!probes.length) return;
	const gl = glc!;
	const ids = probes.splice(0);
	const ls = [...layers].map(([q, L]) => ({ q, on: L.on, n: L.n, dist: +L.dist.toFixed(4), anchor: L.anchor, alt: L.alt }));   // 層の目録（検定の見立て用）
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, layers: ls, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as { message?: string } | null)?.message || e) }); }
}
export function frame(cam: unknown, s: CamState, { w, h }: { w: number; h: number }, api: SplatApi): boolean {
	const gl = glc;
	if (!gl) return false;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (layers.size) drawAll(false, s, api, w, h);
	answerProbes(w, h);
	return false;
}
const decodeId = (r: number, g: number, b: number, a: number): number => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
const D2R = Math.PI / 180;
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): SplatPickResult | null {
	const gl = glc;
	if (!gl || !pickProg || !layers.size || !ctx?.s) return null;
	const { w, h } = ctx.size;
	if (pickW !== w || pickH !== h || !pickFbo) {
		if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo);
		pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h); gl.bindTexture(gl.TEXTURE_2D, null);
		pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
		pickW = w; pickH = h;
	} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	drawAll(true, ctx.s, ctx.api, w, h);
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	let best: { id: number; distance: number } | null = null;
	if (cx1 > cx0 && cy1 > cy0) {
		const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4);
		gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub);
		for (let j = 0; j < cy1 - cy0; j++) for (let i = 0; i < cx1 - cx0; i++) {
			const k = (j * (cx1 - cx0) + i) * 4, id = decodeId(sub[k], sub[k + 1], sub[k + 2], sub[k + 3]); if (!id) continue;
			const dd = Math.hypot(cx0 + i - (x0 + rr), cy0 + j - (y0 + rr));
			if (!best || dd < best.distance) best = { id, distance: dd };
		}
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	if (!best) return null;
	for (const [q, L] of layers) if (best.id >= L.base && best.id < L.base + L.n) {
		const index = best.id - L.base, e = L.ctr[index * 3], nn = L.ctr[index * 3 + 1], a = L.anchor;
		const lngLat: [number, number] = [a[0] + e / (Math.cos(a[1] * D2R) * D2R * R_SPHERE), a[1] + nn / (D2R * R_SPHERE)];
		return { id: best.id, q, layer: q, index, distance: best.distance, lngLat, properties: { ...(L.properties || {}), index } };
	}
	return null;
}
export function destroy(): void { layers.forEach(drop); layers.clear(); glc = null; }
