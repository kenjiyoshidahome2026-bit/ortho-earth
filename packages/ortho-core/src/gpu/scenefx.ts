// 場面の効果（2026-11-01・WebGPU だけ）＝Cesium に無い 4 つの画面の段。map.setPostChain の contactShadow／heightFog／godRays／rain／toon。
//   どれも AO（ao.ts）と SSR（ssr.ts）と同じ「深度から目からの相対位置を戻す」手で描く（視線の基底は CPU の f64・対数深度は expm1・球の床は c/(−b＋√h)）。
//   pre（AO の後・SSR の前）：
//     ①接触影（半解像度）＝画素ごとに太陽へ向かって深度の中を歩き、物の裏に入ったら陰。シャドウマップ（z13 以上・建物だけ）の届かない引いた絵・山・模型にも効く
//     ②乗算の合成（本体の解像度）＝接触影を深度の揃う texel だけで拡大＋雨の濡れ（上を向いた面を暗く・水たまりの斑）
//   post（SSR の後・gint の線と注記の前）：
//     ③霧と雨の筋（本体の解像度・over）＝高さ霧（標高で指数に薄くなる霧を目から画素までの式一つの積分で）＋太陽の前方散乱＋画面の雨の筋（手前の物より奥の筋は描かない）
//     ④光芒（半解像度）＝画面の太陽の位置へ向けて「空の画素」を放射状に集める＝尾根・ビルの隙間から差す光の筋 → ⑤足し算の合成
//     ⑥イラスト風（本体の解像度）＝色を段に切り（輝度の段＋彩度）、1/w の二階差分で輪郭と折れ目に墨の線
//   α は触らない（夜の窓の印は α に居る）。真俯瞰（flat2d）では掛けない（renderer が呼ばない）。
import { viewRays } from "../camera.ts";
import { ssrInverse } from "./ssr.ts";

const M_PER_R = 1 / 6371000;   // 1 m／地球半径（シェーダの単位＝β 単位球）
/** 雑音の錨の格子（m）＝雑音の周期（水たまり 6 m・3 m、波紋 0.75 m の格子がちょうど割り切れる）。目の位置をこの格子に丸めた点からの相対で雑音を引く＝f32 で mm 級 */
export const FX_ANCHOR_M = 3072;

// 雑音（SSR の波紋と水たまりも使う）＝周期つきの値の雑音。m＝錨からの位置（m）
export const FX_NOISE_WGSL = /* wgsl */`
fn fxHash(p: vec3i) -> f32 {
	var h = (u32(p.x) * 73856093u) ^ (u32(p.y) * 19349663u) ^ (u32(p.z) * 83492791u);
	h = (h ^ (h >> 13u)) * 1274126177u;
	h = h ^ (h >> 16u);
	return f32(h & 0xffffu) / 65535.0;
}
fn fxWrap(p: vec3i, n: i32) -> vec3i { return ((p % vec3i(n)) + vec3i(n)) % vec3i(n); }
fn fxNoise(x: vec3f, n: i32) -> f32 {
	let i = floor(x); let f = x - i; let u = f * f * (3.0 - 2.0 * f);
	let b = vec3i(i);
	let a000 = fxHash(fxWrap(b, n)); let a100 = fxHash(fxWrap(b + vec3i(1, 0, 0), n));
	let a010 = fxHash(fxWrap(b + vec3i(0, 1, 0), n)); let a110 = fxHash(fxWrap(b + vec3i(1, 1, 0), n));
	let a001 = fxHash(fxWrap(b + vec3i(0, 0, 1), n)); let a101 = fxHash(fxWrap(b + vec3i(1, 0, 1), n));
	let a011 = fxHash(fxWrap(b + vec3i(0, 1, 1), n)); let a111 = fxHash(fxWrap(b + vec3i(1, 1, 1), n));
	return mix(mix(mix(a000, a100, u.x), mix(a010, a110, u.x), u.y), mix(mix(a001, a101, u.x), mix(a011, a111, u.x), u.y), u.z);
}
// 水たまり（0..1）＝6 m と 3 m の雑音の和を閾で切る
fn fxPuddle(m: vec3f) -> f32 {
	let v = fxNoise(m / 6.0, 512) * 0.65 + fxNoise(m / 3.0 + vec3f(7.0, 3.0, 1.0), 1024) * 0.35;
	return smoothstep(0.48, 0.62, v);
}
// 水たまりの斑を遠くで均す（画素より細かい斑はちらつく＝150 m より先は平均 0.5 へ）。w＝視距離（R）
fn fxPuddleFar(m: vec3f, w: f32) -> f32 { return mix(0.5, fxPuddle(m), clamp(150.0 * ${M_PER_R.toExponential(6)} / max(w, 1e-12), 0.0, 1.0)); }
// 雨の波紋（接平面の 2 成分・−0.5..0.5）＝0.75 m の雑音を時間で流す
fn fxRipple(m: vec3f, t: f32) -> vec2f {
	let z = vec3f(0.0, 0.0, t * 1.7);
	return vec2f(fxNoise(m / 0.75 + z, 4096), fxNoise(m / 0.75 + vec3f(11.0, 5.0, 3.0) + z, 4096)) - 0.5;
}`;

const FULL_VS = /* wgsl */`@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 共通の頭：uniform・深度・位置の復元（ssr.ts ssrPos と同式）・画面への投影（[F X Y] の逆）・法線
const HEAD = (ms: boolean): string => /* wgsl */`
struct FxP { rF: vec4f, rX: vec4f, rY: vec4f, i0: vec4f, i1: vec4f, i2: vec4f, eye: vec4f, sun: vec4f, sunS: vec4f, cs: vec4f, fog: vec4f, fogC: vec4f, ray: vec4f, rain: vec4f, toon: vec4f, ex: vec4f, ny: vec4f, an: vec4f, size: vec4f, on: vec4f, on2: vec4f };
// rF/rX/rY.xyz＝視線 v(ndc)＝rF＋ndc.x·rX＋ndc.y·rY（clip w が 1 の長さ）・rX.w＝|eye|²−1・rY.w＝2·ln2／logCoef
// i0/i1/i2＝[rF rX rY] の逆の行・eye＝(目 xyz, 目の高度 R)・sun＝(太陽 xyz, 目の所の昼の度合い)・sunS＝(画面の太陽 ndc xy, 前にあるか, 光芒の太陽の高さの重み)
// cs＝接触影 (強さ, 長さ（視距離の割合）, 厚み（視距離の割合）, 歩数)・fog＝(濃さ／R, 高さの尺 R, 底 R, 太陽の散乱)・fogC＝(霧の色, 異方性 g)
// ray＝光芒 (強さ, 減衰, 長さ, 歩数)・rain＝(濡れ＝強さ×濡れ, 暗さ, 時刻 s, 筋＝筋×強さ)・toon＝(段数, 線の濃さ, 線の閾, 彩度)
// ex/ny＝目の所の東・北（β）・an＝目−錨（β）・size＝(W, H, 1/W, 1/H)・on＝(接触影, 霧, 光芒, 雨)・on2＝(イラスト, dpr, 線の消える距離 R, 積み上げの番目)
@group(0) @binding(0) var<uniform> U: FxP;
@group(0) @binding(1) var fxDep: ${ms ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
const FX_M: f32 = ${M_PER_R.toExponential(6)};
fn fxExpm1(x: f32) -> f32 {
	if (x < 0.1) { return x * (1.0 + x * (0.5 + x * (0.16666667 + x * (0.041666668 + x * (0.008333334 + x * 0.0013888889))))); }
	return exp(x) - 1.0;
}
fn fxClampQ(q: vec2i) -> vec2i { return clamp(q, vec2i(0), vec2i(U.size.xy) - vec2i(1)); }
fn fxRay(q: vec2i) -> vec3f {
	let uv = (vec2f(q) + 0.5) * U.size.zw;
	return U.rF.xyz + (uv.x * 2.0 - 1.0) * U.rX.xyz + (1.0 - uv.y * 2.0) * U.rY.xyz;
}
// 本体の画素 q → xyz＝目からの相対位置・w＝clip w（空は w<0）。深度の無い画素は球の床
fn fxPos(q0: vec2i) -> vec4f {
	let q = fxClampQ(q0);
	let z = textureLoad(fxDep, q, 0);
	let v = fxRay(q);
	if (z >= 1.0) {
		let a = dot(v, v); let b = dot(U.eye.xyz, v); let c = U.rX.w;
		let h = b * b - a * c;
		if (h < 0.0 || b >= 0.0 || c <= 0.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
		let s = c / (-b + sqrt(h));
		return vec4f(v * s, s);
	}
	let w = fxExpm1(z * U.rY.w);
	return vec4f(v * w, w);
}
fn fxProj(Q: vec3f) -> vec3f {
	let a = vec3f(dot(U.i0.xyz, Q), dot(U.i1.xyz, Q), dot(U.i2.xyz, Q));
	if (a.x <= 0.0) { return vec3f(-1.0, 0.0, 0.0); }
	return vec3f(a.x, a.yz / a.x);
}
fn fxPix(ndc: vec2f) -> vec2i { return vec2i(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * U.size.xy); }
fn fxUp(Pc: vec4f) -> vec3f { return normalize(U.eye.xyz + Pc.xyz); }
// 画素の高度（R）＝|E＋P|−1 を桁落ち無しで
fn fxAlt(Pc: vec4f) -> f32 { return (2.0 * dot(U.eye.xyz, Pc.xyz) + dot(Pc.xyz, Pc.xyz) + U.rX.w) / (length(U.eye.xyz + Pc.xyz) + 1.0); }
// 法線＝隣の画素との差（奥行きの揃う側）。差は視距離で割って f32 の小さい数の積を避ける。球の床は上向き。0 ベクトル＝決まらない
fn fxNormal(q: vec2i, Pc: vec4f) -> vec3f {
	if (textureLoad(fxDep, fxClampQ(q), 0) >= 1.0) { return fxUp(Pc); }
	let Px1 = fxPos(q + vec2i(1, 0)); let Px0 = fxPos(q - vec2i(1, 0));
	let Py1 = fxPos(q + vec2i(0, 1)); let Py0 = fxPos(q - vec2i(0, 1));
	let dx = select(Pc.xyz - Px0.xyz, Px1.xyz - Pc.xyz, abs(Px1.w - Pc.w) < abs(Px0.w - Pc.w) || Px0.w < 0.0);
	let dy = select(Pc.xyz - Py0.xyz, Py1.xyz - Pc.xyz, abs(Py1.w - Pc.w) < abs(Py0.w - Pc.w) || Py0.w < 0.0);
	let cn = cross(dx / Pc.w, dy / Pc.w);
	if (dot(cn, cn) < 1e-24) { return vec3f(0.0); }
	var n = normalize(cn);
	if (dot(n, Pc.xyz) > 0.0) { n = -n; }
	return n;
}
fn fxIGN(p0: vec2f) -> f32 { let p = p0 + U.on2.w * 5.588238; return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }   // on2.w＝静止の積み上げの番目（毎フレームずらす）
${FX_NOISE_WGSL}
${FULL_VS}`;

// ①接触影（半解像度・rg16float＝(見える度合い, clip w)）
export const FX_CONTACT_WGSL = (ms: boolean): string => HEAD(ms) + /* wgsl */`
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let q = vec2i(pos.xy) * 2;
	let Pc = fxPos(q);
	if (Pc.w < 0.0) { return vec4f(1.0, -1.0, 0.0, 0.0); }
	let L = U.sun.xyz;
	let n = fxNormal(q, Pc);
	let up = fxUp(Pc);
	if (dot(n, n) < 0.5 || dot(up, L) < 0.0 || dot(n, L) <= 0.02) { return vec4f(1.0, Pc.w, 0.0, 0.0); }   // 夜・太陽に背を向けた面（照明が既に暗い）は触らない
	let len = Pc.w * U.cs.y;
	let O = Pc.xyz + n * (Pc.w * 1.0e-3);
	let thick = Pc.w * U.cs.z;
	let N = i32(U.cs.w);
	let jit = fxIGN(pos.xy);
	var occ = 0.0;
	for (var i = 0; i < N; i++) {
		let s = (f32(i) + jit) / f32(N);
		let t = len * s * s;
		let a = fxProj(O + L * t);
		if (a.x <= 0.0 || abs(a.y) > 1.0 || abs(a.z) > 1.0) { break; }
		let px = fxPix(a.yz);
		let dq = vec2f(px - q);
		if (dot(dq, dq) < 9.0) { continue; }   // 出発の 3 px の内＝自分の面（画素の量子化）
		let S = fxPos(px);
		if (S.w > 0.0 && a.x > S.w && a.x - S.w < thick + t * 0.05) { occ = 1.0 - smoothstep(0.55, 1.0, s); break; }
	}
	let edge = 1.0 - smoothstep(0.9, 1.0, max(abs(f32(q.x) * U.size.z * 2.0 - 1.0), abs(f32(q.y) * U.size.w * 2.0 - 1.0)));
	return vec4f(1.0 - U.cs.x * occ * edge, Pc.w, 0.0, 0.0);
}`;

// ②乗算の合成（本体の解像度・MSAA は本体と同じ）＝接触影の拡大（深度の揃う texel だけ）×雨の濡れ
export const FX_PRE_WGSL = (ms: boolean): string => HEAD(ms) + /* wgsl */`
@group(0) @binding(2) var csT: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let q = vec2i(pos.xy);
	let Pc = fxPos(q);
	if (Pc.w < 0.0) { return vec4f(1.0); }
	var k = 1.0;
	if (U.on.x > 0.5) {
		let hp = pos.xy * 0.5 - 0.5;
		let b = vec2i(floor(hp)); let f = hp - floor(hp);
		let dim = vec2i(textureDimensions(csT)) - vec2i(1);
		var sv = 0.0; var sw = 0.0; var best = 1.0; var bestD = 1e30;
		for (var j = 0; j < 4; j++) {
			let o = vec2i(j & 1, j >> 1u);
			let c = textureLoad(csT, clamp(b + o, vec2i(0), dim), 0);
			let bw = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
			let dd = abs(c.y - Pc.w) / Pc.w;
			if (c.y > 0.0 && dd < bestD) { bestD = dd; best = c.x; }
			let dw = select(0.0, 1.0, c.y > 0.0 && dd < 0.03);
			sv += c.x * bw * dw; sw += bw * dw;
		}
		k = select(best, sv / sw, sw > 1e-3);
	}
	if (U.on.w > 0.5) {   // 雨の濡れ＝上を向いた面を暗く（水たまりはもっと）
		let n = fxNormal(q, Pc);
		let nUp = dot(n, fxUp(Pc));
		let m = (Pc.xyz + U.an.xyz) / FX_M;
		let wet = U.rain.x * smoothstep(0.75, 0.95, nUp) * (0.8 + 0.2 * fxPuddleFar(m, Pc.w));
		k *= 1.0 - U.rain.y * wet;
	}
	return vec4f(k, k, k, 1.0);
}`;

// ③高さ霧と雨の筋（本体の解像度・前乗算の over）
export const FX_FOG_WGSL = (ms: boolean): string => HEAD(ms) + /* wgsl */`
fn fxH1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let q = vec2i(pos.xy);
	let Pc = fxPos(q);
	let vn = normalize(fxRay(q));
	var fc = vec3f(0.0); var fa = 0.0;
	if (U.on.y > 0.5) {
		let H = U.fog.y; let base = U.fog.z;
		let h0 = max(U.eye.w - base, 0.0);
		let e0 = exp(-h0 / H);
		var od = 0.0;
		if (Pc.w < 0.0) {   // 空＝上へ抜ける光線の積分（d·H·e0／sinθ）。水平に近いほど濃い＝地平線で地面の霧と繋がる
			let s = dot(vn, normalize(U.eye.xyz));
			od = U.fog.x * H * e0 / max(s, 0.002);
		} else {
			let Lm = length(Pc.xyz);
			let h1 = max(fxAlt(Pc) - base, 0.0);
			let k = (h1 - h0) / H;
			od = select(U.fog.x * Lm * e0 * (1.0 - exp(-k)) / k, U.fog.x * Lm * e0 * (1.0 - 0.5 * k), abs(k) < 1e-3);
		}
		fa = 1.0 - exp(-max(od, 0.0));
		let g = U.fogC.w;
		let ct = dot(vn, U.sun.xyz);
		let hg = 0.04 * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * ct, 1e-4), 1.5);
		let day = U.sun.w;
		let sunC = mix(vec3f(1.0, 0.62, 0.38), vec3f(1.0, 0.94, 0.84), day);
		fc = min(U.fogC.rgb * (0.2 + 0.8 * day) + sunC * (U.fog.w * hg * smoothstep(0.0, 0.15, day + 0.05)), vec3f(1.2)) * fa;
	}
	if (U.on.w > 0.5 && U.rain.w > 0.0) {   // 雨の筋＝奥行き 3 層（6/18/50 m）。手前に物がある層は描かない
		let uv = pos.xy * U.size.zw;
		let asp = U.size.x * U.size.w;
		var sa = 0.0;
		for (var l = 0; l < 3; l++) {
			let dM = select(select(50.0, 18.0, l == 1), 6.0, l == 0);
			if (Pc.w > 0.0 && Pc.w < dM * FX_M) { continue; }
			let sc = select(select(0.35, 0.6, l == 1), 1.0, l == 0);
			let p = vec2f((uv.x * asp + uv.y * 0.12) * 70.0 / sc, uv.y * 3.0 / sc + U.rain.z * (2.2 / sc));
			let col = floor(p.x) + f32(l) * 101.0;
			let h = fxH1(col); let h2 = fxH1(col + 37.0);
			let y = fract(p.y + h * 7.0);
			let st = smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(0.04, 0.3, y)) * step(0.55, h2) * (1.0 - smoothstep(0.05, 0.2, abs(p.x - floor(p.x) - 0.5)));
			sa = max(sa, st * (0.45 + 0.55 * sc));
		}
		sa = clamp(sa * U.rain.w * 0.35, 0.0, 1.0);
		fc = vec3f(0.78, 0.82, 0.88) * sa + fc * (1.0 - sa);
		fa = sa + fa * (1.0 - sa);
	}
	return vec4f(fc, fa);
}`;

// ④光芒（半解像度・rgba16float）＝画面の太陽へ向けて空の画素を集める
export const FX_RAYS_WGSL = (ms: boolean): string => HEAD(ms) + /* wgsl */`
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	if (U.sunS.z < 0.5) { return vec4f(0.0); }
	let uv = (pos.xy * 2.0 + 1.0) * U.size.zw;
	let sUV = vec2f(U.sunS.x * 0.5 + 0.5, 0.5 - U.sunS.y * 0.5);
	let N = i32(U.ray.w);
	let dlt = (sUV - uv) * (U.ray.z / f32(N));
	var p = uv + dlt * fxIGN(pos.xy);
	var ill = 1.0; var acc = 0.0;
	for (var i = 0; i < N; i++) {
		p += dlt;
		if (all(p >= vec2f(0.0)) && all(p <= vec2f(1.0))) {
			if (fxPos(vec2i(p * U.size.xy)).w < 0.0) { acc += ill; }
		}
		ill *= U.ray.y;
	}
	acc /= f32(N);
	let d = length((uv - sUV) * vec2f(U.size.x * U.size.w, 1.0));
	let w = exp(-d * 1.6);
	let c = mix(vec3f(1.0, 0.62, 0.36), vec3f(1.0, 0.93, 0.8), U.sun.w) * (U.ray.x * acc * w * U.sunS.w);
	return vec4f(c, 0.0);
}`;

// ⑤光芒の足し算の合成（双線形）
export const FX_RAYS_COMP_WGSL = /* wgsl */`
@group(0) @binding(2) var rT: texture_2d<f32>;
@group(0) @binding(3) var rS: sampler;
@group(0) @binding(4) var<uniform> CP: vec4f;
${FULL_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	return vec4f(textureSampleLevel(rT, rS, pos.xy * CP.xy, 0.0).rgb, 0.0);
}`;

// ⑦静止の積み上げ（2026-11-01）＝カメラが止まったら数フレーム、歩き始めのずらしを変えて描き、控え（前までの平均）を blend の定数 k/(k+1) で重ねる＝粒が消える。
//   位置合わせは要らない（同じカメラの絵だけを足す）。α は触らない
export const FX_ACC_WGSL = /* wgsl */`
@group(0) @binding(0) var hT: texture_2d<f32>;
${FULL_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(hT, vec2i(pos.xy), 0).rgb, 1.0); }`;

// ⑥イラスト風（本体の解像度・色だけ書く）＝輝度の段＋彩度＋1/w の二階差分の線
export const FX_TOON_WGSL = (ms: boolean): string => HEAD(ms) + /* wgsl */`
@group(0) @binding(2) var colT: texture_2d<f32>;
fn fxIz(q: vec2i) -> f32 { let P = fxPos(q); return select(1.0 / P.w, 0.0, P.w < 0.0); }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let q = vec2i(pos.xy);
	let c = textureLoad(colT, fxClampQ(q), 0).rgb;
	let LW = vec3f(0.2126, 0.7152, 0.0722);
	let l = dot(c, LW);
	let x = l * U.toon.x;
	let fl = floor(x);
	let lq = (fl + smoothstep(0.42, 0.58, x - fl)) / U.toon.x;
	var col = c * (max(lq, 0.02) / max(l, 0.02));
	col = clamp(mix(vec3f(dot(col, LW)), col, U.toon.w), vec3f(0.0), vec3f(1.0));
	let Pc = fxPos(q);
	if (Pc.w > 0.0 && U.toon.y > 0.0) {
		let st = max(1, i32(round(U.on2.y)));
		let iz = 1.0 / Pc.w;
		let izl = fxIz(q - vec2i(st, 0)); let izr = fxIz(q + vec2i(st, 0));
		let izu = fxIz(q - vec2i(0, st)); let izd = fxIz(q + vec2i(0, st));
		let d2 = max(abs(izl + izr - 2.0 * iz), abs(izu + izd - 2.0 * iz)) / iz;
		let fade = 1.0 - smoothstep(0.6, 1.0, Pc.w / U.on2.z);
		let e = smoothstep(U.toon.z, U.toon.z * 2.5, d2) * U.toon.y * fade;
		col = mix(col, vec3f(0.08, 0.08, 0.1), clamp(e, 0.0, 1.0));
	}
	return vec4f(col, 1.0);
}`;

/** renderer.set("sceneFx", …) の形（globe の postchain.ts が正規化）。null の効果は掛けない。 */
export interface SceneFxOptions {
	contact: { strength: number; length: number; thickness: number; steps: number } | null;
	fog: { density: number; height: number; base: number; color: number[]; sun: number; anisotropy: number } | null;   // density＝1/km（底の高さで）・height／base＝m
	rays: { strength: number; decay: number; length: number; samples: number } | null;
	rain: { intensity: number; wetness: number; darken: number; streaks: number } | null;
	toon: { levels: number; edge: number; threshold: number; saturation: number } | null;
}
/** encode の入力（mvp/invMvp/eye/sun は f64 のまま）。canvasTex＝1x の時の canvas の色（4x は colorView を resolve する）。 */
export interface SceneFxFrame {
	depthTex: GPUTexture; samples: number; W: number; H: number; colorView: GPUTextureView; canvasTex: GPUTexture | null;
	mvp: ArrayLike<number>; invMvp: ArrayLike<number>; eye: ArrayLike<number>; logCoef: number; sun: ArrayLike<number>; dpr: number;
	pole: ArrayLike<number>; time: number; opt: SceneFxOptions; fade: number;
	phase?: number;   // 静止の積み上げの番目（0..）＝雑音のずらし
}
/** 静止の積み上げの入力（k＝0 は控えを取り直すだけ）。 */
export interface AccFrame { samples: number; W: number; H: number; colorView: GPUTextureView; canvasTex: GPUTexture | null; k: number }
export interface SceneFxGPU { pre(enc: GPUCommandEncoder, d: SceneFxFrame): void; post(enc: GPUCommandEncoder, d: SceneFxFrame): void; accumulate(enc: GPUCommandEncoder, d: AccFrame): void; dispose(): void; bytes(): number }

/** 目の所の東・北（β）と錨からの相対（f64・純関数＝Node の検定が読む）。pole＝北極の β 点 */
export function fxFrame(eye: ArrayLike<number>, pole: ArrayLike<number>): { ex: number[]; ny: number[]; an: number[] } {
	const r = Math.hypot(eye[0], eye[1], eye[2]), up = [eye[0] / r, eye[1] / r, eye[2] / r];
	const cr = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	let ex = cr(pole, up); const el = Math.hypot(ex[0], ex[1], ex[2]) || 1; ex = ex.map(v => v / el);
	const ny = cr(up, ex);
	const g = FX_ANCHOR_M * M_PER_R, an = [0, 1, 2].map(i => eye[i] - Math.round(eye[i] / g) * g);
	return { ex, ny, an };
}

export function createSceneFxGPU(device: GPUDevice, format: GPUTextureFormat): SceneFxGPU {
	const FS = GPUShaderStage.FRAGMENT;
	const lays = new Map<string, GPUBindGroupLayout>();
	const lay = (k: string, make: () => GPUBindGroupLayout) => { let l = lays.get(k); if (!l) { l = make(); lays.set(k, l); } return l; };
	const ent = (ms: boolean, tex: boolean): GPUBindGroupLayoutEntry[] => [
		{ binding: 0, visibility: FS, buffer: {} },
		{ binding: 1, visibility: FS, texture: { sampleType: "depth", multisampled: ms } },
		...(tex ? [{ binding: 2, visibility: FS, texture: { sampleType: "unfilterable-float" as GPUTextureSampleType } }] : []),
	];
	const layD = (ms: boolean) => lay("d" + ms, () => device.createBindGroupLayout({ entries: ent(ms, false) }));
	const layDT = (ms: boolean) => lay("dt" + ms, () => device.createBindGroupLayout({ entries: ent(ms, true) }));
	const layRC = lay("rc", () => device.createBindGroupLayout({ entries: [
		{ binding: 2, visibility: FS, texture: { sampleType: "float" } },
		{ binding: 3, visibility: FS, sampler: { type: "filtering" } },
		{ binding: 4, visibility: FS, buffer: {} },
	] }));
	const pipes = new Map<string, GPURenderPipeline>();
	const pipe = (k: string, make: () => GPURenderPipeline) => { let p = pipes.get(k); if (!p) { p = make(); pipes.set(k, p); } return p; };
	const mk = (code: string, layout: GPUBindGroupLayout, targets: GPUColorTargetState[], sampleCount: number, label: string): GPURenderPipeline => {
		const module = device.createShaderModule({ code, label });
		return device.createRenderPipeline({ label, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets }, primitive: { topology: "triangle-list" }, multisample: { count: sampleCount } });
	};
	const KEEP_A = { srcFactor: "zero", dstFactor: "one", operation: "add" } as const;
	const MUL: GPUColorTargetState[] = [{ format, blend: { color: { srcFactor: "zero", dstFactor: "src", operation: "add" }, alpha: KEEP_A } }];
	const OVER: GPUColorTargetState[] = [{ format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: KEEP_A } }];
	const ADD: GPUColorTargetState[] = [{ format, blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: KEEP_A } }];
	const RGB: GPUColorTargetState[] = [{ format, writeMask: 0x7 /* RGB＝α は触らない */ }];
	const uBuf = device.createBuffer({ size: 21 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const cBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const samp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const u = new Float32Array(21 * 4);
	let csT: GPUTexture | null = null, rayT: GPUTexture | null = null, colT: GPUTexture | null = null, cw = 0, ch = 0;
	const bgs = new Map<string, { dep: GPUTexture; bg: GPUBindGroup }>();
	function ensure(W: number, H: number): void {
		if (csT && cw === W && ch === H) return;
		csT?.destroy(); rayT?.destroy(); colT?.destroy(); colT = null;
		const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
		csT = device.createTexture({ size: [hw, hh], format: "rg16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		rayT = device.createTexture({ size: [hw, hh], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		cw = W; ch = H; bgs.clear();
	}
	function colTex(): GPUTexture {   // イラスト風の色の控え（1x）＝要る時だけ
		colT ??= device.createTexture({ size: [cw, ch], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		return colT;
	}
	// 束（深度が変われば作り直す）。tex＝binding 2 の texture（無し＝深度だけ）
	function bg(key: string, l: GPUBindGroupLayout, dep: GPUTexture, tex: GPUTexture | null): GPUBindGroup {
		const c = bgs.get(key);
		if (c && c.dep === dep) return c.bg;
		const e: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uBuf } }, { binding: 1, resource: dep.createView({ aspect: "depth-only" }) }];
		if (tex) e.push({ binding: 2, resource: tex.createView() });
		const g = device.createBindGroup({ layout: l, entries: e });
		bgs.set(key, { dep, bg: g });
		return g;
	}
	let rcBG: GPUBindGroup | null = null, rcTex: GPUTexture | null = null;
	function writeU(d: SceneFxFrame): void {
		const r = viewRays(d.mvp, d.invMvp), inv = ssrInverse(r.F, r.X, r.Y), e = d.eye, o = d.opt, s = d.sun;
		const er = Math.hypot(e[0], e[1], e[2]);
		const sinAlt = (e[0] * s[0] + e[1] * s[1] + e[2] * s[2]) / er;
		const fr = fxFrame(e, d.pole);
		u.fill(0);
		u.set(r.F, 0); u.set(r.X, 4); u[7] = e[0] * e[0] + e[1] * e[1] + e[2] * e[2] - 1;
		u.set(r.Y, 8); u[11] = 2 * Math.LN2 / d.logCoef;
		u.set(inv[0], 12); u.set(inv[1], 16); u.set(inv[2], 20);
		u[24] = e[0]; u[25] = e[1]; u[26] = e[2]; u[27] = er - 1;
		u[28] = s[0]; u[29] = s[1]; u[30] = s[2]; { const t = Math.max(0, Math.min(1, (sinAlt + 0.1045) / 0.209)); u[31] = t * t * (3 - 2 * t); }
		// 画面の太陽（方向＝無限遠の点を [F X Y] の逆で）
		const a0 = inv[0][0] * s[0] + inv[0][1] * s[1] + inv[0][2] * s[2], a1 = inv[1][0] * s[0] + inv[1][1] * s[1] + inv[1][2] * s[2], a2 = inv[2][0] * s[0] + inv[2][1] * s[1] + inv[2][2] * s[2];
		if (a0 > 0 && Math.abs(a1 / a0) < 2.5 && Math.abs(a2 / a0) < 2.5) { u[32] = a1 / a0; u[33] = a2 / a0; u[34] = 1; }
		{ const t = Math.max(0, Math.min(1, (sinAlt + 0.02) / 0.06)); u[35] = t * t * (3 - 2 * t); }   // 光芒は太陽が目の地平線の上の間（−1°→＋2.3°で点く）
		if (o.contact) { u[36] = o.contact.strength * d.fade; u[37] = o.contact.length; u[38] = o.contact.thickness; u[39] = o.contact.steps; }
		if (o.fog) { u[40] = o.fog.density / 1000 / M_PER_R; u[41] = o.fog.height * M_PER_R; u[42] = o.fog.base * M_PER_R; u[43] = o.fog.sun; u.set(o.fog.color.slice(0, 3), 44); u[47] = o.fog.anisotropy; }
		if (o.rays) { u[48] = o.rays.strength * d.fade; u[49] = o.rays.decay; u[50] = o.rays.length; u[51] = o.rays.samples; }
		if (o.rain) { u[52] = o.rain.intensity * o.rain.wetness; u[53] = o.rain.darken; u[54] = d.time % 600; u[55] = o.rain.streaks * o.rain.intensity; }
		if (o.toon) { u[56] = o.toon.levels; u[57] = o.toon.edge; u[58] = o.toon.threshold; u[59] = o.toon.saturation; }
		u.set(fr.ex, 60); u.set(fr.ny, 64); u.set(fr.an, 68);
		u[72] = d.W; u[73] = d.H; u[74] = 1 / d.W; u[75] = 1 / d.H;
		u[76] = o.contact ? 1 : 0; u[77] = o.fog ? 1 : 0; u[78] = o.rays ? 1 : 0; u[79] = o.rain ? 1 : 0;
		u[80] = o.toon ? 1 : 0; u[81] = d.dpr; u[82] = Math.max(er - 1, 50 * M_PER_R) * 40; u[83] = d.phase ?? 0;
		device.queue.writeBuffer(uBuf, 0, u);
	}
	function fullPass(enc: GPUCommandEncoder, view: GPUTextureView, p: GPURenderPipeline, g: GPUBindGroup, clear = false): void {
		const ps = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: clear ? "clear" : "load", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		ps.setPipeline(p); ps.setBindGroup(0, g); ps.draw(3); ps.end();
	}
	function pre(enc: GPUCommandEncoder, d: SceneFxFrame): void {
		const o = d.opt;
		if (!o.contact && !o.rain) return;
		ensure(d.W, d.H); writeU(d);
		const ms = d.samples > 1;
		if (o.contact) fullPass(enc, csT!.createView(), pipe("cs" + ms, () => mk(FX_CONTACT_WGSL(ms), layD(ms), [{ format: "rg16float" }], 1, "fxContact")), bg("cs" + ms, layD(ms), d.depthTex, null), true);
		fullPass(enc, d.colorView, pipe("pre" + d.samples, () => mk(FX_PRE_WGSL(ms), layDT(ms), MUL, d.samples, "fxPre")), bg("pre" + ms, layDT(ms), d.depthTex, csT));
	}
	function post(enc: GPUCommandEncoder, d: SceneFxFrame): void {
		const o = d.opt;
		const fogOn = !!o.fog || !!(o.rain && o.rain.streaks > 0);
		if (!fogOn && !o.rays && !o.toon) return;
		ensure(d.W, d.H); writeU(d);
		const ms = d.samples > 1;
		if (fogOn) fullPass(enc, d.colorView, pipe("fog" + d.samples, () => mk(FX_FOG_WGSL(ms), layD(ms), OVER, d.samples, "fxFog")), bg("fog" + ms, layD(ms), d.depthTex, null));
		if (o.rays && u[34] > 0.5 && u[35] > 0) {
			fullPass(enc, rayT!.createView(), pipe("rays" + ms, () => mk(FX_RAYS_WGSL(ms), layD(ms), [{ format: "rgba16float" }], 1, "fxRays")), bg("rays" + ms, layD(ms), d.depthTex, null), true);
			if (!rcBG || rcTex !== rayT) { rcTex = rayT; rcBG = device.createBindGroup({ layout: layRC, entries: [{ binding: 2, resource: rayT!.createView() }, { binding: 3, resource: samp }, { binding: 4, resource: { buffer: cBuf } }] }); }
			device.queue.writeBuffer(cBuf, 0, new Float32Array([1 / d.W, 1 / d.H, 0, 0]));
			fullPass(enc, d.colorView, pipe("rc" + d.samples, () => mk(FX_RAYS_COMP_WGSL, layRC, ADD, d.samples, "fxRaysComp")), rcBG);
		}
		if (o.toon) {
			const ct = colTex();
			if (d.canvasTex) enc.copyTextureToTexture({ texture: d.canvasTex }, { texture: ct }, [d.W, d.H]);
			else enc.beginRenderPass({ colorAttachments: [{ view: d.colorView, resolveTarget: ct.createView(), loadOp: "load", storeOp: "store" }] }).end();
			const k = "toon" + ms;
			if (bgs.get(k)?.dep !== d.depthTex) bgs.delete(k);
			fullPass(enc, d.colorView, pipe("toon" + d.samples, () => mk(FX_TOON_WGSL(ms), layDT(ms), RGB, d.samples, "fxToon")), bg(k, layDT(ms), d.depthTex, ct));
		}
	}
	// 静止の積み上げ：控え histT（1x）を k/(k+1) で重ね、重ねた絵を控えへ取り直す
	let histT: GPUTexture | null = null, hw0 = 0, hh0 = 0, accBG: GPUBindGroup | null = null;
	const layA = lay("acc", () => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: FS, texture: { sampleType: "unfilterable-float" } }] }));
	const BLEND_K: GPUColorTargetState[] = [{ format, blend: { color: { srcFactor: "constant", dstFactor: "one-minus-constant", operation: "add" }, alpha: KEEP_A } }];
	function accumulate(enc: GPUCommandEncoder, d: AccFrame): void {
		if (!histT || hw0 !== d.W || hh0 !== d.H) {
			histT?.destroy();
			histT = device.createTexture({ size: [d.W, d.H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
			hw0 = d.W; hh0 = d.H; accBG = device.createBindGroup({ layout: layA, entries: [{ binding: 0, resource: histT.createView() }] });
			if (d.k > 0) d = { ...d, k: 0 };   // 控えが無い＝今の絵から始める
		}
		if (d.k > 0) {
			const c = d.k / (d.k + 1);
			const ps = enc.beginRenderPass({ colorAttachments: [{ view: d.colorView, loadOp: "load", storeOp: "store" }] });
			ps.setPipeline(pipe("acc" + d.samples, () => mk(FX_ACC_WGSL, layA, BLEND_K, d.samples, "fxAcc"))); ps.setBindGroup(0, accBG!); ps.setBlendConstant({ r: c, g: c, b: c, a: c }); ps.draw(3); ps.end();
		}
		if (d.canvasTex) enc.copyTextureToTexture({ texture: d.canvasTex }, { texture: histT }, [d.W, d.H]);
		else enc.beginRenderPass({ colorAttachments: [{ view: d.colorView, resolveTarget: histT.createView(), loadOp: "load", storeOp: "store" }] }).end();
	}
	function dispose() { csT?.destroy(); rayT?.destroy(); colT?.destroy(); histT?.destroy(); csT = rayT = colT = histT = null; bgs.clear(); rcBG = null; accBG = null; uBuf.destroy(); cBuf.destroy(); pipes.clear(); }
	return { pre, post, accumulate, dispose, bytes: () => (cw >> 1) * (ch >> 1) * 12 + (colT ? cw * ch * 4 : 0) + hw0 * hh0 * 4 };
}
