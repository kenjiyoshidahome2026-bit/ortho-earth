// SSR（画面空間の映り込み・2026-11-01・WebGPU だけ）：map.setPostChain([{ type: "ssr", … }]) の段。Cesium に無い ortho の機能。
//   main パスの後（AO の後・gint の線と注記の前）に 3 パス足す：
//   ①色の写し＝本体の色を 1x の控えへ（4x は resolve だけのパス・1x は canvas から copy）＝映す色の元（同じ的を読みながら書けないため）
//   ②映り込み（半解像度・rgba16float）＝画素ごとに「映す面か」と反射率を決め、映す面だけ視線を反射させて深度の中を歩く。当たった画素の色×重みを書く（前乗算）
//   ③合成（本体の解像度・本体と同じ MSAA）＝双線形で拡大して over（dst×(1−a)＋src）。α は触らない（夜の窓の印は α に居る）
// 映す面（どれも 0..1＝真上から見た時の反射率・斜めほど強くなる＝Schlick）：
//   ocean＝標高 0 m 以下の地面（DEM・海と湖面下の陸）。地形（標高）が来ていない時と標高の窓の外は映さない
//   ground＝上を向いた面すべて（球の床・地形・屋上）＝雨上がりの濡れた地面
//   facades＝建物メッシュ・模型・3D Tiles（stencil bit7）の立った面＝ガラスの壁
// 位置の復元は AO（ao.ts）の精度の掟と同じ：視線の基底は CPU の f64・対数深度は expm1・球の床は c/(−b＋√h)。
// 歩いた点を画面へ戻すのも f64 で前計算した [F X Y] の逆行列（目からの相対位置 Q → (w, w·x, w·y)）＝絶対座標を経ない。
// 限界：画面に写っている物しか映らない（画面外・物の裏は映らない＝重みが 0 のまま＝元の色）。真俯瞰は映る物がほぼ無いので AO と同じく傾けた時だけ。
import { FRAME } from "./wgsl.ts";
import { viewRays } from "../camera.ts";
import { FX_NOISE_WGSL, fxFrame } from "./scenefx.ts";   // 雨（setPostChain の rain）＝波紋と水たまりの雑音・目の所の東北と錨（scenefx と共有）

const M_PER_R = 1 / 6371000;   // 1 m／地球半径（シェーダの単位＝β 単位球）

// 映り込みの段（半解像度）。group(0)/(1)＝本体の main スロット（Frame・標高のアトラス・DrawP は宣言だけ）＝海の判定が elev() を使う。group(2)＝SSR の物
export const SSR_WGSL = (ms: boolean): string => /* wgsl */`
${FRAME}
struct SsrP { rF: vec4f, rX: vec4f, rY: vec4f, i0: vec4f, i1: vec4f, i2: vec4f, eye: vec4f, p: vec4f, q: vec4f, size: vec4f, rn: vec4f, an: vec4f, ex: vec4f, ny: vec4f };
// rF/rX/rY.xyz＝視線 v(ndc)＝rF＋ndc.x·rX＋ndc.y·rY（clip w が 1 の長さ）・rX.w＝|eye|²−1・rY.w＝2·ln2／logCoef
// i0/i1/i2＝[rF rX rY] の逆行列の行（Q → (w, w·ndc.x, w·ndc.y)）・eye.xyz＝目（β 単位球）
// p＝(強さ, 歩く長さ（R）, 厚み（R）, 歩数)・q＝(ocean, ground, facades, 0)・size＝(W, H, 1/W, 1/H)（本体の画素）
// rn＝雨 (濡れ 0..1, 時刻 s, 積み上げの番目, 0)・an＝目−雑音の錨（β）・ex/ny＝目の所の東・北（β）＝水たまりの斑と波紋（scenefx.ts FX_NOISE_WGSL）
@group(2) @binding(0) var<uniform> SS: SsrP;
@group(2) @binding(1) var ssrDep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@group(2) @binding(2) var ssrStn: ${ms ? "texture_multisampled_2d<u32>" : "texture_2d<u32>"};
@group(2) @binding(3) var ssrCol: texture_2d<f32>;
const SSR_M: f32 = ${M_PER_R.toExponential(6)};
${FX_NOISE_WGSL}
fn ssrExpm1(x: f32) -> f32 {
	if (x < 0.1) { return x * (1.0 + x * (0.5 + x * (0.16666667 + x * (0.041666668 + x * (0.008333334 + x * 0.0013888889))))); }
	return exp(x) - 1.0;
}
fn ssrClampQ(q: vec2i) -> vec2i { return clamp(q, vec2i(0), vec2i(SS.size.xy) - vec2i(1)); }
// 本体の画素 q → xyz＝目からの相対位置・w＝clip w（空は w<0）。深度の無い画素は球の床（AO の posAt と同式）
fn ssrPos(q0: vec2i) -> vec4f {
	let q = ssrClampQ(q0);
	let z = textureLoad(ssrDep, q, 0);
	let uv = (vec2f(q) + 0.5) * SS.size.zw;
	let v = SS.rF.xyz + (uv.x * 2.0 - 1.0) * SS.rX.xyz + (1.0 - uv.y * 2.0) * SS.rY.xyz;
	if (z >= 1.0) {
		let a = dot(v, v); let b = dot(SS.eye.xyz, v); let c = SS.rX.w;
		let h = b * b - a * c;
		if (h < 0.0 || b >= 0.0 || c <= 0.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
		let s = c / (-b + sqrt(h));
		return vec4f(v * s, s);
	}
	let w = ssrExpm1(z * SS.rY.w);
	return vec4f(v * w, w);
}
// 目からの相対位置 Q → (w, ndc.x, ndc.y)（w≤0＝目の後ろ）
fn ssrProj(Q: vec3f) -> vec3f {
	let a = vec3f(dot(SS.i0.xyz, Q), dot(SS.i1.xyz, Q), dot(SS.i2.xyz, Q));
	if (a.x <= 0.0) { return vec3f(-1.0, 0.0, 0.0); }
	return vec3f(a.x, a.yz / a.x);
}
fn ssrPix(ndc: vec2f) -> vec2i { return vec2i(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * SS.size.xy); }
// 標高の窓（近・遠）の内か＝海の判定は窓の外（標高 0＝データ無し）を海にしない
fn ssrCovered(ll: vec2f) -> bool {
	let u = (ll - F.elevBounds.xy) / F.elevBounds.zw;
	if (all(u >= vec2f(0.0)) && all(u <= vec2f(1.0))) { return true; }
	if (F.farP.x < 0.5) { return false; }
	let g = (ll - F.farBounds.xy) / F.farBounds.zw;
	return all(g >= vec2f(0.0)) && all(g <= vec2f(1.0));
}
${FULL_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let k4 = u32(SS.rn.z) & 3u;   // 静止の積み上げの番目で 2×2 のどの画素を受け持つかを回す（4 枚で全画素＝細い部材が埋まる・動いている間は 0）
	let q = vec2i(pos.xy) * 2 + vec2i(i32(k4 & 1u), i32(k4 >> 1u));   // 半解像度の texel → 本体の 2×2 の左上
	let Pc = ssrPos(q);
	if (Pc.w < 0.0) { return vec4f(0.0); }
	let wp = SS.eye.xyz + Pc.xyz;
	let up = normalize(wp);
	// 法線＝深度のある画素は隣の画素との差（手前側の差＝縁で跳ばない・AO と同式）。球の床は上向き
	var n = up;
	if (textureLoad(ssrDep, ssrClampQ(q), 0) < 1.0) {
		let Px1 = ssrPos(q + vec2i(1, 0)); let Px0 = ssrPos(q - vec2i(1, 0));
		let Py1 = ssrPos(q + vec2i(0, 1)); let Py0 = ssrPos(q - vec2i(0, 1));
		let dx = select(Pc.xyz - Px0.xyz, Px1.xyz - Pc.xyz, abs(Px1.w - Pc.w) < abs(Px0.w - Pc.w) || Px0.w < 0.0);
		let dy = select(Pc.xyz - Py0.xyz, Py1.xyz - Pc.xyz, abs(Py1.w - Pc.w) < abs(Py0.w - Pc.w) || Py0.w < 0.0);
		let cn = cross(dx, dy);
		if (dot(cn, cn) < 1e-30) { return vec4f(0.0); }
		n = normalize(cn);
	}
	if (dot(n, Pc.xyz) > 0.0) { n = -n; }   // 視線に向ける
	let nUp = dot(n, up);
	// 雨（rain）＝上を向いた面は水たまりの所ほど鏡に近く・近くは波紋で揺らす（遠くは画素より細かいので揺らさない）
	var wetK = 1.0;
	if (SS.rn.x > 0.0 && nUp > 0.9) {
		let m = (Pc.xyz + SS.an.xyz) / SSR_M;
		wetK = mix(0.3, 1.0, fxPuddleFar(m, Pc.w));
		let rp = fxRipple(m, SS.rn.y) * (0.12 * SS.rn.x * clamp(60.0 * SSR_M / Pc.w, 0.0, 1.0));
		n = normalize(n + SS.ex.xyz * rp.x + SS.ny.xyz * rp.y);
	}
	// 映す面と反射率
	var r = 0.0;
	if (nUp > 0.9) { r = SS.q.y * wetK; }   // ground
	if (SS.q.z > 0.0 && abs(nUp) < 0.35 && (textureLoad(ssrStn, ssrClampQ(q), 0).r & 0x80u) != 0u) { r = max(r, SS.q.z); }   // facades（建物・模型の立った面）
	if (SS.q.x > 0.0 && nUp > 0.9 && F.elevP.y > 0.5) {   // ocean＝標高 0 m 以下の地面（屋上を除く＝高さ 30 m 未満）
		let alt = (2.0 * dot(SS.eye.xyz, Pc.xyz) + dot(Pc.xyz, Pc.xyz) + SS.rX.w) / (length(wp) + 1.0) / SSR_M;   // |E＋P|−1（桁落ち無し）→ m
		let dll = deltaLL(F.eyeO.xyz + Pc.xyz, F.originPt, F.trig.z, F.eyeO.w, F.ellP.x);
		let ll = F.origin + dll;
		if (alt < 30.0 && ssrCovered(ll)) { r = max(r, SS.q.x * (1.0 - smoothstep(0.0, 1.0, elev(ll)))); }
	}
	if (r <= 0.0) { return vec4f(0.0); }
	// 反射の向きと Fresnel（Schlick＝r が真上から見た反射率・斜めほど 1 へ。小さい r は斜めの伸びも抑える）
	let V = normalize(Pc.xyz);
	let R = reflect(V, n);
	let cosT = clamp(-dot(V, n), 0.0, 1.0);
	let fres = r + (1.0 - r) * pow(1.0 - cosT, 5.0) * min(1.0, 2.0 * r);
	// 深度の中を歩く：t＝長さ×s²（手前ほど細かい）・s のジッタは画素ごと（IGN）＝縞を拡大の双線形で均す。
	// 当たり＝「物の手前」から「物の裏」へ入った 1 歩を見つけ、その歩の中を 6 回の二分で面まで詰め、詰めた所の深度の差が厚みの内なら当たり（厚みを超える＝物の後ろを通った＝歩き続ける）
	let nSteps = i32(SS.p.w);
	let jit = fract(52.9829189 * fract(dot(pos.xy + SS.rn.z * 5.588238, vec2f(0.06711056, 0.00583715))));   // rn.z＝静止の積み上げの番目（毎フレームずらす）
	let O = Pc.xyz + n * (Pc.w * 2.0e-4);   // 自分の面に当たらない下駄（視距離の 0.02%）
	let maxD = SS.p.y;   // 歩く長さ＝maxDistance（視距離の 2 倍で頭打ちにすると、手前の水面から奥の岸のビルへ届かず映り込みが途中で切れた・Mac 2026-11-02）
	var tPrev = 0.0; var tHit = -1.0; var front = true;
	for (var i = 0; i < nSteps; i++) {
		let s = (f32(i) + jit) / f32(nSteps);
		let t = maxD * s * s;
		let a = ssrProj(O + R * t);
		if (a.x <= 0.0 || abs(a.y) > 1.0 || abs(a.z) > 1.0) { break; }   // 目の後ろ・画面の外＝映らない
		let Sx = ssrPos(ssrPix(a.yz));
		let px = ssrPix(a.yz);
		let near = dot(vec2f(px - q), vec2f(px - q)) < 16.0;   // 出発の画素から 4 px の内＝画素の量子化で自分の面の裏に見える（床の自己交差）＝当たりと見ない
		let behind = !near && Sx.w > 0.0 && a.x > Sx.w;
		if (behind && front) {
			var lo = tPrev; var hi = t;
			for (var k = 0; k < 6; k++) {
				let mid = 0.5 * (lo + hi);
				let am = ssrProj(O + R * mid);
				let Sm = ssrPos(ssrPix(am.yz));
				if (am.x > 0.0 && Sm.w > 0.0 && am.x > Sm.w) { hi = mid; } else { lo = mid; }
			}
			let ah = ssrProj(O + R * hi);
			let Sh = ssrPos(ssrPix(ah.yz));
			if (Sh.w > 0.0 && ah.x - Sh.w < SS.p.z + (hi - lo) + Sh.w * 0.004) { tHit = hi; break; }
		}
		front = !behind;
		tPrev = t;
	}
	if (tHit < 0.0) { return vec4f(0.0); }
	let hi = tHit;
	let a = ssrProj(O + R * hi);
	if (a.x <= 0.0) { return vec4f(0.0); }
	let edgeF = 1.0 - smoothstep(0.85, 1.0, max(abs(a.y), abs(a.z)));   // 画面の縁で消す
	let dfade = 1.0 - smoothstep(0.6, 1.0, hi / maxD);                    // 歩く長さの終わりで消す
	let wgt = clamp(SS.p.x * fres * edgeF * dfade, 0.0, 1.0);
	let c = textureLoad(ssrCol, ssrClampQ(ssrPix(a.yz)), 0).rgb;
	return vec4f(c * wgt, wgt);
}`;

const FULL_VS = /* wgsl */`@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 合成：半解像度の映り込み（前乗算）を双線形で拡大して over。blend の α は dst を保つ
export const SSR_COMP_WGSL = /* wgsl */`
@group(0) @binding(0) var rT: texture_2d<f32>;
@group(0) @binding(1) var rS: sampler;
@group(0) @binding(2) var<uniform> CP: vec4f;   // (1/W, 1/H, 0, 0)（本体の画素）
${FULL_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	return textureSampleLevel(rT, rS, (pos.xy - CP.zw) * CP.xy, 0.0);   // CP.zw＝半解像度の texel が受け持つ画素のずれ（積み上げで 2×2 を回す）
}`;
// ぼかし（半解像度・前乗算のまま）：縦横 2 段の 5 点（1,4,6,4,1）/16＝点々のブロックと壁のまだらを均す（映り込みのごく浅い粗さ）
export const SSR_BLUR_WGSL = (dir: readonly [number, number]): string => /* wgsl */`
@group(0) @binding(0) var bT: texture_2d<f32>;
${FULL_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let xy = vec2i(pos.xy); let dim = vec2i(textureDimensions(bT));
	var s = vec4f(0.0);
	for (var i = -2; i <= 2; i++) { s += select(select(1.0, 4.0, abs(i) == 1), 6.0, i == 0) * textureLoad(bT, clamp(xy + vec2i(${dir[0]}, ${dir[1]}) * i, vec2i(0), dim - vec2i(1)), 0); }
	return s / 16.0;
}`;

/** [F X Y]（列）の逆行列の行（f64・純関数＝Node の検定が読む）。Q＝w·(F＋x·X＋y·Y) → 行 i0·Q＝w・i1·Q＝w·x・i2·Q＝w·y。 */
export function ssrInverse(F: ArrayLike<number>, X: ArrayLike<number>, Y: ArrayLike<number>): number[][] {
	const m = [[F[0], X[0], Y[0]], [F[1], X[1], Y[1]], [F[2], X[2], Y[2]]];
	const c = (r0: number, c0: number, r1: number, c1: number) => m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0];
	const A = [
		[c(1, 1, 2, 2), -c(0, 1, 2, 2), c(0, 1, 1, 2)],
		[-c(1, 0, 2, 2), c(0, 0, 2, 2), -c(0, 0, 1, 2)],
		[c(1, 0, 2, 1), -c(0, 0, 2, 1), c(0, 0, 1, 1)],
	];
	const det = m[0][0] * A[0][0] + m[0][1] * A[1][0] + m[0][2] * A[2][0];
	return A.map(row => row.map(v => v / det));
}

/** setPostChain の ssr（正規化済み）＝renderer.set("ssr", …) の形。 */
export interface SsrOptions { intensity: number; maxDistance: number; thickness: number; steps: number; ocean: number; ground: number; facades: number; rain?: number }   // rain＝雨の濡れ（setPostChain の rain が足す・水たまりと波紋）
/** encode の入力（mvp/invMvp/eye は f64 のまま）。canvasTex＝1x の時の canvas の色（4x は colorView を resolve する）。bg0/bg1＝本体の main スロット。 */
export interface SsrFrame {
	depthTex: GPUTexture; samples: number; W: number; H: number; colorView: GPUTextureView; canvasTex: GPUTexture | null;
	mvp: ArrayLike<number>; invMvp: ArrayLike<number>; eye: ArrayLike<number>; logCoef: number;
	bg0: GPUBindGroup; bg1: GPUBindGroup; opt: SsrOptions; fade: number;
	time?: number; pole?: ArrayLike<number>; phase?: number;   // phase＝静止の積み上げの番目   // 雨の波紋の時刻（s）・北極の β 点（東北の基底）
}
export interface SsrGPU { encode(enc: GPUCommandEncoder, d: SsrFrame): void; dispose(): void; bytes(): number }
// device・format（canvas の色形式）・bgl0/bgl1＝本体の group(0)/(1) のレイアウト（Frame と標高を同じ束縛で読む）
export function createSsrGPU(device: GPUDevice, format: GPUTextureFormat, bgl0: GPUBindGroupLayout, bgl1: GPUBindGroupLayout): SsrGPU {
	const FS = GPUShaderStage.FRAGMENT;
	const bglS = (ms: boolean): GPUBindGroupLayout => device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: FS, buffer: {} },
		{ binding: 1, visibility: FS, texture: { sampleType: "depth", multisampled: ms } },
		{ binding: 2, visibility: FS, texture: { sampleType: "uint", multisampled: ms } },
		{ binding: 3, visibility: FS, texture: { sampleType: "unfilterable-float" } },
	] });
	const bglC = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: FS, texture: { sampleType: "float" } },
		{ binding: 1, visibility: FS, sampler: { type: "filtering" } },
		{ binding: 2, visibility: FS, buffer: {} },
	] });
	const lays = new Map<boolean, GPUBindGroupLayout>();
	const lay = (ms: boolean) => { let l = lays.get(ms); if (!l) { l = bglS(ms); lays.set(ms, l); } return l; };
	const pipes = new Map<string, GPURenderPipeline>();
	const pipe = (k: string, make: () => GPURenderPipeline) => { let p = pipes.get(k); if (!p) { p = make(); pipes.set(k, p); } return p; };
	const mk = (code: string, layouts: GPUBindGroupLayout[], targets: GPUColorTargetState[], sampleCount = 1, label = "ssr"): GPURenderPipeline => {
		const module = device.createShaderModule({ code, label });
		return device.createRenderPipeline({ label, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets }, primitive: { topology: "triangle-list" }, multisample: { count: sampleCount } });
	};
	const OVER: GPUColorTargetState[] = [{ format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } } }];
	const sBuf = device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const cBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const samp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const u = new Float32Array(56);
	let colT: GPUTexture | null = null, refT: GPUTexture | null = null, refB: GPUTexture | null = null, cw = 0, ch = 0;
	let bgS: { dep: GPUTexture; col: GPUTexture; bg: GPUBindGroup } | null = null, bgC: GPUBindGroup | null = null, bgBH: GPUBindGroup | null = null, bgBV: GPUBindGroup | null = null;
	const bglB = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: FS, texture: { sampleType: "unfilterable-float" } }] });
	function ensure(W: number, H: number): void {
		if (colT && cw === W && ch === H) return;
		colT?.destroy(); refT?.destroy(); refB?.destroy();
		colT = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });   // 本体の色の控え（1x）
		refT = device.createTexture({ size: [Math.max(1, W >> 1), Math.max(1, H >> 1)], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });   // 映り込み（前乗算）
		refB = device.createTexture({ size: [Math.max(1, W >> 1), Math.max(1, H >> 1)], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });   // 横ぼかしの控え
		cw = W; ch = H; bgS = null; bgC = null; bgBH = null; bgBV = null;
	}
	function encode(enc: GPUCommandEncoder, d: SsrFrame): void {
		ensure(d.W, d.H);
		const ms = d.samples > 1, l = lay(ms);
		const pS = pipe(ms ? "ms" : "ss", () => mk(SSR_WGSL(ms), [bgl0, bgl1, l], [{ format: "rgba16float" }], 1, "ssr"));
		const pC = pipe("comp" + d.samples, () => mk(SSR_COMP_WGSL, [bglC], OVER, d.samples, "ssrComp"));
		if (!bgS || bgS.dep !== d.depthTex || bgS.col !== colT) {
			bgS = { dep: d.depthTex, col: colT!, bg: device.createBindGroup({ layout: l, entries: [
				{ binding: 0, resource: { buffer: sBuf } },
				{ binding: 1, resource: d.depthTex.createView({ aspect: "depth-only" }) },
				{ binding: 2, resource: d.depthTex.createView({ aspect: "stencil-only" }) },
				{ binding: 3, resource: colT!.createView() },
			] }) };
		}
		const pBH = pipe("blurH", () => mk(SSR_BLUR_WGSL([1, 0]), [bglB], [{ format: "rgba16float" }], 1, "ssrBlurH")), pBV = pipe("blurV", () => mk(SSR_BLUR_WGSL([0, 1]), [bglB], [{ format: "rgba16float" }], 1, "ssrBlurV"));
		bgBH ??= device.createBindGroup({ layout: bglB, entries: [{ binding: 0, resource: refT!.createView() }] });
		bgBV ??= device.createBindGroup({ layout: bglB, entries: [{ binding: 0, resource: refB!.createView() }] });
		bgC ??= device.createBindGroup({ layout: bglC, entries: [{ binding: 0, resource: refT!.createView() }, { binding: 1, resource: samp }, { binding: 2, resource: { buffer: cBuf } }] });
		// ①色の写し
		if (d.canvasTex) enc.copyTextureToTexture({ texture: d.canvasTex }, { texture: colT! }, [d.W, d.H]);
		else enc.beginRenderPass({ colorAttachments: [{ view: d.colorView, resolveTarget: colT!.createView(), loadOp: "load", storeOp: "store" }] }).end();
		// uniform
		const r = viewRays(d.mvp, d.invMvp), inv = ssrInverse(r.F, r.X, r.Y), e = d.eye, o = d.opt;
		u.fill(0);
		u.set(r.F, 0); u.set(r.X, 4); u[7] = e[0] * e[0] + e[1] * e[1] + e[2] * e[2] - 1;
		u.set(r.Y, 8); u[11] = 2 * Math.LN2 / d.logCoef;
		u.set(inv[0], 12); u.set(inv[1], 16); u.set(inv[2], 20);
		u[24] = e[0]; u[25] = e[1]; u[26] = e[2];
		u[28] = o.intensity * d.fade; u[29] = o.maxDistance * M_PER_R; u[30] = o.thickness * M_PER_R; u[31] = o.steps;
		u[32] = o.ocean; u[33] = o.ground; u[34] = o.facades;
		u[36] = d.W; u[37] = d.H; u[38] = 1 / d.W; u[39] = 1 / d.H;
		u[42] = d.phase ?? 0;
		if (o.rain && o.rain > 0 && d.pole) { const fr = fxFrame(e, d.pole); u[40] = o.rain; u[41] = (d.time ?? 0) % 600; u.set(fr.an, 44); u.set(fr.ex, 48); u.set(fr.ny, 52); }
		device.queue.writeBuffer(sBuf, 0, u);
		const k4 = (d.phase ?? 0) & 3;
		device.queue.writeBuffer(cBuf, 0, new Float32Array([1 / d.W, 1 / d.H, k4 & 1, k4 >> 1]));
		// ②映り込み（半解像度）
		const p2 = enc.beginRenderPass({ colorAttachments: [{ view: refT!.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		p2.setPipeline(pS); p2.setBindGroup(0, d.bg0); p2.setBindGroup(1, d.bg1); p2.setBindGroup(2, bgS.bg); p2.draw(3); p2.end();
		// ぼかし（横 → refB・縦 → refT）
		const blur = (view: GPUTextureView, p: GPURenderPipeline, bg: GPUBindGroup) => { const ps = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] }); ps.setPipeline(p); ps.setBindGroup(0, bg); ps.draw(3); ps.end(); };
		blur(refB!.createView(), pBH, bgBH); blur(refT!.createView(), pBV, bgBV);
		// ③合成（本体の色の的へ over）
		const p3 = enc.beginRenderPass({ colorAttachments: [{ view: d.colorView, loadOp: "load", storeOp: "store" }] });
		p3.setPipeline(pC); p3.setBindGroup(0, bgC); p3.draw(3); p3.end();
	}
	function dispose() { colT?.destroy(); refT?.destroy(); refB?.destroy(); colT = refT = refB = null; bgS = null; bgC = null; bgBH = null; bgBV = null; sBuf.destroy(); cBuf.destroy(); pipes.clear(); }
	return { encode, dispose, bytes: () => cw * ch * 4 + (cw >> 1) * (ch >> 1) * 16 };
}
