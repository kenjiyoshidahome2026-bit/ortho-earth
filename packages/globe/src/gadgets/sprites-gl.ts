// 絵の粒（sprite）のオーバーレイ（2026-10-28・Cesium の ParticleSystem＝BillboardCollection の粒・順 5）＝render worker の組み込み（BUILTIN_OVERLAYS の "sprites"）。
// 1 層＝1 枚の絵（ImageBitmap・無ければ丸）を、粒ごとの位置・色・大きさ・回転で画面に向けて貼る。粒は毎フレーム動く（煙・花火・雨）＝main から毎回まとめて送る。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"layer", q, n, origin:[X,Y,Z]（ECEF m・倍精度）, pos: Float32Array(n*3)（origin からの ECEF m）, rgba: Uint8Array(n*4)（premultiplied でない）,
//             size: Float32Array(n*2)（幅・高さ＝meters なら m、でなければ CSS px）, rot?: Float32Array(n)（rad・反時計回り）, meters?: boolean }＝同じ q は置き換え
//           ／{ type:"image", q, image: ImageBitmap | null }（層の絵・一度だけ送る）／{ type:"remove", q }／{ type:"clear" }
//   描いた後＝新しい layer を受けていたら host.post({ type:"drawn" })＝main はこれを待ってから次の粒を送る（遅い GPU にメッセージを溜めない）
// 置き方＝czml-draw と同じ：楕円体＝ECEF を a で割り y を b/a で割る（β ワールド）・球＝測地の緯度・経度・高さ（単位球の地表点×(1＋h/R)）。
// 位置（ECEF→画面）と地球の陰は CPU（粒は数千まで）、描くのは GPU の画面の四角（instanced）。シーンの深度（地形・建物・模型）に隠れる所は捨てる（opts.depth・api.depth）。
import { ellipsoidOn, worldRadiusM } from "@ortho-earth/core/camera";
import { ecefToLlh } from "../czml-time.ts";
import type { CameraPose, CameraState, OverlayApi, OverlayHost, OverlaySize } from "../types/overlay.ts";

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Layer { n: number; origin: number[]; pos: Float32Array; rgba: Uint8Array; size: Float32Array; rot: Float32Array | null; meters: boolean; tex: WebGLTexture | null; on: boolean }
type Msg =
	| { type: "layer"; q: string; n: number; origin: number[]; pos: Float32Array; rgba: Uint8Array; size: Float32Array; rot?: Float32Array | null; meters?: boolean }
	| { type: "image"; q: string; image: ImageBitmap | null }
	| { type: "remove"; q: string } | { type: "vis"; q: string; on: unknown } | { type: "clear" } | { type: "probe"; id: unknown };

const D2R = Math.PI / 180;
const STRIDE = 10;   // 粒ごと：中心（device px）x, y・半幅・半高・回転・clip w（深度）・r, g, b, a（premultiplied でない 0..1）
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;   // -1..1 の四隅
layout(location = 1) in vec4 a_c;        // x, y, hw, hh（device px）
layout(location = 2) in vec2 a_rw;       // 回転・clip w
layout(location = 3) in vec4 a_col;
uniform vec2 u_vp;
out vec2 v_uv; out vec4 v_col; out float v_w;
void main() {
	float c = cos(a_rw.x), s = sin(a_rw.x);
	vec2 d = vec2(a_corner.x * a_c.z, a_corner.y * a_c.w);
	vec2 p = a_c.xy + vec2(c * d.x - s * d.y, -(s * d.x + c * d.y));   // 画面は y 下向き＝反時計回りは -y
	v_uv = vec2(a_corner.x * 0.5 + 0.5, 0.5 - a_corner.y * 0.5);
	v_col = a_col; v_w = a_rw.y;
	gl_Position = vec4(p.x / u_vp.x * 2.0 - 1.0, 1.0 - p.y / u_vp.y * 2.0, 0.0, 1.0);
}`;
const DEPTH_STUB = `highp float sceneOcclusion(highp vec2 uv, highp float w) { return 0.0; }`;
const FS = (depthGLSL: string) => `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_col; in float v_w;
uniform sampler2D u_img; uniform float u_hasImg; uniform vec2 u_vp;
${depthGLSL}
out vec4 o;
void main() {
	vec4 t;
	if (u_hasImg > 0.5) t = texture(u_img, v_uv);   // premultiplied で上げてある
	else { float r = length(v_uv * 2.0 - 1.0); float a = clamp((1.0 - r) * 8.0, 0.0, 1.0); t = vec4(a); }
	vec4 col = t * vec4(v_col.rgb, 1.0) * v_col.a;
	if (col.a <= 0.002) discard;
	float occ = sceneOcclusion(vec2(gl_FragCoord.x, gl_FragCoord.y) / u_vp, v_w);
	if (occ > 0.5) discard;
	o = col;
}`;

/** ECEF（m）→ この地図の世界（単位球／β ワールド）。純関数（tests が読む） */
export function ecefToWorld(X: number, Y: number, Z: number, ell: boolean, R: number, rAx: number): [number, number, number] {
	if (ell) return [X / R, Z / (R * rAx), Y / R];
	const llh = ecefToLlh(X, Y, Z), a = llh[0] * D2R, b = llh[1] * D2R, k = 1 + llh[2] / R, cb = Math.cos(b);
	return [cb * Math.cos(a) * k, Math.sin(b) * k, cb * Math.sin(a) * k];
}

export function create() {
	let gl: WebGL2RenderingContext | null = null, prog: WebGLProgram | null = null, uni: Uniforms = {}, host: OverlayHost | null = null, wantDepth = false;
	let vao: WebGLVertexArrayObject | null = null, quad: WebGLBuffer | null = null, inst: WebGLBuffer | null = null, cpu = new Float32Array(0);
	const layers = new Map<string, Layer>(), images = new Map<string, WebGLTexture | null>();
	const probes: unknown[] = [];
	let fresh = false;   // a layer came in since the last frame (answered with { type:"drawn" } after drawing it)

	function compile(vs: string, fs: string): { p: WebGLProgram; u: Uniforms } {
		const mk = (type: GLenum, src: string) => { const s = gl!.createShader(type)!; gl!.shaderSource(s, src); gl!.compileShader(s); if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s)!); return s; };
		const p = gl!.createProgram(); gl!.attachShader(p, mk(gl!.VERTEX_SHADER, vs)); gl!.attachShader(p, mk(gl!.FRAGMENT_SHADER, fs)); gl!.linkProgram(p);
		if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p)!);
		const u: Uniforms = {}; for (let i = 0, n = gl!.getProgramParameter(p, gl!.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl!.getActiveUniform(p, i)!.name; u[nm] = gl!.getUniformLocation(p, nm); }
		return { p, u };
	}
	function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null) {
		host = h;
		gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false }) as WebGL2RenderingContext | null;
		if (!gl) throw new Error("WebGL2 is not available (sprites overlay)");
		wantDepth = opts.depth !== false && !!h?.depthGLSL;
		({ p: prog, u: uni } = compile(VS, FS(wantDepth ? h!.depthGLSL : DEPTH_STUB)));
		vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		inst = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, inst);
		const B = STRIDE * 4;
		gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, B, 0); gl.vertexAttribDivisor(1, 1);
		gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 16); gl.vertexAttribDivisor(2, 1);
		gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, B, 24); gl.vertexAttribDivisor(3, 1);
		gl.bindVertexArray(null);
		return wantDepth ? { depth: true } : undefined;
	}
	function upload(img: ImageBitmap): WebGLTexture {
		const g = gl!, t = g.createTexture()!;
		g.bindTexture(g.TEXTURE_2D, t);
		g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
		g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img);
		g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		g.generateMipmap(g.TEXTURE_2D);
		g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
		g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
		return t;
	}
	function message(d: Msg) {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!gl) return;
		if (d.type === "image") {
			const old = images.get(d.q); if (old) gl.deleteTexture(old);
			const t = d.image ? upload(d.image) : null;
			images.set(d.q, t); d.image?.close?.();
			const L = layers.get(d.q); if (L) L.tex = t;
		} else if (d.type === "layer") {
			fresh = true;
			layers.set(d.q, { n: d.n, origin: d.origin, pos: d.pos, rgba: d.rgba, size: d.size, rot: d.rot ?? null, meters: !!d.meters, tex: images.get(d.q) ?? null, on: layers.get(d.q)?.on ?? true });
		} else if (d.type === "remove") { layers.delete(d.q); const t = images.get(d.q); if (t) gl.deleteTexture(t); images.delete(d.q); }
		else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; }
		else if (d.type === "clear") { layers.clear(); for (const t of images.values()) if (t) gl.deleteTexture(t); images.clear(); }
		host?.requestDraw?.();
	}
	function answerProbes(w: number, h: number) {
		if (!probes.length) return;
		const ids = probes.splice(0);
		try { const data = new Uint8Array(w * h * 4); gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
		catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
	}
	/** 1 層の粒 → 画面の四角（cpu へ詰める）。戻り＝詰めた数 */
	function project(L: Layer, s: CameraState, w: number, h: number, dpr: number, rAx: number, clip: OverlayApi["clip"]): number {
		const m = s.mvp, E = s.eye, ell = ellipsoidOn(), R = worldRadiusM(), o = L.origin;
		if (cpu.length < L.n * STRIDE) cpu = new Float32Array(Math.max(L.n, 64) * STRIDE * 2);
		let k = 0;
		for (let i = 0; i < L.n; i++) {
			const a = L.rgba[i * 4 + 3];
			if (!a) continue;
			const X = o[0] + L.pos[i * 3], Y = o[1] + L.pos[i * 3 + 1], Z = o[2] + L.pos[i * 3 + 2];
			const [x, y, z] = ecefToWorld(X, Y, Z, ell, R, rAx);
			const ww = m[3] * x + m[7] * y + m[11] * z + m[15];
			if (ww <= 1e-9) continue;
			// 地球の陰（視線が単位球を通る）
			const dx = x - E[0], dy = y - E[1], dz = z - E[2], dd = dx * dx + dy * dy + dz * dz, tt = -(E[0] * dx + E[1] * dy + E[2] * dz) / dd;
			if (tt > 0 && tt < 1) { const px = E[0] + dx * tt, py = E[1] + dy * tt, pz = E[2] + dz * tt; if (px * px + py * py + pz * pz < 0.99999) continue; }
			if (clip) { const llh = ecefToLlh(X, Y, Z); if (clip.distM(llh[0], llh[1], llh[2]) < 0) continue; }
			const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / ww * 0.5 + 0.5) * w, sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / ww * 0.5 + 0.5)) * h;
			// 大きさ：m＝その距離での画素（focal は単位距離での device px）・px＝CSS px × dpr
			const f = L.meters ? s.focal / (ww * R) : dpr, hw = L.size[i * 2] * f * 0.5, hh = L.size[i * 2 + 1] * f * 0.5;
			if (hw < 0.05 && hh < 0.05) continue;
			const rr = Math.max(hw, hh) * 1.415;
			if (sx + rr < 0 || sy + rr < 0 || sx - rr > w || sy - rr > h) continue;
			const b = k * STRIDE;
			cpu[b] = sx; cpu[b + 1] = sy; cpu[b + 2] = hw; cpu[b + 3] = hh; cpu[b + 4] = L.rot ? L.rot[i] : 0; cpu[b + 5] = ww;
			cpu[b + 6] = L.rgba[i * 4] / 255; cpu[b + 7] = L.rgba[i * 4 + 1] / 255; cpu[b + 8] = L.rgba[i * 4 + 2] / 255; cpu[b + 9] = a / 255;
			k++;
		}
		return k;
	}
	function frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi) {
		if (!gl) return false;
		const g = gl, { w, h } = size;
		g.bindFramebuffer(g.FRAMEBUFFER, null);
		g.viewport(0, 0, w, h);
		g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT);
		if (layers.size) {
			g.useProgram(prog);
			if (wantDepth) { if (api?.depth) api.depth.bind(g, prog!, 3); else if (uni.u_sceneDepthOn) g.uniform1f(uni.u_sceneDepthOn, 0); }
			g.uniform2f(uni.u_vp, w, h);
			g.enable(g.BLEND); g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA); g.disable(g.DEPTH_TEST);
			g.bindVertexArray(vao);
			for (const L of layers.values()) {
				if (!L.on || !L.n) continue;
				const k = project(L, s, w, h, cam.dpr || api?.dpr || 1, api?.rAx || 1, api?.clip ?? null);
				if (!k) continue;
				g.bindBuffer(g.ARRAY_BUFFER, inst); g.bufferData(g.ARRAY_BUFFER, cpu.subarray(0, k * STRIDE), g.STREAM_DRAW);
				g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, L.tex); g.uniform1i(uni.u_img, 0); g.uniform1f(uni.u_hasImg, L.tex ? 1 : 0);
				g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, k);
			}
			g.bindVertexArray(null);
		}
		answerProbes(w, h);
		if (fresh) { fresh = false; host?.post?.({ type: "drawn" }); }   // main sends the next frame's particles only after this (a slow GPU is not flooded with messages)
		return false;
	}
	const _state = () => ({ layers: [...layers].map(([q, L]) => ({ q, n: L.n, meters: L.meters, image: !!L.tex, on: L.on })) });
	function destroy() {
		if (!gl) return;
		for (const t of images.values()) if (t) gl.deleteTexture(t);
		images.clear(); layers.clear();
		gl.deleteBuffer(quad); gl.deleteBuffer(inst); gl.deleteVertexArray(vao); gl.deleteProgram(prog);
		gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null;
	}
	return { init, message, frame, _state, destroy };
}
