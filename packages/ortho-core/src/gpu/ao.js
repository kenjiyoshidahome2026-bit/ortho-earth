// AO（#46 段 3・2026-09-26・WebGPU だけ）：建物の足元・谷の陰＝画面空間の環境遮蔽。main パスの後・gint の前に 4 パス足す：
//   ①AO（半解像度）＝シーンの深度（対数＝logCoef で線形化）から位置と法線を復元し、地平線型（8 方向×4 歩）で接平面からの最大仰角を取る。
//     位置は目からの相対（P_rel＝w·v(ndc)）。視線 v は CPU が f64 で作る（v(ndc)＝rF＋ndc.x·rX＋ndc.y·rY・clip w が 1 になる長さ）。
//     方向の回しと歩のジッタは 4×4 の周期（Bayer の並び）＝16 通りを 4×4 の画素に 1 つずつ。
//   ②ぼかし（半解像度）＝縦横 2 段の 7 点（(0.5,1,1,1,0.5)⊛(1,2,1)）＝周期 4 の模様をちょうど 1 周ずつ足す＝回しの模様が数学的に消える（画面に貼り付く模様を残さない）。
//     深度の重み（AO 面の GB に同梱した深度＝縁を跨がない）。深度が無い画素（GLOBE の床）は視線と単位球の交点で床を復元。
//   ③合成＝色に乗算（blend＝dst×src・MSAA の段は本体と同じ＝4x の静止フレームも 1x の遷移フレームも同じ的へ）。中間の色面は要らない。
//     半解像度から画素へは深度を見て戻す（周りの 4 texel のうち奥行きが画素と揃う物だけ・揃う物が無ければ一番近い物）＝輪郭で背景の AO がにじまない。
// 半径は視距離の 10%（20m〜400m）・画面上 4〜48px＝寄れば足元・引けば谷（机上シミュレーション：壁の手前 1.5〜5m で 0.8・30m で 0.95・60m で 1）。空（深度 1）は 1。LOW_MEM は globe が旗を落とす（作らない）。
// 深度は 4x のとき texture_depth_multisampled_2d の sample 0（#47 depthout と同じ手）。
// 精度の掟（2026-09-26・実機の縦縞とまだらの根治）：位置の復元に f32 の桁落ちを入れない。平らな地面が AO で暗くなる・動くと模様が泳ぐのは全部これだった。
//   ・視線を invMvp から戻さない＝近平面が浅い（チルト 60° で near≈43m）と invMvp の要素は 7 万台＝小さな ndc の項が足し込みで丸められ、
//     視線が 1〜4 画素ぶん 8 画素周期のノコギリ波で揺れる（Math.fround で再現）＝縦縞。CPU（f64）で rF/rX/rY に畳んで渡す
//   ・対数深度の逆は exp2(x)−1 でなく expm1＝1 の近くの引き算は w を 1.2e-7（≈0.76m）刻みに量子化する＝地面の段々・まだら
//   ・球の床は −b−√h（打ち消し）でなく c/(−b＋√h)・c＝|eye|²−1 は CPU（f64）＝床が 0.4m 級に波打たない

// 深度を GB の 16bit に詰める／戻す（ぼかしと合成の深度重み用・AO 面に同梱＝ぼかしは深度テクスチャを読まない）
const ENC_W = "fn encW(w: f32) -> vec2f { let g = clamp(log2(1.0 + w * 1.0e5) / 25.0, 0.0, 1.0); let hi = floor(g * 255.0); return vec2f(hi, floor((g * 255.0 - hi) * 255.0)) / 255.0; }";
const DEC_W = "fn decW(gb: vec2f) -> f32 { let g = (gb.x * 255.0 + gb.y) / 255.0; return (exp2(g * 25.0) - 1.0) * 1.0e-5; }";
const FULL_VS = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// AO と合成が共有する頭：uniform・深度・画素の位置の復元（上の精度の掟）
const AO_HEAD = ms => /* wgsl */`
struct AoP { rF: vec4f, rX: vec4f, rY: vec4f, eye: vec4f, p: vec4f, size: vec4f };
// rF/rX/rY.xyz＝視線 v(ndc)＝rF＋ndc.x·rX＋ndc.y·rY（clip w が 1 の長さ＝P_rel＝w·v）・rF.w＝焦点距離（AO 面の px）・rX.w＝|eye|²−1・rY.w＝2·ln2／logCoef
// eye.xyz＝目（β 単位球）・p=(0, 半径の係数, 強さ, 接平面の sin の下駄)・size=(W,H,1/W,1/H)（AO 面）
@group(0) @binding(0) var<uniform> A: AoP;
@group(0) @binding(1) var dep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
const M_PER_R: f32 = 1.5696e-7;   // 1m／地球半径
fn expm1s(x: f32) -> f32 {   // exp(x)−1 を 0 の近くでも桁落ちなしに（x＜0.1＝7 次の級数・誤差 1e-11 相対）
	if (x < 0.1) { return x * (1.0 + x * (0.5 + x * (0.16666667 + x * (0.041666668 + x * (0.008333334 + x * 0.0013888889))))); }
	return exp(x) - 1.0;
}
fn linW(z: f32) -> f32 { return expm1s(z * A.rY.w); }   // 対数深度（wgsl.js logDepthZ：z＝logCoef/2·log2(1+w)）の逆＝clip w（目からの奥行き）
${ENC_W}
${DEC_W}
fn posAt(q: vec2i) -> vec4f {   // 本体の画素 q → xyz＝目からの相対位置・w＝clip w（空は w<0）。深度は sample 0・視線は同じ画素の中心
	let dim = vec2i(textureDimensions(dep));
	let z = textureLoad(dep, q, 0);
	let uv = (vec2f(q) + 0.5) / vec2f(dim);
	let v = A.rF.xyz + (uv.x * 2.0 - 1.0) * A.rX.xyz + (1.0 - uv.y * 2.0) * A.rY.xyz;
	if (z >= 1.0) {   // 深度が無い＝球の床（GLOBE パスは深度を書かない）か空。視線と単位球の交点で床を復元（地形がある所は地形の深度が来る）
		let a = dot(v, v); let b = dot(A.eye.xyz, v); let c = A.rX.w;
		let h = b * b - a * c;
		if (h < 0.0 || b >= 0.0 || c <= 0.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }   // 当たらない・目が球の中（地中）＝空扱い
		let s = c / (-b + sqrt(h));   // 手前の根（打ち消しの無い形）＝そのまま clip w
		return vec4f(v * s, s);
	}
	let w = linW(z);
	return vec4f(v * w, w);
}
fn posRel(xy: vec2i) -> vec4f {   // AO 面の texel → 本体の 2×2 の左上の画素
	return posAt(clamp(xy * 2, vec2i(0), vec2i(textureDimensions(dep)) - vec2i(1)));
}
${FULL_VS}`;

export const AO_WGSL = ms => /* wgsl */`
${AO_HEAD(ms)}
// 4×4 の Bayer＝隣り合う画素ほど離れた番号＝どの 4×4 の窓にも 16 通りが 1 つずつ
const B4 = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
// 地平線型（HBAO）：画面上の 8 方向（4×4 の周期で回す）× 4 歩（同じ周期でジッタ）で最大仰角（接平面からの sin）を取り、距離で減衰。
// 半球サンプル型は壁の手前 6m で遮蔽が 1〜2 割にしかならず足元が出ない（机上シミュレーション 2026-09-26）＝壁の方向は仰角 80° 超＝ほぼ全遮蔽になる地平線型へ。
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let xy = vec2i(pos.xy);
	let P = posRel(xy);
	if (P.w < 0.0) { return vec4f(1.0, 1.0, 1.0, 1.0); }
	// 法線＝隣の texel との差（手前側の差を採る＝縁で反対側へ跳ばない）
	let Px1 = posRel(xy + vec2i(1, 0)); let Px0 = posRel(xy - vec2i(1, 0));
	let Py1 = posRel(xy + vec2i(0, 1)); let Py0 = posRel(xy - vec2i(0, 1));
	let dx = select(P.xyz - Px0.xyz, Px1.xyz - P.xyz, abs(Px1.w - P.w) < abs(Px0.w - P.w) || Px0.w < 0.0);
	let dy = select(P.xyz - Py0.xyz, Py1.xyz - P.xyz, abs(Py1.w - P.w) < abs(Py0.w - P.w) || Py0.w < 0.0);
	var n = cross(dx, dy);
	if (dot(n, n) < 1e-30) { return vec4f(1.0, encW(P.w), 1.0); }
	n = normalize(n);
	if (dot(n, P.xyz) > 0.0) { n = -n; }   // 視線に向ける
	// 半径＝視距離の 10%（20m〜400m）・画面上の半径（AO 面の px・4〜48）
	let radius = clamp(P.w * A.p.y, 20.0 * M_PER_R, 400.0 * M_PER_R);
	let rpx = clamp(radius / P.w * A.rF.w, 4.0, 48.0);
	let biasS = A.p.w;   // 接平面からの sin の下駄（自己遮蔽・平面の縞を切る）
	// 回しとジッタ＝4×4 の周期（16 通り）。回しは π/4 を 16 等分・ジッタは同じ番号の別の並び（×7＋5 は 16 の置換）＝ぼかしが 1 周ずつ足して消す。
	// p.x＝模様の位相（横へ texel ずらす・検定の口＝位相を変えても AO が変わらない＝動いても模様が泳がない）
	let r = B4[u32((xy.y & 3) * 4 + ((xy.x + i32(A.p.x)) & 3))];
	let ang0 = (f32(r) + 0.5) * (0.7853982 / 16.0);
	let jit = (f32((r * 7u + 5u) & 15u) + 0.5) / 16.0;
	let fxy = vec2f(xy);
	let dim = vec2i(A.size.xy);
	var occ = 0.0;
	for (var k = 0; k < 8; k++) {
		let a = ang0 + f32(k) * 0.7853982;
		let dv = vec2f(cos(a), sin(a));
		var hmax = 0.0;
		for (var s = 0; s < 4; s++) {
			let q = clamp(vec2i(fxy + 0.5 + dv * (rpx * (f32(s) + 0.3 + 0.7 * jit) / 4.0)), vec2i(0), dim - vec2i(1));
			let Q = posRel(q);
			if (Q.w < 0.0) { continue; }
			let D = Q.xyz - P.xyz; let l = length(D);
			if (l < 1e-12 || l > radius) { continue; }
			let se = dot(D, n) / l;                      // 接平面からの仰角の sin
			let fall = 1.0 - (l * l) / (4.0 * radius * radius);   // 遠い遮蔽は弱く（R で 0.75＝壁の最良の地平線は R 付近に来るので 0 にしない）
			hmax = max(hmax, se * fall);
		}
		occ += max(hmax - biasS, 0.0) / (1.0 - biasS);
	}
	let ao = 1.0 - A.p.z * occ / 8.0;
	return vec4f(clamp(ao, 0.0, 1.0), encW(P.w), 1.0);
}`;

// ぼかし＝縦横 2 段（dir＝(1,0)/(0,1)）の 7 点×深度の重み（|Δw| が視距離の 5% を超える texel は混ぜない＝縁を跨がない）。GB の深度は運ぶ。
// 核＝(0.5,1,1,1,0.5)⊛(1,2,1)＝(0.5,2,3.5,4,3.5,2,0.5)/16：前者が周期 4 の回しの模様の各位相をちょうど 1 回ずつ足して消し（両端は同じ位相＝半分ずつ）、
// 後者が標本の粗さを均す（旧 7 点ガウスと同じ幅）＝続いた面では模様が数学的に残らない
export const AO_BLUR_WGSL = dir => /* wgsl */`
@group(0) @binding(0) var aoT: texture_2d<f32>;   // R=AO・GB=深度（AO パスが同梱）
${DEC_W}
const BW = array<f32, 7>(0.5, 2.0, 3.5, 4.0, 3.5, 2.0, 0.5);
${FULL_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let xy = vec2i(pos.xy);
	let dim = vec2i(textureDimensions(aoT));
	let c0 = textureLoad(aoT, xy, 0);
	let w0 = decW(c0.gb); let tol = max(w0 * 0.05, 1.0e-6);
	var s = 0.0; var wsum = 0.0;
	for (var i = -3; i <= 3; i++) {
		let q = clamp(xy + vec2i(${dir[0]}, ${dir[1]}) * i, vec2i(0), dim - vec2i(1));
		let cq = textureLoad(aoT, q, 0);
		let wq = BW[i + 3] * select(0.0, 1.0, abs(decW(cq.gb) - w0) < tol);
		s += cq.r * wq; wsum += wq;
	}
	return vec4f(select(c0.r, s / wsum, wsum > 0.0), c0.gb, 1.0);
}`;

// 合成（乗算・blend＝dst×src）：画素の奥行き（本体の深度から posAt と同じ式）と、周りの 4 texel（texel i＝本体の画素 2i）の奥行きを比べて戻す。
// 揃う texel（|Δw|＜5%）だけを双線形の重みで混ぜる・どれも揃わなければ奥行きが一番近い texel＝建物の縁に背景（や手前）の AO がにじまない＝動いても縁が泳がない
export const AO_COMP_WGSL = ms => /* wgsl */`
${AO_HEAD(ms)}
@group(0) @binding(2) var aoT: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let P = posAt(vec2i(pos.xy));
	if (P.w < 0.0) { return vec4f(1.0); }   // 空
	let dimA = vec2i(textureDimensions(aoT));
	let s = (pos.xy - 0.5) * 0.5;   // AO 面の texel 番号の座標（texel i の中心＝i）
	let i0 = vec2i(floor(s)); let f = fract(s);
	var acc = 0.0; var wsum = 0.0; var best = 1.0; var bestD = 1e30;
	for (var k = 0; k < 4; k++) {
		let o = vec2i(k & 1, k >> 1);
		let c = textureLoad(aoT, clamp(i0 + o, vec2i(0), dimA - vec2i(1)), 0);
		let dw = abs(decW(c.gb) - P.w);
		let bw = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
		let wk = bw * select(0.0, 1.0, dw < P.w * 0.05);
		acc += c.r * wk; wsum += wk;
		if (dw < bestD) { bestD = dw; best = c.r; }
	}
	let a = select(best, acc / wsum, wsum > 1e-4);
	return vec4f(a, a, a, 1.0);
}`;

// 視線の基底（f64・純関数＝Node の検定が読む）：v(ndc)＝F＋ndc.x·X＋ndc.y·Y。長さは clip w が 1 になる向き（g·v＝1・g＝mvp の w 行）＝
// 目からの相対位置は P＝w·v（w＝clip w＝深度から戻す奥行き）。透視は ndc に対して v がアフィン＝3 点で決まる。mvp/invMvp は列優先（mat.js）。
export function aoRays(mvp, invMvp) {
	const M = invMvp, g = [mvp[3], mvp[7], mvp[11]];
	const un = (x, y, z) => { const o = [0, 1, 2, 3].map(r => M[r] * x + M[4 + r] * y + M[8 + r] * z + M[12 + r]); return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
	const ray = (x, y) => { const a = un(x, y, 0), b = un(x, y, 1), v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], k = g[0] * v[0] + g[1] * v[1] + g[2] * v[2]; return v.map(c => c / k); };
	const F = ray(0, 0), X = ray(1, 0), Y = ray(0, 1);
	return { F, X: X.map((c, i) => c - F[i]), Y: Y.map((c, i) => c - F[i]) };
}

// device・format（canvas の色形式）。encode は main パスの後（同じエンコーダ）に 4 パスを積む。
export function createAoGPU(device, format) {
	const F = GPUShaderStage.FRAGMENT;
	const bglAo = ms => device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} },
		{ binding: 1, visibility: F, texture: { sampleType: "depth", multisampled: ms } },
	] });
	const bglComp = ms => device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: F, buffer: {} },
		{ binding: 1, visibility: F, texture: { sampleType: "depth", multisampled: ms } },
		{ binding: 2, visibility: F, texture: { sampleType: "unfilterable-float" } },
	] });
	const bglBlur = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: "unfilterable-float" } }] });
	const layouts = new Map();   // ms → { ao, comp }
	const lay = ms => { let l = layouts.get(ms); if (!l) { l = { ao: bglAo(ms), comp: bglComp(ms) }; layouts.set(ms, l); } return l; };
	const pipes = new Map();     // "ms"/"ss" → ao・"blurH"/"blurV"・`comp${sc}`
	const mk = (code, layout, targets, sampleCount = 1) => {
		const module = device.createShaderModule({ code });
		return device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets }, primitive: { topology: "triangle-list" }, multisample: { count: sampleCount } });
	};
	const pipe = (k, make) => { let p = pipes.get(k); if (!p) { p = make(); pipes.set(k, p); } return p; };
	const R8 = [{ format: "rgba8unorm" }];
	const MUL = [{ format, blend: { color: { srcFactor: "zero", dstFactor: "src", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } } }];
	const uBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const uCPU = new Float32Array(24);
	let texA = null, texB = null, tw = 0, th = 0, bgs = null;
	function ensure(W, H) {
		const w = Math.max(1, W >> 1), h = Math.max(1, H >> 1);
		if (texA && tw === w && th === h) return;
		texA?.destroy(); texB?.destroy();
		texA = device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });   // R=AO・GB=深度
		texB = device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });   // 横ぼかし（GB の深度を運ぶ）→ 縦ぼかしは texA へ戻す
		tw = w; th = h; bgs = null;
	}
	// enc＝フレームのエンコーダ・d＝{ depthTex, samples, W, H, colorView, mvp, invMvp, eye, focal, logCoef, strength, radiusK, biasSin, phase? }（mvp/invMvp/eye は f64 のまま・phase＝模様の位相＝検定の口）
	function encode(enc, d) {
		ensure(d.W, d.H);
		const ms = d.samples > 1, l = lay(ms);
		const pAo = pipe(ms ? "ms" : "ss", () => mk(AO_WGSL(ms), l.ao, R8));
		const pH = pipe("blurH", () => mk(AO_BLUR_WGSL([1, 0]), bglBlur, R8)), pV = pipe("blurV", () => mk(AO_BLUR_WGSL([0, 1]), bglBlur, R8));
		const pC = pipe("comp" + d.samples, () => mk(AO_COMP_WGSL(ms), l.comp, MUL, d.samples));
		if (bgs?.dep !== d.depthTex) {   // 深度（1x/4x・寸法）か AO 面が替わった時だけ作り直す
			const dv = d.depthTex.createView({ aspect: "depth-only" }), ub = { buffer: uBuf };
			bgs = { dep: d.depthTex,
				ao: device.createBindGroup({ layout: l.ao, entries: [{ binding: 0, resource: ub }, { binding: 1, resource: dv }] }),
				blurH: device.createBindGroup({ layout: bglBlur, entries: [{ binding: 0, resource: texA.createView() }] }),
				blurV: device.createBindGroup({ layout: bglBlur, entries: [{ binding: 0, resource: texB.createView() }] }),
				comp: device.createBindGroup({ layout: l.comp, entries: [{ binding: 0, resource: ub }, { binding: 1, resource: dv }, { binding: 2, resource: texA.createView() }] }) };
		}
		const r = aoRays(d.mvp, d.invMvp), e = d.eye, u = uCPU;
		u.set(r.F, 0); u[3] = d.focal / 2;   // 焦点距離（device px）→AO 面（半解像度）
		u.set(r.X, 4); u[7] = e[0] * e[0] + e[1] * e[1] + e[2] * e[2] - 1;   // |eye|²−1（球の床の交点・f64 で引く）
		u.set(r.Y, 8); u[11] = 2 * Math.LN2 / d.logCoef;   // 対数深度 → ln(1+w)
		u[12] = e[0]; u[13] = e[1]; u[14] = e[2]; u[15] = 0;
		u[16] = d.phase | 0; u[17] = d.radiusK; u[18] = d.strength; u[19] = d.biasSin;
		u[20] = tw; u[21] = th; u[22] = 1 / tw; u[23] = 1 / th;
		device.queue.writeBuffer(uBuf, 0, u);
		const run = (view, p, bg, clear = true) => { const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: clear ? "clear" : "load", clearValue: { r: 1, g: 1, b: 1, a: 1 }, storeOp: "store" }] }); pass.setPipeline(p); pass.setBindGroup(0, bg); pass.draw(3); pass.end(); };
		run(texA.createView(), pAo, bgs.ao);
		run(texB.createView(), pH, bgs.blurH);   // 横
		run(texA.createView(), pV, bgs.blurV);   // 縦（texA へ戻す＝合成が読む）
		run(d.colorView, pC, bgs.comp, false);    // 乗算合成（本体の色の的へ）
	}
	function dispose() { texA?.destroy(); texB?.destroy(); texA = texB = null; bgs = null; uBuf.destroy(); pipes.clear(); }
	return { encode, dispose, bytes: () => tw * th * 8 };
}
