// 画面の段（WebGPU・2026-10-28）＝Cesium の postProcessStages 相当（gl/poststage.js の移植）。固定の後処理の鎖（postfx.js COMP）の出力を的に受け、
// 並び順どおり 1 段ずつ全画面で掛ける（2 枚のフル解像度の的を行き来し、最後の段だけ canvas へ）。段の形は ../postfx.js PostStage。
//   silhouette＝深度の縁取り（Cesium の EdgeDetection＋Silhouette と同式）／grey＝白黒／brightness＝明るさ／nightVision＝暗視。glsl（利用者の GLSL）は WebGPU では描けない＝1 度だけ警告して飛ばす
// 深度＝Cesium の尺（log2(w−near+1)／log2(far−near+1)・w＝目からの奥行き m）に写した depth24plus を、段が要る時だけ 1 フレームに 1 度作る（本体の深度＝対数・4x は sample 0）
import type { PostStage } from "../postfx.ts";

const R_M = 6378137, CZM_NEAR = 1, CZM_FAR = 5e8;
const FULL_VS = `struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
	var o: VOut;
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = p;
	return o;
}`;
// 深度の写し：P.p＝(2·ln2／logCoef, 1／log2(far−near+1), near, 0)
export const DEPTH_WGSL = (ms: boolean): string => `struct DP { p: vec4f };
@group(0) @binding(0) var<uniform> P: DP;
@group(0) @binding(1) var dep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
${FULL_VS}
fn expm1s(x: f32) -> f32 { if (x < 0.1) { return x * (1.0 + x * (0.5 + x * (0.16666667 + x * (0.041666668 + x * (0.0083333335 + x * (0.0013888889 + x * 0.00019841270)))))); } return exp(x) - 1.0; }
struct FOut { @builtin(frag_depth) d: f32 };
@fragment fn fs(in: VOut) -> FOut {
	var o: FOut;
	let d = textureLoad(dep, vec2i(in.pos.xy), 0);
	if (d >= 1.0) { o.d = 1.0; return o; }
	let w = expm1s(d * P.p.x) * ${R_M.toFixed(1)};
	o.d = clamp(log2(max(w - P.p.z, 0.0) + 1.0) * P.p.y, 0.0, 1.0);
	return o;
}`;
// S.c＝縁の色 rgba／S.p＝(length｜gradations｜value, frame, dpr, 0)／S.size＝(W, H, 1/W, 1/H)
const HEAD = `struct SP { c: vec4f, p: vec4f, size: vec4f };
@group(0) @binding(0) var<uniform> S: SP;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var dep: texture_depth_2d;
fn luminance(rgb: vec3f) -> f32 { return dot(rgb, vec3f(0.2125, 0.7154, 0.0721)); }
fn depthAt(p: vec2i) -> f32 { let dim = vec2i(textureDimensions(dep)); return textureLoad(dep, clamp(p, vec2i(0), dim - 1), 0); }
` + FULL_VS;
const SIL = HEAD + `
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let q = vec2i(in.pos.xy); let pad = max(1, i32(round(S.p.z)));
	let dirs = array<i32, 3>(-1, 0, 1); let sc = array<f32, 3>(3.0, 10.0, 3.0);
	var h = 0.0; var v = 0.0;
	for (var i = 0; i < 3; i++) {
		let dir = dirs[i]; let s = sc[i];
		h -= depthAt(q + vec2i(-pad, dir * pad)) * s;
		h += depthAt(q + vec2i(pad, dir * pad)) * s;
		v -= depthAt(q + vec2i(dir * pad, -pad)) * s;
		v += depthAt(q + vec2i(dir * pad, pad)) * s;
	}
	let len = sqrt(h * h + v * v);
	let a = select(0.0, S.c.a, len > S.p.x);
	let c = textureLoad(src, q, 0);
	return mix(c, vec4f(S.c.rgb, a), a);
}`;
const GREY = HEAD + `
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let rgb = textureLoad(src, vec2i(in.pos.xy), 0).rgb;
	var darkness = luminance(rgb) * S.p.x;
	darkness = (darkness - fract(darkness)) / S.p.x;
	return vec4f(vec3f(darkness), 1.0);
}`;
const BRIGHT = HEAD + `
@fragment fn fs(in: VOut) -> @location(0) vec4f { let rgb = textureLoad(src, vec2i(in.pos.xy), 0).rgb; return vec4f(mix(vec3f(0.0), rgb, S.p.x), 1.0); }`;
const NV = HEAD + `
fn rand(co: vec2f) -> f32 { return fract(sin(dot(co, vec2f(12.9898, 78.233))) * 43758.5453); }
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let noise = rand(in.uv + sin(S.p.y)) * 0.1;
	let rgb = textureLoad(src, vec2i(in.pos.xy), 0).rgb;
	return vec4f((noise + rgb) * vec3f(0.0, 1.0, 0.0), 1.0);
}`;
/** 検定（t-wgsl）がコンパイルを検める口 */
export const STAGE_WGSL = Object.freeze({ STAGE_SIL_WGSL: SIL, STAGE_GREY_WGSL: GREY, STAGE_BRIGHT_WGSL: BRIGHT, STAGE_NV_WGSL: NV, STAGE_DEPTH_WGSL: DEPTH_WGSL(false), STAGE_DEPTH_MS_WGSL: DEPTH_WGSL(true) });
/** フレームの尺：depth＝本体の深度（samples＝1x/4x）・logCoef・dpr＝czm_pixelRatio・frame＝フレーム番号 */
export interface StageFrameGPU { depthTex: GPUTexture; samples: number; logCoef: number; dpr: number; frame: number }
export interface PostStagesGPU {
	/** 固定の鎖の出力の的（最初の段が読む） */
	target(W: number, H: number): GPUTextureView;
	/** 描ける段が 1 つでもあるか（glsl だけなら false） */
	drawable(stages: PostStage[]): boolean;
	/** 的（target）→ 段を順に → dst（canvas） */
	encode(enc: GPUCommandEncoder, stages: PostStage[], dst: GPUTextureView, W: number, H: number, f: StageFrameGPU): void;
	dispose(): void; bytes(): number;
}
export function createPostStagesGPU(device: GPUDevice, format: GPUTextureFormat): PostStagesGPU {
	const F = GPUShaderStage.FRAGMENT;
	const bgl = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} }, { binding: 1, visibility: F, texture: {} }, { binding: 2, visibility: F, sampler: {} }, { binding: 3, visibility: F, texture: { sampleType: "depth" } },
	] });
	const bglD = (ms: boolean) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, buffer: {} }, { binding: 1, visibility: F, texture: { sampleType: "depth", multisampled: ms } }] });
	const pipes = new Map<string, GPURenderPipeline>();
	const pipe = (key: string, code: string): GPURenderPipeline => {
		let p = pipes.get(key);
		if (!p) { p = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }), vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" }, fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }); pipes.set(key, p); }
		return p;
	};
	const dPipes = new Map<boolean, { p: GPURenderPipeline; l: GPUBindGroupLayout }>();
	const dPipe = (ms: boolean) => {
		let d = dPipes.get(ms);
		if (!d) { const l = bglD(ms), code = DEPTH_WGSL(ms); d = { l, p: device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [l] }), vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" }, fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" }, depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "always" } }) }; dPipes.set(ms, d); }
		return d;
	};
	const smp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const MAXS = 16;
	const STRIDE = 256;   // uniform の dynamic/offset 束縛は 256B 揃え
	const ub = device.createBuffer({ size: STRIDE * MAXS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), ubD = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	let T: { w: number; h: number; tex: GPUTexture[]; view: GPUTextureView[]; d: GPUTexture; dv: GPUTextureView } | null = null;
	let warnedGlsl = false;
	function free(): void { if (!T) return; for (const t of T.tex) t.destroy(); T.d.destroy(); T = null; }
	function ensure(W: number, H: number): void {
		if (T && T.w === W && T.h === H) return;
		free();
		const tex = [0, 1].map(() => device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }));
		const d = device.createTexture({ size: [W, H], format: "depth24plus", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
		T = { w: W, h: H, tex, view: tex.map(t => t.createView()), d, dv: d.createView() };
	}
	const okStage = (s: PostStage): boolean => { if (s.type !== "glsl") return true; if (!warnedGlsl) { warnedGlsl = true; console.warn("[gpu] post stage \"glsl\" is WebGL2 only (skipped on WebGPU)"); } return false; };
	function target(W: number, H: number): GPUTextureView { ensure(W, H); return T!.view[1]; }
	const drawable = (stages: PostStage[]): boolean => stages.some(s => s.type !== "glsl");
	function encode(enc: GPUCommandEncoder, stages: PostStage[], dst: GPUTextureView, W: number, H: number, f: StageFrameGPU): void {
		ensure(W, H);
		const list = stages.filter(okStage).slice(0, MAXS);
		if (list.some(s => s.type === "silhouette")) {   // Cesium の尺の深度を 1 度だけ
			const ms = f.samples > 1, d = dPipe(ms);
			device.queue.writeBuffer(ubD, 0, new Float32Array([2 * Math.LN2 / Math.max(f.logCoef, 1e-9), 1 / Math.log2(CZM_FAR - CZM_NEAR + 1), CZM_NEAR, 0]));
			const p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: T!.dv, depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" } });
			p.setPipeline(d.p); p.setBindGroup(0, device.createBindGroup({ layout: d.l, entries: [{ binding: 0, resource: { buffer: ubD } }, { binding: 1, resource: f.depthTex.createView({ aspect: "depth-only" }) }] })); p.draw(3); p.end();
		}
		const u = new Float32Array((STRIDE / 4) * list.length);
		list.forEach((s, i) => {
			const o = i * (STRIDE / 4);
			if (s.type === "silhouette") { u.set(s.color, o); u[o + 4] = s.length; }
			else if (s.type === "grey") u[o + 4] = s.gradations;
			else if (s.type === "brightness") u[o + 4] = s.value;
			u[o + 5] = f.frame; u[o + 6] = f.dpr; u[o + 8] = W; u[o + 9] = H; u[o + 10] = 1 / W; u[o + 11] = 1 / H;
		});
		device.queue.writeBuffer(ub, 0, u);
		let cur = T!.view[1];
		list.forEach((s, i) => {
			const last = i === list.length - 1, view = last ? dst : T!.view[i & 1];
			const code = s.type === "silhouette" ? SIL : s.type === "grey" ? GREY : s.type === "brightness" ? BRIGHT : NV;
			const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub, offset: i * STRIDE, size: 48 } }, { binding: 1, resource: cur }, { binding: 2, resource: smp }, { binding: 3, resource: T!.dv }] });
			const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
			p.setPipeline(pipe(s.type, code)); p.setBindGroup(0, bg); p.draw(3); p.end();
			cur = T!.view[i & 1];
		});
	}
	function dispose(): void { free(); ub.destroy(); ubD.destroy(); pipes.clear(); dPipes.clear(); }
	const bytes = (): number => (T ? T.w * T.h * (4 + 4 + 4) : 0);
	return { target, drawable, encode, dispose, bytes };
}
