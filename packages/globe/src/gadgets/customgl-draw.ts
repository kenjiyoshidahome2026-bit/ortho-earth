// MapLibre の custom 層（CustomLayerInterface）を render worker の中で描く同一フレームのオーバーレイ（deck.gl 差分 PR-7・計画 段 C3・2026-10-12）。
// 既存の customgl.js（main の別 canvas）は地図と深度を共有せず常に手前。こちらは OffscreenCanvas の WebGL2 に層の render(gl, args) を呼び、
// 本体の深度（#47・api.depth）を**深度バッファに前置きで書き込む**＝renderingMode "3d" の層は shader を直さずに地形・建物に隠れる（深度テストがそのまま効く）。
// 層のコードは worker で動く＝main の object は渡せない。利用者はモジュールの URL で渡す：
//   addLayer の層の指定＝{ id, type: "custom", renderingMode: "3d", url: <モジュールの URL>, params, depth: true }（globe.js の mountLayer がこの overlay を作る）
//   モジュール＝export function createLayer(params, env) → 層（onAdd(map, gl) / prerender?(gl, args) / render(gl, args) / onRemove?(map, gl) / onMessage?(data, map)）
//           または export default 層。args は main の customgl と同じ物（customgl-args.js・mainMatrix＝メルカトル→クリップ・getProjectionData・prelude）。
//   onAdd/render の map＝小さな代理（triggerRepaint・getCanvas（OffscreenCanvas）・getProjection・getZoom）。three.js を使う層は三者の URL をモジュール内で import する（three-draw.js と同じ流儀＝repo の依存にしない）。
//   メッセージ：h.post(data) → 層の onMessage(data, map)。検定用の { type:"probe", id }＝次の frame の後に自分の画素を host.post（{ type:"pixels", … }）。
// 深度の前置き：全画面 1 三角形・colorMask off・depthFunc ALWAYS で、シーンの深度（log の 24bit・DEPTH_GLSL の depthOfW の逆）を層と同じ透視行列の NDC z に戻して gl_FragDepth へ。
//   クリア値（1＝何も無い）はそのまま 1。深度の無いフレーム（申し出前・LOW_MEM）は前置きを飛ばす＝隠れない（従来の挙動）。
// 契約（map.overlay）：init(canvas, opts, host) / message(d) / frame(cam, s, size, api) / destroy()。opts＝{ module, params, renderingMode, depth, projection }
// ⚠ 依存ゼロ（import 文なし）＝vite は ?url のファイルをそのまま置く（arcs-gl.js 等と同じ）。args（customgl-args.ts の makeCustomArgs）は host.customArgs、深度の GLSL は host.depthGLSL（render worker が渡す）。
import type { CameraPose, CameraState, DepthApi, OverlayApi, OverlayHost, OverlaySize } from "../types/overlay.ts";
type Uniforms = Record<string, WebGLUniformLocation | null>;
type CustomArgs = ReturnType<OverlayHost["customArgs"]>;
type RenderingMode = "2d" | "3d";
interface CustomGLOpts { module?: string; params?: unknown; renderingMode?: RenderingMode; depth?: boolean; projection?: string }
interface ProxyMap {
	triggerRepaint(): void; getCanvas(): OffscreenCanvas | null; getProjection(): { type: string }; getZoom(): number;
	getCenter(): { lng: number; lat: number }; getBearing(): number; getPitch(): number; getContainer(): null; readonly version: string;
}
interface CustomLayer {
	id?: string; renderingMode?: RenderingMode;
	onAdd?(map: ProxyMap, gl: WebGL2RenderingContext): void;
	prerender?(gl: WebGL2RenderingContext, args: CustomArgs): void;
	render(gl: WebGL2RenderingContext, args: CustomArgs): void;
	onRemove?(map: ProxyMap, gl: WebGL2RenderingContext): void;
	onMessage?(data: unknown, map: ProxyMap): void;
}
interface LayerModule {
	createLayer?(params: unknown, env: { host: OverlayHost | null }): CustomLayer | null | undefined | Promise<CustomLayer | null | undefined>;
	default?: CustomLayer; layer?: CustomLayer;
}
type CustomMsg = { type?: unknown; id?: unknown; [k: string]: unknown } | null | undefined;

let gl: WebGL2RenderingContext = null!, host: OverlayHost | null = null, opts: CustomGLOpts | null = null, layer: CustomLayer | null | undefined = null, ready = false, failed: string | null = null, canvasRef: OffscreenCanvas | null = null, lastCam: CameraPose | null = null, lastSize: OverlaySize | null = null;
let dprog: WebGLProgram | null = null, duni: Uniforms | null = null, dvao: WebGLVertexArrayObject | null = null;   // 深度の前置きパス
const probes: unknown[] = [];

const VS_FULL = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_DEPTH = (depthGLSL: string) => `#version 300 es
precision highp float;
${depthGLSL}
uniform vec2 u_size;
uniform vec4 u_P;   // 透視行列の (m[10], m[14], m[11], m[15])＝clip.z = P10·ze + P14・clip.w = P11·ze + P15
out vec4 o;
void main() {
	vec2 uv = gl_FragCoord.xy / u_size;
	float s = sceneDepthAt(uv);
	o = vec4(0.0);
	if (u_sceneDepthOn < 0.5 || s >= 1.0) { gl_FragDepth = 1.0; return; }
	float w = exp2(2.0 * (s + u_sceneDepthEps) / u_sceneLogCoef) - 1.0;   // depthOfW の逆（eps＝シーンを僅かに奥へ＝同じ面の層が勝つ）
	float ze = (w - u_P.w) / u_P.z;
	float z = (u_P.x * ze + u_P.y) / w;
	gl_FragDepth = clamp(z * 0.5 + 0.5, 0.0, 1.0);
}`;

function compile(vs: string, fs: string): { p: WebGLProgram; u: Uniforms } {
	const mk = (type: GLenum, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!); return s; };
	const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
	const u: Uniforms = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i)!.name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
// 層に渡す map の代理（MapLibre の Map のうち custom 層がよく触る口だけ）
const R2D = 180 / Math.PI;
const proxyMap: ProxyMap = {
	triggerRepaint() { host?.requestDraw?.(); },
	getCanvas() { return canvasRef; },
	getProjection() { return { type: opts?.projection || "mercator" }; },
	getZoom() { return lastCam?.zoom ?? 0; },
	getCenter() { return lastCam ? { lng: lastCam.center[0], lat: lastCam.center[1] } : { lng: 0, lat: 0 }; },
	getBearing() { return (lastCam?.bearing || 0) * R2D; },
	getPitch() { return (lastCam?.pitch || 0) * R2D; },
	getContainer() { return null; },
	get version() { return "ortho-earth"; },
};

export function init(canvas: OffscreenCanvas, o: CustomGLOpts | null, h: OverlayHost | null) {
	host = h || null; opts = o || {}; canvasRef = canvas;
	gl = canvas.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false, depth: true, stencil: true }) as WebGL2RenderingContext;
	if (!gl) throw new Error("WebGL2 is not available (custom layer overlay)");
	const wantDepth = opts.depth !== false && (opts.renderingMode ?? "3d") === "3d";
	if (wantDepth && host?.depthGLSL) {
		try { ({ p: dprog, u: duni } = compile(VS_FULL, FS_DEPTH(host.depthGLSL))); dvao = gl.createVertexArray(); }
		catch (e) { dprog = null; console.warn("[customgl] depth prepass unavailable", (e as Error)?.message); }
	}
	if (typeof host?.customArgs !== "function") { failed = "custom layer: the render worker does not provide host.customArgs"; console.error("[customgl]", failed); host?.post?.({ type: "error", error: failed }); return; }
	if (!opts.module) { failed = "custom layer: url of the layer module is required"; console.error("[customgl]", failed); host?.post?.({ type: "error", error: failed }); return; }
	(async () => {
		try {
			const mod = await import(/* @vite-ignore */ opts!.module!) as LayerModule;
			layer = typeof mod.createLayer === "function" ? await mod.createLayer(opts!.params, { host }) : (mod.default ?? mod.layer);
			if (!layer || typeof layer.render !== "function") throw new Error("custom layer module must export createLayer(params) or a default layer with render(gl, args)");
			if (opts!.renderingMode && !layer.renderingMode) layer.renderingMode = opts!.renderingMode;
			layer.onAdd?.(proxyMap, gl);
			ready = true;
			host?.post?.({ type: "ready", id: layer.id ?? null, renderingMode: layer.renderingMode ?? "2d", depth: !!dprog });
			host?.requestDraw?.();
		} catch (e) { failed = String((e as Error)?.message || e); console.error("[customgl] module failed", opts!.module, e); host?.post?.({ type: "error", error: failed }); }
	})();
	return wantDepth ? { depth: true } : undefined;
}
export function message(d: CustomMsg) {
	if (d?.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!ready) return;
	try { layer!.onMessage?.(d, proxyMap); } catch (e) { console.error("[customgl] onMessage", (e as Error)?.message); }
	host?.requestDraw?.();
}
function depthPrepass(P: Float64Array, w: number, h: number, depth: DepthApi) {
	gl.useProgram(dprog); gl.bindVertexArray(dvao);
	depth.bind(gl, dprog!, 7);
	gl.uniform2f(duni!.u_size, w, h); gl.uniform4f(duni!.u_P, P[10], P[14], P[11], P[15]);
	gl.colorMask(false, false, false, false); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
	gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.colorMask(true, true, true, true); gl.bindVertexArray(null);
}
let depthUsed = false;
export function frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi) {
	if (!gl) return false;
	lastCam = cam; lastSize = size;
	const { w, h } = size;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, w, h);
	gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.depthMask(true); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clearStencil(0);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	if (ready) {
		const args = host!.customArgs(cam, w, h, opts!.projection);   // makeCustomArgs（earthM＝worldRadiusM・globe＝z<GLOBE_MAX_Z かつ投影が globe）
		const three = layer!.renderingMode === "3d";
		depthUsed = false;
		if (three && dprog && api?.depth) { try { depthPrepass(args._st.projection, w, h, api.depth); depthUsed = true; } catch (e) { console.warn("[customgl] depth prepass", (e as Error)?.message); } }
		// MapLibre が層の前に整える状態（深度は 3d の層だけ・ブレンドは事前乗算の合成）
		gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
		if (three) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); } else { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); }
		gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		try { layer!.prerender?.(gl, args); layer!.render(gl, args); } catch (e) { console.error(`[customgl] ${layer!.id ?? ""} render`, (e as Error)?.message); }
	}
	answerProbes(w, h);
	return false;
}
function answerProbes(w: number, h: number) {
	if (!probes.length) return;
	const ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, depthUsed, ready, failed, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
}
export function destroy() {
	try { if (ready) layer!.onRemove?.(proxyMap, gl); } catch { /* 片付けの失敗は無害 */ }
	layer = null; ready = false; gl = null!; dprog = null; dvao = null; canvasRef = null;
}
export const _state = () => ({ ready, failed, depthUsed });
