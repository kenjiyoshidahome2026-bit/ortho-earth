// AO（#46 段 3・2026-09-26・WebGPU だけ）：建物の足元・谷の陰＝画面空間の環境遮蔽。main パスの後・gint の前に 3 パス足す：
//   ①AO（半解像度 r8unorm）＝シーンの深度（対数＝logCoef で線形化）から位置と法線を復元し、半球 12 サンプル（4×4 の回転）で遮蔽を数える。
//     位置は目からの相対（P_rel＝視線×距離＝f32 で m 級の精度）・標本の投影は clipEye＋mvp·(S,0)（CPU double の錨＝RTE と同じ作法）。
//   ②ぼかし（半解像度）＝4×4・深度の重み（AO 面の GB に同梱した深度＝縁を跨がない）。深度が無い画素（GLOBE の床）は視線と単位球の交点で床を復元。
//   ③合成＝色に乗算（blend＝dst×src・MSAA の段は本体と同じ＝4x の静止フレームも 1x の遷移フレームも同じ的へ）。中間の色面は要らない。
// 半径は視距離の 2%（8m〜400m）＝寄れば足元・引けば谷。空（深度 1）は 1。LOW_MEM は globe が旗を落とす（作らない）。
// 深度は 4x のとき texture_depth_multisampled_2d の sample 0（#47 depthout と同じ手）。
export const AO_WGSL = ms => /* wgsl */`
struct AoP { mvp: mat4x4f, invMvp: mat4x4f, clipEye: vec4f, eye: vec4f, p: vec4f, size: vec4f };   // p=(logCoef, 半径の係数, 強さ, bias m→世界)・size=(W,H,1/W,1/H)（AO 面）
@group(0) @binding(0) var<uniform> A: AoP;
@group(0) @binding(1) var dep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
const M_PER_R: f32 = 1.5696e-7;   // 1m／地球半径
fn linW(z: f32) -> f32 { return exp2(2.0 * z / A.p.x) - 1.0; }   // 対数深度（wgsl.js logDepthZ）の逆＝clip w（目からの奥行き）
// 深度を GB の 16bit に詰める（ぼかしの重み用・AO 面に同梱＝ぼかしは深度テクスチャを読まない）
fn encW(w: f32) -> vec2f { let g = clamp(log2(1.0 + w * 1.0e5) / 25.0, 0.0, 1.0); let hi = floor(g * 255.0); return vec2f(hi, floor((g * 255.0 - hi) * 255.0)) / 255.0; }
fn depthAt(xy: vec2i) -> f32 {   // AO 面の texel → 本体の深度（2×2 の左上・sample 0）
	let dim = vec2i(textureDimensions(dep));
	let q = clamp(xy * 2, vec2i(0), dim - vec2i(1));
	return textureLoad(dep, q, 0);
}
fn rayDir(uv: vec2f) -> vec3f {   // 画素の視線（単位・世界）
	let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
	let a = A.invMvp * vec4f(ndc, 0.0, 1.0); let b = A.invMvp * vec4f(ndc, 1.0, 1.0);
	return normalize(b.xyz / b.w - a.xyz / a.w);
}
fn posRel(xy: vec2i, fwd: vec3f) -> vec4f {   // xyz＝目からの相対位置・w＝clip w（空は w<0）
	let z = depthAt(xy);
	let d = rayDir((vec2f(xy) + 0.5) * A.size.zw);
	if (z >= 1.0) {   // 深度が無い＝球の床（GLOBE パスは深度を書かない）か空。視線と単位球の交点で床を復元（地形がある所は地形の深度が来る）
		let o = A.eye.xyz; let b = dot(o, d); let c = dot(o, o) - 1.0; let h = b * b - c;
		if (h < 0.0 || b >= 0.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
		let t = -b - sqrt(h);
		let p = d * t;
		return vec4f(p, dot(p, fwd));
	}
	let w = linW(z);
	return vec4f(d * (w / max(dot(d, fwd), 1e-4)), w);
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
const KERNEL = array<vec3f, 12>(
	vec3f(0.19, 0.06, 0.12), vec3f(-0.22, 0.14, 0.18), vec3f(0.08, -0.27, 0.22), vec3f(-0.11, -0.13, 0.35),
	vec3f(0.35, 0.21, 0.30), vec3f(-0.41, -0.09, 0.28), vec3f(0.12, 0.44, 0.33), vec3f(-0.20, 0.39, 0.45),
	vec3f(0.52, -0.31, 0.40), vec3f(-0.57, 0.22, 0.52), vec3f(0.30, -0.60, 0.58), vec3f(-0.10, 0.10, 0.85));
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let xy = vec2i(pos.xy);
	let fc = A.invMvp * vec4f(0.0, 0.0, 1.0, 1.0); let fn0 = A.invMvp * vec4f(0.0, 0.0, 0.0, 1.0);
	let fwd = normalize(fc.xyz / fc.w - fn0.xyz / fn0.w);
	let P = posRel(xy, fwd);
	if (P.w < 0.0) { return vec4f(1.0); }
	// 法線＝隣の texel との差（手前側の差を採る＝縁で反対側へ跳ばない）
	let Px1 = posRel(xy + vec2i(1, 0), fwd); let Px0 = posRel(xy - vec2i(1, 0), fwd);
	let Py1 = posRel(xy + vec2i(0, 1), fwd); let Py0 = posRel(xy - vec2i(0, 1), fwd);
	let dx = select(P.xyz - Px0.xyz, Px1.xyz - P.xyz, abs(Px1.w - P.w) < abs(Px0.w - P.w) || Px0.w < 0.0);
	let dy = select(P.xyz - Py0.xyz, Py1.xyz - P.xyz, abs(Py1.w - P.w) < abs(Py0.w - P.w) || Py0.w < 0.0);
	var n = cross(dx, dy);
	if (dot(n, n) < 1e-30) { return vec4f(1.0); }
	n = normalize(n);
	if (dot(n, P.xyz) > 0.0) { n = -n; }   // 視線に向ける
	// 半径＝視距離の 2%（8m〜400m）・bias
	let radius = clamp(P.w * A.p.y, 8.0 * M_PER_R, 400.0 * M_PER_R);
	let bias = A.p.w;
	// 接線基底＝画素ごとの回転（4×4 の交互）で縞を散らす
	let ang = f32((xy.x & 3) * 4 + (xy.y & 3)) * 0.3927;   // 16 段
	var t0 = vec3f(cos(ang), sin(ang), 0.37);
	t0 = normalize(t0 - n * dot(t0, n));
	let b0 = cross(n, t0);
	var occ = 0.0;
	for (var i = 0; i < 12; i++) {
		let k = KERNEL[i];
		let S = P.xyz + n * bias + (t0 * k.x + b0 * k.y + n * k.z) * radius;
		let c = A.clipEye + A.mvp * vec4f(S, 0.0);
		if (c.w <= 0.0) { continue; }
		let sn = c.xy / c.w;
		let suv = vec2f(sn.x * 0.5 + 0.5, 0.5 - sn.y * 0.5);
		if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { continue; }
		let sz = depthAt(vec2i(suv * A.size.xy));
		if (sz >= 1.0) { continue; }   // 床（深度なし）は半球の下＝遮らない
		let sw = linW(sz);
		let dW = c.w - sw;   // 標本より手前に面がある＝遮蔽
		if (dW > bias) { occ += smoothstep(0.0, 1.0, radius / max(abs(P.w - sw), 1e-9)); }   // 遠くの面（半径の外）は効かない＝range check
	}
	let ao = 1.0 - A.p.z * occ / 12.0;
	return vec4f(clamp(ao, 0.0, 1.0), encW(P.w), 1.0);
}`;

export const AO_BLUR_WGSL = /* wgsl */`
@group(0) @binding(0) var aoT: texture_2d<f32>;   // R=AO・GB=深度（AO パスが同梱）
fn decW(gb: vec2f) -> f32 { let g = (gb.x * 255.0 + gb.y) / 255.0; return (exp2(g * 25.0) - 1.0) * 1.0e-5; }
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {   // 4×4・深度の重み（|Δw| が視距離の 5% を超える texel は混ぜない＝縁を跨がない）
	let xy = vec2i(pos.xy);
	let dim = vec2i(textureDimensions(aoT));
	let c0 = textureLoad(aoT, xy, 0);
	let w0 = decW(c0.gb); let tol = max(w0 * 0.05, 1.0e-6);
	var s = 0.0; var wsum = 0.0;
	for (var j = -2; j < 2; j++) { for (var i = -2; i < 2; i++) {
		let q = clamp(xy + vec2i(i, j), vec2i(0), dim - vec2i(1));
		let cq = textureLoad(aoT, q, 0);
		let wq = select(0.0, 1.0, abs(decW(cq.gb) - w0) < tol);
		s += cq.r * wq; wsum += wq;
	} }
	return vec4f(select(c0.r, s / wsum, wsum > 0.0), 0.0, 0.0, 1.0);
}`;

export const AO_COMP_WGSL = /* wgsl */`
@group(0) @binding(0) var aoT: texture_2d<f32>;
@group(0) @binding(1) var aoS: sampler;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	var o: VOut; o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {   // 乗算合成（blend＝dst×src）＝AO の値をそのまま出す
	let a = textureSampleLevel(aoT, aoS, in.uv, 0.0).r;
	return vec4f(a, a, a, 1.0);
}`;

// device・format（canvas の色形式）。encode は main パスの後（同じエンコーダ）に 3 パスを積む。
export function createAoGPU(device, format) {
	const bglAo = ms => device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", multisampled: ms } },
	] });
	const bglBlur = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }] });
	const bglComp = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
	] });
	const layouts = new Map();   // ms → { ao }
	const lay = ms => { let l = layouts.get(ms); if (!l) { l = { ao: bglAo(ms) }; layouts.set(ms, l); } return l; };
	const pipes = new Map();     // `${ms}` → { ao, blur }・`comp${sc}` → comp
	const mk = (code, layout, targets, sampleCount = 1) => {
		const module = device.createShaderModule({ code });
		return device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets }, primitive: { topology: "triangle-list" }, multisample: { count: sampleCount } });
	};
	const pipeFor = ms => { const k = ms ? "ms" : "ss"; let p = pipes.get(k); if (!p) { const l = lay(ms); p = { ao: mk(AO_WGSL(ms), l.ao, [{ format: "rgba8unorm" }]), blur: pipes.get("blur") || mk(AO_BLUR_WGSL, bglBlur, [{ format: "r8unorm" }]) }; pipes.set("blur", p.blur); pipes.set(k, p); } return p; };
	const compFor = sc => { const k = "comp" + sc; let p = pipes.get(k); if (!p) { p = mk(AO_COMP_WGSL, bglComp, [{ format, blend: { color: { srcFactor: "zero", dstFactor: "src", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } } }], sc); pipes.set(k, p); } return p; };
	const uBuf = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const uCPU = new Float32Array(48);
	const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	let texA = null, texB = null, tw = 0, th = 0, bgKey = "", bgs = null;
	function ensure(W, H) {
		const w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
		if (texA && tw === w && th === h) return;
		texA?.destroy(); texB?.destroy();
		texA = device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });   // R=AO・GB=深度
		texB = device.createTexture({ size: [w, h], format: "r8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		tw = w; th = h; bgKey = "";
	}
	// enc＝フレームのエンコーダ・d＝{ depthTex, samples, W, H, colorView, mvp, invMvp, clipEye, logCoef, strength, radiusK, biasM }
	function encode(enc, d) {
		ensure(d.W, d.H);
		const ms = d.samples > 1, P = pipeFor(ms), C = compFor(d.samples);
		const key = `${ms}|${d.depthTex.label || ""}|${tw}x${th}`;
		if (bgKey !== key || bgs?.dep !== d.depthTex) {
			const dv = d.depthTex.createView({ aspect: "depth-only" }), l = lay(ms);
			bgs = { dep: d.depthTex,
				ao: device.createBindGroup({ layout: l.ao, entries: [{ binding: 0, resource: { buffer: uBuf } }, { binding: 1, resource: dv }] }),
				blur: device.createBindGroup({ layout: bglBlur, entries: [{ binding: 0, resource: texA.createView() }] }),
				comp: device.createBindGroup({ layout: bglComp, entries: [{ binding: 0, resource: texB.createView() }, { binding: 1, resource: sampler }] }) };
			bgKey = key;
		}
		const u = uCPU; u.set(d.mvp, 0); u.set(d.invMvp, 16);
		u[32] = d.clipEye[0]; u[33] = d.clipEye[1]; u[34] = d.clipEye[2]; u[35] = d.clipEye[3];
		u[36] = d.eye[0]; u[37] = d.eye[1]; u[38] = d.eye[2]; u[39] = 0;
		u[40] = d.logCoef; u[41] = d.radiusK; u[42] = d.strength; u[43] = d.biasM * 1.5696e-7;
		u[44] = tw; u[45] = th; u[46] = 1 / tw; u[47] = 1 / th;
		device.queue.writeBuffer(uBuf, 0, u);
		let pass = enc.beginRenderPass({ colorAttachments: [{ view: texA.createView(), loadOp: "clear", clearValue: { r: 1, g: 1, b: 1, a: 1 }, storeOp: "store" }] });
		pass.setPipeline(P.ao); pass.setBindGroup(0, bgs.ao); pass.draw(3); pass.end();
		pass = enc.beginRenderPass({ colorAttachments: [{ view: texB.createView(), loadOp: "clear", clearValue: { r: 1, g: 0, b: 0, a: 1 }, storeOp: "store" }] });
		pass.setPipeline(P.blur); pass.setBindGroup(0, bgs.blur); pass.draw(3); pass.end();
		pass = enc.beginRenderPass({ colorAttachments: [{ view: d.colorView, loadOp: "load", storeOp: "store" }] });
		pass.setPipeline(C); pass.setBindGroup(0, bgs.comp); pass.draw(3); pass.end();
	}
	function dispose() { texA?.destroy(); texB?.destroy(); texA = texB = null; uBuf.destroy(); pipes.clear(); }
	return { encode, dispose, bytes: () => tw * th * 5 };
}
