// ヒートマップ＝GPU 描画（レンダーワーカー内で地球・注記と同じフレームに描くオーバーレイ・MapLibre の heatmap 層相当・2026-09-21）。
// main（gadgets/aggregate.js）が点の列（単位球ワールド xyz・重み）と、ズームごとの半径/強さの表・色表（heatmap-density 0..1 → RGBA）を渡す。
// 描き方は MapLibre と同じ二段：①密度＝各点のガウス核（weight×intensity×GAUSS_COEF×exp(−½·3²·d²)）を浮動小数の窓へ加算
// ②密度 0..1 を色表で引いて不透明度を掛けて画面へ。地球の裏側の点は足さない（視点側の半球だけ）。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size) / destroy()。依存ゼロ（worker が URL で import()）。

let gl = null, dens = null, prog = null, colorProg = null, vao = null, quad = null, rampTex = null;
let n = 0, posBuf = null, wBuf = null, st = { radius: [30], intensity: [1], opacity: 1, zStep: 0.5 }, fmt = null;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_pos;
layout(location=2) in float a_w;
uniform mat4 u_mvp; uniform vec3 u_eye; uniform vec2 u_px; uniform float u_radius;
out vec2 v_ext; out float v_w;
void main() {
	vec4 c = u_mvp * vec4(a_pos, 1.0);
	bool front = dot(a_pos, u_eye) > 1.0;          // 単位球の点が視点から見える（地平の手前）
	v_ext = a_corner; v_w = front ? a_w : 0.0;
	c.xy += a_corner * u_radius * u_px * c.w;       // 画面上で半径 u_radius px の四角
	gl_Position = front ? c : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec2 v_ext; in float v_w; uniform float u_intensity; out vec4 o;
void main() {
	float r2 = dot(v_ext, v_ext);
	if (r2 > 1.0) discard;                           // 核は円（四角の角まで足すと飽和した時に塊が四角く見える）
	float d = -0.5 * 3.0 * 3.0 * r2;
	o = vec4(v_w * u_intensity * 0.3989422804014327 * exp(d), 0.0, 0.0, 1.0);
}`;
const CVS = `#version 300 es
layout(location=0) in vec2 a_corner; out vec2 v_uv;
void main() { v_uv = a_corner * 0.5 + 0.5; gl_Position = vec4(a_corner, 0.0, 1.0); }`;
const CFS = `#version 300 es
precision highp float;
in vec2 v_uv; uniform sampler2D u_d; uniform sampler2D u_ramp; uniform float u_opacity; out vec4 o;
void main() {
	float t = clamp(texture(u_d, v_uv).r, 0.0, 1.0);
	vec4 c = texture(u_ramp, vec2(t, 0.5));
	o = vec4(c.rgb * c.a, c.a) * u_opacity;          // 前乗算
}`;
function compile(vs, fs) {
	const p = gl.createProgram();
	for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
		const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
		gl.attachShader(p, s);
	}
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}; for (const k of ["u_mvp", "u_eye", "u_px", "u_radius", "u_intensity", "u_d", "u_ramp", "u_opacity"]) u[k] = gl.getUniformLocation(p, k);
	return { p, u };
}
export function init(canvas) {
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false });
	// 密度の窓＝半精度浮動小数（描けない GPU は RGBA8＝量子化するが見た目は近い）
	fmt = gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float") ? { i: gl.R16F, f: gl.RED, t: gl.HALF_FLOAT } : { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
	prog = compile(VS, FS); colorProg = compile(CVS, CFS);
	quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	vao = gl.createVertexArray();
	rampTex = gl.createTexture();
	setRamp(null);
}
function setRamp(rgba) {
	const d = rgba || (() => { const a = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { a[i * 4] = 255; a[i * 4 + 3] = i; } return a; })();
	gl.bindTexture(gl.TEXTURE_2D, rampTex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
// data＝{ type:"points", pos: Float32Array(xyz), w: Float32Array } | { type:"style", radius:[px…], intensity:[…], zStep, opacity, ramp: Uint8Array(1024) } | { type:"clear" }
export function message(d) {
	if (!gl) return;
	if (d.type === "clear") { n = 0; return; }
	if (d.type === "points") {
		n = d.w.length;
		posBuf ??= gl.createBuffer(); wBuf ??= gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, d.pos, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, wBuf); gl.bufferData(gl.ARRAY_BUFFER, d.w, gl.STATIC_DRAW);
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
		gl.bindBuffer(gl.ARRAY_BUFFER, wBuf); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(2, 1);
		gl.bindVertexArray(null);
	}
	if (d.type === "style") { st = { ...st, ...d }; if (d.ramp) setRamp(d.ramp); }
}
const byZoom = (tab, z) => { const k = z / st.zStep, i = Math.max(0, Math.min(tab.length - 1, Math.floor(k))), j = Math.min(tab.length - 1, i + 1), t = Math.max(0, Math.min(1, k - i)); return tab[i] + (tab[j] - tab[i]) * t; };
export function frame(cam, s, { w, h }) {
	if (!gl) return false;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (!n) return false;
	const dpr = cam.dpr || 1, z = cam.zoom || 0;
	if (z < (st.minzoom ?? -99) || z >= (st.maxzoom ?? 99)) return false;   // 層の minzoom/maxzoom（MapLibre の heatmap は高ズームで点へ譲るのが定番）
	// 密度の窓（画面の半分の解像度＝核はぼけるので十分・帯域半分）
	const dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1);
	if (!dens || dens.w !== dw || dens.h !== dh) {
		if (dens) { gl.deleteTexture(dens.tex); gl.deleteFramebuffer(dens.fbo); }
		const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, fmt.i, dw, dh, 0, fmt.f, fmt.t, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		dens = { tex, fbo, w: dw, h: dh };
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, dens.fbo); gl.viewport(0, 0, dw, dh);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
	gl.useProgram(prog.p);
	gl.uniformMatrix4fv(prog.u.u_mvp, false, new Float32Array(s.mvp));
	gl.uniform3fv(prog.u.u_eye, new Float32Array(s.eye));
	gl.uniform2f(prog.u.u_px, 2 / w, 2 / h);
	gl.uniform1f(prog.u.u_radius, byZoom(st.radius, z) * dpr);
	gl.uniform1f(prog.u.u_intensity, byZoom(st.intensity, z));
	gl.bindVertexArray(vao);
	gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
	gl.bindVertexArray(null);
	// 色付け
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.useProgram(colorProg.p);
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dens.tex); gl.uniform1i(colorProg.u.u_d, 0);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rampTex); gl.uniform1i(colorProg.u.u_ramp, 1);
	gl.uniform1f(colorProg.u.u_opacity, st.opacity ?? 1);
	gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0);
	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	gl.disableVertexAttribArray(0);
	gl.activeTexture(gl.TEXTURE0);
	return false;
}
export function destroy() { gl?.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
