// WebGPU の後処理（bloom・vignette・deck.gl 差分 PR-8・2026-10-12）：flush の終端（resolve の後・submit の前）に足す。
// canvas の今のテクスチャ（COPY_SRC）を控え（scratch）に copyTextureToTexture し、①明部の抜き出し（半解像度）②ぼかし横③ぼかし縦④合成（scratch＋bloom×strength・四隅の減光）を canvas へ描く。
// 式は GL2（gl/depthout.js の BRIGHT_FS／BLUR_FS／POST_FS）と同じ。設定の形は ../postfx.js normPost。
const FULL_VS = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// U＝(threshold, strength, radius, 0) / vig＝(strength, radius, softness, on) / size＝(W, H, 1/W, 1/H) / dir＝(dx, dy, 0, 0)
const HEAD = `struct PostP { b: vec4f, vig: vec4f, size: vec4f, dir: vec4f };
@group(0) @binding(0) var<uniform> U: PostP;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
`;
const BRIGHT = HEAD + FULL_VS + `
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let p = vec2i(pos.xy) * 2;
	let c = (textureLoad(src, p, 0).rgb + textureLoad(src, p + vec2i(1, 0), 0).rgb + textureLoad(src, p + vec2i(0, 1), 0).rgb + textureLoad(src, p + vec2i(1, 1), 0).rgb) * 0.25;
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
` + FULL_VS + `
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	var c = textureLoad(src, vec2i(pos.xy), 0);
	let uv = pos.xy * U.size.zw;
	if (U.b.y > 0.0) { c = vec4f(c.rgb + textureSample(bloom, smp, uv).rgb * U.b.y, c.a); }
	if (U.vig.w > 0.5) { let d = length(uv - 0.5) * 1.41421356; c = vec4f(c.rgb * (1.0 - U.vig.x * smoothstep(U.vig.y - U.vig.z, U.vig.y, d)), c.a); }
	return c;
}`;

export function createPostGPU(device, format) {
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
	] });
	const pipe = (code, layout, fmt) => device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module: device.createShaderModule({ code }), entryPoint: "vs" }, fragment: { module: device.createShaderModule({ code }), entryPoint: "fs", targets: [{ format: fmt }] }, primitive: { topology: "triangle-list" } });
	const pBright = pipe(BRIGHT, bgl, "rgba8unorm"), pBlur = pipe(BLUR, bgl, "rgba8unorm"), pComp = pipe(COMP, bglComp, format);
	const smp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const ub = [0, 1, 2, 3].map(() => device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));   // 明部・横・縦・合成
	let T = null;   // { w, h, scratch, half: [3], views }
	function ensure(W, H) {
		if (T && T.w === W && T.h === H) return;
		free();
		const hw = Math.max(1, Math.ceil(W / 2)), hh = Math.max(1, Math.ceil(H / 2));
		const scratch = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		const half = [0, 1, 2].map(() => device.createTexture({ size: [hw, hh], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }));
		T = { w: W, h: H, hw, hh, scratch, half, sv: scratch.createView(), hv: half.map(t => t.createView()) };
	}
	function free() { if (!T) return; T.scratch.destroy(); for (const t of T.half) t.destroy(); T = null; }
	const f32 = new Float32Array(16);
	function uni(i, b, vig, size, dir) { f32.set(b, 0); f32.set(vig, 4); f32.set(size, 8); f32.set(dir, 12); device.queue.writeBuffer(ub[i], 0, f32); }
	// enc＝開いたコマンドエンコーダ・canvasTex＝ctx.getCurrentTexture()（描き終えた色）・post＝normPost の形
	function encode(enc, canvasTex, W, H, post) {
		ensure(W, H);
		const b = post.bloom, v = post.vignette;
		enc.copyTextureToTexture({ texture: canvasTex }, { texture: T.scratch }, { width: W, height: H });
		const bb = b ? [b.threshold, b.strength, b.radius, 0] : [1, 0, 1, 0], vg = v ? [v.strength, v.radius, v.softness, 1] : [0, 1, 0.5, 0], sz = [W, H, 1 / W, 1 / H];
		const pass = (pipeline, view, group) => { const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] }); p.setPipeline(pipeline); p.setBindGroup(0, group); p.draw(3); p.end(); };
		const bg = (i, srcView) => device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ub[i] } }, { binding: 1, resource: srcView }, { binding: 2, resource: smp }] });
		if (b) {
			uni(0, bb, vg, sz, [0, 0, 0, 0]); pass(pBright, T.hv[0], bg(0, T.sv));
			uni(1, bb, vg, sz, [b.radius, 0, 0, 0]); pass(pBlur, T.hv[1], bg(1, T.hv[0]));
			uni(2, bb, vg, sz, [0, b.radius, 0, 0]); pass(pBlur, T.hv[2], bg(2, T.hv[1]));
		}
		uni(3, bb, vg, sz, [0, 0, 0, 0]);
		const comp = device.createBindGroup({ layout: bglComp, entries: [{ binding: 0, resource: { buffer: ub[3] } }, { binding: 1, resource: T.sv }, { binding: 2, resource: smp }, { binding: 3, resource: b ? T.hv[2] : T.sv }] });
		pass(pComp, canvasTex.createView(), comp);
	}
	function dispose() { free(); for (const u of ub) u.destroy(); }
	const bytes = () => T ? T.w * T.h * 4 + T.hw * T.hh * 4 * 3 : 0;
	return { encode, dispose, bytes };
}
