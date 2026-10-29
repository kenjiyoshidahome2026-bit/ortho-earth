// 画面の段（WebGPU・2026-10-28）＝Cesium の postProcessStages 相当（gl/poststage.js の移植）。固定の後処理の鎖（postfx.js COMP）の出力を的に受け、
// 並び順どおり 1 段ずつ全画面で掛ける（2 枚のフル解像度の的を行き来し、最後の段だけ canvas へ）。段の形は ../postfx.js PostStage。
//   silhouette＝深度の縁取り（Cesium の EdgeDetection＋Silhouette と同式）／grey＝白黒／brightness＝明るさ／nightVision＝暗視／lensFlare・depthOfField（gl/poststage.js と同式）。glsl（利用者の GLSL）は WebGPU では描けない＝1 度だけ警告して飛ばす
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
// 画像を 2 枚まで読む段（レンズフレア・被写界深度）：X.a〜d＝段ごとの値・X.size＝(W, H, 1/W, 1/H)。uv＝GL の v_textureCoordinates（下が 0）＝tex() が上下を返して読む
const XHEAD = `struct XP { a: vec4f, b: vec4f, c: vec4f, d: vec4f, size: vec4f };
@group(0) @binding(0) var<uniform> X: XP;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var dep: texture_depth_2d;
@group(0) @binding(4) var texA: texture_2d<f32>;
@group(0) @binding(5) var texB: texture_2d<f32>;
fn tex(t: texture_2d<f32>, uv: vec2f) -> vec4f { return textureSampleLevel(t, smp, vec2f(uv.x, 1.0 - uv.y), 0.0); }
` + FULL_VS;
// レンズフレア（Cesium の LensFlare.glsl と同式）：X.a＝(intensity, distortion, ghostDispersal, haloWidth)・X.b＝(dirtAmount, space, camrot, dpr)・X.c＝(太陽の NDC x, y, 汚れの幅, 高さ)・X.d＝(地球の中心の NDC x, y, 縁の NDC x, 0)。texA＝汚れ・texB＝星形
const LF = XHEAD + `
fn isInEarth(texcoord: vec2f, sceneSize: vec2f) -> f32 {
	var ndc = texcoord * 2.0 - 1.0;
	ndc -= X.d.xy;
	let x = abs(ndc.x) * sceneSize.x; let y = abs(ndc.y) * sceneSize.y;
	// Cesium の本文は clamp(0.0, 1.0, m)（下限＞上限＝GLSL では未定義）。実機（Mac の Metal・SwiftShader）の Cesium は max(min(0, m), 1)＝常に 1 の絵＝地球を隠さない＝同じ値にする
	return max(min(0.0, max(sqrt(x * x + y * y) / max(abs(X.d.z * sceneSize.x), 1.0) - 0.8, 0.0)), 1.0);
}
fn distorted(texcoord: vec2f, direction: vec2f, distortion: vec3f) -> vec4f {
	let sceneSize = X.size.xy;
	let r = isInEarth(texcoord + direction * distortion.r, sceneSize) * tex(src, texcoord + direction * distortion.r).r;
	let g = isInEarth(texcoord + direction * distortion.g, sceneSize) * tex(src, texcoord + direction * distortion.g).g;
	let b = isInEarth(texcoord + direction * distortion.b, sceneSize) * tex(src, texcoord + direction * distortion.b).b;
	return vec4f(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)), 0.0);
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let uv = in.uv;
	let originalColor = tex(src, uv);
	let sunPos = X.c.xy;
	if (X.b.y < 0.5 || !(sunPos.x >= -1.1 && sunPos.x <= 1.1 && sunPos.y >= -1.1 && sunPos.y <= 1.1)) { return originalColor; }
	let intensity = X.a.x; let distortion = X.a.y; let ghostDispersal = X.a.z; let haloWidth = X.a.w; let dirtAmount = X.b.x;
	let texcoord = vec2f(1.0) - uv;
	let pixelSize = X.b.w * X.size.zw;
	let invPixelSize = 1.0 / pixelSize;
	let distortionVec = pixelSize.x * vec3f(-distortion, 0.0, distortion);
	let ghostVec = (vec2f(0.5) - texcoord) * ghostDispersal;
	let direction = normalize(vec3f(ghostVec, 0.0));
	var result = vec4f(0.0);
	for (var i = 0; i < 4; i++) { result += distorted(fract(texcoord + ghostVec * f32(i)), direction.xy, distortionVec); }
	let haloVec = normalize(ghostVec) * haloWidth;
	var weightForHalo = length(vec2f(0.5) - fract(texcoord + haloVec)) / length(vec2f(0.5));
	weightForHalo = pow(1.0 - weightForHalo, 5.0);
	result += distorted(texcoord + haloVec, direction.xy, distortionVec) * weightForHalo * 1.5;
	var dc = (uv * invPixelSize) / X.c.zw;
	if (dc.x > 1.0) { dc.x = select(fract(dc.x), 1.0 - fract(dc.x), floor(dc.x) % 2.0 == 1.0); }
	if (dc.y > 1.0) { dc.y = select(fract(dc.y), 1.0 - fract(dc.y), floor(dc.y) % 2.0 == 1.0); }
	result += dirtAmount * tex(texA, dc);
	let camrot = X.b.z; let cs = cos(camrot); let sn = sin(camrot);
	let rotation = mat3x3f(cs, -sn, 0.0, sn, cs, 0.0, 0.0, 0.0, 1.0);
	let st1 = vec3f(uv * 2.0 - vec2f(1.0), 1.0);
	let st2 = vec3f((rotation * st1).xy, 1.0);
	let st3 = st2 * 0.5 + vec3f(0.5);
	let weightForLensFlare = length(vec3f(sunPos, 0.0));
	let oneMinus = max(1.0 - weightForLensFlare, 0.0);
	result *= oneMinus * intensity;
	result *= tex(texB, st3.xy) * weightForLensFlare * max(1.0 - length(st1.xy), 0.0) * 2.0;
	let o = result + originalColor;
	return vec4f(o.rgb, clamp(max(o.a, max(o.r, max(o.g, o.b))), 0.0, 1.0));   // 透かした宇宙（premultiplied）の上でも光が乗る＝α を色の明るさまで上げる（色＞α は合成で落ちる）
}`;
// 被写界深度のぼかし（Cesium の GaussianBlur1D・USE_STEP_SIZE）：X.a＝(delta, sigma, stepSize, direction)・X.b.w＝dpr
const BLUR = XHEAD + `
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let delta = X.a.x; let sigma = X.a.y; let dir = vec2f(1.0 - X.a.w, X.a.w);
	let stp = vec2f(X.a.z * X.b.w) * X.size.zw;
	var g = vec3f(1.0 / (sqrt(6.283185307179586) * sigma), exp((-0.5 * delta * delta) / (sigma * sigma)), 0.0);
	g.z = g.y * g.y;
	var result = tex(src, in.uv) * g.x;
	for (var i = 1; i < 8; i++) { g = vec3f(g.x * g.y, g.y * g.z, g.z); let o = f32(i) * dir * stp; result += tex(src, in.uv - o) * g.x; result += tex(src, in.uv + o) * g.x; }
	return result;
}`;
// 被写界深度の合成（Cesium の DepthOfField.glsl）：X.a＝(focalDistance, near, far, 地球あり)・X.c＝地球の中心（目の座標）・半径・X.d.xy＝画角の半分の tan・texA＝ぼかし。
// 深度＝Cesium の尺（log2(w−near+1)／log2(far−near+1)）・深度の無い画素＝目の光線が球に当たる奥行き（gl/poststage.js と同式）
const DOF = XHEAD + `
fn groundW(uv: vec2f) -> f32 {
	if (X.a.w < 0.5) { return X.a.z; }
	let dir = vec3f((uv * 2.0 - 1.0) * X.d.xy, -1.0);
	let a = dot(dir, dir); let b = -2.0 * dot(dir, X.c.xyz); let c = dot(X.c.xyz, X.c.xyz) - X.c.w * X.c.w;
	let disc = b * b - 4.0 * a * c;
	if (disc < 0.0) { return X.a.z; }
	let t = (-b - sqrt(disc)) / (2.0 * a);
	return select(X.a.z, t, t > 0.0);
}
fn computeDepthBlur(depth: f32) -> f32 {
	let focalDistance = X.a.x; let near = X.a.y; let far = X.a.z;
	var f: f32;
	if (depth < focalDistance) { f = (focalDistance - depth) / (focalDistance - near); }
	else { f = pow((depth - focalDistance) / (far - focalDistance), 0.1); }
	f *= f;
	return pow(clamp(f, 0.0, 1.0), 0.5);
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
	let dim = vec2i(textureDimensions(dep));
	let d = textureLoad(dep, clamp(vec2i(in.pos.xy), vec2i(0), dim - 1), 0);
	let w = select(exp2(d * ${Math.log2(CZM_FAR - CZM_NEAR + 1).toFixed(6)}) - 1.0 + ${CZM_NEAR.toFixed(1)}, groundW(in.uv), d >= 1.0);
	return mix(tex(src, in.uv), tex(texA, in.uv), computeDepthBlur(w));
}`;
/** 検定（t-wgsl）がコンパイルを検める口 */
export const STAGE_WGSL = Object.freeze({ STAGE_SIL_WGSL: SIL, STAGE_GREY_WGSL: GREY, STAGE_BRIGHT_WGSL: BRIGHT, STAGE_NV_WGSL: NV, STAGE_DEPTH_WGSL: DEPTH_WGSL(false), STAGE_DEPTH_MS_WGSL: DEPTH_WGSL(true), STAGE_LF_WGSL: LF, STAGE_BLUR_WGSL: BLUR, STAGE_DOF_WGSL: DOF });
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
export function createPostStagesGPU(device: GPUDevice, format: GPUTextureFormat, requestDraw?: (() => void) | null): PostStagesGPU {
	const F = GPUShaderStage.FRAGMENT;
	const bgl = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} }, { binding: 1, visibility: F, texture: {} }, { binding: 2, visibility: F, sampler: {} }, { binding: 3, visibility: F, texture: { sampleType: "depth" } },
	] });
	const bglD = (ms: boolean) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, buffer: {} }, { binding: 1, visibility: F, texture: { sampleType: "depth", multisampled: ms } }] });
	const bglX = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} }, { binding: 1, visibility: F, texture: {} }, { binding: 2, visibility: F, sampler: {} }, { binding: 3, visibility: F, texture: { sampleType: "depth" } },
		{ binding: 4, visibility: F, texture: {} }, { binding: 5, visibility: F, texture: {} },
	] });
	const XCODE: Record<string, string> = { lensFlare: LF, blur: BLUR, depthOfField: DOF };
	const pipes = new Map<string, GPURenderPipeline>();
	const pipe = (key: string, code: string): GPURenderPipeline => {
		let p = pipes.get(key);
		if (!p) { p = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [XCODE[key] ? bglX : bgl] }), vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" }, fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }); pipes.set(key, p); }
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
	let B: { w: number; h: number; tex: GPUTexture[]; view: GPUTextureView[] } | null = null;   // 被写界深度のぼかしの行き来（要る時だけ）
	let warnedGlsl = false;
	// 段の画像（レンズフレアの汚れ・星形）：URL ごとに 1 度読む。着くまでは 1×1 の黒＝汚れ無し・星形無し、着いたら一枚要求
	const imgs = new Map<string, { tex: GPUTexture | null; view: GPUTextureView | null; w: number; h: number }>();
	const blackT = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	device.queue.writeTexture({ texture: blackT }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
	const blackV = blackT.createView();
	function image(url: string | undefined): { view: GPUTextureView; w: number; h: number } | null {
		if (!url) return null;
		let e = imgs.get(url);
		if (e) return e.view ? { view: e.view, w: e.w, h: e.h } : null;
		e = { tex: null, view: null, w: 1, h: 1 }; imgs.set(url, e);
		const me = e;
		fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.blob(); }).then(b => createImageBitmap(b)).then(bm => {
			if (imgs.get(url) !== me) { bm.close(); return; }
			const t = device.createTexture({ size: [bm.width, bm.height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
			device.queue.copyExternalImageToTexture({ source: bm }, { texture: t }, [bm.width, bm.height]);
			me.tex = t; me.view = t.createView(); me.w = bm.width; me.h = bm.height; bm.close(); requestDraw?.();
		}).catch(err => console.warn("[gpu] post stage image failed:", (err as Error)?.message || err));
		return null;
	}
	function freeB(): void { if (!B) return; for (const t of B.tex) t.destroy(); B = null; }
	function ensureBlur(W: number, H: number): void {
		if (B && B.w === W && B.h === H) return;
		freeB();
		const tex = [0, 1].map(() => device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }));
		B = { w: W, h: H, tex, view: tex.map(t => t.createView()) };
	}
	function free(): void { freeB(); if (!T) return; for (const t of T.tex) t.destroy(); T.d.destroy(); T = null; }
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
		const list = stages.filter(okStage).slice(0, MAXS - 2);   // 被写界深度は 3 枠（ぼかし x・y・合成）＝枠は数え直す
		if (list.some(s => s.type === "silhouette" || s.type === "depthOfField")) {   // Cesium の尺の深度を 1 度だけ
			const ms = f.samples > 1, d = dPipe(ms);
			device.queue.writeBuffer(ubD, 0, new Float32Array([2 * Math.LN2 / Math.max(f.logCoef, 1e-9), 1 / Math.log2(CZM_FAR - CZM_NEAR + 1), CZM_NEAR, 0]));
			const p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: T!.dv, depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" } });
			p.setPipeline(d.p); p.setBindGroup(0, device.createBindGroup({ layout: d.l, entries: [{ binding: 0, resource: { buffer: ubD } }, { binding: 1, resource: f.depthTex.createView({ aspect: "depth-only" }) }] })); p.draw(3); p.end();
		}
		const u = new Float32Array((STRIDE / 4) * MAXS);
		let slot = 0;
		const size = (o: number) => { u[o + 16] = W; u[o + 17] = H; u[o + 18] = 1 / W; u[o + 19] = 1 / H; };
		const xpass = (key: string, a: number[], b: number[], c: number[], d: number[], from: GPUTextureView, to: GPUTextureView, A: GPUTextureView, Bv: GPUTextureView): void => {
			const o = slot * (STRIDE / 4); u.set(a, o); u.set(b, o + 4); u.set(c, o + 8); u.set(d, o + 12); size(o);
			const bg = device.createBindGroup({ layout: bglX, entries: [{ binding: 0, resource: { buffer: ub, offset: slot * STRIDE, size: 80 } }, { binding: 1, resource: from }, { binding: 2, resource: smp }, { binding: 3, resource: T!.dv }, { binding: 4, resource: A }, { binding: 5, resource: Bv }] });
			slot++;
			const p = enc.beginRenderPass({ colorAttachments: [{ view: to, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
			p.setPipeline(pipe(key, XCODE[key])); p.setBindGroup(0, bg); p.draw(3); p.end();
		};
		let cur = T!.view[1];
		list.forEach((s, i) => {
			const last = i === list.length - 1, view = last ? dst : T!.view[i & 1];
			if (s.type === "lensFlare") {
				const dirt = image(s.dirt), star = image(s.star);
				xpass("lensFlare", [s.intensity, s.distortion, s.ghostDispersal, s.haloWidth], [dirt ? s.dirtAmount : 0, s.space ? 1 : 0, s.camrot, f.dpr], [s.sun[0], s.sun[1], dirt ? dirt.w : 1, dirt ? dirt.h : 1], [s.earth[0], s.earth[1], s.earth[2], 0], cur, view, dirt?.view ?? blackV, star?.view ?? blackV);
			} else if (s.type === "depthOfField") {
				ensureBlur(W, H);
				xpass("blur", [s.delta, s.sigma, s.stepSize, 0], [0, 0, 0, f.dpr], [0, 0, 0, 0], [0, 0, 0, 0], cur, B!.view[0], blackV, blackV);
				xpass("blur", [s.delta, s.sigma, s.stepSize, 1], [0, 0, 0, f.dpr], [0, 0, 0, 0], [0, 0, 0, 0], B!.view[0], B!.view[1], blackV, blackV);
				const e = s.earth, tn = s.tan ?? [1, 1];
				xpass("depthOfField", [s.focalDistance, s.near, s.far, e ? 1 : 0], [0, 0, 0, f.dpr], e ? e.slice(0, 4) : [0, 0, 0, 0], [tn[0], tn[1], 0, 0], cur, view, B!.view[1], blackV);
			} else {
				const o = slot * (STRIDE / 4);
				if (s.type === "silhouette") { u.set(s.color, o); u[o + 4] = s.length; }
				else if (s.type === "grey") u[o + 4] = s.gradations;
				else if (s.type === "brightness") u[o + 4] = s.value;
				u[o + 5] = f.frame; u[o + 6] = f.dpr; u[o + 8] = W; u[o + 9] = H; u[o + 10] = 1 / W; u[o + 11] = 1 / H;
				const code = s.type === "silhouette" ? SIL : s.type === "grey" ? GREY : s.type === "brightness" ? BRIGHT : NV;
				const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub, offset: slot * STRIDE, size: 48 } }, { binding: 1, resource: cur }, { binding: 2, resource: smp }, { binding: 3, resource: T!.dv }] });
				slot++;
				const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
				p.setPipeline(pipe(s.type, code)); p.setBindGroup(0, bg); p.draw(3); p.end();
			}
			cur = T!.view[i & 1];
		});
		device.queue.writeBuffer(ub, 0, u, 0, slot * (STRIDE / 4));   // 書き込みは submit の前に順序づく＝encode の後でも各 pass は自分の枠を読む
	}
	function dispose(): void { free(); ub.destroy(); ubD.destroy(); blackT.destroy(); for (const e of imgs.values()) e.tex?.destroy(); imgs.clear(); pipes.clear(); dPipes.clear(); }
	const bytes = (): number => (T ? T.w * T.h * (4 + 4 + 4) : 0) + (B ? B.w * B.h * 8 : 0);
	return { target, drawable, encode, dispose, bytes };
}
