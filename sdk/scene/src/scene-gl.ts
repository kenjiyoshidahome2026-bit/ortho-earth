// instanced・billboard・3D 文字の描き手（同一フレームのオーバーレイ＝map.overlay・render worker の中で地球と同じ rAF・同じ cam）。@ortho-earth/scene。
// ⚠ 依存ゼロ（実行時の import 文なし・型だけの import は消える）＝render worker が URL で import() する。深度の GLSL は host.depthGLSL を貼る（建物・地形に隠れる）。
// 一つの map の全部の層（instanced／billboards／labels3d）を一つのオーバーレイ＝一つの WebGL 文脈で描く（render worker の文脈は Chrome で 4 つまで＝層ごとに作ると地球が落ちる）。
// 層は q（＝手綱の id）で分け、当たりの答えに layer: q を入れる（本体の addLayerId と組み、統一 picking が手綱の id で当たる）。
// message { type:"layer", q, kind:"mesh", mesh:{ pos, nrm, idx, col? }（局所 m・x 東 y 北 z 上）, n, ll: Float64Array(n*3)（経度・緯度・高さ m）, scl: Float32Array(n*3)（m）,
//           ori: Float32Array(n*3)（heading・pitch・roll 度）, rgba?: Uint8Array(n*4), color:[r,g,b,a 0..1], alt, depthTest, props? }
//         ／{ type:"layer", q, kind:"quad", n, ll, size: Float32Array(n*2)（units の幅・高さ）, uv: Float32Array(n*4), anchor: Float32Array(n*2)（左上 0,0・右下 1,1）,
//           angle: Float32Array(n)（度・時計回り）, rgba?, atlas:{ w, h, data: Uint8Array(w*h*4) }, facing:"screen"|"flat"|"upright", units:"pixels"|"meters", alt, depthTest, props? }
//         ／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }／{ type:"probe", id }（検定＝次の frame の後に自分の画素を host.post）
// 位置＝β 単位球（楕円体は api.rAx）。高さ relative＝地形の高さ（api.elevM×api.liftScale＝本体の持ち上げと同じ式）＋高さ m、absolute＝海面から。
// 順＝mesh を深度つきで描いてから quad（深度は読むだけ＝箱の後ろの文字は隠れる）。facing：screen＝画面に向く・flat＝地面に寝る（angle＝北からの向き）・upright＝立つ板。
// 当たり＝番号（層の底＋gl_InstanceID）を RGBA8 に焼く別パス（同じ順・同じ深度）＝見えている物だけ当たる（画像の α<0.3 は当たらない）。
import type { OverlayFrameApi } from "@ortho-earth/globe";

type GL = WebGL2RenderingContext;
interface Program { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
/** init の第 3 引数（render worker が渡す）＝深度の GLSL・描き直しの依頼・main への返事 */
export interface OverlayHost { depthGLSL?: string | null; requestDraw?(): void; post?(d: unknown): void }
/** frame の camState（render worker の内部の形＝この描き手が読む欄だけ） */
export interface CamState { mvp: ArrayLike<number>; eye: ArrayLike<number>; focal: number }
export interface OverlayCam { dpr?: number }
/** frame の api＝OverlayFrameApi のうち、この描き手が読む欄（pick の ctx.api は depth: null） */
export type SceneApi = Pick<OverlayFrameApi, "rAx" | "elevM" | "liftScale"> & { depth?: OverlayFrameApi["depth"] };
export interface PickContext { s: CamState; api: SceneApi; size: { w: number; h: number }; cam?: OverlayCam | null }
export type SceneAltitude = "relative" | "absolute";
export interface MeshPayload { pos: Float32Array; nrm: Float32Array; idx: Uint32Array; col?: Uint8Array }
export interface AtlasPayload { w: number; h: number; data: Uint8Array }
/** main（index.ts）から届く層の中身（type・q・depthTest は手綱が足す） */
export interface MeshLayerBody { kind: "mesh"; mesh: MeshPayload; n: number; ll: Float64Array; scl: Float32Array; ori: Float32Array; rgba: Uint8Array | null; color: number[]; alt: SceneAltitude; props?: unknown[] | null }
export interface QuadLayerBody { kind: "quad"; n: number; ll: Float64Array; size: Float32Array; uv: Float32Array; anchor: Float32Array; angle: Float32Array; rgba: Uint8Array | null; atlas: AtlasPayload; facing: "screen" | "flat" | "upright"; units: "pixels" | "meters"; alt: SceneAltitude; props?: unknown[] | null }
export type LayerMessage = { type: "layer"; q: string; depthTest: boolean } & (MeshLayerBody | QuadLayerBody);
export type SceneMessage = LayerMessage | { type: "remove"; q: string } | { type: "vis"; q: string; on: boolean } | { type: "clear" } | { type: "probe"; id: unknown };
/** pick の答え（統一 picking が layer で手綱に配る） */
export interface ScenePickResult { id: number; q: string; layer: string; index: number; distance: number; lngLat: [number, number]; properties: unknown }

const DEPTH_STUB = `highp float sceneOcclusion(highp vec2 uv, highp float w) { return 0.0; }`;
const MESH_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec4 a_vcol;
layout(location = 3) in vec3 a_c;
layout(location = 4) in vec3 a_e;
layout(location = 5) in vec3 a_n;
layout(location = 6) in vec3 a_u;
layout(location = 7) in vec4 a_col;
uniform mat4 u_mvp;      // mvp×平行移動(origin)（倍精度で掛けてから f32）
uniform vec3 u_origin;
uniform vec3 u_eyeRel;   // eye − origin
uniform float u_oe;      // dot(origin, eye − origin)
uniform highp uint u_base;
out vec3 v_n; out vec4 v_col; out float v_w; out vec3 v_up; out vec3 v_toEye;
flat out highp uint v_id;
void main() {
	if (u_oe - dot(u_origin, a_c) + dot(a_c, u_eyeRel) - dot(a_c, a_c) < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // 地平線の向こう
	vec3 p = a_c + a_e * a_pos.x + a_n * a_pos.y + a_u * a_pos.z;
	v_n = a_e * (a_nrm.x / max(dot(a_e, a_e), 1e-30)) + a_n * (a_nrm.y / max(dot(a_n, a_n), 1e-30)) + a_u * (a_nrm.z / max(dot(a_u, a_u), 1e-30));   // 逆転置＝A·S⁻²
	v_up = normalize(u_origin + a_c); v_toEye = u_eyeRel - p;
	v_col = a_col * a_vcol; v_id = u_base + uint(gl_InstanceID);
	vec4 c = u_mvp * vec4(p, 1.0); v_w = c.w; gl_Position = c;
}`;
const MESH_FS = (depthGLSL: string, pick: boolean): string => `#version 300 es
precision highp float;
uniform vec2 u_vp; uniform float u_occl;
${depthGLSL}
in vec3 v_n; in vec4 v_col; in float v_w; in vec3 v_up; in vec3 v_toEye;
flat in highp uint v_id;
out vec4 o;
void main() {
	if (u_occl > 0.5 && sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;   // depthTest:false の層は隠れない
	${pick ? `if (v_col.a < 0.05) discard; o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;` : `
	vec3 n = normalize(v_n); if (dot(n, v_toEye) < 0.0) n = -n;   // 両面＝裏から見ても陰影が立つ
	vec3 up = normalize(v_up), e0 = cross(up, vec3(0.0, 1.0, 0.0)); vec3 east = dot(e0, e0) < 1e-12 ? vec3(1.0, 0.0, 0.0) : normalize(e0); vec3 north = cross(east, up);
	float d = 0.55 + 0.45 * max(dot(n, normalize(up * 0.8 - east * 0.35 + north * 0.45)), 0.0);   // 北西の上からの光（基図の建物と同じ向きの印象）
	o = vec4(v_col.rgb * d * v_col.a, v_col.a);`}
}`;
const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_q;
layout(location = 1) in vec3 a_c;
layout(location = 2) in vec2 a_size;
layout(location = 3) in vec4 a_uv;
layout(location = 4) in vec2 a_anc;
layout(location = 5) in float a_ang;
layout(location = 6) in vec4 a_col;
uniform mat4 u_mvp; uniform vec3 u_origin; uniform vec3 u_eyeRel; uniform float u_oe;
uniform vec2 u_vp; uniform float u_dpr; uniform float u_focal; uniform float u_k;
uniform int u_mode; uniform int u_units; uniform highp uint u_base;
out vec2 v_uv; out vec4 v_col; out float v_w;
flat out highp uint v_id;
void main() {
	if (u_oe - dot(u_origin, a_c) + dot(a_c, u_eyeRel) - dot(a_c, a_c) < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
	vec2 off = vec2((a_q.x - a_anc.x) * a_size.x, (a_anc.y - a_q.y) * a_size.y);   // 錨からの位置（右＋・上＋）
	float an = -radians(a_ang), ca = cos(an), sa = sin(an);
	vec4 c0 = u_mvp * vec4(a_c, 1.0);
	float s = u_units == 1 ? u_k : c0.w / u_focal * u_dpr;   // 1 単位あたりの世界の長さ（m なら 1/R・px なら中心の奥行きでの 1 px）
	v_uv = vec2(mix(a_uv.x, a_uv.z, a_q.x), mix(a_uv.y, a_uv.w, a_q.y)); v_col = a_col; v_id = u_base + uint(gl_InstanceID);
	if (u_mode == 0) {
		vec2 r = vec2(off.x * ca - off.y * sa, off.x * sa + off.y * ca);
		vec2 px = u_units == 1 ? r * u_k * u_focal / max(c0.w, 1e-12) : r * u_dpr;
		gl_Position = vec4(c0.xy + px * 2.0 / u_vp * c0.w, c0.z, c0.w); v_w = c0.w; return;
	}
	vec3 up = normalize(u_origin + a_c), e0 = cross(up, vec3(0.0, 1.0, 0.0)); vec3 east = dot(e0, e0) < 1e-12 ? vec3(1.0, 0.0, 0.0) : normalize(e0); vec3 north = cross(east, up);
	vec3 p;
	if (u_mode == 1) { vec3 rx = east * ca + north * sa, ry = -east * sa + north * ca; p = a_c + (rx * off.x + ry * off.y) * s; }   // 寝る＝東北の面で回す
	else { vec3 rx = east * ca + north * sa; p = a_c + (rx * off.x + up * off.y) * s; }   // 立つ＝右手を回し・上はそのまま
	vec4 c = u_mvp * vec4(p, 1.0); v_w = c.w; gl_Position = c;
}`;
const QUAD_FS = (depthGLSL: string, pick: boolean): string => `#version 300 es
precision highp float;
uniform vec2 u_vp; uniform float u_occl; uniform sampler2D u_tex;
${depthGLSL}
in vec2 v_uv; in vec4 v_col; in float v_w;
flat in highp uint v_id;
out vec4 o;
void main() {
	if (u_occl > 0.5 && sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;   // depthTest:false の層は隠れない
	vec4 t = texture(u_tex, v_uv) * v_col;
	${pick ? `if (t.a < 0.3) discard; o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;` : `if (t.a < 0.004) discard; o = vec4(t.rgb * t.a, t.a);`}
}`;
// 層（GPU に載せた物）。mesh と quad で持ち物が違う
interface LayerBase {
	occl: boolean; cst: number[] | null; n: number; ll: Float64Array; alt: SceneAltitude; props: unknown[] | null;
	vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; cbuf: WebGLBuffer; on: boolean; base: number;
	rAx: number | null; origin: number[] | null; centers?: Float64Array | null; liftKey: string | null; refreshAt: number; timer?: number; recheck?: number;
}
interface MeshLayer extends LayerBase { kind: "mesh"; vcol: boolean; scl: Float32Array; ori: Float32Array; ebuf: WebGLBuffer; nbuf: WebGLBuffer; ubuf: WebGLBuffer; count: number }
interface QuadLayer extends LayerBase { kind: "quad"; mode: number; units: number; tex: WebGLTexture }
type Layer = MeshLayer | QuadLayer;
let glc: GL | null = null, host: OverlayHost | null = null, wantDepth = false, quad: WebGLBuffer | null = null, dummyTex: WebGLTexture | null = null;
let mesh: Program | null = null, meshPick: Program | null = null, quadP: Program | null = null, quadPick: Program | null = null;   // { p, u }
let pickFbo: WebGLFramebuffer | null = null, pickTex: WebGLTexture | null = null, pickDepth: WebGLRenderbuffer | null = null, pickW = 0, pickH = 0;
const layers = new Map<string, Layer>(), probes: unknown[] = [];
const R_SPHERE = 6371000, R_ELL = 6378137;
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
	const gl = glc = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: true });
	if (!gl) throw new Error("WebGL2 is not available (scene overlay)");
	wantDepth = opts.depth !== false && !!h?.depthGLSL;
	const dg = wantDepth && h?.depthGLSL ? h.depthGLSL : DEPTH_STUB;
	mesh = compile(MESH_VS, MESH_FS(dg, false)); quadP = compile(QUAD_VS, QUAD_FS(dg, false));
	try { meshPick = compile(MESH_VS, MESH_FS(dg, true)); quadPick = compile(QUAD_VS, QUAD_FS(dg, true)); } catch (e) { meshPick = quadPick = null; console.warn("[scene] pick pass unavailable", (e as { message?: string } | null)?.message); }
	quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
	return wantDepth ? { depth: true } : undefined;
}
// 経緯度 → β 単位球（楕円体は tanβ＝rAx·tanφ）
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * Math.PI / 180; let b = lat * Math.PI / 180; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
// 局所の基底（東・北・上）×向き（heading 北から時計回り・pitch 機首上げ・roll 右翼下げ）×大きさ（m → 単位球）＝列 3 本
export function basisOf(lon: number, lat: number, sx: number, sy: number, sz: number, hd: number, pt: number, rl: number, rAx = 1): number[][] {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	const h = -hd * Math.PI / 180, p = pt * Math.PI / 180, r = rl * Math.PI / 180;
	const Rz = [[Math.cos(h), -Math.sin(h), 0], [Math.sin(h), Math.cos(h), 0], [0, 0, 1]], Rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]], Ry = [[Math.cos(r), 0, Math.sin(r)], [0, 1, 0], [-Math.sin(r), 0, Math.cos(r)]];
	const mm = (A: number[][], B: number[][]): number[][] => A.map((row, i) => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
	const M = mm(mm(Rz, Rx), Ry), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL), S = [sx * k, sy * k, sz * k];
	return [0, 1, 2].map(j => [0, 1, 2].map(c => (E[c] * M[0][j] + N[c] * M[1][j] + u[c] * M[2][j]) * S[j]));   // 列 j＝局所軸 j の世界での向き×大きさ
}
const MODES: Record<string, number | undefined> = { screen: 0, flat: 1, upright: 2 };
const drop = (L: Layer | undefined): void => { if (!L) return; const gl = glc!; clearTimeout(L.timer); clearTimeout(L.recheck); for (const b of L.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(L.vao); if (L.kind === "quad" && L.tex) gl.deleteTexture(L.tex); };
function buildMesh(d: LayerMessage & MeshLayerBody): MeshLayer {
	const gl = glc!;
	const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
	const bufs: WebGLBuffer[] = [];
	const attr = (loc: number, arr: ArrayBufferView, size: number, type: number, norm: boolean, div = 0, usage: number = gl.STATIC_DRAW): WebGLBuffer => { const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, usage); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); gl.vertexAttribDivisor(loc, div); bufs.push(b); return b; };
	attr(0, d.mesh.pos, 3, gl.FLOAT, false); attr(1, d.mesh.nrm, 3, gl.FLOAT, false);
	if (d.mesh.col) attr(2, d.mesh.col, 4, gl.UNSIGNED_BYTE, true); else { gl.disableVertexAttribArray(2); gl.vertexAttrib4f(2, 1, 1, 1, 1); }
	const n = d.n, cbuf = attr(3, new Float32Array(n * 3), 3, gl.FLOAT, false, 1, gl.DYNAMIC_DRAW);
	const ebuf = attr(4, new Float32Array(n * 3), 3, gl.FLOAT, false, 1), nbuf = attr(5, new Float32Array(n * 3), 3, gl.FLOAT, false, 1), ubuf = attr(6, new Float32Array(n * 3), 3, gl.FLOAT, false, 1);
	if (d.rgba) attr(7, d.rgba, 4, gl.UNSIGNED_BYTE, true, 1); else { gl.disableVertexAttribArray(7); const c = d.color || [0.85, 0.85, 0.85, 1]; gl.vertexAttrib4f(7, c[0], c[1], c[2], c[3] ?? 1); }
	const ib = gl.createBuffer()!; gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.mesh.idx, gl.STATIC_DRAW); bufs.push(ib);
	gl.bindVertexArray(null);
	return { kind: "mesh", occl: d.depthTest !== false, vcol: !d.mesh.col, cst: d.rgba ? null : (d.color || [0.85, 0.85, 0.85, 1]), n, ll: d.ll, scl: d.scl, ori: d.ori, alt: d.alt || "relative", props: d.props || null, vao, bufs, cbuf, ebuf, nbuf, ubuf, count: d.mesh.idx.length, on: true, base: 0, rAx: null, origin: null, centers: null, liftKey: null, refreshAt: 0 };
}
function buildQuad(d: LayerMessage & QuadLayerBody): QuadLayer {
	const gl = glc!;
	const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
	const bufs: WebGLBuffer[] = [];
	gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	const attr = (loc: number, arr: ArrayBufferView, size: number, type: number, norm: boolean, usage: number = gl.STATIC_DRAW): WebGLBuffer => { const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, usage); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); gl.vertexAttribDivisor(loc, 1); bufs.push(b); return b; };
	const n = d.n, cbuf = attr(1, new Float32Array(n * 3), 3, gl.FLOAT, false, gl.DYNAMIC_DRAW);
	attr(2, d.size, 2, gl.FLOAT, false); attr(3, d.uv, 4, gl.FLOAT, false); attr(4, d.anchor, 2, gl.FLOAT, false); attr(5, d.angle, 1, gl.FLOAT, false);
	if (d.rgba) attr(6, d.rgba, 4, gl.UNSIGNED_BYTE, true); else { gl.disableVertexAttribArray(6); gl.vertexAttrib4f(6, 1, 1, 1, 1); }
	gl.bindVertexArray(null);
	const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.atlas.w, d.atlas.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.atlas.data);
	gl.generateMipmap(gl.TEXTURE_2D);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return { kind: "quad", occl: d.depthTest !== false, cst: d.rgba ? null : [1, 1, 1, 1], n, ll: d.ll, alt: d.alt || "relative", mode: MODES[d.facing] ?? 0, units: d.units === "meters" ? 1 : 0, props: d.props || null, vao, bufs, cbuf, tex, on: true, base: 0, rAx: null, origin: null, liftKey: null, refreshAt: 0 };
}
function rebase(): void { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
export function message(d: SceneMessage): void {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!glc) return;
	if (d.type === "layer") { drop(layers.get(d.q)); layers.set(d.q, d.kind === "quad" ? buildQuad(d) : buildMesh(d)); rebase(); host?.requestDraw?.(); }
	else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
}
// mesh＝基底（rAx が変わった時だけ）と中心（refreshCenters）
function prepareMesh(L: MeshLayer, api: SceneApi): void {
	const gl = glc!;
	const rAx = api?.rAx || 1, n = L.n;
	if (L.rAx !== rAx) {
		const E = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			const B = basisOf(L.ll[i * 3], L.ll[i * 3 + 1], L.scl[i * 3], L.scl[i * 3 + 1], L.scl[i * 3 + 2], L.ori[i * 3], L.ori[i * 3 + 1], L.ori[i * 3 + 2], rAx);
			E.set(B[0], i * 3); N.set(B[1], i * 3); U.set(B[2], i * 3);
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, L.ebuf); gl.bufferData(gl.ARRAY_BUFFER, E, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, L.nbuf); gl.bufferData(gl.ARRAY_BUFFER, N, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, L.ubuf); gl.bufferData(gl.ARRAY_BUFFER, U, gl.STATIC_DRAW);
		L.rAx = rAx; L.liftKey = null;
	}
	refreshCenters(L, api, rAx);
}
function prepareQuad(L: QuadLayer, api: SceneApi): void {
	const rAx = api?.rAx || 1;
	if (L.rAx !== rAx) { L.rAx = rAx; L.origin = null; L.liftKey = null; }
	refreshCenters(L, api, rAx);
}
// 中心（地形の持ち上げ込み・原点からの差を f32 で）。relative は地形のタイルが後から届く＝引き直す：数が少なければ毎フレーム、多ければ 0.5 秒おき
// （間が空く時は描き直しを頼む）。値が変わったら 0.6 秒後にもう一度描き直しを頼む＝静止した画面でも届いた地形に追いつく（変わらなくなれば止む）
const CHEAP = 2000;
function refreshCenters(L: Layer, api: SceneApi, rAx: number): void {
	const gl = glc!;
	const rel = L.alt !== "absolute", ls = rel ? (api?.liftScale || 0) : 0, key = `${rAx}|${ls}`, now = performance.now(), live = rel && ls > 0;
	if (L.liftKey === key && !(live && (L.n <= CHEAP || now >= L.refreshAt))) {
		if (live && !L.timer) L.timer = setTimeout(() => { L.timer = 0; host?.requestDraw?.(); }, Math.max(16, L.refreshAt - now));
		return;
	}
	const n = L.n, k = 1 / (rAx === 1 ? R_SPHERE : R_ELL), C = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		const lon = L.ll[i * 3], lat = L.ll[i * 3 + 1], u = unit(lon, lat, rAx), r = 1 + (ls > 0 ? (api.elevM(lon, lat) || 0) * ls : 0) + (L.ll[i * 3 + 2] || 0) * k;
		C[i * 3] = u[0] * r; C[i * 3 + 1] = u[1] * r; C[i * 3 + 2] = u[2] * r;
	}
	L.refreshAt = now + 500;
	if (L.liftKey === key && L.centers && C.every((v, i) => v === L.centers![i])) return;
	if (!L.origin) { let x = 0, y = 0, z = 0; for (let i = 0; i < n; i++) { x += C[i * 3]; y += C[i * 3 + 1]; z += C[i * 3 + 2]; } L.origin = n ? [x / n, y / n, z / n] : [0, 0, 0]; }
	const F = new Float32Array(n * 3), o = L.origin;
	for (let i = 0; i < n; i++) { F[i * 3] = C[i * 3] - o[0]; F[i * 3 + 1] = C[i * 3 + 1] - o[1]; F[i * 3 + 2] = C[i * 3 + 2] - o[2]; }
	gl.bindBuffer(gl.ARRAY_BUFFER, L.cbuf); gl.bufferData(gl.ARRAY_BUFFER, F, gl.DYNAMIC_DRAW);
	L.centers = C; L.liftKey = key;
	if (live) { clearTimeout(L.recheck); L.recheck = setTimeout(() => host?.requestDraw?.(), 600); }
}
function bindDepth(P: WebGLProgram, U: Program["u"], api: SceneApi): void {
	if (!wantDepth) return;
	const gl = glc!;
	if (api?.depth) { api.depth.bind(gl, P, 3); return; }
	// 深度の無いフレーム（当たりの別パス・申し出前）＝標本器を空の 1×1 に向ける（既定の unit 0 に当たりの FBO の色が残っていると読み書きの輪で描けない）
	if (U.u_sceneDepthOn) gl.uniform1f(U.u_sceneDepthOn, 0);
	if (U.u_sceneDepth) { if (!dummyTex) { dummyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(U.u_sceneDepth, 3); }
}
const mvpL = new Float32Array(16);
function placeLayer(U: Program["u"], s: CamState, L: Layer): void {   // 層の原点へ平行移動した mvp（倍精度で掛けてから f32）と地平線の判定の係数
	const gl = glc!;
	const M = s.mvp, E = s.eye, o = L.origin!;
	for (let i = 0; i < 12; i++) mvpL[i] = M[i];
	for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];
	gl.uniformMatrix4fv(U.u_mvp, false, mvpL); gl.uniform3f(U.u_origin, o[0], o[1], o[2]);
	const ex = E[0] - o[0], ey = E[1] - o[1], ez = E[2] - o[2];
	gl.uniform3f(U.u_eyeRel, ex, ey, ez); gl.uniform1f(U.u_oe, o[0] * ex + o[1] * ey + o[2] * ez);
	if (U.u_base) gl.uniform1ui(U.u_base, L.base);
	if (U.u_occl) gl.uniform1f(U.u_occl, L.occl ? 1 : 0);
}
function drawAll(pick: boolean, s: CamState, api: SceneApi, w: number, h: number, dpr: number): void {
	const gl = glc!;
	const PM = (pick ? meshPick : mesh)!, PQ = (pick ? quadPick : quadP)!;
	gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
	if (pick) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
	let used = false;
	for (const L of layers.values()) {   // ① mesh（深度を書く）
		if (L.kind !== "mesh" || !L.on || !L.n) continue;
		if (!used) { gl.useProgram(PM.p); bindDepth(PM.p, PM.u, api); gl.uniform2f(PM.u.u_vp, w, h); gl.depthMask(true); used = true; }
		prepareMesh(L, api); placeLayer(PM.u, s, L);
		if (L.vcol) gl.vertexAttrib4f(2, 1, 1, 1, 1);   // 切った属性の定数は VAO でなく文脈の状態＝層ごとに描く直前に置く
		if (L.cst) gl.vertexAttrib4f(7, L.cst[0], L.cst[1], L.cst[2], L.cst[3] ?? 1);
		gl.bindVertexArray(L.vao); gl.drawElementsInstanced(gl.TRIANGLES, L.count, gl.UNSIGNED_INT, 0, L.n);
	}
	used = false;
	for (const L of layers.values()) {   // ② quad（深度は読むだけ）
		if (L.kind !== "quad" || !L.on || !L.n) continue;
		if (!used) { gl.useProgram(PQ.p); bindDepth(PQ.p, PQ.u, api); gl.uniform2f(PQ.u.u_vp, w, h); gl.uniform1f(PQ.u.u_dpr, dpr); gl.uniform1f(PQ.u.u_focal, s.focal); gl.depthMask(false); used = true; }
		prepareQuad(L, api); placeLayer(PQ.u, s, L);
		if (L.cst) gl.vertexAttrib4f(6, 1, 1, 1, 1);
		gl.uniform1f(PQ.u.u_k, 1 / (L.rAx === 1 ? R_SPHERE : R_ELL)); gl.uniform1i(PQ.u.u_mode, L.mode); gl.uniform1i(PQ.u.u_units, L.units);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, L.tex); gl.uniform1i(PQ.u.u_tex, 0);
		gl.bindVertexArray(L.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, L.n);
	}
	gl.bindVertexArray(null); gl.depthMask(true); gl.disable(gl.DEPTH_TEST);
}
function answerProbes(w: number, h: number): void {
	if (!probes.length) return;
	const gl = glc!;
	const ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as { message?: string } | null)?.message || e) }); }
}
export function frame(cam: OverlayCam | null | undefined, s: CamState, { w, h }: { w: number; h: number }, api: SceneApi): boolean {
	const gl = glc;
	if (!gl) return false;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	if (layers.size) drawAll(false, s, api, w, h, cam?.dpr || 1);
	answerProbes(w, h);
	return false;
}
const decodeId = (r: number, g: number, b: number, a: number): number => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): ScenePickResult | null {
	const gl = glc;
	if (!gl || !meshPick || !layers.size || !ctx?.s) return null;
	const { w, h } = ctx.size;
	if (pickW !== w || pickH !== h || !pickFbo) {
		if (pickTex) gl.deleteTexture(pickTex); if (pickDepth) gl.deleteRenderbuffer(pickDepth); if (pickFbo) gl.deleteFramebuffer(pickFbo);
		pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h); gl.bindTexture(gl.TEXTURE_2D, null);
		pickDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
		pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
		pickW = w; pickH = h;
	} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	drawAll(true, ctx.s, ctx.api, w, h, ctx.cam?.dpr || 1);
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
		const index = best.id - L.base;
		return { id: best.id, q, layer: q, index, distance: best.distance, lngLat: [L.ll[index * 3], L.ll[index * 3 + 1]], properties: L.props?.[index] ?? { index } };
	}
	return null;
}
export function destroy(): void {
	const gl = glc;
	if (!gl) return;
	layers.forEach(drop); layers.clear();
	for (const P of [mesh, meshPick, quadP, quadPick]) if (P) gl.deleteProgram(P.p);
	gl.deleteBuffer(quad); if (dummyTex) gl.deleteTexture(dummyTex);
	if (pickTex) gl.deleteTexture(pickTex); if (pickDepth) gl.deleteRenderbuffer(pickDepth); if (pickFbo) gl.deleteFramebuffer(pickFbo);
	glc = null;
}
