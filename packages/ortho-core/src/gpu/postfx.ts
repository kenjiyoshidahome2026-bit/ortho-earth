// WebGPU の後処理（bloom・vignette・deck.gl 差分 PR-8・2026-10-12／fxaa・tonemap・lut＝第 3 波 W1）：flush の終端（resolve の後・submit の前）に足す。
// 掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette（../postfx.js の頭書き）。LUT は ../lut.js で読み（worker 内の fetch）、着くまでは無しで描く。
// canvas の今のテクスチャ（COPY_SRC）を控え（scratch）に copyTextureToTexture し、①明部の抜き出し（半解像度）②ぼかし横③ぼかし縦④合成（scratch＋bloom×strength・四隅の減光）を canvas へ描く。
// 式は GL2（gl/depthout.js の BRIGHT_FS／BLUR_FS／POST_FS）と同じ。設定の形は ../postfx.js normPost。
import { loadLUT } from "../lut.ts";
import { createPostStagesGPU } from "./poststage.ts";
import type { PostStagesGPU, StageFrameGPU } from "./poststage.ts";
import type { PostStage } from "../postfx.ts";
const TM_MODE: Record<string, number> = { linear: 0, reinhard: 1, aces: 2, agx: 3, filmic: 4 };
const FULL_VS = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// U＝(threshold, strength, radius, 0) / vig＝(strength, radius, softness, on) / size＝(W, H, 1/W, 1/H) / dir＝(dx, dy, 0, 0) / tm＝(mode 0..4, exposure, on, fxaaOn) / lut＝(size, intensity, on, 0) / gr＝(夜の色 rgb, on)
// 夜の色（grade・2026-10-24）＝絵全体に乗算（夕景・夜の色）。ただし canvas の α＝1−窓の印（建物メッシュの街明かり・wgsl.js cityWin）の所は掛けない＝灯りだけ暗くならない。
//   明部の抜き出し（bloom）も掛けた後の色から抜く＝夜は灯りだけが滲む。出す色の α は 1 に戻す（撮影の読み出しが α を拾わない）
const HEAD = `struct PostP { b: vec4f, vig: vec4f, size: vec4f, dir: vec4f, tm: vec4f, lut: vec4f, gr: vec4f };
@group(0) @binding(0) var<uniform> U: PostP;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
fn graded(c: vec4f) -> vec3f { if (U.gr.w < 0.5) { return c.rgb; } return c.rgb * mix(U.gr.rgb, vec3f(1.0), 1.0 - c.a); }
`;
const BRIGHT = HEAD + FULL_VS + `
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let p = vec2i(pos.xy) * 2;
	let c = (graded(textureLoad(src, p, 0)) + graded(textureLoad(src, p + vec2i(1, 0), 0)) + graded(textureLoad(src, p + vec2i(0, 1), 0)) + graded(textureLoad(src, p + vec2i(1, 1), 0))) * 0.25;
	let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
	let k = max(l - U.b.x, 0.0) / max(l, 1e-4);
	return vec4f(c * k, 1.0);
}`;
const BLUR = HEAD + FULL_VS + `
const W = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let ts = 1.0 / vec2f(textureDimensions(src));
	let uv = pos.xy * ts;
	var s = textureSample(src, smp, uv).rgb * W[0];
	for (var i = 1; i < 5; i++) { let d = U.dir.xy * f32(i) * ts; s += textureSample(src, smp, uv + d).rgb * W[i]; s += textureSample(src, smp, uv - d).rgb * W[i]; }
	return vec4f(s, 1.0);
}`;
const COMP = HEAD + `@group(0) @binding(3) var bloom: texture_2d<f32>;
@group(0) @binding(4) var lut: texture_2d<f32>;
` + FULL_VS + `
fn tmReinhard(x: vec3f) -> vec3f { return x / (1.0 + x); }
fn tmAces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
fn tmFilmic(x: vec3f) -> vec3f {   // Hable（Uncharted 2）・白点 11.2
	let A = 0.15; let B = 0.50; let C = 0.10; let D = 0.20; let E = 0.02; let F = 0.30; let W = 11.2;
	let c = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
	let w = ((W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F)) - E / F;
	return clamp(c / w, vec3f(0.0), vec3f(1.0));
}
fn tmAgx(c0: vec3f) -> vec3f {   // AgX の最小版＝入出力の行列と 6 次の S 字（GL2 と同じ係数）
	let IN = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
	let OUT = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
	var c = IN * c0;
	c = clamp((log2(max(c, vec3f(1e-10))) + 12.47393) / 16.5, vec3f(0.0), vec3f(1.0));
	let x2 = c * c; let x4 = x2 * x2;
	c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
	return clamp(OUT * c, vec3f(0.0), vec3f(1.0));
}
fn tonemap(c0: vec3f) -> vec3f {
	let c = c0 * U.tm.y;
	let m = i32(U.tm.x + 0.5);
	if (m == 1) { return tmReinhard(c); }
	if (m == 2) { return tmAces(c); }
	if (m == 3) { return tmAgx(c); }
	if (m == 4) { return tmFilmic(c); }
	return clamp(c, vec3f(0.0), vec3f(1.0));
}
fn fxaa(fc: vec2f, inv: vec2f) -> vec3f {   // FXAA 3.11 の簡約版（GL2 の depthout.js と同じ式）
	let SPAN = 8.0; let RMIN = 1.0 / 128.0; let RMUL = 1.0 / 8.0;
	let L = vec3f(0.299, 0.587, 0.114);
	let rgbM = textureSample(src, smp, fc * inv).rgb;
	let lNW = dot(textureSample(src, smp, (fc + vec2f(-1.0, -1.0)) * inv).rgb, L); let lNE = dot(textureSample(src, smp, (fc + vec2f(1.0, -1.0)) * inv).rgb, L);
	let lSW = dot(textureSample(src, smp, (fc + vec2f(-1.0, 1.0)) * inv).rgb, L); let lSE = dot(textureSample(src, smp, (fc + vec2f(1.0, 1.0)) * inv).rgb, L); let lM = dot(rgbM, L);
	let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))); let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
	var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
	let red = max((lNW + lNE + lSW + lSE) * (0.25 * RMUL), RMIN); let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
	dir = min(vec2f(SPAN), max(vec2f(-SPAN), dir * rcp)) * inv;
	let uv = fc * inv;
	let a = 0.5 * (textureSample(src, smp, uv + dir * (1.0 / 3.0 - 0.5)).rgb + textureSample(src, smp, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
	let b = a * 0.5 + 0.25 * (textureSample(src, smp, uv - dir * 0.5).rgb + textureSample(src, smp, uv + dir * 0.5).rgb);
	let lB = dot(b, L);
	if (lB < lMin || lB > lMax) { return a; }
	return b;
}
fn lut3(c0: vec3f) -> vec3f {   // 帯＝x に B の板×size＋R・y に G
	let n = U.lut.x; let c = clamp(c0, vec3f(0.0), vec3f(1.0));
	let bb = c.b * (n - 1.0); let b0 = floor(bb); let b1 = min(b0 + 1.0, n - 1.0); let f = bb - b0;
	let x = (c.r * (n - 1.0) + 0.5) / (n * n); let y = (c.g * (n - 1.0) + 0.5) / n;
	return mix(textureSample(lut, smp, vec2f(b0 / n + x, y)).rgb, textureSample(lut, smp, vec2f(b1 / n + x, y)).rgb, f);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let uv = pos.xy * U.size.zw;
	var c = textureLoad(src, vec2i(pos.xy), 0);
	if (U.tm.w > 0.5) { c = vec4f(fxaa(pos.xy, U.size.zw), c.a); }
	if (U.gr.w > 0.5) { c = vec4f(graded(c), 1.0); }   // 夜の色（窓の印の所は掛けない）
	if (U.b.y > 0.0) { c = vec4f(c.rgb + textureSample(bloom, smp, uv).rgb * U.b.y, c.a); }
	if (U.tm.z > 0.5) { c = vec4f(tonemap(c.rgb), c.a); }
	if (U.lut.z > 0.5) { c = vec4f(mix(c.rgb, lut3(c.rgb), U.lut.y), c.a); }
	if (U.vig.w > 0.5) { let d = length(uv - 0.5) * 1.41421356; c = vec4f(c.rgb * (1.0 - U.vig.x * smoothstep(U.vig.y - U.vig.z, U.vig.y, d)), c.a); }
	return c;
}`;

// 検定（t-wgsl）がコンパイルを検める口
export const POST_WGSL = Object.freeze({ POST_BRIGHT_WGSL: BRIGHT, POST_BLUR_WGSL: BLUR, POST_COMP_WGSL: COMP });
/** encode が読む後処理の設定（normPost の戻りの形＝../postfx.js・型の正本は types/postfx.d.ts の PostProcessNormalized）。 */
export interface PostFrameOptions {
	bloom: { threshold: number; strength: number; radius: number } | null;
	vignette: { strength: number; radius: number; softness: number } | null;
	fxaa?: boolean;
	tonemap?: { mode: string; exposure: number } | null;
	lut?: { url: string; size: number; intensity: number } | null;
	/** 夜の色（乗算 rgb 0..1）＝map.setGrade（2026-10-24）。窓の印（canvas の α）の所は掛けない */
	grade?: number[] | null;
	/** 画面の段（Cesium の postProcessStages 相当・2026-10-28）＝固定の鎖の後に並び順どおり（gpu/poststage.js） */
	stages?: PostStage[] | null;
}
/** encode の戻り＝続きを書く encoder（glsl の段が途中で submit した時は新しい物・他は enc） */
export interface PostGPU { encode(enc: GPUCommandEncoder, canvasTex: GPUTexture, W: number, H: number, post: PostFrameOptions, sf?: StageFrameGPU | null): GPUCommandEncoder; dispose(): void; bytes(): number }
interface PostTargets { w: number; h: number; hw: number; hh: number; scratch: GPUTexture; half: GPUTexture[]; sv: GPUTextureView; hv: GPUTextureView[] }
interface PostLut { url: string; size: number; tex: GPUTexture | null; view: GPUTextureView | null; n: number; ready: boolean }
export function createPostGPU(device: GPUDevice, format: GPUTextureFormat, requestDraw?: (() => void) | null): PostGPU {
	const F = GPUShaderStage.FRAGMENT;
	const bgl = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} },
		{ binding: 1, visibility: F, texture: {} },
		{ binding: 2, visibility: F, sampler: {} },
	] });
	const bglComp = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} },
		{ binding: 1, visibility: F, texture: {} },
		{ binding: 2, visibility: F, sampler: {} },
		{ binding: 3, visibility: F, texture: {} },
		{ binding: 4, visibility: F, texture: {} },
	] });
	const pipe = (code: string, layout: GPUBindGroupLayout, fmt: GPUTextureFormat): GPURenderPipeline => device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" }, fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format: fmt }] }, primitive: { topology: "triangle-list" } });
	const pBright = pipe(BRIGHT, bgl, "rgba8unorm"), pBlur = pipe(BLUR, bgl, "rgba8unorm"), pComp = pipe(COMP, bglComp, format);
	const smp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const ub = [0, 1, 2, 3].map(() => device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));   // 明部・横・縦・合成
	let T: PostTargets | null = null;   // { w, h, scratch, half: [3], views }
	function ensure(W: number, H: number): void {
		if (T && T.w === W && T.h === H) return;
		free();
		const hw = Math.max(1, Math.ceil(W / 2)), hh = Math.max(1, Math.ceil(H / 2));
		const scratch = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		const half = [0, 1, 2].map(() => device.createTexture({ size: [hw, hh], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }));
		T = { w: W, h: H, hw, hh, scratch, half, sv: scratch.createView(), hv: half.map(t => t.createView()) };
	}
	function free() { if (!T) return; T.scratch.destroy(); for (const t of T.half) t.destroy(); T = null; }
	const f32 = new Float32Array(28);
	let gr: number[] = [1, 1, 1, 0];   // 夜の色（encode がフレームごとに詰める）
	function uni(i: number, b: ArrayLike<number>, vig: ArrayLike<number>, size: ArrayLike<number>, dir: ArrayLike<number>, tm: ArrayLike<number> = [0, 1, 0, 0], lp: ArrayLike<number> = [1, 0, 0, 0]): void { f32.set(b, 0); f32.set(vig, 4); f32.set(size, 8); f32.set(dir, 12); f32.set(tm, 16); f32.set(lp, 20); f32.set(gr, 24); device.queue.writeBuffer(ub[i], 0, f32); }
	// 3D LUT（W1）：url が変わったら読み直す。着くまでは LUT 無し（lut.z=0・束縛は 1×1 のダミー）。外したら返す
	let L: PostLut | null = null, dummy: GPUTexture | null = null;   // L＝{ url, size, tex, view, n, ready }
	const dummyView = () => { dummy ??= device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }); return dummy.createView(); };
	function freeLut() { if (!L) return; L.tex?.destroy(); L = null; }
	function syncLut(l: PostFrameOptions["lut"]): void {
		if (!l) { freeLut(); return; }
		if (L && L.url === l.url && L.size === l.size) return;
		freeLut();
		const me: PostLut = L = { url: l.url, size: l.size, tex: null, view: null, n: 0, ready: false };
		loadLUT(l.url, l.size).then(r => {
			if (L !== me) return;
			me.tex = device.createTexture({ size: [r.size * r.size, r.size], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
			device.queue.writeTexture({ texture: me.tex }, r.data, { bytesPerRow: r.size * r.size * 4 }, { width: r.size * r.size, height: r.size });
			me.view = me.tex.createView(); me.n = r.size; me.ready = true; requestDraw?.();
		}).catch((e: unknown) => { console.warn("[gpu] post lut load failed:", (e as Error | null)?.message || e); });
	}
	// enc＝開いたコマンドエンコーダ・canvasTex＝ctx.getCurrentTexture()（描き終えた色）・post＝normPost の形
	let SG: PostStagesGPU | null = null;   // 画面の段（Cesium の postProcessStages 相当）＝段がある間だけ
	function encode(enc: GPUCommandEncoder, canvasTex: GPUTexture, W: number, H: number, post: PostFrameOptions, sf?: StageFrameGPU | null): GPUCommandEncoder {
		ensure(W, H);
		const stages = post.stages?.length && sf ? post.stages : null;
		if (stages) SG ??= createPostStagesGPU(device, format, requestDraw); else if (SG) { SG.dispose(); SG = null; }
		const stageOn = !!(stages && SG!.drawable(stages));
		const b = post.bloom, v = post.vignette, t = post.tonemap, g = post.grade;
		gr = g && g.length >= 3 ? [g[0], g[1], g[2], 1] : [1, 1, 1, 0];
		syncLut(post.lut);
		const lutOn = !!(post.lut && L && L.ready && L.url === post.lut.url);
		const tm = [t ? TM_MODE[t.mode] ?? 2 : 0, t ? t.exposure : 1, t ? 1 : 0, post.fxaa ? 1 : 0], lp = [lutOn ? L!.n : 1, lutOn ? post.lut!.intensity : 0, lutOn ? 1 : 0, 0];
		enc.copyTextureToTexture({ texture: canvasTex }, { texture: T!.scratch }, { width: W, height: H });
		const bb = b ? [b.threshold, b.strength, b.radius, 0] : [1, 0, 1, 0], vg = v ? [v.strength, v.radius, v.softness, 1] : [0, 1, 0.5, 0], sz = [W, H, 1 / W, 1 / H];
		const pass = (pipeline: GPURenderPipeline, view: GPUTextureView, group: GPUBindGroup) => { const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] }); p.setPipeline(pipeline); p.setBindGroup(0, group); p.draw(3); p.end(); };
		const bg = (i: number, srcView: GPUTextureView) => device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub[i] } }, { binding: 1, resource: srcView }, { binding: 2, resource: smp }] });
		if (b) {
			uni(0, bb, vg, sz, [0, 0, 0, 0]); pass(pBright, T!.hv[0], bg(0, T!.sv));
			uni(1, bb, vg, sz, [b.radius, 0, 0, 0]); pass(pBlur, T!.hv[1], bg(1, T!.hv[0]));
			uni(2, bb, vg, sz, [0, b.radius, 0, 0]); pass(pBlur, T!.hv[2], bg(2, T!.hv[1]));
		}
		uni(3, bb, vg, sz, [0, 0, 0, 0], tm, lp);
		const comp = device.createBindGroup({ layout: bglComp, entries: [{ binding: 0, resource: { buffer: ub[3] } }, { binding: 1, resource: T!.sv }, { binding: 2, resource: smp }, { binding: 3, resource: b ? T!.hv[2] : T!.sv }, { binding: 4, resource: lutOn ? L!.view! : dummyView() }] });
		pass(pComp, stageOn ? SG!.target(W, H) : canvasTex.createView(), comp);
		return stageOn ? SG!.encode(enc, stages!, canvasTex.createView(), W, H, sf!) : enc;   // 固定の鎖の出力 → 段を順に → canvas
	}
	function dispose() { free(); freeLut(); dummy?.destroy(); dummy = null; for (const u of ub) u.destroy(); SG?.dispose(); SG = null; }
	const bytes = () => (T ? T.w * T.h * 4 + T.hw * T.hh * 4 * 3 : 0) + (SG ? SG.bytes() : 0) + (L?.ready ? L.n * L.n * L.n * 4 : 0);
	return { encode, dispose, bytes };
}
