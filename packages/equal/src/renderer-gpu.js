// Equal Earth の WebGPU 描画＝renderer.js（WebGL2）と同じ API・同じ絵（2026-09-30 本人依頼「EqualEarth の WebGPU 化」）。
// 式は renderer.js の GLSL を WGSL へ一対一で移したもの＝式を直す時は両方を直す（検定＝tests/gpu-parity.html を実ブラウザで）。
// GL との違いは器だけ：
//  ・描画は命令の記録＝beginFrame で encoder を開き、同じタスクの最後（microtask）で 1 回 submit。readFid は先に flush する。
//  ・uniform は 1 本の構造体をリング（動的オフセット・1 描画 1 スロット）＝GL の「プログラムごとに uniform を詰め直す」と同じ値。
//  ・国 ID は別パス（r32float・加算ブレンド＝float32-blendable）。main パスは load で開き直す。無い機体はステンシルの陸マスク（GL と同じ落ち方）。
//  ・ステンシルの層ごとのクリアは全画面の「0 書き」三角形（パス内で clear できない）。
//  ・フラグメント座標は上原点＝外形の式へは y を反転して渡す（fc = (x, H − y)）。ID テクスチャは描いた向きのまま読む＝readFid は反転しない。
//  ・readFid は Promise（GPU の読み戻しは非同期）。
import { A1, A2, A3, A4, M, yOfLat, pxPerUnit } from "./equalearth.js";
import { f32ToF16 } from "@ortho-earth/core/f16";

// uniform 構造体（WGSL の U と同じ並び・float 単位のオフセット）
const O = { vp: 0, ix0: 2, vw: 3, yc: 4, ppu: 5, zoom: 6, dpr: 7, morph: 8, ppuS: 9, sphLat: 10, camS: 11, sphDlon: 12, lon0: 13,
	hypsoA: 14, hasElev: 15, hasClim: 16, hasNear: 17, hasId: 18, choroA: 19, hover: 20, paintW: 21,
	nearB: 24, col: 28, sea: 32, bg: 36, edge: 40, land: 44, hoverC: 48, pal: 52, color: 84, param: 148 };
const U_FLOATS = 212, U_BYTES = U_FLOATS * 4, SLOT = 1024, SLOT_F = SLOT / 4, CAP = 128;   // 1 フレーム 128 描画を超えたら途中で submit して使い回す
const PAL_KEYS = ["lowHumid", "lowArid", "midHumid", "midArid", "ramp1", "ramp2", "peak", "snow"];

const WGSL = /* wgsl */`
struct U {
	vp: vec2f, ix0: u32, vw: i32,
	yc: f32, ppu: f32, zoom: f32, dpr: f32,
	morph: f32, ppuS: f32, sphLat: f32, camS: f32,
	sphDlon: f32, lon0: f32, hypsoA: f32, hasElev: f32,
	hasClim: f32, hasNear: f32, hasId: f32, choroA: f32,
	hover: f32, paintW: i32, _p0: f32, _p1: f32,
	nearB: vec4f, col: vec4f, sea: vec4f, bg: vec4f, edge: vec4f, land: vec4f, hoverC: vec4f,
	pal: array<vec4f, 8>,     // lowHumid, lowArid, midHumid, midArid, ramp1, ramp2, peak, snow
	color: array<vec4f, 16>,
	param: array<vec4f, 16>,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var idTex: texture_2d<f32>;
@group(0) @binding(2) var elevTex: texture_2d<f32>;
@group(0) @binding(3) var climTex: texture_2d<f32>;
@group(0) @binding(4) var nearTex: texture_2d<f32>;
@group(0) @binding(5) var paintTex: texture_2d<f32>;
@group(0) @binding(6) var sElev: sampler;
@group(0) @binding(7) var sClim: sampler;
@group(0) @binding(8) var sNear: sampler;
@group(1) @binding(0) var vtx: texture_2d<u32>;

const A1 = ${A1}; const A2 = ${A2}; const A3 = ${A3}; const A4 = ${A4}; const M = ${M};
const D2R = 0.017453292519943295;
const Y_MAX = 1.3173627591574;
const PI = 3.141592653589793;
const OFF = vec4f(0.0, 0.0, 2.0, 1.0);

fn dlonE7(a: u32, b: u32) -> f32 {
	var d = max(a, b) - min(a, b);
	var s = select(-1.0, 1.0, a >= b);
	if (d > 1800000000u) { d = 3600000000u - d; s = -s; }
	return f32(d) * s;
}
fn fetchV(idx: u32) -> vec2f {   // (dlon°, lat°)
	let i = i32(idx);
	let t = textureLoad(vtx, vec2i(i % u.vw, i / u.vw), 0);
	return vec2f(dlonE7(t.r, u.ix0) * 1e-7, f32(i32(t.g) - 900000000) * 1e-7);
}
fn ee(dlon: f32, lat: f32) -> vec2f {
	let l = asin(M * sin(lat * D2R)); let l2 = l * l; let l6 = l2 * l2 * l2;
	return vec2f(dlon * D2R * cos(l) / (M * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2))),
	             l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)));
}
fn px(p: vec2f) -> vec2f { return vec2f(p.x, p.y - u.yc) * u.ppu; }
fn clipOf(p: vec2f) -> vec4f { return vec4f(p / (u.vp * 0.5), 0.0, 1.0); }
fn sph(dlon: f32, lat: f32) -> vec3f {
	let a = (dlon - u.sphDlon) * D2R; let b = lat * D2R; let cb = cos(b);
	let x = cb * sin(a); let y = sin(b); let z = cb * cos(a);
	let c0 = cos(u.sphLat); let s0 = sin(u.sphLat);
	return vec3f(x, y * c0 - z * s0, y * s0 + z * c0);
}
fn mpx(dlon: f32, lat: f32) -> vec3f {   // xy＝device px・z＝可視度
	let e = px(ee(dlon, lat));
	if (u.morph >= 1.0) { return vec3f(e, 1.0); }
	let s = sph(dlon, lat);
	let D = 1.0 + u.camS; let zh = 1.0 / D;
	let w = 0.06 + 0.8 * u.morph;
	let vis = smoothstep(0.0, w, (s.z - zh) + (1.0 + zh + w) * u.morph);
	let p = s.xy * (u.ppuS * u.camS / (D - s.z));
	return vec3f(mix(p, e, u.morph), vis);
}
struct Cross { hit: bool, s: f32, latC: f32 }
fn crosses(dA: f32, latA: f32, dB: f32, latB: f32) -> Cross {
	var c: Cross; c.s = select(1.0, -1.0, dA < 0.0); c.latC = latA; c.hit = false;
	if (abs(dA - dB) <= 180.0) { return c; }
	let den = dB + 360.0 * c.s - dA;
	let t = select((180.0 * c.s - dA) / den, 0.5, abs(den) < 1e-9);
	c.latC = mix(latA, latB, clamp(t, 0.0, 1.0)); c.hit = true;
	return c;
}

// ── 線 ──
struct LineOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) d: f32, @location(2) hw: f32, @location(3) a: f32 }
@vertex fn vsLine(@builtin(vertex_index) vi: u32, @location(0) e: vec3<u32>) -> LineOut {
	var o: LineOut; o.pos = OFF; o.color = vec4f(0.0); o.d = 0.0; o.hw = 0.0; o.a = 0.0;
	let cls = e.z & 255u; let prm = u.param[cls];
	if (u.zoom < f32(e.z >> 8u) * 0.1 || prm.x <= 0.0) { return o; }
	let A = fetchV(e.x); let B = fetchV(e.y);
	let q = vi / 6u; let c = vi % 6u;
	let cr = crosses(A.x, A.y, B.x, B.y);
	var m0: vec3f; var m1: vec3f;
	if (cr.hit) {
		if (q == 0u) { m0 = mpx(A.x, A.y); m1 = mpx(180.0 * cr.s, cr.latC); }
		else         { m0 = mpx(-180.0 * cr.s, cr.latC); m1 = mpx(B.x, B.y); }
	} else {
		if (q == 1u) { return o; }
		m0 = mpx(A.x, A.y); m1 = mpx(B.x, B.y);
	}
	let P0 = m0.xy; let P1 = m1.xy;
	let w = prm.x * u.dpr; let hw = max(w, 1.0) * 0.5;
	let d = P1 - P0; let L = length(d);
	let dir = select(vec2f(1.0, 0.0), d / L, L > 1e-6); let n = vec2f(-dir.y, dir.x);
	let t = select(0.0, 1.0, c == 1u || c == 2u || c == 4u);
	let side = select(1.0, -1.0, c == 0u || c == 1u || c == 3u);
	let ext = hw + 1.0;
	let p = mix(P0, P1, t) + dir * (t * 2.0 - 1.0) * hw + n * side * ext;
	o.pos = clipOf(p);
	o.color = u.color[cls]; o.d = side * ext; o.hw = hw; o.a = min(w, 1.0) * mix(m0.z, m1.z, t);
	return o;
}
@fragment fn fsLine(i: LineOut) -> @location(0) vec4f {
	let a = clamp(i.hw + 0.5 - abs(i.d), 0.0, 1.0) * i.a * i.color.a;
	return vec4f(i.color.rgb * a, a);
}

// ── 塗り（ステンシル偶奇の扇／国 ID の加算）──
const XF = 3.2; const YT = 2.0;
struct FillOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) id: f32 }
@vertex fn vsFill(@builtin(vertex_index) vi: u32, @location(0) e: vec4<u32>) -> FillOut {
	var o: FillOut; o.pos = OFF;
	o.id = f32(e.w & 0xFFFFFu) + 1.0;
	if (u.zoom < f32(e.w >> 20u) * 0.1) { return o; }
	let tri = vi / 3u; let c = vi % 3u;
	let A = fetchV(e.x); let B = fetchV(e.y);
	let cr = crosses(A.x, A.y, B.x, B.y);
	var Q0: vec2f; var Q1: vec2f;
	if (!cr.hit) {
		if (tri != 0u) { return o; }
		Q0 = ee(A.x, A.y); Q1 = ee(B.x, B.y);
	} else {
		let s = cr.s; let yC = ee(0.0, cr.latC).y;
		let pA = ee(A.x, A.y); let CA = ee(180.0 * s, cr.latC); let FA = vec2f(s * XF, yC); let TA = vec2f(s * XF, YT);
		let pB = ee(B.x, B.y); let CB = ee(-180.0 * s, cr.latC); let FB = vec2f(-s * XF, yC); let TB = vec2f(-s * XF, YT);
		if (tri == 0u) { Q0 = pA; Q1 = CA; } else if (tri == 1u) { Q0 = CA; Q1 = FA; } else if (tri == 2u) { Q0 = FA; Q1 = TA; }
		else if (tri == 3u) { Q0 = TB; Q1 = FB; } else if (tri == 4u) { Q0 = FB; Q1 = CB; } else { Q0 = CB; Q1 = pB; }
	}
	var p: vec2f;
	if (c == 0u) { let P = fetchV(e.z); p = ee(P.x, P.y); } else { p = select(Q1, Q0, c == 1u); }
	o.pos = clipOf(px(p));
	return o;
}
@fragment fn fsNone() -> @location(0) vec4f { return vec4f(0.0); }
@fragment fn fsId(@location(0) @interpolate(flat) id: f32, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
	return vec4f(select(-id, id, ff), 0.0, 0.0, 0.0);
}

// ── 外形 ──
fn outlineDist(fc: vec2f) -> f32 {
	var p = (fc - u.vp * 0.5) / u.ppu; p.y += u.yc;
	let y = clamp(p.y, -Y_MAX, Y_MAX);
	var l = y / A1;
	for (var i = 0; i < 6; i++) {
		let l2 = l * l; let l6 = l2 * l2 * l2;
		l -= (l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)) - y) / (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2));
	}
	let l2 = l * l; let l6 = l2 * l2 * l2;
	let xe = PI * cos(l) / (M * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2)));
	return max((abs(p.x) - xe) * u.ppu, (abs(p.y) - Y_MAX) * u.ppu);
}
fn insideK(fc: vec2f) -> f32 { return 1.0 - smoothstep(-0.5, 0.5, outlineDist(fc)); }
fn fcOf(pos: vec4f) -> vec2f { return vec2f(pos.x, u.vp.y - pos.y); }   // GL の gl_FragCoord（下原点）

@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
	return vec4f(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u), 0.0, 1.0);
}
@fragment fn fsSea(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let d = outlineDist(fcOf(pos));
	var c = mix(u.bg.rgb, u.sea.rgb, 1.0 - smoothstep(-0.5, 0.5, d));
	c = mix(c, u.edge.rgb, u.edge.a * (1.0 - smoothstep(0.4, 1.2, abs(d))));
	return vec4f(c, 1.0);
}
@fragment fn fsCover(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let a = u.col.a * insideK(fcOf(pos));
	if (a <= 0.0) { discard; }
	return vec4f(u.col.rgb * a, a);
}
@fragment fn fsVeil() -> @location(0) vec4f { return vec4f(u.col.rgb * u.col.a, u.col.a); }

// ── 全球ハイプソ（renderer.js WORLD_HYPSO と同式）──
fn wetBox(ll: vec2f, b: vec4f) -> f32 {
	return smoothstep(b.x - 3.0, b.x + 3.0, ll.x) * (1.0 - smoothstep(b.y - 3.0, b.y + 3.0, ll.x))
	     * smoothstep(b.z - 3.0, b.z + 3.0, ll.y) * (1.0 - smoothstep(b.w - 3.0, b.w + 3.0, ll.y));
}
fn worldHypso(e: f32, ll: vec2f) -> vec3f {
	let latD = ll.y; let al = abs(latD);
	var arid: f32; var pol: f32;
	if (u.hasClim > 0.5) {
		let c2 = textureSampleLevel(climTex, sClim, vec2f(fract(ll.x / 360.0 + 0.5), 0.5 - latD / 180.0), 0.0).rg;
		arid = c2.r; pol = c2.g;
	} else {
		arid = smoothstep(10.0, 17.0, al) * (1.0 - smoothstep(32.0, 45.0, al));
		var wet = wetBox(ll, vec4f(95.0, 148.0, 17.0, 40.0));
		wet = max(wet, wetBox(ll, vec4f(118.0, 150.0, 40.0, 55.0)));
		wet = max(wet, wetBox(ll, vec4f(-100.0, -70.0, 24.0, 40.0)));
		wet = max(wet, wetBox(ll, vec4f(-63.0, -35.0, -35.0, -15.0)));
		wet = max(wet, wetBox(ll, vec4f(74.0, 95.0, 8.0, 30.0)));
		arid *= 1.0 - wet;
		pol = 1.0 - smoothstep(-64.0, -58.0, latD);
	}
	let low = mix(u.pal[0].rgb, u.pal[1].rgb, arid); let mid = mix(u.pal[2].rgb, u.pal[3].rgb, arid);
	var c = mix(low, mid, smoothstep(0.0, 400.0, e));
	c = mix(c, u.pal[4].rgb, smoothstep(400.0, 1300.0, e));
	c = mix(c, u.pal[5].rgb, smoothstep(1300.0, 2800.0, e));
	c = mix(c, u.pal[6].rgb, smoothstep(2800.0, 4800.0, e));
	let snow = pol + smoothstep(56.0, 62.0, latD) * smoothstep(1100.0, 1900.0, e);
	c = mix(c, u.pal[7].rgb, clamp(snow, 0.0, 1.0));
	return mix(c, vec3f(dot(c, vec3f(0.299, 0.587, 0.114))), 0.10);
}
fn eeInv(p: vec2f) -> vec2f {
	let y = clamp(p.y, -Y_MAX, Y_MAX);
	var l = y / A1;
	for (var i = 0; i < 6; i++) {
		let l2 = l * l; let l6 = l2 * l2 * l2;
		l -= (l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)) - y) / (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2));
	}
	let l2 = l * l; let l6 = l2 * l2 * l2;
	return vec2f(M * p.x * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2)) / cos(l) / D2R,
	             asin(clamp(sin(l) / M, -1.0, 1.0)) / D2R);
}
fn modp(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }   // GLSL mod
fn elevAt(ll: vec2f) -> f32 {
	var e = textureSampleLevel(elevTex, sElev, vec2f(fract((ll.x + 180.0) / 360.0), (ll.y + 90.0) / 180.0), 0.0).r;
	if (u.hasNear > 0.5) {
		let d = vec2f(modp(ll.x - u.nearB.x, 360.0), ll.y - u.nearB.y);
		let uv = d / u.nearB.zw;
		if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
			let m = min(d, u.nearB.zw - d);
			let w = smoothstep(0.0, 0.5, min(m.x, m.y));
			e = mix(e, textureSampleLevel(nearTex, sNear, uv, 0.0).r, w);
		}
	}
	return max(e, 0.0);
}
@fragment fn fsComposite(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let fc = fcOf(pos);
	let cov = insideK(fc); if (cov <= 0.0) { discard; }
	if (u.hasId > 0.5) { let id = floor(abs(textureLoad(idTex, vec2i(pos.xy), 0).r) + 0.5); if (id < 0.5) { discard; } }
	var c = u.land.rgb;
	if (u.hypsoA > 0.001 && u.hasElev > 0.5) {
		let p = (fc - u.vp * 0.5) / u.ppu;
		let dl = eeInv(vec2f(p.x, p.y + u.yc));
		let ll = vec2f(u.lon0 + dl.x, dl.y);
		let e = elevAt(ll);
		let farStep = 180.0 / f32(textureDimensions(elevTex).y);
		let pxDeg = 57.29578 / u.ppu;
		var dstep = farStep;
		if (u.hasNear > 0.5) { dstep = clamp(pxDeg, u.nearB.w / f32(textureDimensions(nearTex).y), farStep); }
		let hx = elevAt(ll + vec2f(dstep, 0.0)) - e; let hy = elevAt(ll + vec2f(0.0, dstep)) - e;
		let shade = clamp(0.86 + (-hx + hy) * 0.00013 * sqrt(farStep / dstep), 0.62, 1.08);
		c = mix(c, worldHypso(e, ll) * shade, u.hypsoA);
	}
	return vec4f(c * cov, cov);
}
@fragment fn fsChoro(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let cov = insideK(fcOf(pos)); if (cov <= 0.0) { discard; }
	let id = floor(abs(textureLoad(idTex, vec2i(pos.xy), 0).r) + 0.5);
	if (id < 0.5) { discard; }
	let fid = i32(id) - 1;
	let pc = textureLoad(paintTex, vec2i(fid % u.paintW, fid / u.paintW), 0);
	let a1 = pc.a * u.choroA;
	let a2 = select(0.0, u.hoverC.a, abs(f32(fid) - u.hover) < 0.5);
	let a = a1 + a2 * (1.0 - a1);
	if (a <= 0.0) { discard; }
	let pm = pc.rgb * a1 + u.hoverC.rgb * a2 * (1.0 - a1);
	return vec4f(pm * cov, a * cov);
}

// ── 点 ──
struct PtOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) q: vec2f, @location(2) r: f32 }
@vertex fn vsPoint(@builtin(vertex_index) c: u32, @location(0) e: vec3<u32>) -> PtOut {
	var o: PtOut; o.pos = OFF; o.color = vec4f(0.0); o.q = vec2f(0.0); o.r = 0.0;
	let cls = e.z & 255u; let prm = u.param[cls];
	if (u.zoom < f32(e.z >> 8u) * 0.1 || prm.x <= 0.0) { return o; }
	let dlon = dlonE7(e.x, u.ix0) * 1e-7; let lat = f32(i32(e.y) - 900000000) * 1e-7;
	let q = vec2f(select(-1.0, 1.0, c == 1u || c == 2u || c == 4u), select(-1.0, 1.0, c == 2u || c == 4u || c == 5u));
	let r = prm.x * u.dpr * 0.5 + 1.5;
	let P = mpx(dlon, lat);
	o.pos = clipOf(P.xy + q * r);
	o.color = u.color[cls] * vec4f(1.0, 1.0, 1.0, P.z); o.q = q * r; o.r = prm.x * u.dpr * 0.5;
	return o;
}
@fragment fn fsPoint(i: PtOut) -> @location(0) vec4f {
	let d = length(i.q);
	let aOut = clamp(i.r + 1.5 - d, 0.0, 1.0);
	let aIn = clamp(i.r - 0.5 - d, 0.0, 1.0);
	let rgb = mix(vec3f(1.0), i.color.rgb, aIn);
	let a = aOut * i.color.a;
	return vec4f(rgb * a, a);
}
`;

// 失敗（アダプタ無し・デバイス/パイプライン作成の検証エラー）は null＝呼び手が WebGL2 へ落ちる。
// canvas.getContext("webgpu") は全部通った後に取る＝失敗時は同じ canvas がまだ WebGL2 に使える。
// opts.noFloatId＝float32-blendable が無い機体の落ち方（ステンシルの陸マスク）を検定で踏むための口
export async function createRendererGPU(canvas, opts = {}) {
	const adapter = await navigator.gpu?.requestAdapter?.().catch(() => null);
	if (!adapter) return null;
	const hasFloatId = adapter.features.has("float32-blendable") && !opts.noFloatId;
	const device = await adapter.requestDevice({ requiredFeatures: hasFloatId ? ["float32-blendable"] : [] }).catch(() => null);
	if (!device) return null;
	if (!hasFloatId) console.warn("[equal] WebGPU float32-blendable unavailable -> no choropleth / hover (land mask via stencil)");
	device.pushErrorScope("validation");
	const format = navigator.gpu.getPreferredCanvasFormat();
	const module = device.createShaderModule({ code: WGSL });
	const TF = "float", visF = GPUShaderStage.FRAGMENT, visVF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
	const bgl0 = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: visVF, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: U_BYTES } },
		{ binding: 1, visibility: visF, texture: { sampleType: "unfilterable-float" } },
		{ binding: 2, visibility: visF, texture: { sampleType: TF } },
		{ binding: 3, visibility: visF, texture: { sampleType: TF } },
		{ binding: 4, visibility: visF, texture: { sampleType: TF } },
		{ binding: 5, visibility: visF, texture: { sampleType: TF } },
		{ binding: 6, visibility: visF, sampler: {} }, { binding: 7, visibility: visF, sampler: {} }, { binding: 8, visibility: visF, sampler: {} },
	] });
	const bgl1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } }] });
	const layA = device.createPipelineLayout({ bindGroupLayouts: [bgl0] }), layV = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
	const PREMUL = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
	const ADD = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } };
	const face = (compare, passOp = "keep") => ({ compare, passOp, failOp: "keep", depthFailOp: "keep" });
	const STENCIL = {   // main パスは全部 stencil8 付き＝パイプラインも全部宣言する
		none: { format: "stencil8", depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 1, stencilWriteMask: 0, stencilFront: face("always"), stencilBack: face("always") },
		invert: { format: "stencil8", depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 1, stencilWriteMask: 1, stencilFront: face("always", "invert"), stencilBack: face("always", "invert") },
		zero: { format: "stencil8", depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 0xff, stencilWriteMask: 0xff, stencilFront: face("always", "zero"), stencilBack: face("always", "zero") },
		equal1: { format: "stencil8", depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 1, stencilWriteMask: 0, stencilFront: face("equal"), stencilBack: face("equal") },
	};
	const vb = (comps) => [{ arrayStride: comps * 4, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: `uint32x${comps}` }] }];
	const pipe = ({ vs, fs, layout = layA, buffers = [], stencil = "none", mask = 0xF, blend = PREMUL, target = format, samples = 4 }) => device.createRenderPipeline({
		layout, vertex: { module, entryPoint: vs, buffers },
		fragment: { module, entryPoint: fs, targets: [{ format: target, blend: mask ? blend : undefined, writeMask: mask }] },
		primitive: { topology: "triangle-list", cullMode: "none" },
		depthStencil: stencil ? STENCIL[stencil] : undefined,
		multisample: { count: samples },
	});
	const P = {
		line: pipe({ vs: "vsLine", fs: "fsLine", layout: layV, buffers: vb(3) }),
		fillSt: pipe({ vs: "vsFill", fs: "fsNone", layout: layV, buffers: vb(4), stencil: "invert", mask: 0 }),
		zero: pipe({ vs: "vsFull", fs: "fsNone", stencil: "zero", mask: 0 }),
		cover: pipe({ vs: "vsFull", fs: "fsCover", stencil: "equal1" }),
		sea: pipe({ vs: "vsFull", fs: "fsSea" }),
		veil: pipe({ vs: "vsFull", fs: "fsVeil" }),
		comp: pipe({ vs: "vsFull", fs: "fsComposite" }),
		compSt: pipe({ vs: "vsFull", fs: "fsComposite", stencil: "equal1" }),
		choro: pipe({ vs: "vsFull", fs: "fsChoro" }),
		point: pipe({ vs: "vsPoint", fs: "fsPoint", buffers: vb(3) }),
		id: hasFloatId ? pipe({ vs: "vsFill", fs: "fsId", layout: layV, buffers: vb(4), stencil: null, blend: ADD, target: "r32float", samples: 1 }) : null,
	};
	const err = await device.popErrorScope();
	if (err) { console.warn("[equal] WebGPU pipeline setup failed -> WebGL2", err.message); device.destroy(); return null; }
	const ctx = canvas.getContext("webgpu");
	if (!ctx) { device.destroy(); return null; }
	ctx.configure({ device, format, alphaMode: "opaque" });
	let lost = false;
	device.lost.then(info => { lost = true; if (info.reason !== "destroyed") console.warn("[equal] WebGPU device lost", info.message); });

	const maxTex = device.limits.maxTextureDimension2D, MAX_TEX = Math.min(4096, maxTex);
	const TEX = GPUTextureUsage;
	const texture = (w, h, fmt, usage = TEX.TEXTURE_BINDING | TEX.COPY_DST) => device.createTexture({ size: [w, h], format: fmt, usage });
	const dummy = texture(1, 1, "rgba8unorm");
	const sElev = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat", addressModeV: "clamp-to-edge" });
	const sClim = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" });
	const sNear = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	const ubuf = device.createBuffer({ size: CAP * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const staging = new Float32Array(CAP * SLOT_F);
	const cur = new Float32Array(U_FLOATS), curU = new Uint32Array(cur.buffer), curI = new Int32Array(cur.buffer);
	let slot = 0;

	// 絵の材料（標高・気候・塗り表・国 ID）＝差し替えたらグループ 0 を作り直す
	let elevTex = null, climTex = null, paintTex = null, paintW = 1, nearTex = null, nearB = null;
	let idTex = null, msaa = null, stencil = null, tW = 0, tH = 0;
	let bgMain = null, bgNoId = null;
	const dirty = () => { bgMain = bgNoId = null; };
	const group0 = (id) => device.createBindGroup({ layout: bgl0, entries: [
		{ binding: 0, resource: { buffer: ubuf, size: U_BYTES } },
		{ binding: 1, resource: (id || dummy).createView() },
		{ binding: 2, resource: (elevTex || dummy).createView() },
		{ binding: 3, resource: (climTex || dummy).createView() },
		{ binding: 4, resource: (nearTex || dummy).createView() },
		{ binding: 5, resource: (paintTex || dummy).createView() },
		{ binding: 6, resource: sElev }, { binding: 7, resource: sClim }, { binding: 8, resource: sNear },
	] });
	const mainBG = () => bgMain ||= group0(idTex);
	const noIdBG = () => bgNoId ||= group0(null);   // ID パス＝idTex を描き先にするので読み側に置かない

	function ensureTargets(W, H) {
		if (tW === W && tH === H) return;
		msaa?.destroy(); stencil?.destroy(); idTex?.destroy();
		msaa = device.createTexture({ size: [W, H], format, sampleCount: 4, usage: TEX.RENDER_ATTACHMENT });
		stencil = device.createTexture({ size: [W, H], format: "stencil8", sampleCount: 4, usage: TEX.RENDER_ATTACHMENT });
		idTex = hasFloatId ? device.createTexture({ size: [W, H], format: "r32float", usage: TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | TEX.COPY_SRC }) : null;
		tW = W; tH = H; dirty();
	}

	// ── 命令の記録と submit ──
	let enc = null, pass = null, passPipe = null, flushQueued = false, cleared = false, canvasView = null, clearValue = null, frame = null, idsThisFrame = false;
	const graveyard = [];   // freeVAO の buffer＝記録済み命令が使うかもしれない＝submit の後で捨てる
	function ensureEnc() {
		if (!enc) enc = device.createCommandEncoder();
		if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
		return enc;
	}
	function endPass() { if (pass) { pass.end(); pass = null; passPipe = null; } }
	function mainPass() {
		if (pass) return pass;
		const load = cleared ? "load" : "clear";
		pass = ensureEnc().beginRenderPass({
			colorAttachments: [{ view: msaa.createView(), resolveTarget: canvasView, loadOp: load, clearValue, storeOp: "store" }],
			depthStencilAttachment: { view: stencil.createView(), stencilLoadOp: load, stencilClearValue: 0, stencilStoreOp: "store" },
		});
		cleared = true;
		return pass;
	}
	function flush() {
		flushQueued = false;
		if (!enc || lost) { enc = null; pass = null; return; }
		if (frame && !cleared) mainPass();   // 何も描かないフレームも背景色で消す（GL の clear と同じ）
		endPass();
		if (slot) device.queue.writeBuffer(ubuf, 0, staging, 0, slot * SLOT_F);
		device.queue.submit([enc.finish()]);
		enc = null; slot = 0;
		for (const b of graveyard.splice(0)) b.destroy();
	}
	// 今の cur を 1 スロットへ＝動的オフセット（満杯なら途中で submit＝続きは load で開き直す）
	function pushU() {
		if (slot >= CAP) flush();
		staging.set(cur, slot * SLOT_F);
		return (slot++) * SLOT;
	}
	function use(p, pl, off, vtx) {
		if (passPipe !== pl) { p.setPipeline(pl); passPipe = pl; }
		p.setBindGroup(0, p === pass ? mainBG() : noIdBG(), [off]);
		if (vtx) p.setBindGroup(1, vtx.bg);
	}

	// 頂点テクスチャ（RG32UI・幅 4096 折り返し）
	function uploadVertices(xy, count) {
		const w = Math.max(1, Math.min(MAX_TEX, count)), h = Math.max(1, Math.ceil(count / w));
		const data = new Uint32Array(w * h * 2); data.set(xy.subarray(0, count * 2));
		const tex = texture(w, h, "rg32uint");
		device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * 8 }, [w, h]);
		return { tex, w, bg: device.createBindGroup({ layout: bgl1, entries: [{ binding: 0, resource: tex.createView() }] }) };
	}
	function instanceVAO(u32, comps) {
		const buf = device.createBuffer({ size: Math.max(4, u32.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		if (u32.byteLength) device.queue.writeBuffer(buf, 0, u32);
		return { buf, count: u32.length / comps };
	}
	function freeVAO(v) { if (v) { if (enc) graveyard.push(v.buf); else v.buf.destroy(); } }

	function setNearElevation(atlas) {
		if (!atlas) { nearB = null; return; }
		if (!nearTex || nearTex.width !== atlas.width || nearTex.height !== atlas.height) { nearTex?.destroy(); nearTex = texture(atlas.width, atlas.height, "r16float"); dirty(); }
		device.queue.writeTexture({ texture: nearTex }, f32ToF16(atlas.data), { bytesPerRow: atlas.width * 2 }, [atlas.width, atlas.height]);
		nearB = atlas.bounds;
	}
	function setElevation(f32, w, h) {
		if (!elevTex || elevTex.width !== w || elevTex.height !== h) { elevTex?.destroy(); elevTex = texture(w, h, "r16float"); dirty(); }
		device.queue.writeTexture({ texture: elevTex }, f32ToF16(f32), { bytesPerRow: w * 2 }, [w, h]);
	}
	function setClimate(img) {
		const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
		climTex?.destroy();
		climTex = texture(w, h, "rgba8unorm", TEX.TEXTURE_BINDING | TEX.COPY_DST | TEX.RENDER_ATTACHMENT);
		device.queue.copyExternalImageToTexture({ source: img }, { texture: climTex }, [w, h]);
		dirty();
	}
	function setPaint(rgba8, count) {
		const w = Math.max(1, Math.min(1024, count)), h = Math.max(1, Math.ceil(count / w));
		const data = new Uint8Array(w * h * 4); data.set(rgba8.subarray(0, Math.min(rgba8.length, w * h * 4)));
		if (!paintTex || paintTex.width !== w || paintTex.height !== h) { paintTex?.destroy(); paintTex = texture(w, h, "rgba8unorm"); dirty(); }
		device.queue.writeTexture({ texture: paintTex }, data, { bytesPerRow: w * 4 }, [w, h]);
		paintW = w;
	}

	function beginFrame(view, clearRGB, morph = null) {
		if (enc) flush();
		idsThisFrame = false;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const W = Math.max(1, Math.round(canvas.clientWidth * dpr)), H = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
		ensureTargets(W, H);
		frame = {
			lon0: view.lon, ix0: Math.round((((view.lon + 180) % 360 + 360) % 360) * 1e7) >>> 0,
			yc: yOfLat(view.lat), ppu: pxPerUnit(view.zoom) * dpr, vp: [W, H], zoom: view.zoom, dpr,
			morph: morph ? Math.max(0, Math.min(1, morph.t)) : 1, ppuS: morph ? morph.ppuS * dpr : 0, sphLat: morph ? morph.lat : 0, camS: morph ? morph.cam : 1, sphDlon: morph ? morph.dlon || 0 : 0,
		};
		cur.fill(0);
		cur[O.vp] = W; cur[O.vp + 1] = H; curU[O.ix0] = frame.ix0;
		cur[O.yc] = frame.yc; cur[O.ppu] = frame.ppu; cur[O.zoom] = frame.zoom; cur[O.dpr] = dpr;
		cur[O.morph] = frame.morph; cur[O.ppuS] = frame.ppuS; cur[O.sphLat] = frame.sphLat; cur[O.camS] = frame.camS; cur[O.sphDlon] = frame.sphDlon;
		cur[O.lon0] = frame.lon0;
		clearValue = { r: clearRGB[0], g: clearRGB[1], b: clearRGB[2], a: 1 };
		cleared = false;
		if (lost) return;
		canvasView = ctx.getCurrentTexture().createView();
		ensureEnc();
	}
	const set4 = (o, v) => { cur[o] = v[0]; cur[o + 1] = v[1]; cur[o + 2] = v[2]; cur[o + 3] = v[3] ?? 0; };
	function setStyles(styles) {
		cur.fill(0, O.color, U_FLOATS);
		styles.forEach((s, i) => { if (!s) return; set4(O.color + i * 4, s.color); cur[O.param + i * 4] = s.width ?? s.size ?? 0; });
	}
	const ok = () => frame && !lost;

	function drawLines(vtx, vao, styles) {
		if (!vao?.count || !ok()) return;
		curI[O.vw] = vtx.w; setStyles(styles);
		const off = pushU(), p = mainPass();
		use(p, P.line, off, vtx); p.setVertexBuffer(0, vao.buf); p.draw(12, vao.count);
	}
	function stencilFan(vtx, vao) {   // 層ごとに偶奇をやり直す（全画面の 0 書き）→ 扇で反転
		curI[O.vw] = vtx.w;
		const off = pushU(), p = mainPass();
		use(p, P.zero, off); p.draw(3);
		use(p, P.fillSt, off, vtx); p.setVertexBuffer(0, vao.buf); p.draw(18, vao.count);
	}
	function drawVeil(color) {
		if (!(color[3] > 0.001) || !ok()) return;
		set4(O.col, color);
		const off = pushU(), p = mainPass();
		use(p, P.veil, off); p.draw(3);
	}
	function drawSea(sea, bg, edge) {
		if (!ok()) return;
		set4(O.sea, sea); set4(O.bg, bg); set4(O.edge, edge);
		const off = pushU(), p = mainPass();
		use(p, P.sea, off); p.draw(3);
	}
	function drawFill(vtx, vao, color) {
		if (!vao?.count || !ok()) return;
		stencilFan(vtx, vao);
		set4(O.col, color);
		const off = pushU(), p = mainPass();
		use(p, P.cover, off); p.setStencilReference(1); p.draw(3);
	}
	function drawIds(vtx, vao) {
		if (!vao?.count || !ok()) return false;
		if (hasFloatId) {
			curI[O.vw] = vtx.w;
			const off = pushU();
			endPass();
			const ip = ensureEnc().beginRenderPass({ colorAttachments: [{ view: idTex.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
			ip.setPipeline(P.id); ip.setBindGroup(0, noIdBG(), [off]); ip.setBindGroup(1, vtx.bg);
			ip.setVertexBuffer(0, vao.buf); ip.draw(18, vao.count);
			ip.end();
		} else stencilFan(vtx, vao);   // ステンシルは次の drawLand が消費する（直後に呼ぶこと）
		return idsThisFrame = true;
	}
	function drawLand(o) {
		if (!idsThisFrame || !ok()) return;
		cur[O.hasId] = hasFloatId ? 1 : 0;
		set4(O.land, o.land);
		cur[O.hypsoA] = o.hypso || 0; cur[O.hasElev] = elevTex ? 1 : 0; cur[O.hasClim] = climTex ? 1 : 0;
		PAL_KEYS.forEach((k, i) => set4(O.pal + i * 4, o.pal[k]));
		cur[O.hasNear] = nearB && elevTex && nearTex ? 1 : 0;
		if (nearB) set4(O.nearB, nearB);
		const off = pushU(), p = mainPass();
		use(p, hasFloatId ? P.comp : P.compSt, off);
		if (!hasFloatId) p.setStencilReference(1);
		p.draw(3);
	}
	const HOVER_DEFAULT = [0.10, 0.14, 0.20, 0.14];
	function drawChoropleth(o = {}) {
		if (!hasFloatId || !idTex || !idsThisFrame || !ok()) return;
		const alpha = paintTex ? (o.alpha || 0) : 0, hover = o.hover ?? -1;
		if (alpha <= 0.001 && hover < 0) return;
		cur[O.choroA] = alpha; curI[O.paintW] = paintW; cur[O.hover] = hover;
		set4(O.hoverC, o.hoverColor || HOVER_DEFAULT);
		const off = pushU(), p = mainPass();
		use(p, P.choro, off); p.draw(3);
	}
	function drawPoints(vao, styles) {
		if (!vao?.count || !ok()) return;
		setStyles(styles);
		const off = pushU(), p = mainPass();
		use(p, P.point, off); p.setVertexBuffer(0, vao.buf); p.draw(6, vao.count);
	}
	// 画面 CSS px（左上原点）の国 → Promise<fid | -1>。記録中の命令を先に submit＝このフレームの ID を読む
	const readBufs = [];
	async function readFid(cssX, cssY) {
		if (!hasFloatId || !idTex || !frame || lost) return -1;
		const x = Math.floor(cssX * frame.dpr), y = Math.floor(cssY * frame.dpr);
		if (x < 0 || y < 0 || x >= tW || y >= tH) return -1;
		if (enc) flush();
		const rb = readBufs.pop() || device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const e = device.createCommandEncoder();
		e.copyTextureToBuffer({ texture: idTex, origin: { x, y } }, { buffer: rb, bytesPerRow: 256 }, [1, 1]);
		device.queue.submit([e.finish()]);
		try {
			await rb.mapAsync(GPUMapMode.READ);
			const v = new Float32Array(rb.getMappedRange())[0];
			rb.unmap(); readBufs.push(rb);
			const id = Math.round(Math.abs(v));
			return id > 0 ? id - 1 : -1;
		} catch { rb.destroy(); return -1; }
	}
	function destroy() { lost = true; enc = null; pass = null; try { ctx.unconfigure(); } catch { /* 既に無い */ } device.destroy(); }

	return { backend: "webgpu", maxTex, hasFloatId, uploadVertices, instanceVAO, freeVAO, beginFrame, drawSea, drawLines, drawFill, drawVeil, drawIds, drawLand, drawChoropleth, drawPoints, readFid, setElevation, setNearElevation, setClimate, setPaint, flush, destroy };
}
