// COPC の点群の描き方（#178・同一フレームのオーバーレイ＝map.overlay・レンダーワーカー内で地球と同じ rAF・同じ cam）。
// 本人裁定 2026-09-30「描き方の強化は COPC だけ」＝3D Tiles の点（points-gl.js）は触らない＝このファイルは points-gl の兄弟。points-gl に足した物：
//   ・奥行き：シーンの深度（#47・core の depthout）で隠れる所を捨てる（地形・建物の裏で点が透けない）＝init の戻り { depth: true } で本体に申し出る
//   ・大きさ：画素固定（size・px）か、距離で縮む（attenuation＝節の点の間隔 × 焦点距離 / 距離・1〜size×2 px）。上限は size×4 → size×2（2026-10-23）＝ADD の親の節は粗い間隔の分だけ大きく描かれる
//     ＝子が埋めた所を上から太い点で塗り重ねていた（級ごとに画面の足跡と同じ量の塗り＝4 級で 4 倍）。上限を半分にすると大きい点の塗りが 1/4 になる
//   ・MSAA（canvas の antialias）は切る（2026-10-23）＝点の縁は FS の cov で既に滑らか・4x の標本は塗りの量だけ増やしていた（静岡の LAS が重い＝ベンチの基準 bench-baseline）
//   ・色：rgb（点の RGB）／classification（ASPRS の分類の表）／intensity（強度の灰）／elevation（標高の段彩・elevRange）
// 契約：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"layer", q, n, pos: Float32Array(n*3), origin, rgb?: Uint8Array(n*3), intensity: Uint16Array(n), cls: Uint8Array(n), elev: Float32Array(n), spacing }
//           spacing＝この節の点の間隔（世界単位）／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }
//           { type:"style", mode, size, attenuation, elevRange:[m, m], intensityRange:[lo, hi], opacity, lift（世界単位）, liftM（m） }／検定用 { type:"probe", id }
//           lift＝高さの足し込み（heightOffset）＝点を鉛直（球の法線）に持ち上げる・段彩の値にも liftM を足す＝読み直さずに効く（2026-10-18）
// render worker の組み込み（BUILTIN_OVERLAYS の "copc"・create() で実体を作る）。深度の GLSL は host.depthGLSL を貼る。
import type { CameraPose, CameraState, OverlayApi, OverlayHost, OverlaySize } from "../types/overlay.ts";
type Uniforms = Record<string, WebGLUniformLocation | null>;
/** 層（q ごと＝COPC の節） */
interface Layer { n: number; vao: WebGLVertexArrayObject | null; bufs: WebGLBuffer[]; origin: ArrayLike<number>; spacing: number; on: boolean }
interface Style { mode: string; size: number; attenuation: boolean; elevRange: number[]; intensityRange: number[]; opacity: number; lift: number; liftM: number }
/** message(d) の形 */
type Msg =
	| { type: "probe"; id: unknown }
	| { type: "layer"; q: string; n: number; pos: Float32Array; origin: ArrayLike<number>; rgb?: Uint8Array; intensity: Uint16Array; cls: Uint8Array; elev: Float32Array; spacing?: number }
	| { type: "remove"; q: string } | { type: "vis"; q: string; on: unknown } | { type: "clear" }
	| ({ type: "style" } & Partial<Style>);
const DEPTH_STUB = `highp float sceneOcclusion(highp vec2 uv, highp float w) { return 0.0; }`;
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_rgb;
layout(location = 2) in float a_int;
layout(location = 3) in float a_cls;
layout(location = 4) in float a_elev;
uniform mat4 u_mvp; uniform vec3 u_origin; uniform vec3 u_eye;
uniform int u_mode; uniform float u_size; uniform float u_atten; uniform float u_spacing; uniform float u_focal; uniform float u_maxPt;
uniform vec2 u_elev; uniform vec2 u_intRange; uniform float u_opacity; uniform float u_lift; uniform float u_liftM;
out vec4 v_col; out float v_rad; out float v_w;
vec3 ramp(float t) {   // 標高の段彩（青→緑→黄→赤）
	t = clamp(t, 0.0, 1.0);
	return t < 0.33 ? mix(vec3(0.17, 0.35, 0.75), vec3(0.20, 0.65, 0.35), t / 0.33) : t < 0.66 ? mix(vec3(0.20, 0.65, 0.35), vec3(0.95, 0.85, 0.25), (t - 0.33) / 0.33) : mix(vec3(0.95, 0.85, 0.25), vec3(0.80, 0.22, 0.15), (t - 0.66) / 0.34);
}
vec3 clsColor(float c) {   // ASPRS LAS 1.4 の分類
	int k = int(c + 0.5);
	if (k == 2) return vec3(0.63, 0.47, 0.30);   // 地面
	if (k == 3) return vec3(0.62, 0.84, 0.45);   // 低い植生
	if (k == 4) return vec3(0.35, 0.70, 0.30);   // 中の植生
	if (k == 5) return vec3(0.13, 0.50, 0.18);   // 高い植生
	if (k == 6) return vec3(0.90, 0.35, 0.25);   // 建物
	if (k == 7 || k == 18) return vec3(0.85, 0.20, 0.85);   // ノイズ
	if (k == 9) return vec3(0.20, 0.45, 0.90);   // 水
	if (k == 10) return vec3(0.45, 0.35, 0.55);  // 鉄道
	if (k == 11) return vec3(0.55, 0.55, 0.58);  // 道路面
	if (k == 17) return vec3(0.95, 0.65, 0.20);  // 橋
	return vec3(0.72, 0.72, 0.72);               // 未分類・その他
}
void main() {
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	vec3 pos = a_pos + normalize(a_pos + u_origin) * u_lift;   // 高さの足し込み（球の法線＝数 m なら楕円体の法線との差は無視できる）
	vec3 d = (pos + u_origin) - u_eye;   // 地平線の向こう（球の裏側）は描かない
	float a = dot(d, d), b = dot(u_eye, d), c = dot(u_eye, u_eye) - 1.0, disc = b * b - a * c;
	if (disc > 0.0) { float s = sqrt(disc); float t0 = (-b - s) / a; if (t0 > 1e-4 && t0 < 1.0 - 1e-4) { gl_Position = off; gl_PointSize = 0.0; v_col = vec4(0.0); v_rad = 0.0; v_w = 1.0; return; } }
	vec4 cpos = u_mvp * vec4(pos, 1.0);
	if (cpos.w <= 0.0) { gl_Position = off; gl_PointSize = 0.0; v_col = vec4(0.0); v_rad = 0.0; v_w = 1.0; return; }
	float rad = u_atten > 0.5 ? clamp(0.5 * u_spacing * u_focal / max(1e-9, sqrt(a)), 1.0, u_size * 2.0) : u_size;
	v_rad = min(rad, u_maxPt * 0.5 - 1.0);
	vec3 col = u_mode == 0 ? a_rgb : u_mode == 1 ? clsColor(a_cls) : u_mode == 2 ? vec3(clamp((a_int - u_intRange.x) / max(1e-6, u_intRange.y - u_intRange.x), 0.0, 1.0)) : ramp((a_elev + u_liftM - u_elev.x) / max(1e-6, u_elev.y - u_elev.x));
	v_col = vec4(col, u_opacity); v_w = cpos.w;
	gl_PointSize = v_rad * 2.0 + 2.0;
	gl_Position = cpos;
}`;

// 一つのオーバーレイ＝一つの閉包（2026-10-17・旧＝URL ごとに別のモジュール実体＝?ov=）。render worker の BUILTIN_OVERLAYS が create() で作る
export function create() {
	const FS: (depthGLSL: string) => string = depthGLSL => `#version 300 es
precision highp float;
in vec4 v_col; in float v_rad; in float v_w;
uniform vec2 u_vp;
${depthGLSL}
out vec4 o;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * (v_rad + 1.0);
	float cov = clamp(v_rad + 0.5 - length(p), 0.0, 1.0);
	if (cov <= 0.0) discard;
	if (sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;
	float a = v_col.a * cov;
	o = vec4(v_col.rgb * a, a);
}`;
	let gl: WebGL2RenderingContext | null = null, prog: WebGLProgram | null = null, uni: Uniforms = {}, maxPt = 1, wantDepth = false, host: OverlayHost | null = null;
	const layers = new Map<string, Layer>();
	let style: Style = { mode: "rgb", size: 2, attenuation: true, elevRange: [0, 100], intensityRange: [0, 65535], opacity: 1, lift: 0, liftM: 0 };
	const MODES: Record<string, number> = { rgb: 0, classification: 1, intensity: 2, elevation: 3 };
	const probes: unknown[] = [];

	function compile(vs: string, fs: string): { p: WebGLProgram; u: Uniforms } {
		const mk = (type: GLenum, src: string) => { const s = gl!.createShader(type)!; gl!.shaderSource(s, src); gl!.compileShader(s); if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s)!); return s; };
		const p = gl!.createProgram(); gl!.attachShader(p, mk(gl!.VERTEX_SHADER, vs)); gl!.attachShader(p, mk(gl!.FRAGMENT_SHADER, fs)); gl!.linkProgram(p);
		if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p)!);
		const u: Uniforms = {}; for (let i = 0, n = gl!.getProgramParameter(p, gl!.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl!.getActiveUniform(p, i)!.name; u[nm] = gl!.getUniformLocation(p, nm); }
		return { p, u };
	}
	function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null) {
		host = h;
		gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false }) as WebGL2RenderingContext | null;   // antialias:false＝点の縁は FS の cov で滑らか（上の注）
		if (!gl) throw new Error("WebGL2 is not available (COPC overlay)");
		wantDepth = opts.depth !== false && !!h?.depthGLSL;
		({ p: prog, u: uni } = compile(VS, FS(wantDepth ? h!.depthGLSL : DEPTH_STUB)));
		maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
		return wantDepth ? { depth: true } : undefined;
	}
	const drop: (L: Layer | undefined) => void = L => { if (!L) return; for (const b of L.bufs) gl!.deleteBuffer(b); gl!.deleteVertexArray(L.vao); };
	const attr = (loc: number, data: ArrayBufferView, size: number, type: GLenum, norm: boolean) => { const b = gl!.createBuffer(); gl!.bindBuffer(gl!.ARRAY_BUFFER, b); gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW); gl!.enableVertexAttribArray(loc); gl!.vertexAttribPointer(loc, size, type, norm, 0, 0); return b; };
	function message(d: Msg) {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!gl) return;
		if (d.type === "layer") {
			drop(layers.get(d.q));
			const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
			const bufs = [attr(0, d.pos, 3, gl.FLOAT, false), attr(2, d.intensity, 1, gl.UNSIGNED_SHORT, false), attr(3, d.cls, 1, gl.UNSIGNED_BYTE, false), attr(4, d.elev, 1, gl.FLOAT, false)];
			if (d.rgb) bufs.push(attr(1, d.rgb, 3, gl.UNSIGNED_BYTE, true)); else { gl.disableVertexAttribArray(1); gl.vertexAttrib3f(1, 0.85, 0.85, 0.85); }
			gl.bindVertexArray(null);
			layers.set(d.q, { n: d.n, vao, bufs, origin: d.origin, spacing: d.spacing || 0, on: true });
		} else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); }
		else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; }
		else if (d.type === "clear") { layers.forEach(drop); layers.clear(); }
		else if (d.type === "style") { style = { ...style, ...d }; }
	}
	function answerProbes(w: number, h: number) {
		if (!probes.length) return;
		const ids = probes.splice(0);
		try { const data = new Uint8Array(w * h * 4); gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice(), info: { layers: layers.size, depth: wantDepth } }); }
		catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
	}
	function frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi) {
		draw(cam, s, size, api);
		if (gl) answerProbes(size.w, size.h);
		return false;
	}
	function draw(cam: CameraPose, s: CameraState, { w, h }: OverlaySize, api: OverlayApi) {
		if (!gl) return;
		gl.viewport(0, 0, w, h);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		if (!layers.size) return;
		const dpr = cam.dpr || 1;
		gl.useProgram(prog);
		if (wantDepth) { if (api?.depth) api.depth.bind(gl, prog!, 3); else if (uni.u_sceneDepthOn) gl.uniform1f(uni.u_sceneDepthOn, 0); }
		gl.uniform2f(uni.u_vp, w, h);
		gl.uniform3fv(uni.u_eye, new Float32Array(s.eye));
		gl.uniform1i(uni.u_mode, MODES[style.mode] ?? 0);
		gl.uniform1f(uni.u_size, Math.max(0.5, style.size * dpr));
		gl.uniform1f(uni.u_atten, style.attenuation ? 1 : 0);
		gl.uniform1f(uni.u_focal, s.focal);
		gl.uniform1f(uni.u_maxPt, maxPt);
		gl.uniform2f(uni.u_elev, style.elevRange[0], style.elevRange[1]);
		gl.uniform2f(uni.u_intRange, style.intensityRange[0], style.intensityRange[1]);
		gl.uniform1f(uni.u_opacity, style.opacity ?? 1);
		gl.uniform1f(uni.u_lift, style.lift || 0); gl.uniform1f(uni.u_liftM, style.liftM || 0);
		gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
		const M = s.mvp, mvpL = new Float32Array(16);
		for (const L of layers.values()) {
			if (!L.on) continue;
			const o = L.origin;   // mvp·T(o)＝4 列目だけが変わる（倍精度で掛ける）
			for (let i = 0; i < 12; i++) mvpL[i] = M[i];
			for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];
			gl.uniformMatrix4fv(uni.u_mvp, false, mvpL); gl.uniform3f(uni.u_origin, o[0], o[1], o[2]);
			gl.uniform1f(uni.u_spacing, L.spacing);
			gl.bindVertexArray(L.vao); gl.drawArrays(gl.POINTS, 0, L.n);
		}
		gl.bindVertexArray(null);
	}
	function destroy() { if (!gl) return; layers.forEach(drop); layers.clear(); gl.deleteProgram(prog); gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
	return { init, message, frame, destroy };
}
