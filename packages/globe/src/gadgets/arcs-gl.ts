// 弧のオーバーレイ（同一フレームのオーバーレイ＝map.overlay・レンダーワーカー内で地球と同じ rAF・同じ cam に描く）。deck.gl の ArcLayer／GreatCircleLayer の相当（差分 PR-4・2026-10-12）。
// 始点と終点を単位球の上で slerp（大円）し、弦長比の高さの放物線で持ち上げる。頂点はシェーダで補間（CPU は始点・終点・開き角だけ持つ＝弧 1 本＝インスタンス 1 つ）。幅は px。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"layer", q, n, src: Float32Array(n*3), dst: Float32Array(n*3), theta: Float32Array(n), rgba?: Uint8Array(n*4), rgba2?: Uint8Array(n*4), width?: Float32Array(n), height?: Float32Array(n), origin?: [x,y,z] }
//           src/dst＝β 単位球の xyz の原点相対（RTE・points-gl と同じ）、theta＝始点と終点の開き角（rad・倍精度で求めておく＝f32 の acos は近い 2 点で崩れる）、
//           rgba/rgba2＝始点側・終点側の色（無ければ style の色・t で混ぜる）、width＝px（無ければ style.width）、height＝弦長に対する高さの比（0＝大円が地面を這う・無ければ style.height）
//           ／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"style", width, color, color2, height, segments }／{ type:"clear" }／{ type:"probe", id }（検定用の画素＝points-gl と同じ口）
//           PR-6：layer に f（弧ごとのフィルタの値）、{ type:"filter", q?, range }・{ type:"brush", x, y, r }（始点か終点がブラシの中）・{ type:"mask", bbox, w, h, data }（始点がマスクの中）
// 補間（純関数 arcPoint＝node の検定 tests/arcs.mjs が読む）：p(t) = (sin((1−t)θ)·A + sin(tθ)·B) / sinθ（単位球の上）＋ 4·h·弦長·t(1−t) を動径の向きへ。
//   原点相対のまま：p − O = cA·(A−O) + cB·(B−O) + (cA+cB−1)·O ＝ 近い 2 点（θ 小）では cA+cB−1 ≈ 0 で O の f32 誤差が消える（RTE が効く）。
// 当たり判定（統一 picking・PR-1）：pick(x, y, r, ctx)＝弧の番号（層の base＋gl_InstanceID・1 から）を RGBA8 に焼く別パス＝points-gl と同じ流儀。
// render worker の組み込み（BUILTIN_OVERLAYS の "arcs"・create() で実体を作る）。
import type { CameraPose, CameraState, LastOverlayFrame, OverlayApi, OverlayHost, OverlaySize } from "../types/overlay.ts";
type Uniforms = Record<string, WebGLUniformLocation | null>;
/** 層（q ごと）＝has＝属性を持つか（無ければ style の定数） */
interface Layer {
	n: number; bufs: WebGLBuffer[]; vao: WebGLVertexArrayObject | null; has: { c: boolean; c2: boolean; w: boolean; h: boolean; f?: boolean };
	src: Float32Array; dst: Float32Array; origin: ArrayLike<number> | null; on: boolean; base: number; filter?: number[] | null;
}
interface Style { width: number; color: number[]; color2: number[] | null; height: number; segments: number }
/** message(d) の形 */
type Msg =
	| { type: "probe"; id: unknown }
	| { type: "layer"; q: string; n: number; src: Float32Array; dst: Float32Array; theta: Float32Array; rgba?: Uint8Array; rgba2?: Uint8Array; width?: Float32Array; height?: Float32Array; f?: Float32Array; origin?: ArrayLike<number> | null }
	| { type: "remove"; q: string } | { type: "vis"; q: string; on: unknown } | { type: "clear" }
	| ({ type: "style" } & Partial<Style>)
	| { type: "filter"; q?: string | null; range: ArrayLike<number> | null }
	| { type: "brush"; x?: number | null; y: number; r: number }
	| { type: "mask"; bbox: number[]; w: number; h: number; data: ArrayBufferView | null };
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_tv;      // 頂点ごと：t（0..1）と側（−1/+1）
layout(location = 1) in vec3 a_src;     // 以下インスタンス（弧）ごと
layout(location = 2) in vec3 a_dst;
layout(location = 3) in float a_theta;
layout(location = 4) in vec4 a_c0;
layout(location = 5) in vec4 a_c1;
layout(location = 6) in float a_w;      // 幅（CSS px）
layout(location = 7) in float a_h;      // 高さ（弦長比）
layout(location = 8) in float a_f;      // フィルタの値（PR-6）
uniform vec2 u_filter; uniform float u_filterOn;
uniform vec3 u_brush;                                      // ブラシ（x, y, r・device px）＝始点か終点が中なら描く
uniform sampler2D u_mask; uniform float u_maskOn; uniform vec4 u_maskBox; uniform float u_rAx;   // マスク＝始点の経緯度で
uniform mat4 u_mvp;        // 層ごと＝mvp×平行移動(origin)
uniform vec3 u_origin;
uniform vec3 u_eyeRel;     // eye − origin（倍精度で引いてから f32）
uniform float u_oe;        // dot(origin, eye − origin)（倍精度）
uniform vec2 u_half;       // canvas の半分（device px）
uniform float u_dpr;
uniform float u_seg;
out vec4 v_col;
out float v_side;          // 中心からの距離（device px・符号付き）
out float v_half;          // 幅の半分（device px）
out float v_hid;           // 地平線の判定＝dot(P, eye − P)（< 0 なら球の裏）。頂点で捨てずに FS で discard（帯の片側だけ消えて角へ伸びる棘を作らない）
vec3 arcRel(float t) {
	float th = a_theta, cA, cB;
	if (th < 1e-4) { cA = 1.0 - t; cB = t; } else { float s = sin(th); cA = sin((1.0 - t) * th) / s; cB = sin(t * th) / s; }
	vec3 rel = cA * a_src + cB * a_dst + (cA + cB - 1.0) * u_origin;
	float hh = 4.0 * a_h * 2.0 * sin(th * 0.5) * t * (1.0 - t);
	return hh > 0.0 ? rel + normalize(rel + u_origin) * hh : rel;
}
bool masked(vec3 rel) {
	vec3 P = rel + u_origin; float lon = degrees(atan(P.z, P.x)), beta = asin(clamp(P.y / length(P), -1.0, 1.0)), lat = degrees(atan(tan(beta) / u_rAx));
	vec2 uv = vec2((lon - u_maskBox.x) / (u_maskBox.z - u_maskBox.x), (lat - u_maskBox.y) / (u_maskBox.w - u_maskBox.y));
	return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || texture(u_mask, uv).r < 0.5;
}
vec2 scr(vec3 rel) { vec4 c = u_mvp * vec4(rel, 1.0); return vec2((c.x / c.w + 1.0) * u_half.x, (1.0 - c.y / c.w) * u_half.y); }
void main() {
	float t = a_tv.x, side = a_tv.y;
	v_col = mix(a_c0, a_c1, t);
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	if (u_filterOn > 0.5 && (a_f < u_filter.x || a_f > u_filter.y)) { gl_Position = off; return; }
	if (u_maskOn > 0.5 && masked(a_src)) { gl_Position = off; return; }
	if (u_brush.z > 0.0 && distance(scr(a_src), u_brush.xy) > u_brush.z && distance(scr(a_dst), u_brush.xy) > u_brush.z) { gl_Position = off; return; }
	vec3 p0 = arcRel(t);
	// dot(P, eye − P) を原点相対で：P = O + rel, eye − P = eyeRel − rel → dot(O, eyeRel) − dot(O, rel) + dot(rel, eyeRel) − dot(rel, rel)（絶対座標の f32 では z11 で判定が揺れ、棘になった）
	v_hid = u_oe - dot(u_origin, p0) + dot(p0, u_eyeRel) - dot(p0, p0);
	float dt = 1.0 / u_seg, sgn = t < 1.0 ? 1.0 : -1.0;
	vec3 p1 = arcRel(t + sgn * dt);
	vec4 c0 = u_mvp * vec4(p0, 1.0), c1 = u_mvp * vec4(p1, 1.0);
	if (c0.w <= 0.0) { gl_Position = off; return; }
	if (c1.w <= 0.0) c1 = c0 + vec4(1e-3, 0.0, 0.0, 0.0);
	vec2 s0 = c0.xy / c0.w * u_half, s1 = c1.xy / c1.w * u_half;
	vec2 tg = (s1 - s0) * sgn; float L = length(tg); tg = L > 1e-6 ? tg / L : vec2(1.0, 0.0);
	vec2 nrm = vec2(-tg.y, tg.x);
	float halfW = a_w * u_dpr * 0.5;
	v_half = halfW; v_side = side * (halfW + 0.5);
	gl_Position = c0; gl_Position.xy += nrm * v_side / u_half * c0.w;
}`;
const FS = `#version 300 es
precision highp float;
in vec4 v_col; in float v_side; in float v_half; in float v_hid;
out vec4 o;
void main() {
	if (v_hid < 0.0) discard;
	float cov = clamp(v_half + 0.5 - abs(v_side), 0.0, 1.0);
	if (cov <= 0.0) discard;
	float a = v_col.a * cov;
	o = vec4(v_col.rgb * a, a);
}`;
const FS_PICK = `#version 300 es
precision highp float;
flat in highp uint v_id; in float v_side; in float v_half; in float v_hid;
out vec4 o;
void main() {
	if (v_hid < 0.0) discard;
	if (abs(v_side) > v_half + 0.5) discard;
	o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;
}`;
// ── 純関数（node の検定が読む）
export const arcTheta = (A: ArrayLike<number>, B: ArrayLike<number>): number => Math.acos(Math.max(-1, Math.min(1, (A[0] * B[0] + A[1] * B[1] + A[2] * B[2]) / (Math.hypot(A[0], A[1], A[2]) * Math.hypot(B[0], B[1], B[2]) || 1))));
// A, B＝単位球の絶対座標。t＝0..1。h＝弦長に対する高さの比。シェーダ arcRel と同じ式（原点 0）
export function arcPoint(A: ArrayLike<number>, B: ArrayLike<number>, t: number, h = 0, theta = arcTheta(A, B)): number[] {
	let cA: number, cB: number;
	if (theta < 1e-4) { cA = 1 - t; cB = t; } else { const s = Math.sin(theta); cA = Math.sin((1 - t) * theta) / s; cB = Math.sin(t * theta) / s; }
	const p = [cA * A[0] + cB * B[0], cA * A[1] + cB * B[1], cA * A[2] + cB * B[2]];
	const hh = 4 * h * 2 * Math.sin(theta / 2) * t * (1 - t);
	if (hh > 0) { const r = Math.hypot(p[0], p[1], p[2]) || 1; for (let i = 0; i < 3; i++) p[i] += p[i] / r * hh; }
	return p;
}
export const decodeId = (r: number, g: number, b: number, a: number): number => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;

// 一つのオーバーレイ＝一つの閉包（2026-10-17・旧＝URL ごとに別のモジュール実体＝?ov=）。render worker の BUILTIN_OVERLAYS が create() で作る
export function create() {
	const VS_PICK = VS.replace("out vec4 v_col;", "out vec4 v_col; flat out highp uint v_id; uniform highp uint u_base;").replace("v_col = mix(a_c0, a_c1, t);", "v_col = mix(a_c0, a_c1, t); v_id = u_base + uint(gl_InstanceID);");
	function nearestId(data: ArrayLike<number>, side: number) {
		const c = (side - 1) / 2; let best: { id: number; distance: number } | null = null;
		for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
			const k = (j * side + i) * 4, id = decodeId(data[k], data[k + 1], data[k + 2], data[k + 3]);
			if (!id) continue;
			const d = Math.hypot(i - c, (side - 1 - j) - c);
			if (!best || d < best.distance) best = { id, distance: d };
		}
		return best;
	}

	let gl: WebGL2RenderingContext | null = null, prog: WebGLProgram | null = null, uni: Uniforms = {}, pickProg: WebGLProgram | null = null, pickUni: Uniforms = {}, pickFbo: WebGLFramebuffer | null = null, pickTex: WebGLTexture | null = null, pickW = 0, pickH = 0;
	let geomBuf: WebGLBuffer | null = null, geomSeg = 0, geomN = 0;   // 頂点ごとの (t, side)＝(seg+1)×2 の帯（全層で共用）
	const layers = new Map<string, Layer>();   // q → { n, bufs, vao, has:{c,w,h}, src, dst, origin, on, base }
	function rebase() { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
	let style: Style = { width: 2, color: [0.2, 0.6, 1, 0.9], color2: null, height: 0.3, segments: 32 };
	let brush: { x: number; y: number; r: number } | null = null, mask: { bbox: number[]; w: number; h: number } | null = null, maskTex: WebGLTexture | null = null, rAxNow = 1;
	let host: OverlayHost | null = null;
	const probes: unknown[] = [];

	function compile(vs: string, fs: string): { p: WebGLProgram; u: Uniforms } {
		const mk = (type: GLenum, src: string) => { const s = gl!.createShader(type)!; gl!.shaderSource(s, src); gl!.compileShader(s); if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s)!); return s; };
		const p = gl!.createProgram(); gl!.attachShader(p, mk(gl!.VERTEX_SHADER, vs)); gl!.attachShader(p, mk(gl!.FRAGMENT_SHADER, fs)); gl!.linkProgram(p);
		if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p)!);
		const u: Uniforms = {}; for (let i = 0, n = gl!.getProgramParameter(p, gl!.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl!.getActiveUniform(p, i)!.name; u[nm] = gl!.getUniformLocation(p, nm); }
		return { p, u };
	}
	function geometry(seg: number) {
		if (geomBuf && geomSeg === seg) return;
		seg = Math.max(2, Math.min(256, seg | 0));
		const v = new Float32Array((seg + 1) * 4);
		for (let i = 0; i <= seg; i++) { const t = i / seg; v[i * 4] = t; v[i * 4 + 1] = -1; v[i * 4 + 2] = t; v[i * 4 + 3] = 1; }
		geomBuf ??= gl!.createBuffer(); gl!.bindBuffer(gl!.ARRAY_BUFFER, geomBuf); gl!.bufferData(gl!.ARRAY_BUFFER, v, gl!.STATIC_DRAW);
		geomSeg = seg; geomN = (seg + 1) * 2;
		for (const L of layers.values()) bindGeom(L);   // VAO は geomBuf を指しているだけ＝差し替え不要・ただし初回に作る層のため
	}
	function bindGeom(L: Layer) { gl!.bindVertexArray(L.vao); gl!.bindBuffer(gl!.ARRAY_BUFFER, geomBuf); gl!.enableVertexAttribArray(0); gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0); gl!.vertexAttribDivisor(0, 0); gl!.bindVertexArray(null); }
	function init(canvas: OffscreenCanvas, _opts: object, h: OverlayHost | null) {
		host = h || null;
		gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: false }) as WebGL2RenderingContext | null;
		if (!gl) throw new Error("WebGL2 is not available (arcs overlay)");
		({ p: prog, u: uni } = compile(VS, FS));
		try { ({ p: pickProg, u: pickUni } = compile(VS_PICK, FS_PICK)); } catch (e) { pickProg = null; console.warn("[arcs] pick pass unavailable", (e as Error)?.message); }
		geometry(style.segments);
	}
	const drop: (L: Layer | undefined) => void = L => { if (!L) return; for (const b of L.bufs) gl!.deleteBuffer(b); gl!.deleteVertexArray(L.vao); };
	function message(d: Msg) {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!gl) return;
		if (d.type === "layer") {
			drop(layers.get(d.q));
			const vao = gl.createVertexArray(), bufs: WebGLBuffer[] = [];
			const L: Layer = { n: d.n, bufs, vao, has: { c: !!d.rgba, c2: !!d.rgba2, w: !!d.width, h: !!d.height }, src: d.src, dst: d.dst, origin: d.origin || null, on: true, base: 0 };
			bindGeom(L);
			gl.bindVertexArray(vao);
			const inst = (loc: number, arr: ArrayBufferView, size: number, type: GLenum, norm: boolean) => { const b = gl!.createBuffer(); bufs.push(b); gl!.bindBuffer(gl!.ARRAY_BUFFER, b); gl!.bufferData(gl!.ARRAY_BUFFER, arr, gl!.STATIC_DRAW); gl!.enableVertexAttribArray(loc); gl!.vertexAttribPointer(loc, size, type, norm, 0, 0); gl!.vertexAttribDivisor(loc, 1); };
			inst(1, d.src, 3, gl.FLOAT, false); inst(2, d.dst, 3, gl.FLOAT, false); inst(3, d.theta, 1, gl.FLOAT, false);
			if (d.rgba) inst(4, d.rgba, 4, gl.UNSIGNED_BYTE, true); else gl.disableVertexAttribArray(4);
			if (d.rgba2) inst(5, d.rgba2, 4, gl.UNSIGNED_BYTE, true);
			else if (d.rgba) { gl.bindBuffer(gl.ARRAY_BUFFER, bufs[3]); gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(5, 1); L.has.c2 = true; }   // 始点の色だけ＝終点も同じ色
			else gl.disableVertexAttribArray(5);
			if (d.width) inst(6, d.width, 1, gl.FLOAT, false); else gl.disableVertexAttribArray(6);
			if (d.height) inst(7, d.height, 1, gl.FLOAT, false); else gl.disableVertexAttribArray(7);
			if (d.f) { inst(8, d.f, 1, gl.FLOAT, false); L.has.f = true; } else gl.disableVertexAttribArray(8);
			gl.bindVertexArray(null);
			L.filter = layers.get(d.q)?.filter ?? null;
			layers.set(d.q, L); rebase();
		} else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); }
		else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; }
		else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); }
		else if (d.type === "style") { style = { ...style, ...d }; if (d.segments) geometry(d.segments); }
		else if (d.type === "filter") { const r = d.range ? [+d.range[0], +d.range[1]] : null; if (d.q != null) { const L = layers.get(d.q); if (L) L.filter = r; } else for (const L of layers.values()) L.filter = r; }
		else if (d.type === "brush") brush = d.x != null && d.r > 0 ? { x: d.x, y: d.y, r: d.r } : null;
		else if (d.type === "mask") {
			if (maskTex) { gl.deleteTexture(maskTex); maskTex = null; } mask = null;
			if (d.data && d.w && d.h) { maskTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, d.w, d.h, 0, gl.RED, gl.UNSIGNED_BYTE, d.data); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); mask = { bbox: d.bbox, w: d.w, h: d.h }; }
		}
		host?.requestDraw?.();
	}
	function answerProbes(w: number, h: number) {
		if (!probes.length) return;
		const ids = probes.splice(0);
		try { const data = new Uint8Array(w * h * 4); gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
		catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
	}
	function frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi) {
		if (!gl) return false;
		if (api?.rAx) rAxNow = api.rAx;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, size.w, size.h);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		if (layers.size) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); drawLayers(prog, uni, s, cam.dpr || 1, size, false); }
		answerProbes(size.w, size.h);
		return false;
	}
	function drawLayers(P: WebGLProgram | null, U: Uniforms, s: CameraState, dpr: number, { w, h }: OverlaySize, idMode: boolean) {
		gl!.useProgram(P);
		const M = s.mvp, mvpL = new Float32Array(16), mvp0 = new Float32Array(M), E = s.eye;
		gl!.uniform2f(U.u_half, w / 2, h / 2); gl!.uniform1f(U.u_dpr, dpr); gl!.uniform1f(U.u_seg, geomSeg);
		if (brush) gl!.uniform3f(U.u_brush, brush.x * dpr, brush.y * dpr, brush.r * dpr); else gl!.uniform3f(U.u_brush, 0, 0, 0);
		if (mask && maskTex) { gl!.activeTexture(gl!.TEXTURE0); gl!.bindTexture(gl!.TEXTURE_2D, maskTex); gl!.uniform1i(U.u_mask, 0); gl!.uniform1f(U.u_maskOn, 1); gl!.uniform4f(U.u_maskBox, mask.bbox[0], mask.bbox[1], mask.bbox[2], mask.bbox[3]); gl!.uniform1f(U.u_rAx, rAxNow); } else { gl!.uniform1f(U.u_maskOn, 0); gl!.activeTexture(gl!.TEXTURE0); gl!.bindTexture(gl!.TEXTURE_2D, null); }   // マスク無し＝unit 0 を空に（pick の FBO の texture が残っていると「読みながら書く」＝描画が黙って捨てられる）
		const c1 = style.color, c2 = style.color2 || style.color;
		for (const L of layers.values()) {
			if (!L.on) continue;
			const o = L.origin;
			if (o) {
				for (let i = 0; i < 12; i++) mvpL[i] = M[i];
				for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];
				gl!.uniformMatrix4fv(U.u_mvp, false, mvpL); gl!.uniform3f(U.u_origin, o[0], o[1], o[2]);
			} else { gl!.uniformMatrix4fv(U.u_mvp, false, mvp0); gl!.uniform3f(U.u_origin, 0, 0, 0); }
			const oo = o || [0, 0, 0], ex = E[0] - oo[0], ey = E[1] - oo[1], ez = E[2] - oo[2];
			gl!.uniform3f(U.u_eyeRel, ex, ey, ez); gl!.uniform1f(U.u_oe, oo[0] * ex + oo[1] * ey + oo[2] * ez);
			if (idMode) gl!.uniform1ui(U.u_base, L.base);
			gl!.uniform1f(U.u_filterOn, L.filter && L.has.f ? 1 : 0); if (L.filter) gl!.uniform2f(U.u_filter, L.filter[0], L.filter[1]);
			gl!.bindVertexArray(L.vao);
			if (!L.has.f) gl!.vertexAttrib1f(8, 0);
			// 無い属性は定数（generic attribute＝VAO の外の状態＝描く時に入れる）
			if (!L.has.c) gl!.vertexAttrib4f(4, c1[0], c1[1], c1[2], c1[3] ?? 1);
			if (!L.has.c2) gl!.vertexAttrib4f(5, c2[0], c2[1], c2[2], c2[3] ?? 1);
			if (!L.has.w) gl!.vertexAttrib1f(6, style.width);
			if (!L.has.h) gl!.vertexAttrib1f(7, style.height);
			gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, geomN, L.n);
		}
		gl!.bindVertexArray(null);
	}
	const toLngLat = (arr: ArrayLike<number> | null | undefined, i: number, o: ArrayLike<number>, rAx: number) => {
		if (!arr || arr.length < i * 3 + 3) return null;
		const px = arr[i * 3] + o[0], py = arr[i * 3 + 1] + o[1], pz = arr[i * 3 + 2] + o[2];
		const lon = Math.atan2(pz, px) * 180 / Math.PI, beta = Math.asin(Math.max(-1, Math.min(1, py / Math.hypot(px, py, pz))));
		return [lon, Math.atan(Math.tan(beta) / rAx) * 180 / Math.PI];
	};
	function pick(x: number, y: number, r: number, ctx: LastOverlayFrame) {
		if (!gl || !pickProg || !layers.size || !ctx?.s) return null;
		const { w, h } = ctx.size, dpr = ctx.cam?.dpr || 1;
		if (pickW !== w || pickH !== h || !pickFbo) {
			if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo);
			pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
			pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
			pickW = w; pickH = h;
		} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
		gl.viewport(0, 0, w, h); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		rAxNow = ctx.api?.rAx || rAxNow;
		drawLayers(pickProg, pickUni, ctx.s, dpr, { w, h }, true);
		const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
		const data = new Uint8Array(side * side * 4);
		const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
		if (cx1 > cx0 && cy1 > cy0) {
			const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4);
			gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub);
			for (let j = 0; j < cy1 - cy0; j++) data.set(sub.subarray(j * (cx1 - cx0) * 4, (j + 1) * (cx1 - cx0) * 4), ((j + cy0 - y0) * side + (cx0 - x0)) * 4);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const best = nearestId(data, side);
		if (!best) return null;
		let q: string | null = null, L: Layer | null = null; for (const [k, v] of layers) if (best.id >= v.base && best.id < v.base + v.n) { q = k; L = v; break; }
		if (!L) return null;
		const index = best.id - L.base, o = L.origin || [0, 0, 0], rAx = ctx.api?.rAx || 1;
		const source = toLngLat(L.src, index, o, rAx), target = toLngLat(L.dst, index, o, rAx);
		return { id: best.id, q, index, distance: best.distance, lngLat: source, properties: { q, index, source, target } };
	}
	function destroy() { if (!gl) return; layers.forEach(drop); layers.clear(); if (maskTex) gl.deleteTexture(maskTex); maskTex = null; mask = null; gl.deleteProgram(prog); if (pickProg) gl.deleteProgram(pickProg); if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo); if (geomBuf) gl.deleteBuffer(geomBuf); geomBuf = null; geomSeg = 0; pickProg = pickTex = pickFbo = null; pickW = pickH = 0; gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
	return { init, message, frame, pick, destroy };
}
