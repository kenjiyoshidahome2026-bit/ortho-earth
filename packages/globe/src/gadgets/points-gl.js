// 汎用の点オーバーレイ（同一フレームのオーバーレイ＝map.overlay・レンダーワーカー内で地球と同じ rAF・同じ cam に描く）。
// 用途＝GeoParquet の点だけのファイル（gadgets/parquet-view.js）：列（経緯度）→ 単位球の xyz → そのまま GPU。gint も GeoPBF も経由しない。
// 契約（app.js map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"layer", q, n, pos: Float32Array(n*3), rgba?: Uint8Array(n*4) }（同じ q は置き換え・rgba＝点ごとの色＝属性で色分け）
//           ／{ type:"remove", q }／{ type:"style", size, color:[r,g,b,a] }（rgba の無い層の色）／{ type:"clear" }
// ⚠ 依存ゼロ（import 文なし）＝vite は ?url のファイルをそのまま置く。
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_rgba;   // 点ごとの色（無い層は u_color）
uniform mat4 u_mvp;
uniform vec3 u_eye;
uniform float u_size;      // 半径（device px）
uniform vec4 u_color;
uniform float u_perPoint;  // 1＝a_rgba を使う
out vec4 v_col;
void main() {
	v_col = u_perPoint > 0.5 ? a_rgba : u_color;
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	// 地平線の向こう（球の裏側）は描かない：視線 eye→P が球の中を通るなら裏
	vec3 d = a_pos - u_eye;
	float a = dot(d, d), b = dot(u_eye, d), c = dot(u_eye, u_eye) - 1.0;
	float disc = b * b - a * c;
	if (disc > 0.0) { float s = sqrt(disc); float t0 = (-b - s) / a; if (t0 > 1e-4 && t0 < 1.0 - 1e-4) { gl_Position = off; gl_PointSize = 0.0; return; } }
	vec4 cpos = u_mvp * vec4(a_pos, 1.0);
	if (cpos.w <= 0.0) { gl_Position = off; gl_PointSize = 0.0; return; }
	gl_PointSize = u_size * 2.0 + 2.0;
	gl_Position = cpos;
}`;
const FS = `#version 300 es
precision highp float;
in vec4 v_col;   // premultiplied でない RGBA
uniform float u_size;
out vec4 o;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * (u_size + 1.0);
	float cov = clamp(u_size + 0.5 - length(p), 0.0, 1.0);
	if (cov <= 0.0) discard;
	float a = v_col.a * cov;
	o = vec4(v_col.rgb * a, a);
}`;
let gl = null, prog = null, uni = {}, maxPt = 1;
const layers = new Map();   // q → { n, buf, cbuf, vao, perPoint }
let style = { size: 3, color: [0.9, 0.3, 0.2, 0.85] };

function compile(vs, fs) {
	const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
	const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
export function init(canvas) {
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (points overlay)");
	({ p: prog, u: uni } = compile(VS, FS));
	maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
}
const drop = L => { if (!L) return; gl.deleteBuffer(L.buf); if (L.cbuf) gl.deleteBuffer(L.cbuf); gl.deleteVertexArray(L.vao); };
export function message(d) {
	if (!gl) return;
	if (d.type === "layer") {
		drop(layers.get(d.q));
		const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, d.pos, gl.STATIC_DRAW);
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		let cbuf = null;
		if (d.rgba) { cbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cbuf); gl.bufferData(gl.ARRAY_BUFFER, d.rgba, gl.STATIC_DRAW); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0); }
		else { gl.disableVertexAttribArray(1); gl.vertexAttrib4f(1, 0, 0, 0, 1); }
		gl.bindVertexArray(null);
		layers.set(d.q, { n: d.n, buf, cbuf, vao, perPoint: !!d.rgba });
	} else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); }
	else if (d.type === "style") { style = { ...style, ...d }; }
}
export function frame(cam, s, { w, h }) {
	if (!gl) return false;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (!layers.size) return false;
	const dpr = cam.dpr || 1;
	gl.useProgram(prog);
	gl.uniformMatrix4fv(uni.u_mvp, false, new Float32Array(s.mvp));
	gl.uniform3fv(uni.u_eye, new Float32Array(s.eye));
	gl.uniform1f(uni.u_size, Math.min(maxPt * 0.5 - 1, style.size * dpr));
	gl.uniform4fv(uni.u_color, new Float32Array(style.color));
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	for (const L of layers.values()) { gl.uniform1f(uni.u_perPoint, L.perPoint ? 1 : 0); gl.bindVertexArray(L.vao); gl.drawArrays(gl.POINTS, 0, L.n); }
	gl.bindVertexArray(null);
	return false;
}
export function destroy() { if (!gl) return; layers.forEach(drop); layers.clear(); gl.deleteProgram(prog); gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
