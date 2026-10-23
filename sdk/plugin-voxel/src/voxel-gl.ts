// voxel の WebGL2 の描き手（同一フレームのオーバーレイ＝map.overlay・render worker の中で地球と同じ rAF・同じ cam）。@ortho-earth/plugin-voxel（2026-10-23）。
// ⚠ 依存ゼロ（実行時の import 文なし・型だけの import は消える）＝render worker が URL で import() する。深度の GLSL は host.depthGLSL を貼る（建物・地形に隠れる）。
// 一つの map の全部の層を一つのオーバーレイ＝一つの WebGL 文脈で描く（render worker の文脈は Chrome で 4 つまで）。当たりの答えに layer: q（本体の addLayerId と組む）。
// message { type:"layer", q, dims, comps, tex（R8 か RGBA8）, cmap（256×RGBA8）, anchor:[lng,lat,alt], alt:"relative"|"absolute", A: Float64Array(9)（セル → 東北上 m・行優先）, radius（m）,
//           mode: 0（blocks）|1（volume）, thr（0〜1）, step（セル）, opacity, depthTest, properties?, range, on }／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }／{ type:"probe", id }（検定）
// 描き方＝格子を包む箱（セル空間 [0, dims]）の裏面（cullFace FRONT＝目が箱の中でも描ける）を描き、FS で目からの光線をセル空間に入れて辿る：
//   blocks＝DDA（Amanatides–Woo）で最初の空でないセルに止まり、面の法線（東北上）で陰影。volume＝一定の刻みで三線形に引き、色表の色と α を前から重ねる（α が 0.98 を越えたら打ち切り）。
//   シーンの深度＝対数深度を w に戻し（w＝exp2(2·s/logCoef)−1）、光線はそこで止まる（w は光線に沿って線形＝mvp の第 4 行）。
// 当たり＝止まったセルの番号を RGBA8 に焼く別パス（volume は積算の α が 0.5 を越えたセル）。
// 精度＝目の位置（セル空間）と箱の mvp は CPU の倍精度で作る（RTE・plugin-splat と同じ）。
import type { OverlayFrameApi } from "@ortho-earth/globe";

type GL = WebGL2RenderingContext;
interface Program { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
export interface OverlayHost { depthGLSL?: string | null; requestDraw?(): void; post?(d: unknown): void; gpuDevice?(): GPUDevice | null }
export interface CamState { mvp: ArrayLike<number>; eye?: ArrayLike<number> | null }
export type VoxelApi = Pick<OverlayFrameApi, "rAx" | "elevM" | "liftScale"> & { depth?: OverlayFrameApi["depth"] };
export interface PickContext { s: CamState; api: VoxelApi; size: { w: number; h: number } }
export type VoxelAltitude = "relative" | "absolute";
export interface VoxelLayerBody { dims: [number, number, number]; comps: 1 | 4; tex: Uint8Array; cmap: Uint8Array; anchor: [number, number, number]; alt?: VoxelAltitude; A: Float64Array | ArrayLike<number>; radius: number; mode: 0 | 1; thr: number; step: number; opacity: number; depthTest?: boolean; properties?: Record<string, unknown> | null; range: [number, number]; on?: boolean }
export type VoxelMessage = ({ type: "layer"; q: string } & VoxelLayerBody) | { type: "remove"; q: string } | { type: "vis"; q: string; on: boolean } | { type: "clear" } | { type: "probe"; id: unknown };
export interface VoxelPickResult { id: number; q: string; layer: string; index: number; cell: [number, number, number]; value: number | null; distance: number; lngLat: [number, number]; properties: Record<string, unknown> & { index: number; cell: [number, number, number]; value: number | null } }
export interface EnuBasis { E: number[]; N: number[]; U: number[]; u: number[] }

// 深度の無い時の代わり（DEPTH_GLSL と同じ名前＝FS は同じ字で書ける）
const DEPTH_STUB = `uniform highp float u_sceneLogCoef; uniform highp float u_sceneDepthOn; highp float sceneDepthAt(highp vec2 uv) { return 1.0; }`;
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
uniform mat4 u_mvp; uniform vec3 u_dims;
out vec3 v_p;
void main() { v_p = a_pos * u_dims; gl_Position = u_mvp * vec4(v_p, 1.0); }`;
const FS = (depthGLSL: string, pick: boolean): string => `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
${depthGLSL}
uniform mat4 u_mvp; uniform vec3 u_dims; uniform vec3 u_eye; uniform vec2 u_vp;
uniform highp sampler3D u_vol; uniform sampler2D u_cmap;
uniform int u_mode; uniform int u_comps; uniform int u_maxSteps;
uniform float u_thr; uniform float u_step; uniform float u_opacity; uniform float u_occl;
uniform mat3 u_nrm; uniform vec3 u_light; uniform highp uint u_base;
in vec3 v_p;
out vec4 o;
// セルの値（R8＝0 は空・1〜255 → 0〜1。RGBA＝そのまま・α 0 は空）
vec4 cellColor(ivec3 c, out bool solid) {
	vec4 s = texelFetch(u_vol, c, 0);
	if (u_comps == 4) { solid = s.a > 0.0; return s; }
	float vn = (s.r * 255.0 - 1.0) / 254.0;
	solid = s.r > 0.0 && vn >= u_thr;
	return texture(u_cmap, vec2(vn, 0.5));
}
${pick ? `vec4 encode(highp uint id) { return vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float((id >> 24) & 255u)) / 255.0; }
highp uint cellId(ivec3 c) { return u_base + uint(c.x + int(u_dims.x) * (c.y + int(u_dims.y) * c.z)); }` : ""}
void main() {
	vec3 ro = u_eye, rd = normalize(v_p - ro);
	// 箱 [0, dims] との交わり
	vec3 inv = 1.0 / rd;   // rd の 0 は ±inf＝下の min/max で消える
	vec3 ta = -ro * inv, tb = (u_dims - ro) * inv, tmin = min(ta, tb), tmax = max(ta, tb);
	float t0 = max(max(tmin.x, tmin.y), tmin.z), t1 = min(min(tmax.x, tmax.y), tmax.z);
	int axis0 = t0 == tmin.x ? 0 : t0 == tmin.y ? 1 : 2;
	bool inside = t0 < 0.0;
	t0 = max(t0, 0.0);
	// シーンの深度＝光線を w がそこへ届く所で切る（w は光線に沿って線形）
	if (u_occl > 0.5 && u_sceneDepthOn > 0.5) {
		float s = sceneDepthAt(gl_FragCoord.xy / u_vp);
		if (s < 1.0) {
			float ws = exp2(2.0 * s / u_sceneLogCoef) - 1.0;
			float w0 = dot(vec4(ro, 1.0), vec4(u_mvp[0][3], u_mvp[1][3], u_mvp[2][3], u_mvp[3][3])), dw = dot(rd, vec3(u_mvp[0][3], u_mvp[1][3], u_mvp[2][3]));
			if (dw > 1e-12) t1 = min(t1, (ws - w0) / dw);
		}
	}
	if (t1 <= t0) discard;
	if (u_mode == 0) {   // blocks＝DDA
		vec3 p = ro + rd * (t0 + 1e-4);
		ivec3 c = clamp(ivec3(floor(p)), ivec3(0), ivec3(u_dims) - 1);
		ivec3 st = ivec3(sign(rd));
		vec3 tMax = (vec3(c) + vec3(greaterThan(rd, vec3(0.0))) - ro) * inv, tDelta = abs(inv);
		int axis = inside ? -1 : axis0;
		for (int i = 0; i < 1024; i++) {
			if (i >= u_maxSteps) break;
			bool solid; vec4 col = cellColor(c, solid);
			if (solid) {
				${pick ? `o = encode(cellId(c)); return;` : `
				vec3 nc = axis < 0 ? -rd : (axis == 0 ? vec3(-float(st.x), 0.0, 0.0) : axis == 1 ? vec3(0.0, -float(st.y), 0.0) : vec3(0.0, 0.0, -float(st.z)));
				vec3 ne = normalize(u_nrm * nc);
				float l = 0.55 + 0.45 * max(0.0, dot(ne, u_light));
				float a = u_opacity;
				o = vec4(col.rgb * l * a, a); return;`}
			}
			if (tMax.x < tMax.y && tMax.x < tMax.z) { if (tMax.x > t1) break; c.x += st.x; tMax.x += tDelta.x; axis = 0; }
			else if (tMax.y < tMax.z) { if (tMax.y > t1) break; c.y += st.y; tMax.y += tDelta.y; axis = 1; }
			else { if (tMax.z > t1) break; c.z += st.z; tMax.z += tDelta.z; axis = 2; }
			if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, ivec3(u_dims)))) break;
		}
		discard;
	}
	// volume＝一定の刻み（セル）で三線形に引いて前から重ねる。刻みの位相を画素ごとに散らす（縞を消す）
	float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
	float t = t0 + u_step * (0.25 + 0.5 * jit);
	vec4 acc = vec4(0.0);
	for (int i = 0; i < 4096; i++) {
		if (i >= u_maxSteps || t >= t1) break;
		vec3 p = ro + rd * t;
		vec4 s = texture(u_vol, p / u_dims);
		vec4 col; float a;
		if (u_comps == 4) { col = s; a = s.a; }
		else { float vn = (s.r * 255.0 - 1.0) / 254.0; if (s.r > 0.5 / 255.0 && vn >= u_thr) { col = texture(u_cmap, vec2(max(vn, 0.0), 0.5)); a = col.a; } else { col = vec4(0.0); a = 0.0; } }
		if (a > 0.0) {
			a = 1.0 - pow(1.0 - min(a * u_opacity, 0.999), u_step);
			acc.rgb += (1.0 - acc.a) * col.rgb * a; acc.a += (1.0 - acc.a) * a;
			${pick ? `if (acc.a >= 0.5) { o = encode(cellId(clamp(ivec3(floor(p)), ivec3(0), ivec3(u_dims) - 1))); return; }` : `if (acc.a > 0.98) break;`}
		}
		t += u_step;
	}
	${pick ? `discard;` : `if (acc.a < 1.0 / 255.0) discard; o = acc;`}
}`;
interface Layer {
	dims: [number, number, number]; comps: 1 | 4; n: number; anchor: [number, number, number]; alt: VoxelAltitude; A: Float64Array; Ainv: Float64Array; radius: number;
	mode: 0 | 1; thr: number; step: number; opacity: number; occl: boolean; properties: Record<string, unknown> | null; range: [number, number];
	tex: WebGLTexture; cmap: WebGLTexture; on: boolean; base: number; dist: number; nrm: Float32Array;
}
let glc: GL | null = null, host: OverlayHost | null = null, prog: Program | null = null, pickProg: Program | null = null, boxVao: WebGLVertexArrayObject | null = null, wantDepth = false, dummyTex: WebGLTexture | null = null, max3d = 256;
let pickFbo: WebGLFramebuffer | null = null, pickTex: WebGLTexture | null = null, pickW = 0, pickH = 0;
const layers = new Map<string, Layer>(), probes: unknown[] = [];
const R_SPHERE = 6371000, R_ELL = 6378137, D2R = Math.PI / 180;
const LIGHT = ((): number[] => { const v = [-0.35, 0.45, 0.82], l = Math.hypot(...v); return v.map(x => x / l); })();   // 東北上＝北西の上から
function compile(vs: string, fs: string): Program {
	const gl = glc!;
	const mk = (type: number, src: string): WebGLShader => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s))); return s; };
	const p = gl.createProgram()!; gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)));
	const u: Record<string, WebGLUniformLocation | null> = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number; i < n; i++) { const nm = gl.getActiveUniform(p, i)!.name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
// 単位立方体の 12 枚の三角形（外向きの CCW）＝cullFace(FRONT) で裏面だけ描く
const BOX = ((): Float32Array => {
	const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];   // -z +z -x +x +y -y（各面を外から見て CCW）
	const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
	const out: number[] = [];
	for (const [a, b, c, d] of f) for (const i of [a, c, b, a, d, c]) out.push(...v[i]);
	return new Float32Array(out);
})();
export function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null): { depth: true } | undefined {
	host = h;
	const gl = glc = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (plugin-voxel overlay)");
	wantDepth = opts.depth !== false && !!h?.depthGLSL;
	const dg = wantDepth && h?.depthGLSL ? h.depthGLSL : DEPTH_STUB;
	prog = compile(VS, FS(dg, false));
	try { pickProg = compile(VS, FS(dg, true)); } catch (e) { pickProg = null; console.warn("[plugin-voxel] pick pass unavailable", (e as { message?: string } | null)?.message); }
	max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number || 256;
	boxVao = gl.createVertexArray(); gl.bindVertexArray(boxVao);
	const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, BOX, gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	return wantDepth ? { depth: true } : undefined;
}
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * D2R; let b = lat * D2R; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
/** 錨の東北上 m → 単位球（列＝東・北・上×1/R） */
export function enuBasis(lon: number, lat: number, rAx = 1): EnuBasis {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	return { E: E.map(v => v * k), N: N.map(v => v * k), U: u.map(v => v * k), u };
}
function inv3(m: ArrayLike<number>): Float64Array {
	const [a, b, c, d, e, f, g, h, i] = Array.from(m, Number);
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C, k = 1 / det;
	return Float64Array.from([A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k]);
}
function build(d: VoxelLayerBody): Layer {
	const gl = glc!;
	const [nx, ny, nz] = d.dims;
	if (nx > max3d || ny > max3d || nz > max3d) throw new Error(`plugin-voxel: dims ${d.dims.join("×")} exceed MAX_3D_TEXTURE_SIZE ${max3d}`);
	const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_3D, tex);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	if (d.comps === 4) gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, nx, ny, nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.tex);
	else gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, nx, ny, nz, 0, gl.RED, gl.UNSIGNED_BYTE, d.tex);
	for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
	gl.bindTexture(gl.TEXTURE_3D, null);
	const cmap = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, cmap);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.cmap);
	for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
	gl.bindTexture(gl.TEXTURE_2D, null);
	const A = Float64Array.from(d.A as ArrayLike<number>), Ainv = inv3(A);
	// 法線の行列＝セルの軸 → 東北上の単位ベクトル（A の列を正規化・GL の列優先）
	const nrm = new Float32Array(9);
	for (let c = 0; c < 3; c++) { const l = Math.hypot(A[c], A[3 + c], A[6 + c]) || 1; nrm[c * 3] = A[c] / l; nrm[c * 3 + 1] = A[3 + c] / l; nrm[c * 3 + 2] = A[6 + c] / l; }
	return { dims: [nx, ny, nz], comps: d.comps, n: nx * ny * nz, anchor: d.anchor, alt: d.alt || "relative", A, Ainv, radius: d.radius || 0, mode: d.mode, thr: d.thr || 0, step: d.step || 0.5, opacity: d.opacity ?? 1, occl: d.depthTest !== false, properties: d.properties ?? null, range: d.range, tex, cmap, on: d.on !== false, base: 0, dist: 0, nrm };
}
const drop = (L: Layer | undefined): void => { if (!L) return; const gl = glc!; gl.deleteTexture(L.tex); gl.deleteTexture(L.cmap); };
function rebase(): void { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
export function message(d: VoxelMessage): void {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!glc) return;
	if (d.type === "layer") {
		drop(layers.get(d.q)); layers.delete(d.q);
		try { layers.set(d.q, build(d)); } catch (e) { host?.post?.({ type: "error", q: d.q, error: String((e as { message?: string } | null)?.message || e) }); }
		rebase(); host?.requestDraw?.();
	}
	else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
}
// 層の mvp（セル空間 → clip＝mvp × [E N U o] × A・倍精度で掛けてから f32）と、目のセル空間の位置
const mvpL = new Float64Array(16), mvpC = new Float32Array(16), eyeC = new Float32Array(3);
function place(L: Layer, s: CamState, api: VoxelApi | null | undefined): boolean {
	const rAx = api?.rAx || 1, [lon, lat, alt] = L.anchor, B = enuBasis(lon, lat, rAx), R = rAx === 1 ? R_SPHERE : R_ELL, k = 1 / R;
	const ls = L.alt !== "absolute" ? (api?.liftScale || 0) : 0, r = 1 + (ls > 0 ? (api!.elevM(lon, lat) || 0) * ls : 0) + (alt || 0) * k;
	const o = [B.u[0] * r, B.u[1] * r, B.u[2] * r], M = s.mvp, cols = [B.E, B.N, B.U];
	for (let j = 0; j < 3; j++) for (let row = 0; row < 4; row++) mvpL[j * 4 + row] = M[row] * cols[j][0] + M[4 + row] * cols[j][1] + M[8 + row] * cols[j][2];
	for (let row = 0; row < 4; row++) mvpL[12 + row] = M[row] * o[0] + M[4 + row] * o[1] + M[8 + row] * o[2] + M[12 + row];
	// × A（セル → 東北上 m・行優先）＝列 c の clip ベクトル＝Σ_j mvpL 列 j × A[j][c]
	const A = L.A;
	for (let c = 0; c < 3; c++) for (let row = 0; row < 4; row++) mvpC[c * 4 + row] = mvpL[row] * A[c] + mvpL[4 + row] * A[3 + c] + mvpL[8 + row] * A[6 + c];
	for (let row = 0; row < 4; row++) mvpC[12 + row] = mvpL[12 + row];
	const E = s.eye;
	if (!E) return false;
	// 目 → 東北上 m → セル空間
	const d = [E[0] - o[0], E[1] - o[1], E[2] - o[2]], enu = [0, 0, 0];
	for (let j = 0; j < 3; j++) enu[j] = (d[0] * cols[j][0] + d[1] * cols[j][1] + d[2] * cols[j][2]) * R * R;   // 列は 1/R 倍の単位ベクトル＝内積 ×R で単位球の長さ・×R で m
	const Ai = L.Ainv;
	for (let i = 0; i < 3; i++) eyeC[i] = Ai[i * 3] * enu[0] + Ai[i * 3 + 1] * enu[1] + Ai[i * 3 + 2] * enu[2];
	L.dist = Math.hypot(d[0], d[1], d[2]);
	const rr = L.radius * k;   // 地平線の向こう（錨の半径ぶんの余裕）
	const behind = o[0] * d[0] + o[1] * d[1] + o[2] * d[2] < -rr * Math.hypot(...o) - 1e-9;
	return !behind;
}
function bindDepth(P: Program, api: VoxelApi | null | undefined): void {
	const gl = glc!;
	if (!wantDepth) return;
	if (api?.depth) { api.depth.bind(gl, P.p, 3); return; }
	if (P.u.u_sceneDepthOn) gl.uniform1f(P.u.u_sceneDepthOn, 0);
	if (P.u.u_sceneDepth) { if (!dummyTex) { dummyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); gl.bindTexture(gl.TEXTURE_2D, null); } gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P.u.u_sceneDepth, 3); }
}
function drawAll(pick: boolean, s: CamState, api: VoxelApi | null | undefined, w: number, h: number): void {
	const gl = glc!;
	const P = (pick ? pickProg : prog)!;
	gl.disable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
	if (pick) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
	gl.useProgram(P.p); bindDepth(P, api);
	gl.uniform2f(P.u.u_vp, w, h); gl.uniform1i(P.u.u_vol, 0); gl.uniform1i(P.u.u_cmap, 1); gl.uniform3f(P.u.u_light, LIGHT[0], LIGHT[1], LIGHT[2]);
	const vis: Layer[] = [];
	for (const L of layers.values()) if (L.on && L.n && place(L, s, api)) vis.push(L);
	vis.sort((a, b) => b.dist - a.dist);   // 層は奥から
	gl.bindVertexArray(boxVao);
	for (const L of vis) {
		place(L, s, api);
		gl.uniformMatrix4fv(P.u.u_mvp, false, mvpC); gl.uniform3f(P.u.u_dims, L.dims[0], L.dims[1], L.dims[2]); gl.uniform3fv(P.u.u_eye, eyeC);
		gl.uniformMatrix3fv(P.u.u_nrm, false, L.nrm);
		gl.uniform1i(P.u.u_mode, L.mode); gl.uniform1i(P.u.u_comps, L.comps);
		gl.uniform1i(P.u.u_maxSteps, L.mode === 0 ? L.dims[0] + L.dims[1] + L.dims[2] + 2 : Math.min(4096, Math.ceil(Math.hypot(L.dims[0], L.dims[1], L.dims[2]) / L.step) + 2));
		gl.uniform1f(P.u.u_thr, L.thr); gl.uniform1f(P.u.u_step, L.step); gl.uniform1f(P.u.u_opacity, L.opacity); gl.uniform1f(P.u.u_occl, L.occl ? 1 : 0);
		gl.uniform1ui(P.u.u_base, L.base);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, L.tex);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L.cmap);
		gl.drawArrays(gl.TRIANGLES, 0, 36);
	}
	gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(null); gl.disable(gl.CULL_FACE);
}
function answerProbes(w: number, h: number): void {
	if (!probes.length) return;
	const gl = glc!;
	const ids = probes.splice(0);
	const ls = [...layers].map(([q, L]) => ({ q, on: L.on, n: L.n, dims: L.dims, mode: L.mode, dist: +L.dist.toFixed(4), anchor: L.anchor, alt: L.alt }));
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, layers: ls, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as { message?: string } | null)?.message || e) }); }
}
export function frame(cam: unknown, s: CamState, { w, h }: { w: number; h: number }, api: VoxelApi): boolean {
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
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): VoxelPickResult | null {
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
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	gl.viewport(0, 0, w, h);
	gl.enable(gl.SCISSOR_TEST); gl.scissor(cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0));   // 光線を辿るのは読む画素だけ（全画面の当たりパスは SwiftShader で秒単位）
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (cx1 > cx0 && cy1 > cy0) drawAll(true, ctx.s, ctx.api, w, h);
	gl.disable(gl.SCISSOR_TEST);
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
		const index = best.id - L.base, [nx, ny] = L.dims, i = index % nx, j = Math.floor(index / nx) % ny, k = Math.floor(index / (nx * ny));
		const cc = [i + 0.5, j + 0.5, k + 0.5], A = L.A, e = A[0] * cc[0] + A[1] * cc[1] + A[2] * cc[2], nn = A[3] * cc[0] + A[4] * cc[1] + A[5] * cc[2], a = L.anchor;
		const lngLat: [number, number] = [a[0] + e / (Math.cos(a[1] * D2R) * D2R * R_SPHERE), a[1] + nn / (D2R * R_SPHERE)];
		const cell: [number, number, number] = [i, j, k];
		return { id: best.id, q, layer: q, index, cell, value: null, distance: best.distance, lngLat, properties: { ...(L.properties || {}), index, cell, value: null } };
	}
	return null;
}
export function destroy(): void { layers.forEach(drop); layers.clear(); glc = null; }
