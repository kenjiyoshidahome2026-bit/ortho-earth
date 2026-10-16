// WebGPU の深度の書き出し（#47・2026-09-25）：本体の深度テクスチャ（depth24plus-stencil8・1x／4x）は copy できない形式＝
// 描き終えたフレーム（flush＝submit の後）に 1 パス足して、深度を RGBA8 に詰めて自前の OffscreenCanvas へ描き、
// transferToImageBitmap で ImageBitmap にする（同じ worker のオーバーレイ＝別の WebGL2 コンテキストへ texImage2D で上がる）。
// 深度テクスチャに TEXTURE_BINDING を足すのは申し出がある間だけ（renderer の targets が作り直す）。
// 詰め方は ../depthout.js と同じ（24bit・R が上位）。行の向きは GL に揃える＝ImageBitmap の先頭行＝シーンの一番下の行。
const WGSL = ms => `
@group(0) @binding(0) var dep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let dim = vec2i(textureDimensions(dep));
	let xy = vec2i(i32(pos.x), dim.y - 1 - i32(pos.y));
	let v = min(floor(textureLoad(dep, xy, 0) * 16777215.0 + 0.5), 16777215.0);   // min＝d=1 の丸め上がり（GL 版の注）
	let r = floor(v / 65536.0);
	let g = floor((v - r * 65536.0) / 256.0);
	let b = v - r * 65536.0 - g * 256.0;
	return vec4f(r, g, b, 255.0) / 255.0;
}`;

export function createDepthOutGPU(device) {
	const cv = new OffscreenCanvas(1, 1);
	const ctx = cv.getContext("webgpu");
	if (!ctx) throw new Error("depthout: webgpu context unavailable");
	ctx.configure({ device, format: "rgba8unorm", alphaMode: "premultiplied" });
	const pipes = new Map();   // multisampled(bool) → pipeline
	const pipe = ms => {
		let p = pipes.get(ms);
		if (!p) {
			const module = device.createShaderModule({ code: WGSL(ms) });
			p = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
			pipes.set(ms, p);
		}
		return p;
	};
	let bgKey = null, bg = null;
	// d＝{ tex（深度テクスチャ・TEXTURE_BINDING つき）, samples, w, h }。戻り＝ImageBitmap
	function encode(d) {
		if (cv.width !== d.w || cv.height !== d.h) { cv.width = d.w; cv.height = d.h; }
		const ms = d.samples > 1, p = pipe(ms);
		if (bgKey !== d.tex) { bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: d.tex.createView({ aspect: "depth-only" }) }] }); bgKey = d.tex; }
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 1, g: 1, b: 1, a: 1 }, storeOp: "store" }] });
		pass.setPipeline(p); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
		device.queue.submit([enc.finish()]);
		return cv.transferToImageBitmap();
	}
	function dispose() { bg = null; bgKey = null; pipes.clear(); try { ctx.unconfigure(); } catch { /* 古い実装 */ } }
	return { encode, dispose, bytes: () => cv.width * cv.height * 4 };
}
