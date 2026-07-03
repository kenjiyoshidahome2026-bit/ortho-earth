// 透視カメラ（チルト対応）。経緯度→単位球3D→u_mvp でクリップ座標へ。
// 頂点はシーン原点(u_origin)からの経緯度差分。fill は clip 直行、line/capsule はスクリーン空間で幅付け。

export const PROJECT = /* glsl */`
uniform mat4  u_mvp;
uniform vec3  u_eye;        // カメラ位置（単位球ワールド）
uniform vec2  u_origin;     // シーン原点 lon/lat (deg)
uniform vec2  u_viewport;   // canvas 幅高 (device px)
const float D2R = 0.017453292519943295;

vec3 lonlatTo3D(vec2 ll) {
	float a = ll.x * D2R, b = ll.y * D2R, cb = cos(b);
	return vec3(cb * cos(a), sin(b), cb * sin(a));
}
// clip.xy/clip.w → device px（左上原点, y下向き）
vec2 toScreen(vec4 c) {
	vec2 ndc = c.xy / c.w;
	return vec2((ndc.x * 0.5 + 0.5) * u_viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y);
}
`;

// 球体本体：フルスクリーン三角形の各画素でカメラ光線×単位球。当たれば land色、外れれば宇宙(discard)。
export const GLOBE_VS = `#version 300 es
precision highp float;
out vec2 v_ndc;
void main() {
	vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
	v_ndc = p;
	gl_Position = vec4(p, 0.0, 1.0);
}`;

export const GLOBE_FS = `#version 300 es
precision highp float;
uniform mat4 u_invMvp;
uniform vec4 u_land;
uniform vec4 u_atmo;   // 大気色 rgb + 強さ(a)
in vec2 v_ndc;
out vec4 fragColor;
void main() {
	vec4 np = u_invMvp * vec4(v_ndc, -1.0, 1.0);
	vec4 fp = u_invMvp * vec4(v_ndc, 1.0, 1.0);
	vec3 A = np.xyz / np.w, B = fp.xyz / fp.w, d = B - A;
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = dot(A, A) - 1.0;
	float disc = bb * bb - 4.0 * aa * cc;
	float aDotd = bb * 0.5, tstar = -aDotd / aa;
	if (disc < 0.0) {                              // 球ミス：大気ハロー（縁の外へフェード）
		if (tstar <= 0.0) discard;
		float m = sqrt(max((cc + 1.0) - aDotd * aDotd / aa, 0.0));   // 光線の球中心最接近距離
		float glow = smoothstep(1.09, 1.0, m);
		if (glow <= 0.0) discard;
		float a = glow * glow * u_atmo.a;
		fragColor = vec4(u_atmo.rgb * a, a);       // premultiplied
		return;
	}
	float t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) discard;
	vec3 P = A + t * d;                            // 面上の点（単位球＝法線）
	vec3 viewDir = normalize(A - P);              // 面→カメラ
	float ndv = clamp(dot(P, viewDir), 0.0, 1.0);
	float haze = pow(1.0 - ndv, 3.0);             // 縁ほど強い内側リムの霞
	vec3 col = mix(u_land.rgb, u_atmo.rgb, haze * u_atmo.a * 0.9);
	fragColor = vec4(col, 1.0);
}`;

export const FILL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
in vec4 a_color;
${PROJECT}
out vec4 v_color;
out float v_front;
void main() {
	vec3 w = lonlatTo3D(u_origin + a_delta);
	v_color = a_color;
	v_front = dot(w, u_eye) - 1.0;          // >0 で手前半球
	gl_Position = u_mvp * vec4(w, 1.0);
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_front;
out vec4 fragColor;
void main() {
	if (v_front < 0.0) discard;             // 裏半球は描かない
	fragColor = vec4(v_color.rgb * v_color.a, v_color.a);  // premultiplied
}`;

// capsule 方式：両端をスクリーン空間へ投影して定px幅・丸端で描く。透視でも幅が一定。
export const LINE_VS = `#version 300 es
precision highp float;
in vec2 a_p1;
in vec2 a_p2;
in vec2 a_corner;   // (end 0/1, side -1/+1)
in float a_half;    // CSS px
in vec4 a_color;
uniform float u_dpr;
${PROJECT}
flat out vec2 v_a;
flat out vec2 v_b;
flat out float v_half;
out vec2 v_pos;
out vec4 v_color;
out float v_front;
void main() {
	vec3 wa = lonlatTo3D(u_origin + a_p1), wb = lonlatTo3D(u_origin + a_p2);
	vec4 ca = u_mvp * vec4(wa, 1.0), cb = u_mvp * vec4(wb, 1.0);
	float fa = dot(wa, u_eye) - 1.0, fb = dot(wb, u_eye) - 1.0;
	if (ca.w <= 0.0 || cb.w <= 0.0) { v_front = -1.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }  // カメラ背後
	vec2 sa = toScreen(ca), sb = toScreen(cb);
	vec2 d = sb - sa; float len = length(d);
	vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
	vec2 perp = vec2(-dir.y, dir.x);
	float hw = a_half * u_dpr + 1.0;        // +1px の AA/丸端余白
	vec2 base = a_corner.x < 0.5 ? sa : sb;
	float capSign = a_corner.x < 0.5 ? -1.0 : 1.0;
	vec2 pos = base + perp * (hw * a_corner.y) + dir * (capSign * hw);
	v_a = sa; v_b = sb; v_half = a_half * u_dpr; v_pos = pos;
	v_color = a_color; v_front = min(fa, fb);
	vec2 ndc = vec2(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0);
	gl_Position = vec4(ndc, 0.0, 1.0);
}`;

export const LINE_FS = `#version 300 es
precision highp float;
flat in vec2 v_a;
flat in vec2 v_b;
flat in float v_half;
in vec2 v_pos;
in vec4 v_color;
in float v_front;
out vec4 fragColor;
void main() {
	if (v_front < 0.0) discard;
	vec2 pa = v_pos - v_a, ba = v_b - v_a;
	float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	float dist = length(pa - ba * t);
	float alpha = clamp(v_half - dist + 0.5, 0.0, 1.0);
	if (alpha <= 0.0) discard;
	float a = v_color.a * alpha;
	fragColor = vec4(v_color.rgb * a, a);
}`;
