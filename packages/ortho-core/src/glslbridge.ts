// 利用者の GLSL の段を WebGPU の鎖の中で描く橋（2026-10-30・Cesium の PostProcessStage の fragmentShader＝fog-post-process など）。
// WebGPU は GLSL を読めない＝同じ worker に小さな WebGL2 の文脈（OffscreenCanvas）を立て、GL2 の段の描き手（gl/poststage.js）をそのまま走らせる：
//   ① 今の色と本体の対数深度（RGB8 に詰める・白＝遠方）を WebGPU の小さな canvas 2 枚へ描く → ここまでの命令を submit
//   ② 2 枚を transferToImageBitmap で GL のテクスチャへ（上下を返す＝v_textureCoordinates の下が 0）→ GL の段を順に（最後の段は GL の canvas へ）
//   ③ GL の canvas を readPixels で読み、writeTexture で WebGPU の的へ戻し、続きは新しい encoder で
// gl/ と gpu/ の両方に跨る＝どちらの下にも置かない（backend-split）。gpu/poststage.js が glsl の段を初めて見た時に動的 import で読む＝使わない WebGPU の束に GL の段は入らない。
// 1 フレームに GPU の写しが 2 回・CPU への読み戻しが 1 回と submit が 1 回増える＝glsl の段がある間だけの費用。GL の canvas は α 無し（不透明）＝戻す色の α は 1。
import { createPostStagesGL } from "./gl/poststage.ts";
import type { PostStagesGL, StageFrame } from "./gl/poststage.ts";
import type { PostStage } from "./postfx.ts";

const FULL_VS = `struct VOut { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
	var o: VOut;
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
	return o;
}`;
const COPY_WGSL = `@group(0) @binding(0) var src: texture_2d<f32>;
${FULL_VS}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return vec4f(textureLoad(src, vec2i(in.pos.xy), 0).rgb, 1.0); }`;
// 本体の深度（対数・0〜1）を RGB8 へ詰める（Cesium の czm_packDepth の 3 桁版）。1 以上＝遠方＝白
const PACK_WGSL = (ms: boolean): string => `@group(0) @binding(0) var dep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
${FULL_VS}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let d = textureLoad(dep, vec2i(in.pos.xy), 0);
	if (d >= 1.0) { return vec4f(1.0); }
	var e = fract(vec3f(1.0, 255.0, 65025.0) * d);
	e -= e.yzz * vec3f(1.0 / 255.0, 1.0 / 255.0, 0.0);
	return vec4f(e, 1.0);
}`;
/** 検定（t-wgsl）がコンパイルを検める口 */
export const BRIDGE_WGSL = Object.freeze({ BRIDGE_COPY_WGSL: COPY_WGSL, BRIDGE_PACK_WGSL: PACK_WGSL(false), BRIDGE_PACK_MS_WGSL: PACK_WGSL(true) });

export interface GlslBridgeFrame { depthTex: GPUTexture; samples: number; logCoef: number; dpr: number; fovy: number; frame: number }
export interface GlslBridge {
	/** enc の命令を submit し、src（色）と深度から GL の段を描いて dst（COPY_DST の付いた的）へ戻す。続きを書く新しい encoder を返す。描けない時は null（enc はそのまま） */
	run(enc: GPUCommandEncoder, stages: PostStage[], src: GPUTextureView, dst: GPUTexture, W: number, H: number, f: GlslBridgeFrame): GPUCommandEncoder | null;
	dispose(): void;
}
export function createGlslBridge(device: GPUDevice, format: GPUTextureFormat, requestDraw?: (() => void) | null): GlslBridge | null {
	if (typeof OffscreenCanvas === "undefined") return null;
	const glCanvas = new OffscreenCanvas(1, 1);
	const opts: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false };
	const gl0 = (glCanvas.getContext("webgl2", opts) ?? glCanvas.getContext("webgl2", opts)) as WebGL2RenderingContext | null;   // 2 度目で取れる器がある（SwiftShader の WebGPU の worker で最初の 1 つが null・2026-10-30）
	if (!gl0) return null;
	const cC = new OffscreenCanvas(1, 1), cD = new OffscreenCanvas(1, 1);
	const xC0 = cC.getContext("webgpu") as GPUCanvasContext | null, xD0 = cD.getContext("webgpu") as GPUCanvasContext | null;
	if (!xC0 || !xD0) return null;
	const gl: WebGL2RenderingContext = gl0, xC: GPUCanvasContext = xC0, xD: GPUCanvasContext = xD0;
	let size = [0, 0];
	let px = new Uint8Array(0), out = new Uint8Array(0);
	const bgra = format === "bgra8unorm";
	const vao = gl.createVertexArray()!;
	const S: PostStagesGL = createPostStagesGL(gl, gl.bindFramebuffer, vao, requestDraw, true);
	const texOf = (): WebGLTexture => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
	const tC = texOf(), tD = texOf();
	gl.bindTexture(gl.TEXTURE_2D, tC); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);   // 利用者の段は uv で色を引く（Cesium の colorTexture は線形）
	const F = GPUShaderStage.FRAGMENT;
	const lC = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: {} }] });
	const lD = (ms: boolean) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: "depth", multisampled: ms } }] });
	const mk = (code: string, l: GPUBindGroupLayout): GPURenderPipeline => { const m = device.createShaderModule({ code }); return device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [l] }), vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }); };
	const pCopy = mk(COPY_WGSL, lC);
	const pPack = new Map<boolean, { p: GPURenderPipeline; l: GPUBindGroupLayout }>();
	const pack = (ms: boolean) => { let e = pPack.get(ms); if (!e) { const l = lD(ms); e = { l, p: mk(PACK_WGSL(ms), l) }; pPack.set(ms, e); } return e; };
	function resize(W: number, H: number): void {
		if (size[0] === W && size[1] === H) return;
		size = [W, H];
		glCanvas.width = cC.width = cD.width = W; glCanvas.height = cC.height = cD.height = H;
		for (const x of [xC, xD]) x.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT });
	}
	const draw = (enc: GPUCommandEncoder, p: GPURenderPipeline, bg: GPUBindGroup, view: GPUTextureView) => { const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] }); r.setPipeline(p); r.setBindGroup(0, bg); r.draw(3); r.end(); };
	const upload = (t: WebGLTexture, bm: ImageBitmap) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bm); bm.close(); };
	function run(enc: GPUCommandEncoder, stages: PostStage[], src: GPUTextureView, dst: GPUTexture, W: number, H: number, f: GlslBridgeFrame): GPUCommandEncoder | null {
		if (!stages.length || !S.drawable(stages)) return null;
		resize(W, H);
		draw(enc, pCopy, device.createBindGroup({ layout: lC, entries: [{ binding: 0, resource: src }] }), xC.getCurrentTexture().createView());
		const pk = pack(f.samples > 1);
		draw(enc, pk.p, device.createBindGroup({ layout: pk.l, entries: [{ binding: 0, resource: f.depthTex.createView({ aspect: "depth-only" }) }] }), xD.getCurrentTexture().createView());
		device.queue.submit([enc.finish()]);
		const bC = cC.transferToImageBitmap(), bD = cD.transferToImageBitmap();
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		upload(tC, bC); upload(tD, bD);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		const sf: StageFrame = { logCoef: f.logCoef, dpr: f.dpr, fovy: f.fovy, frame: f.frame };
		S.run(stages, tC, tD, W, H, sf);   // 最後の段は GL の canvas（既定の framebuffer）へ
		// 戻しは readPixels → writeTexture（GL の canvas からの copyExternalImageToTexture は SwiftShader で写せず、ImageBitmap にすると worker ごと止まった・2026-10-30）。
		// GL の行は下から＝上下を返し、BGRA の canvas（Mac）は R と B を入れ替える
		if (px.length !== W * H * 4) { px = new Uint8Array(W * H * 4); out = new Uint8Array(W * H * 4); }
		gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
		const row = W * 4;
		for (let y = 0; y < H; y++) {
			const so = (H - 1 - y) * row, d = y * row;
			if (bgra) for (let x = 0; x < row; x += 4) { out[d + x] = px[so + x + 2]; out[d + x + 1] = px[so + x + 1]; out[d + x + 2] = px[so + x]; out[d + x + 3] = 255; }
			else out.set(px.subarray(so, so + row), d);
		}
		device.queue.writeTexture({ texture: dst }, out, { bytesPerRow: row, rowsPerImage: H }, [W, H]);
		return device.createCommandEncoder();
	}
	function dispose(): void {
		S.dispose(); gl.deleteTexture(tC); gl.deleteTexture(tD); gl.deleteVertexArray(vao);
		try { xC.unconfigure(); xD.unconfigure(); } catch { /* 既に外れた */ }
		gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
	return { run, dispose };
}
