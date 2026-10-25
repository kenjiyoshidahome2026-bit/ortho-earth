// 面の貼り付け（分類・classification・2026-10-25）＝gl/classify.ts の WebGPU 版（同じ手順・同じ stencil の使い方）。
// ①z-fail で柱の巻き数（stencil 0-6 ビット）②地形だけ＝bit7 の画素を 0 へ ③巻き数≠0 を塗って 0 へ（3D だけ＝0x80 < s）④3D だけ＝残りを 0 へ。
// 本体の main パスの中（メッシュの後・夜面の前）で描く＝深度・stencil（depth24plus-stencil8）は本体の物をそのまま使う。
// パイプラインは sampleCount ごと（本体の遷移時AA＝1x／4x と同じ）に遅延生成。柱ごとに uniform（mvp・原点の clip・色・logCoef）を 1 本。
import * as mat from "../mat.ts";
import type { ClassifyIn, ClassifyStyle } from "../gl/classify.ts";

const WGSL = /* wgsl */`
struct U { mvp: mat4x4f, clip: vec4f, color: vec4f, p: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct O { @builtin(position) pos: vec4f, @location(0) w: f32 };
@vertex fn vs(@location(0) a: vec3f) -> O {
	var o: O;
	var p = u.clip + u.mvp * vec4f(a, 0.0);
	o.w = p.w;
	p.z = log2(max(1.0 + p.w, 1e-6)) * u.p.x * 0.5 * p.w;
	o.pos = p;
	return o;
}
fn log1pS(w: f32) -> f32 { if (w < 0.1) { return w * (1.0 - w * (0.5 - w * (0.33333334 - w * (0.25 - w * (0.2 - w * (0.16666667 - w * 0.14285715)))))); } return log(1.0 + w); }
struct F { @location(0) c: vec4f, @builtin(frag_depth) d: f32 };
@fragment fn fs(i: O) -> F {
	var f: F;
	f.c = vec4f(u.color.rgb * u.color.a, u.color.a);
	f.d = clamp(log1pS(max(i.w, 1e-30)) * 1.4426950 * u.p.x * 0.5, 0.0, 1.0);
	return f;
}
`;
interface Vol { vbo: GPUBuffer; ibo: GPUBuffer; ubo: GPUBuffer; bg: GPUBindGroup; count: number; origin: number[]; color: number[]; type: number }
type Pipes = { stencil: GPURenderPipeline; occ: GPURenderPipeline; cover: GPURenderPipeline; cover3d: GPURenderPipeline; zero: GPURenderPipeline };

export function createClassifyGPU(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat, blend: GPUBlendState) {
	const vols = new Map<string, Vol>();
	const mod = device.createShaderModule({ code: WGSL, label: "classify" });
	const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
	const pipeSets = new Map<number, Pipes>();
	const st = (compare: GPUCompareFunction, passOp: GPUStencilOperation = "keep", depthFailOp: GPUStencilOperation = "keep"): GPUStencilFaceState => ({ compare, failOp: "keep", depthFailOp, passOp });
	const build = (sc: number): Pipes => {
		const mk = (ds: Partial<GPUDepthStencilState>, color: boolean, label: string) => device.createRenderPipeline({
			label: "classify:" + label, layout,
			vertex: { module: mod, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
			fragment: { module: mod, entryPoint: "fs", targets: [color ? { format, blend } : { format, writeMask: 0 }] },
			primitive: { topology: "triangle-list", cullMode: "none" },
			depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 0xFF, stencilWriteMask: 0x7F, ...ds },
			multisample: { count: sc },
		});
		return {
			// ① z-fail：深度で負けた裏面 +1・表面 −1
			stencil: mk({ depthCompare: "less", stencilFront: st("always", "keep", "decrement-wrap"), stencilBack: st("always", "keep", "increment-wrap") }, false, "stencil"),
			// ② 地形だけ：bit7 の画素の巻き数を 0 へ（ref 0x80・replace は ref&0x7F＝0 を書く）
			occ: mk({ stencilFront: st("equal", "replace"), stencilBack: st("equal", "replace"), stencilReadMask: 0x80 }, false, "occ"),
			// ③ 塗り：巻き数≠0（ref 0）／3D だけ＝0x80 < s（ref 0x80）。通った画素は 0 へ＝一画素一回
			cover: mk({ stencilFront: st("not-equal", "zero"), stencilBack: st("not-equal", "zero"), stencilReadMask: 0x7F }, true, "cover"),
			cover3d: mk({ stencilFront: st("less", "zero"), stencilBack: st("less", "zero") }, true, "cover3d"),
			// ④ 残りを 0 へ
			zero: mk({ stencilFront: st("always", "zero"), stencilBack: st("always", "zero") }, false, "zero"),
		};
	};
	const pipesFor = (sc: number) => { let p = pipeSets.get(sc); if (!p) { p = build(sc); pipeSets.set(sc, p); } return p; };
	const buf = (data: ArrayBufferView, usage: number) => {
		const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
		return b;
	};
	const free = (v: Vol) => { v.vbo.destroy(); v.ibo.destroy(); v.ubo.destroy(); };
	function set(key: string, data: ClassifyIn | null | undefined): void {
		const old = vols.get(key);
		if (old) { free(old); vols.delete(key); }
		if (!data || !data.pos?.length || !data.idx?.length) return;
		const ubo = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		vols.set(key, {
			vbo: buf(data.pos, GPUBufferUsage.VERTEX), ibo: buf(data.idx, GPUBufferUsage.INDEX), ubo,
			bg: device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ubo } }] }),
			count: data.idx.length, origin: Array.from(data.origin).slice(0, 3), color: Array.from(data.color).slice(0, 4), type: data.type ?? 0,
		});
	}
	function style(key: string, s: ClassifyStyle | null | undefined): void {
		const v = vols.get(key); if (!v || !s) return;
		if (s.color) v.color = Array.from(s.color).slice(0, 4);
		if (s.type != null) v.type = s.type;
	}
	const U = new Float32Array(32);
	// 本体の main パスの中で（メッシュの後）。stencil の reference は戻さない（呼ぶ側が要るなら入れ直す）
	function draw(pass: GPURenderPassEncoder, sampleCount: number, mvp: ArrayLike<number>, logCoef: number): void {
		if (!vols.size) return;
		const P = pipesFor(sampleCount);
		for (const v of vols.values()) {
			if (!(v.color[3] > 0)) continue;
			U.set(mvp as ArrayLike<number>, 0);
			const c = mat.transform(mvp as number[], [v.origin[0], v.origin[1], v.origin[2], 1]);
			U[16] = c[0]; U[17] = c[1]; U[18] = c[2]; U[19] = c[3];
			U[20] = v.color[0]; U[21] = v.color[1]; U[22] = v.color[2]; U[23] = v.color[3];
			U[24] = logCoef;
			device.queue.writeBuffer(v.ubo, 0, U.buffer, 0, 128);
			pass.setBindGroup(0, v.bg);
			pass.setVertexBuffer(0, v.vbo);
			pass.setIndexBuffer(v.ibo, "uint32");
			pass.setPipeline(P.stencil); pass.setStencilReference(0); pass.drawIndexed(v.count);
			if (v.type === 1) { pass.setPipeline(P.occ); pass.setStencilReference(0x80); pass.drawIndexed(v.count); }
			if (v.type === 2) { pass.setPipeline(P.cover3d); pass.setStencilReference(0x80); pass.drawIndexed(v.count); pass.setPipeline(P.zero); pass.drawIndexed(v.count); }
			else { pass.setPipeline(P.cover); pass.setStencilReference(0); pass.drawIndexed(v.count); }
		}
	}
	function dispose(): void { for (const v of vols.values()) free(v); vols.clear(); pipeSets.clear(); }
	return { set, style, draw, dispose, get size() { return vols.size; } };
}
