// 正射（orthographic）球面投影を頂点シェーダで行う。座標はシーン原点からの経緯度差分(float32)。
// 精度は M1.1 目視には十分（極端なズームで数px揺れる可能性。厳密化は gint 同様の整数Morton+shader差分で M2）。

export const PROJECT = /* glsl */`
uniform vec2  u_origin;     // シーン原点 lon/lat (deg)
uniform vec2  u_center;     // カメラ中心 lon/lat (deg)
uniform float u_scale;      // 球半径 (device px)
uniform vec2  u_translate;  // 画面中心 (device px)
uniform vec2  u_viewport;   // canvas 幅高 (device px)
const float D2R = 0.017453292519943295;

// 経緯度差分 → 画面座標(device px)と前面判定(cosc)
vec3 projectDelta(vec2 d) {
	float lon = (u_origin.x + d.x) * D2R, lat = (u_origin.y + d.y) * D2R;
	float lon0 = u_center.x * D2R, lat0 = u_center.y * D2R;
	float dl = lon - lon0;
	float clat = cos(lat), slat = sin(lat), clat0 = cos(lat0), slat0 = sin(lat0), cdl = cos(dl);
	float cosc = slat0 * slat + clat0 * clat * cdl;      // >=0 で前面
	float x = clat * sin(dl);
	float y = clat0 * slat - slat0 * clat * cdl;
	return vec3(u_translate + u_scale * vec2(x, -y), cosc);
}
vec4 toNDC(vec2 screen) {
	return vec4(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

export const FILL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
in vec4 a_color;
${PROJECT}
out vec4 v_color;
out float v_front;
void main() {
	vec3 p = projectDelta(a_delta);
	v_color = a_color;
	v_front = p.z;
	gl_Position = toNDC(p.xy);
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_front;
out vec4 fragColor;
void main() {
	if (v_front < 0.0) discard;                 // 裏半球は描かない
	fragColor = vec4(v_color.rgb * v_color.a, v_color.a);  // premultiplied
}`;

// capsule 方式：各線分を「垂直押し出し＋両端を半幅ぶん延長」した矩形として出し、
// フラグメントで中心線分からの距離により丸くマスクする。幅は完全一定、丸接合で隙間/スパイク無し、AA付き。
// p0/p3 は使わない（capsule は隣接点不要）。renderer 側の a_p0/a_p3 バインドは location=-1 で無効化される。
export const LINE_VS = `#version 300 es
precision highp float;
in vec2 a_p1;       // 始点 A
in vec2 a_p2;       // 終点 B
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
	vec3 qa = projectDelta(a_p1), qb = projectDelta(a_p2);
	vec2 sa = qa.xy, sb = qb.xy;
	vec2 d = sb - sa; float len = length(d);
	vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
	vec2 perp = vec2(-dir.y, dir.x);
	float hw = a_half * u_dpr + 1.0;            // +1px の AA/丸端の余白
	vec2 base = a_corner.x < 0.5 ? sa : sb;
	float capSign = a_corner.x < 0.5 ? -1.0 : 1.0;
	vec2 pos = base + perp * (hw * a_corner.y) + dir * (capSign * hw);
	v_a = sa; v_b = sb; v_half = a_half * u_dpr;
	v_pos = pos; v_color = a_color; v_front = min(qa.z, qb.z);
	gl_Position = toNDC(pos);
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
	if (v_front < 0.0) discard;                 // 裏半球
	vec2 pa = v_pos - v_a, ba = v_b - v_a;
	float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	float dist = length(pa - ba * t);           // 中心線分からの距離
	float alpha = clamp(v_half - dist + 0.5, 0.0, 1.0);  // 1px AA
	if (alpha <= 0.0) discard;
	float a = v_color.a * alpha;
	fragColor = vec4(v_color.rgb * a, a);       // premultiplied
}`;
