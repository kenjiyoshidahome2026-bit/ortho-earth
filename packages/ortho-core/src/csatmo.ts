// Cesium の大気（view.csAtmo・2026-10-25）＝CesiumJS（1.146）の地面の大気と空の大気を、その式のまま写した物。@ortho-earth/cesium が Cesium の頁を
// Cesium と同じ見た目で描くための口（既定は off＝従来の霞とリム光）。写した式：AtmosphereCommon.glsl computeScattering／computeAtmosphereColor、
// GroundAtmosphere.glsl、SkyAtmosphereCommon.glsl、GlobeFS.glsl（地面の大気の枝・HDR なし）、SkyAtmosphereFS.glsl（HDR なし）。
// Cesium の既定の場合だけ：動的な光源なし（光は各点の真上から＝DynamicAtmosphereLightingType.NONE・enableLighting false）、HDR なし、色相の補正なし。
// 単位はメートル（ortho の β 単位球×赤道半径）。散乱は球殻の近似（Cesium も球殻）。
// 地面の大気は遠くから見た時だけ（Cesium の lightingFadeOut/InDistance＝中心から π/2·R → π·R で 0 → 1）。空の大気は殻（半径×1.025）の奥の面の点で計る。

/** 地面の大気の効き（0..1）：目の地球中心からの距離（m）で（Globe.lightingFadeOutDistance／lightingFadeInDistance の既定） */
export function csGroundFade(eyeDistM: number): number {
	const R = 6356752.314245179, out = Math.PI / 2 * R, inn = Math.PI * R;
	return Math.max(0, Math.min(1, (eyeDistM - out) / (inn - out)));
}

const C = { R: "6378137.0", RPOLAR: "6356752.3142451793", THICK: "111000.0" };   // GLSL と WGSL で同じ定数

/** GLSL（GL2）：csGround(色, 目, 点, 効き)・csSky(目, 視線の単位ベクトル)→前乗算 rgba */
export const CS_ATMO_GLSL = /* glsl */`
const float CS_R = ${C.R};
const float CS_RP = ${C.RPOLAR};
const float CS_THICK = ${C.THICK};
const vec3 CS_BR = vec3(5.5e-6, 13.0e-6, 28.4e-6);
const vec3 CS_BM = vec3(21e-6);
const vec2 CS_H = vec2(10000.0, 3200.0);
const float CS_G = 0.9;
float csTanh(float x) { float x2 = x * x; return max(-1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2))); }
// 半直線と球（中心 0）の区間（czm_raySphereIntersectionInterval）。交わらない＝false
bool csSphere(vec3 o, vec3 d, float r, out vec2 seg) {
	float a = dot(d, d), b = 2.0 * dot(d, o), c = dot(o, o) - r * r, det = b * b - 4.0 * a * c;
	if (det < 0.0) { seg = vec2(0.0); return false; }
	float s = sqrt(det);
	seg = vec2(-b - s, -b + s) / (2.0 * a);
	return true;
}
// computeScattering（AtmosphereCommon.glsl）
void csScatter(vec3 ro, vec3 rd, float rayLen, vec3 L, float inner, out vec3 ray, out vec3 mie, out float opac) {
	ray = vec3(0.0); mie = vec3(0.0); opac = 0.0;
	float outer = inner + CS_THICK;
	vec2 seg;
	if (!csSphere(ro, rd, outer, seg)) return;
	float x = 1e-7 * seg.y / abs(rayLen);
	float wStop = 0.5 * (1.0 + csTanh(x));
	float start0 = seg.x;
	seg.x = max(seg.x, 0.0);
	seg.y = min(seg.y, abs(rayLen));
	float wIn = 1.0 - 0.5 * (1.0 + csTanh(start0 - CS_THICK));
	int PS = 16 - int(wIn * 12.0), LS = 4 - int(wIn * 2.0);
	float pos = seg.x, total = seg.y - pos;
	float inc = wIn * ((1.0 - wStop) * total / (float(PS * (PS + 1)) / 2.0));
	float stepL = max(1.0 - wIn, wStop) * total / max(7.0 * wIn, float(PS));
	vec3 accR = vec3(0.0), accM = vec3(0.0);
	vec2 od = vec2(0.0);
	for (int i = 0; i < 16; i++) {
		if (i >= PS) break;
		vec3 sp = ro + rd * (pos + stepL);
		vec2 dens = exp(-(length(sp) - inner) / CS_H) * stepL;
		od += dens;
		vec2 ls;
		csSphere(sp, L, outer, ls);
		float lstep = ls.y / float(LS), lpos = 0.0;
		vec2 lod = vec2(0.0);
		for (int j = 0; j < 4; j++) {
			if (j >= LS) break;
			lod += exp(-(length(sp + L * (lpos + lstep * 0.5)) - inner) / CS_H) * lstep;
			lpos += lstep;
		}
		vec3 att = exp(-(CS_BM * (od.y + lod.y) + CS_BR * (od.x + lod.x)));
		accR += dens.x * att; accM += dens.y * att;
		stepL += inc; pos += stepL;
	}
	ray = CS_BR * accR; mie = CS_BM * accM;
	opac = length(exp(-(CS_BM * od.y + CS_BR * od.x)));
}
// computeAtmosphereColor
vec4 csColor(vec3 eye, vec3 p, vec3 L, vec3 ray, vec3 mie, float opac, float intensity) {
	float c = dot(normalize(p - eye), L), c2 = c * c, g2 = CS_G * CS_G;
	float phR = 3.0 / 50.2654824574 * (1.0 + c2);
	float phM = 3.0 / 25.1327412287 * ((1.0 - g2) * (c2 + 1.0)) / (pow(1.0 + g2 - 2.0 * c * CS_G, 1.5) * (2.0 + g2));
	return vec4((phR * ray + phM * mie) * intensity, opac);
}
// 地面の大気（GlobeFS・HDR なし）：col は表示の色（Cesium も画像の色に直に足す）
vec3 csGround(vec3 col, vec3 eye, vec3 p, float fade) {
	if (fade <= 0.0) return col;
	vec3 L = normalize(p), ray, mie;
	float op;
	csScatter(eye, normalize(p - eye), length(p - eye), L, length(p), ray, mie, op);
	vec4 a = csColor(eye, p, L, ray, mie, op, 10.0);
	vec3 f = col + a.rgb * (0.5 + clamp(1.0 - a.a, 0.0, 1.0));
	return mix(col, vec3(1.0) - exp(-2.0 * f), fade);
}
vec3 csTone(vec3 c) {   // czm_pbrNeutralTonemapping
	float x = min(c.r, min(c.g, c.b));
	c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
	float peak = max(c.r, max(c.g, c.b));
	if (peak < 0.76) return c;
	float d = 0.24, np = 1.0 - d * d / (peak + d - 0.76);
	c *= np / peak;
	return mix(c, vec3(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
}
// 空の大気（SkyAtmosphereCommon＋SkyAtmosphereFS・HDR なし）：殻（半径×1.025）の奥の面の点の色。前乗算の rgba
vec4 csSky(vec3 eye, vec3 dir) {
	vec2 s;
	if (!csSphere(eye, dir, CS_R * 1.025, s) || s.y <= 0.0) return vec4(0.0);
	vec3 p = eye + dir * s.y;
	float eyeH = length(eye) - CS_R, rdiff = CS_R - CS_RP;
	float rAdj = rdiff / 4.0 + rdiff / 2.0 * clamp((eyeH - CS_R / 4.0) / (CS_R - CS_R / 4.0), 0.0, 1.0);
	float inner = CS_R - rAdj;
	vec3 L = normalize(p), ray, mie;
	float op;
	csScatter(eye, dir, length(p - eye), L, inner, ray, mie, op);
	float outer = inner + CS_THICK;
	op = clamp((outer - (eyeH + inner)) / (outer - inner), 0.0, 1.0);
	vec4 c = csColor(eye, p, L, ray, mie, op, 50.0);
	c.rgb = pow(max(csTone(c.rgb), vec3(0.0)), vec3(1.0 / 2.2));
	float a = clamp(mix(c.b, 1.0, c.a), 0.0, 1.0);
	return vec4(c.rgb * a, a);
}
`;

/** WGSL（WebGPU）：同じ関数（名前も同じ） */
export const CS_ATMO_WGSL = /* wgsl */`
const CS_R: f32 = ${C.R};
const CS_RP: f32 = ${C.RPOLAR};
const CS_THICK: f32 = ${C.THICK};
const CS_BR: vec3f = vec3f(5.5e-6, 13.0e-6, 28.4e-6);
const CS_BM: vec3f = vec3f(21e-6);
const CS_H: vec2f = vec2f(10000.0, 3200.0);
const CS_G: f32 = 0.9;
fn csTanh(x: f32) -> f32 { let x2 = x * x; return max(-1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2))); }
// 半直線と球（中心 0）の区間。交わらない＝z が 0
fn csSphere(o: vec3f, d: vec3f, r: f32) -> vec3f {
	let a = dot(d, d); let b = 2.0 * dot(d, o); let c = dot(o, o) - r * r; let det = b * b - 4.0 * a * c;
	if (det < 0.0) { return vec3f(0.0); }
	let s = sqrt(det);
	return vec3f((-b - s) / (2.0 * a), (-b + s) / (2.0 * a), 1.0);
}
struct CsScat { ray: vec3f, mie: vec3f, opac: f32 };
fn csScatter(ro: vec3f, rd: vec3f, rayLen: f32, L: vec3f, inner: f32) -> CsScat {
	var r: CsScat; r.ray = vec3f(0.0); r.mie = vec3f(0.0); r.opac = 0.0;
	let outer = inner + CS_THICK;
	var seg = csSphere(ro, rd, outer);
	if (seg.z < 0.5) { return r; }
	let wStop = 0.5 * (1.0 + csTanh(1e-7 * seg.y / abs(rayLen)));
	let start0 = seg.x;
	seg.x = max(seg.x, 0.0);
	seg.y = min(seg.y, abs(rayLen));
	let wIn = 1.0 - 0.5 * (1.0 + csTanh(start0 - CS_THICK));
	let PS = 16 - i32(wIn * 12.0); let LS = 4 - i32(wIn * 2.0);
	var pos = seg.x; let total = seg.y - pos;
	let inc = wIn * ((1.0 - wStop) * total / (f32(PS * (PS + 1)) / 2.0));
	var stepL = max(1.0 - wIn, wStop) * total / max(7.0 * wIn, f32(PS));
	var accR = vec3f(0.0); var accM = vec3f(0.0); var od = vec2f(0.0);
	for (var i = 0; i < 16; i++) {
		if (i >= PS) { break; }
		let sp = ro + rd * (pos + stepL);
		let dens = exp(-(length(sp) - inner) / CS_H) * stepL;
		od += dens;
		let ls = csSphere(sp, L, outer);
		let lstep = ls.y / f32(LS); var lpos = 0.0; var lod = vec2f(0.0);
		for (var j = 0; j < 4; j++) {
			if (j >= LS) { break; }
			lod += exp(-(length(sp + L * (lpos + lstep * 0.5)) - inner) / CS_H) * lstep;
			lpos += lstep;
		}
		let att = exp(-(CS_BM * (od.y + lod.y) + CS_BR * (od.x + lod.x)));
		accR += dens.x * att; accM += dens.y * att;
		stepL += inc; pos += stepL;
	}
	r.ray = CS_BR * accR; r.mie = CS_BM * accM;
	r.opac = length(exp(-(CS_BM * od.y + CS_BR * od.x)));
	return r;
}
fn csColor(eye: vec3f, p: vec3f, L: vec3f, s: CsScat, intensity: f32) -> vec4f {
	let c = dot(normalize(p - eye), L); let c2 = c * c; let g2 = CS_G * CS_G;
	let phR = 3.0 / 50.2654824574 * (1.0 + c2);
	let phM = 3.0 / 25.1327412287 * ((1.0 - g2) * (c2 + 1.0)) / (pow(1.0 + g2 - 2.0 * c * CS_G, 1.5) * (2.0 + g2));
	return vec4f((phR * s.ray + phM * s.mie) * intensity, s.opac);
}
fn csGround(col: vec3f, eye: vec3f, p: vec3f, fade: f32) -> vec3f {
	if (fade <= 0.0) { return col; }
	let L = normalize(p);
	let a = csColor(eye, p, L, csScatter(eye, normalize(p - eye), length(p - eye), L, length(p)), 10.0);
	let f = col + a.rgb * (0.5 + clamp(1.0 - a.a, 0.0, 1.0));
	return mix(col, vec3f(1.0) - exp(-2.0 * f), fade);
}
fn csTone(c0: vec3f) -> vec3f {
	var c = c0;
	let x = min(c.r, min(c.g, c.b));
	c -= select(0.04, x - 6.25 * x * x, x < 0.08);
	let peak = max(c.r, max(c.g, c.b));
	if (peak < 0.76) { return c; }
	let d = 0.24; let np = 1.0 - d * d / (peak + d - 0.76);
	c *= np / peak;
	return mix(c, vec3f(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
}
fn csSky(eye: vec3f, dir: vec3f) -> vec4f {
	let s = csSphere(eye, dir, CS_R * 1.025);
	if (s.z < 0.5 || s.y <= 0.0) { return vec4f(0.0); }
	let p = eye + dir * s.y;
	let eyeH = length(eye) - CS_R; let rdiff = CS_R - CS_RP;
	let inner = CS_R - (rdiff / 4.0 + rdiff / 2.0 * clamp((eyeH - CS_R / 4.0) / (CS_R - CS_R / 4.0), 0.0, 1.0));
	let L = normalize(p);
	var sc = csScatter(eye, dir, length(p - eye), L, inner);
	let outer = inner + CS_THICK;
	sc.opac = clamp((outer - (eyeH + inner)) / (outer - inner), 0.0, 1.0);
	let c = csColor(eye, p, L, sc, 50.0);
	let rgb = pow(max(csTone(c.rgb), vec3f(0.0)), vec3f(1.0 / 2.2));
	let a = clamp(mix(rgb.b, 1.0, c.a), 0.0, 1.0);
	return vec4f(rgb * a, a);
}
`;
