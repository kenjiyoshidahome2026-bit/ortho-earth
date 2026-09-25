// 検定用の同一フレームのオーバーレイ（#47・シーンの深度）。依存ゼロ。
// 受けた点（[lon, lat, hM]…）を api.clipH で clip 座標にして 9px の点で描き、FS で sceneOcclusion を引く＝見える＝赤・隠れ＝青。
// 描いた直後に自分の画素（点の中心）を読んで main へ返す：{ depth: {backend,w,h,logCoef}|null, res: ["vis"|"hid"|"none"…] }。
// opts.noRequest＝深度を申し出ない（api.depth が来ないこと・本体が深度を作らないことの確かめ）。
let gl = null, prog = null, rawProg = null, host = null, vao = null, vbo = null, pts = [], wantDepth = true, last = 0;
const VS = `#version 300 es
in vec4 a_clip;
out float v_w;
void main() { gl_Position = a_clip; gl_PointSize = 9.0; v_w = a_clip.w; }`;
const FS = glsl => `#version 300 es
precision highp float;
${glsl}
uniform vec2 u_size;
in float v_w;
out vec4 o;
void main() { o = sceneOcclusion(gl_FragCoord.xy / u_size, v_w) > 0.5 ? vec4(0.0, 0.0, 1.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0); }`;
// 診断：点の所の本体の深度（詰めた 3 バイトそのもの）を出す＝readPixels で CPU へ（{ raw: [本体の d…], mine: [自分の d…] }）
const RAW_FS = glsl => `#version 300 es
precision highp float;
${glsl}
uniform vec2 u_size;
in float v_w;
out vec4 o;
void main() { o = vec4(texture(u_sceneDepth, gl_FragCoord.xy / u_size).rgb, 1.0); }`;
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
export function init(canvas, opts, h) {
	host = h; wantDepth = !opts.noRequest;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, depth: false, antialias: false });
	prog = gl.createProgram();
	gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS(host.depthGLSL)));
	gl.bindAttribLocation(prog, 0, "a_clip"); gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
	rawProg = gl.createProgram();
	gl.attachShader(rawProg, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(rawProg, sh(gl.FRAGMENT_SHADER, RAW_FS(host.depthGLSL)));
	gl.bindAttribLocation(rawProg, 0, "a_clip"); gl.linkProgram(rawProg);
	vao = gl.createVertexArray(); vbo = gl.createBuffer();
	gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	return wantDepth ? { depth: true } : undefined;
}
export function message(d) { if (d && d.pts) pts = d.pts; }
export function frame(cam, s, size, api) {
	gl.viewport(0, 0, size.w, size.h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (!pts.length) return true;
	const clips = pts.map(([lon, lat, hM]) => api.clipH(lon, lat, hM));
	gl.useProgram(prog);
	if (api.depth) api.depth.bind(gl, prog, 3);
	else gl.uniform1f(gl.getUniformLocation(prog, "u_sceneDepthOn"), 0);
	gl.uniform2f(gl.getUniformLocation(prog, "u_size"), size.w, size.h);
	gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(clips.flat()), gl.DYNAMIC_DRAW);
	gl.drawArrays(gl.POINTS, 0, clips.length);
	gl.bindVertexArray(null);
	const now = performance.now();
	if (now - last > 150) {
		last = now;
		const px = new Uint8Array(4);
		const at = c => { const x = Math.round((c[0] / c[3] * 0.5 + 0.5) * size.w), y = Math.round((c[1] / c[3] * 0.5 + 0.5) * size.h); return c[3] > 0 && x >= 0 && y >= 0 && x < size.w && y < size.h ? [x, y] : null; };
		const res = clips.map(c => {
			const q = at(c); if (!q) return "none";
			gl.readPixels(q[0], q[1], 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
			return px[0] > 128 && px[2] < 64 ? "vis" : px[2] > 128 && px[0] < 64 ? "hid" : "none";
		});
		const d = api.depth;
		let raw = null, mine = null;
		if (d) {   // 診断の 2 枚目（点の所の本体の深度）＝読んだら消す
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(rawProg); d.bind(gl, rawProg, 3);
			gl.uniform2f(gl.getUniformLocation(rawProg, "u_size"), size.w, size.h);
			gl.bindVertexArray(vao); gl.drawArrays(gl.POINTS, 0, clips.length); gl.bindVertexArray(null);
			raw = clips.map(c => { const q = at(c); if (!q) return null; gl.readPixels(q[0], q[1], 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return +((px[0] * 65536 + px[1] * 256 + px[2]) / 16777215).toFixed(7); });
			mine = clips.map(c => +(0.5 * Math.log2(Math.max(1 + c[3], 1e-6)) * d.logCoef).toFixed(7));
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(prog); gl.bindVertexArray(vao); gl.drawArrays(gl.POINTS, 0, clips.length); gl.bindVertexArray(null);
		}
		host.post({ depth: d ? { backend: d.backend, w: d.w, h: d.h, logCoef: d.logCoef } : null, res, raw, mine });
	}
	return true;
}
export function destroy() { gl?.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
