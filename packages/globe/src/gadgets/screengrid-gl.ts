// 画面格子の集約（deck.gl の ScreenGridLayer 相当・差分 PR-5・2026-10-12）＝同一フレームのオーバーレイ（render worker・WebGL2・地球と同じ rAF・同じ cam）。
// 点を毎フレーム画面に投影して cellPx の格子に数え、色の段（colorRange）で塗る＝カメラが動けば格子も動く（画面に固定）。格子は画面の左上から（旧 canvas2D と同じ）。
// GPU で三段（2026-10-22・旧＝screengrid-draw の canvas2D で点ごとに投影して fillRect）：
//   ①点を格子の窓（cols×rows の浮動小数）へ 1 画素の点として足す（R＝値・A＝件数。agg "max" は R を MAX で混ぜる＝blendEquationSeparate）
//   ②窓の全セルを 1×1 の窓へ MAX で混ぜて最大値 ③画面いっぱいの四角で、画素の居るセルの値÷最大値で色の段を引く（隙間 gap は塗らない）。
// 点は β 単位球の xyz（lonlatTo3D・ヒートマップと同じ）＝地形の持ち上げは無い（旧は api.project＝地形込み。格子の粒では差は出ない）。地球の裏の点は数えない。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"data", lon: Float64Array(n), lat: Float64Array(n), w?: Float32Array(n) }／{ type:"style", cellPx, colorRange: [[r,g,b,a], …]（0〜255）, agg:"sum"|"count"|"max", opacity, gap }／{ type:"clear" }／{ type:"probe", id }
// 当たり判定（統一 picking・PR-1）：pick(x, y)＝その画素のセル → { id, index, distance 0, properties:{ count, value, col, row, max } }（セルが空なら null）＝最後に描いた窓を読む。
// render worker の組み込み（BUILTIN_OVERLAYS の "screengrid"・create() で実体を作る）。
import { lonlatTo3D } from "@ortho-earth/core/camera";
import type { CameraPose, CameraState, OverlayHost, OverlaySize } from "../types/overlay.ts";
type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Prog { p: WebGLProgram; u: Uniforms }
/** 色の段の 1 つ（0〜255・a は省略可） */
type Rgba = [number, number, number, number?];
interface GridStyle { cellPx: number; colorRange: Rgba[]; agg: "sum" | "count" | "max"; opacity: number; gap: number }
type GridMsg = { type: "probe"; id: unknown } | { type: "data"; lon: Float64Array; lat: Float64Array; w?: Float32Array } | ({ type: "style" } & Partial<GridStyle>) | { type: "clear" };
/** 浮動小数の窓（格子・最大値） */
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }
/** 最後に描いた格子（pick が読む） */
interface Grid { cols: number; rows: number; cell: number }

// ① 点 → 格子の窓の 1 画素（画面の左上からのセル (col,row) を窓の texel (col,row) へ）
const VS_ACC = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_w;
uniform mat4 u_mvp; uniform vec3 u_eye; uniform vec2 u_scr; uniform vec2 u_grid; uniform float u_cell; uniform float u_count;
out float v_w;
void main() {
	gl_PointSize = 1.0; v_w = u_count > 0.5 ? 1.0 : a_w;
	vec4 c = u_mvp * vec4(a_pos, 1.0);
	vec2 s = vec2((c.x / c.w * 0.5 + 0.5) * u_scr.x, (0.5 - c.y / c.w * 0.5) * u_scr.y);   // 画面の device px（左上から）
	bool ok = dot(a_pos, u_eye) > 1.0 && c.w > 0.0 && s.x >= 0.0 && s.y >= 0.0 && s.x < u_scr.x && s.y < u_scr.y;   // 裏・画面外は数えない
	vec2 cr = floor(s / u_cell);
	gl_Position = ok ? vec4((cr + 0.5) / u_grid * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const FS_ACC = `#version 300 es
precision highp float;
in float v_w; out vec4 o;
void main() { o = vec4(v_w, 0.0, 0.0, 1.0); }`;
// ② 格子の全セル → 1×1 の窓へ MAX（件数の無いセルは 0）
const VS_MAX = `#version 300 es
precision highp float;
uniform sampler2D u_g; uniform int u_cols; out float v_v;
void main() {
	gl_PointSize = 1.0;
	vec4 g = texelFetch(u_g, ivec2(gl_VertexID % u_cols, gl_VertexID / u_cols), 0);
	v_v = g.a > 0.0 ? g.r : 0.0;
	gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}`;
const FS_MAX = `#version 300 es
precision highp float;
in float v_v; out vec4 o;
void main() { o = vec4(v_v, 0.0, 0.0, 1.0); }`;
// ③ 画面の画素 → セル → 色の段（前乗算）
const VS_COL = `#version 300 es
layout(location=0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner, 0.0, 1.0); }`;
const FS_COL = `#version 300 es
precision highp float;
uniform sampler2D u_g; uniform sampler2D u_mx; uniform sampler2D u_cr; uniform int u_n; uniform float u_cell; uniform float u_gap; uniform float u_h; uniform float u_opacity;
out vec4 o;
void main() {
	vec2 s = vec2(gl_FragCoord.x, u_h - gl_FragCoord.y);   // 画面の device px（左上から）
	vec2 cr = floor(s / u_cell), l = s - cr * u_cell;
	if (l.x < u_gap * 0.5 || l.y < u_gap * 0.5 || l.x >= u_cell - u_gap * 0.5 || l.y >= u_cell - u_gap * 0.5) discard;   // 隙間（旧 fillRect の内側と同じ）
	vec4 g = texelFetch(u_g, ivec2(cr), 0);
	float mx = texelFetch(u_mx, ivec2(0), 0).r;
	if (g.a <= 0.0 || mx <= 0.0) discard;
	int k = min(u_n - 1, int(floor(g.r / mx * float(u_n))));
	vec4 c = texelFetch(u_cr, ivec2(k, 0), 0);
	float a = c.a * u_opacity;
	o = vec4(c.rgb * a, a);
}`;

// 一つのオーバーレイ＝一つの閉包（2026-10-17・旧＝URL ごとに別のモジュール実体＝?ov=）。render worker の BUILTIN_OVERLAYS が create() で作る
export function create() {
	let gl: WebGL2RenderingContext = null!, host: OverlayHost | null = null;
	let acc: Prog | null = null, mxp: Prog | null = null, col: Prog | null = null, vao: WebGLVertexArrayObject | null = null, quad: WebGLBuffer | null = null, empty: WebGLVertexArrayObject | null = null;
	let posBuf: WebGLBuffer | null = null, wBuf: WebGLBuffer | null = null, n = 0, hasW = false, crTex: WebGLTexture | null = null, crN = 0;
	let grid: Target | null = null, mx: Target | null = null, fmt: { i: GLenum; t: GLenum } | null = null;
	let style: GridStyle = { cellPx: 24, colorRange: [[255, 255, 178, 40], [254, 217, 118, 120], [254, 178, 76, 170], [253, 141, 60, 200], [240, 59, 32, 230], [189, 0, 38, 255]], agg: "sum", opacity: 1, gap: 1 };
	let last: Grid | null = null;
	const probes: unknown[] = [];
	function compile(vs: string, fs: string, names: string[]): Prog {
		const p = gl.createProgram();
		for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as [GLenum, string][]) {
			const s = gl.createShader(t)!; gl.shaderSource(s, src); gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!);
			gl.attachShader(p, s);
		}
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
		const u: Uniforms = {}; for (const k of names) u[k] = gl.getUniformLocation(p, k);
		return { p, u };
	}
	function init(canvas: OffscreenCanvas, _opts: unknown, h: OverlayHost | null): void {
		host = h || null;
		gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false }) as WebGL2RenderingContext;
		// 窓＝32bit 浮動小数（足し算に混ぜられる時）か 16bit（件数・重みの和が 2048 を超えると丸まる＝色の段の粒では効かない）
		const cbf = !!gl.getExtension("EXT_color_buffer_float");
		fmt = cbf && gl.getExtension("EXT_float_blend") ? { i: gl.RGBA32F, t: gl.FLOAT } : cbf || gl.getExtension("EXT_color_buffer_half_float") ? { i: gl.RGBA16F, t: gl.HALF_FLOAT } : { i: gl.RGBA8, t: gl.UNSIGNED_BYTE };
		acc = compile(VS_ACC, FS_ACC, ["u_mvp", "u_eye", "u_scr", "u_grid", "u_cell", "u_count"]);
		mxp = compile(VS_MAX, FS_MAX, ["u_g", "u_cols"]);
		col = compile(VS_COL, FS_COL, ["u_g", "u_mx", "u_cr", "u_n", "u_cell", "u_gap", "u_h", "u_opacity"]);
		quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		vao = gl.createVertexArray(); empty = gl.createVertexArray();
		crTex = gl.createTexture(); setRamp();
	}
	function setRamp() {
		const CR = style.colorRange?.length ? style.colorRange : [[255, 255, 255, 255] as Rgba], d = new Uint8Array(CR.length * 4);
		CR.forEach((c, i) => { d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3] ?? 255; });
		gl.bindTexture(gl.TEXTURE_2D, crTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, CR.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		crN = CR.length;
	}
	function message(d: GridMsg): void {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!gl) return;
		if (d.type === "data") {
			n = d.lon.length; hasW = !!d.w;
			const pos = new Float32Array(n * 3);
			for (let i = 0; i < n; i++) { const u = lonlatTo3D(d.lon[i], d.lat[i]); pos[i * 3] = u[0]; pos[i * 3 + 1] = u[1]; pos[i * 3 + 2] = u[2]; }
			posBuf ??= gl.createBuffer(); wBuf ??= gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
			gl.bindBuffer(gl.ARRAY_BUFFER, wBuf); gl.bufferData(gl.ARRAY_BUFFER, d.w || new Float32Array(n).fill(1), gl.STATIC_DRAW);
			gl.bindVertexArray(vao);
			gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, wBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
			gl.bindVertexArray(null);
		}
		else if (d.type === "style") { const { type: _t, ...rest } = d; style = { ...style, ...rest }; if (d.colorRange) setRamp(); }
		else if (d.type === "clear") { n = 0; last = null; }
		host?.requestDraw?.();
	}
	const target = (t: Target | null, w: number, h: number): Target => {
		if (t && t.w === w && t.h === h) return t;
		if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
		const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texStorage2D(gl.TEXTURE_2D, 1, fmt!.i, w, h);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		return { tex, fbo, w, h };
	};
	function frame(cam: CameraPose, s: CameraState, { w, h }: OverlaySize): boolean {
		if (!gl) return false;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		last = null;
		if (n) draw(cam, s, w, h);
		answerProbes(w, h);
		return false;
	}
	function draw(cam: CameraPose, s: CameraState, w: number, h: number) {
		const dpr = cam.dpr || 1, cell = Math.max(2, style.cellPx * dpr), cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
		// ① 点 → 格子
		grid = target(grid, cols, rows);
		gl.bindFramebuffer(gl.FRAMEBUFFER, grid.fbo); gl.viewport(0, 0, cols, rows);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
		gl.blendEquationSeparate(style.agg === "max" ? gl.MAX : gl.FUNC_ADD, gl.FUNC_ADD);   // R＝値（max は MAX）・A＝件数（足す）
		gl.useProgram(acc!.p);
		gl.uniformMatrix4fv(acc!.u.u_mvp, false, new Float32Array(s.mvp));
		gl.uniform3fv(acc!.u.u_eye, new Float32Array(s.eye));
		gl.uniform2f(acc!.u.u_scr, w, h); gl.uniform2f(acc!.u.u_grid, cols, rows); gl.uniform1f(acc!.u.u_cell, cell);
		gl.uniform1f(acc!.u.u_count, style.agg === "count" || !hasW ? 1 : 0);
		gl.bindVertexArray(vao); gl.drawArrays(gl.POINTS, 0, n); gl.bindVertexArray(null);
		// ② 最大値
		mx = target(mx, 1, 1);
		gl.bindFramebuffer(gl.FRAMEBUFFER, mx.fbo); gl.viewport(0, 0, 1, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.blendEquation(gl.MAX);
		gl.useProgram(mxp!.p);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, grid.tex); gl.uniform1i(mxp!.u.u_g, 0); gl.uniform1i(mxp!.u.u_cols, cols);
		gl.bindVertexArray(empty); gl.drawArrays(gl.POINTS, 0, cols * rows); gl.bindVertexArray(null);
		// ③ 色付け（画面へ・前乗算）
		gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
		gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(col!.p);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, grid.tex); gl.uniform1i(col!.u.u_g, 0);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mx.tex); gl.uniform1i(col!.u.u_mx, 1);
		gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, crTex); gl.uniform1i(col!.u.u_cr, 2);
		gl.uniform1i(col!.u.u_n, crN); gl.uniform1f(col!.u.u_cell, cell); gl.uniform1f(col!.u.u_gap, style.gap * dpr); gl.uniform1f(col!.u.u_h, h); gl.uniform1f(col!.u.u_opacity, style.opacity);
		gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disableVertexAttribArray(0); gl.activeTexture(gl.TEXTURE0); gl.disable(gl.BLEND);
		last = { cols, rows, cell };
	}
	// 検定用の画素（premultiplied RGBA・上が先＝旧 canvas2D の getImageData と同じ向きに並べ直す）＝描いた直後に readPixels して host へ
	function answerProbes(w: number, h: number) {
		if (!probes.length) return;
		const ids = probes.splice(0);
		try { const raw = new Uint8Array(w * h * 4), data = new Uint8Array(w * h * 4), row = w * 4; gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw); for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: false, data: id === ids[ids.length - 1] ? data : data.slice() }); }
		catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
	}
	// 窓の 1 texel を読む（浮動小数の窓は FLOAT で読める・RGBA8 の窓は 0〜1 に丸まる）
	const texel = (t: Target, x: number, y: number) => {
		gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
		const fl = fmt!.t !== gl.UNSIGNED_BYTE, out = fl ? new Float32Array(4) : new Uint8Array(4);
		gl.readPixels(x, y, 1, 1, gl.RGBA, fl ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return fl ? [...out] : [...out].map(v => v / 255);
	};
	function pick(x: number, y: number) {
		if (!last || !grid || !mx) return null;
		const c = Math.floor(x / last.cell), r = Math.floor(y / last.cell); if (c < 0 || r < 0 || c >= last.cols || r >= last.rows) return null;
		const g = texel(grid, c, r); if (!(g[3] > 0)) return null;
		const k = r * last.cols + c;
		return { id: k + 1, index: k, distance: 0, lngLat: null, properties: { count: g[3], value: g[0], col: c, row: r, max: texel(mx, 0, 0)[0] } };
	}
	function destroy(): void { gl?.getExtension("WEBGL_lose_context")?.loseContext(); gl = null!; last = null; }
	return { init, message, frame, pick, destroy };
}
