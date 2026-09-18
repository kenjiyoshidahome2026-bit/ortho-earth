// Equal Earth の WebGL2 描画。ortho-core（球専用）には触らない＝アプリ内の専用描画（本人裁定 2026-09-18）。
// 流儀は gint と同じ：頂点は整数 (ix,iy) のテクスチャ・経度は中心からの整数差 dlonE7（360e7 周期で最短）＝
// 中央経線を毎フレーム動かしても頂点データは不変。投影（Equal Earth）は頂点シェーダ。
//
// 画面の外形：縮小下限とスクロール範囲で「画面矩形 ⊂ 投影の外形」を保証（equalearth.js clampView）＝
// 外形の縁は画面に出ない。antimeridian（中心の裏経線）を跨ぐ辺だけは頂点シェーダで縫い目の左右に割る。
import { A1, A2, A3, A4, M, yOfLat, pxPerUnit } from "./equalearth.js";

const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D u_vtx; uniform int u_vw;
uniform uint u_ix0;        // 中央経線（=画面中心経度）の ix
uniform float u_yc;        // 画面中心の投影 y
uniform float u_ppu;       // device px / 単位
uniform vec2 u_vp;         // viewport（device px）
uniform float u_zoom, u_dpr;
const float A1=${A1}, A2=${A2}, A3=${A3}, A4=${A4}, M=${M};
const float D2R = 0.017453292519943295;
const vec4 OFF = vec4(0.0, 0.0, 2.0, 1.0);   // クリップ外＝捨てる頂点
// 経度差（1e-7°・符号付き最短）＝ortho-core と同じ uint のままの畳み込み
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b);
	float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { d = 3600000000u - d; s = -s; }
	return float(d) * s;
}
void fetchV(uint idx, out float dlon, out float lat) {
	uvec4 t = texelFetch(u_vtx, ivec2(int(idx) % u_vw, int(idx) / u_vw), 0);
	dlon = dlonE7(t.r, u_ix0) * 1e-7;
	lat = float(int(t.g) - 900000000) * 1e-7;
}
vec2 ee(float dlon, float lat) {
	float l = asin(M * sin(lat * D2R)), l2 = l * l, l6 = l2 * l2 * l2;
	return vec2(dlon * D2R * cos(l) / (M * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2))),
	            l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)));
}
vec2 px(vec2 u) { return vec2(u.x, u.y - u_yc) * u_ppu; }     // 中心原点・y 上向き・device px
vec4 clipOf(vec2 p) { return vec4(p / (u_vp * 0.5), 0.0, 1.0); }
// 辺 A→B が中心の裏経線（dλ=±180）を跨ぐか。跨ぐなら s=A 側の符号・latC=跨ぎ点の緯度（経緯度で線形内挿）
bool crosses(float dA, float latA, float dB, float latB, out float s, out float latC) {
	s = dA < 0.0 ? -1.0 : 1.0; latC = latA;
	if (abs(dA - dB) <= 180.0) return false;
	float den = dB + 360.0 * s - dA;
	float t = abs(den) < 1e-9 ? 0.5 : (180.0 * s - dA) / den;
	latC = mix(latA, latB, clamp(t, 0.0, 1.0));
	return true;
}
`;

// 線：辺1本＝インスタンス1つ＝四角2枚（縫い目で割れた時の左右）。幅は CSS px・端は角キャップ（継ぎ目を埋める）
const LINE_VS = COMMON + `
layout(location=0) in uvec3 a_e;
uniform vec4 u_color[16]; uniform vec4 u_param[16];   // param.x=幅(CSS px)
out vec4 v_color; out float v_d; out float v_hw; out float v_a;
void main() {
	uint cls = a_e.z & 255u; vec4 prm = u_param[cls];
	if (u_zoom < float(a_e.z >> 8u) * 0.1 || prm.x <= 0.0) { gl_Position = OFF; return; }
	float dA, latA, dB, latB; fetchV(a_e.x, dA, latA); fetchV(a_e.y, dB, latB);
	int q = gl_VertexID / 6, c = gl_VertexID % 6;
	float s, latC; vec2 P0, P1;
	if (crosses(dA, latA, dB, latB, s, latC)) {
		if (q == 0) { P0 = px(ee(dA, latA)); P1 = px(ee(180.0 * s, latC)); }
		else        { P0 = px(ee(-180.0 * s, latC)); P1 = px(ee(dB, latB)); }
	} else {
		if (q == 1) { gl_Position = OFF; return; }
		P0 = px(ee(dA, latA)); P1 = px(ee(dB, latB));
	}
	float w = prm.x * u_dpr, hw = max(w, 1.0) * 0.5;
	vec2 d = P1 - P0; float L = length(d);
	vec2 dir = L > 1e-6 ? d / L : vec2(1.0, 0.0), n = vec2(-dir.y, dir.x);
	float t = (c == 1 || c == 2 || c == 4) ? 1.0 : 0.0;
	float side = (c == 0 || c == 1 || c == 3) ? -1.0 : 1.0;
	float ext = hw + 1.0;   // AA の縁取り 1px
	vec2 p = mix(P0, P1, t) + dir * (t * 2.0 - 1.0) * hw + n * side * ext;
	gl_Position = clipOf(p);
	v_color = u_color[cls]; v_d = side * ext; v_hw = hw; v_a = min(w, 1.0);
}`;
const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_color; in float v_d; in float v_hw; in float v_a;
out vec4 o;
void main() { float a = clamp(v_hw + 0.5 - abs(v_d), 0.0, 1.0) * v_a * v_color.a; o = vec4(v_color.rgb * a, a); }`;

// 塗り：ステンシル偶奇（扇の要＝リング先頭頂点）。辺1本＝三角形6枚ぶんの頂点。
// 縫い目を跨ぐ辺は A→跨ぎ点→画面外の遠点 F→上端 T、反対側 T'→F'→跨ぎ点'→B に置き換える。
// 1つのリングの跨ぎは偶数回＝T の辺は偶奇で打ち消し合い、F〜外形の余分な領域は外形の外（＝画面外）にしか出ない。
const FILL_VS = COMMON + `
layout(location=0) in uvec4 a_e;
const float XF = 3.2, YT = 2.0;   // 外形（|x|≤2.72, |y|≤1.32）の外
flat out float v_id;              // fid+1（ID 塗り用）
void main() {
	v_id = float(a_e.w & 0xFFFFFu) + 1.0;
	if (u_zoom < float(a_e.w >> 20u) * 0.1) { gl_Position = OFF; return; }
	int tri = gl_VertexID / 3, c = gl_VertexID % 3;
	float dA, latA, dB, latB, dP, latP;
	fetchV(a_e.x, dA, latA); fetchV(a_e.y, dB, latB);
	float s, latC; vec2 Q0, Q1;
	if (!crosses(dA, latA, dB, latB, s, latC)) {
		if (tri != 0) { gl_Position = OFF; return; }
		Q0 = ee(dA, latA); Q1 = ee(dB, latB);
	} else {
		float yC = ee(0.0, latC).y;
		vec2 A = ee(dA, latA), CA = ee(180.0 * s, latC), FA = vec2(s * XF, yC), TA = vec2(s * XF, YT);
		vec2 B = ee(dB, latB), CB = ee(-180.0 * s, latC), FB = vec2(-s * XF, yC), TB = vec2(-s * XF, YT);
		if (tri == 0) { Q0 = A; Q1 = CA; } else if (tri == 1) { Q0 = CA; Q1 = FA; } else if (tri == 2) { Q0 = FA; Q1 = TA; }
		else if (tri == 3) { Q0 = TB; Q1 = FB; } else if (tri == 4) { Q0 = FB; Q1 = CB; } else { Q0 = CB; Q1 = B; }
	}
	vec2 u;
	if (c == 0) { fetchV(a_e.z, dP, latP); u = ee(dP, latP); } else u = (c == 1) ? Q0 : Q1;
	gl_Position = clipOf(px(u));
}`;
const FILL_FS = `#version 300 es
precision highp float; flat in float v_id; out vec4 o; void main() { o = vec4(0.0); }`;
// ID 塗り（国＝コロプレスの面）：扇の三角形ごとに ±(fid+1) を R32F へ加算。表＝+・裏＝−（gl_FrontFacing）。
// 外環は反時計回りに正規化済み（bake.js）＝面の内側で巻き数 +1 → 画素値 = fid+1、外・穴 = 0。
// 国は互いに重ならない＝一回のパスで「陸マスク＋国ID」が同時に出る（ホバー識別も同じバッファを読む）。
const ID_FS = `#version 300 es
precision highp float; flat in float v_id; out vec4 o;
void main() { o = vec4(gl_FrontFacing ? v_id : -v_id, 0.0, 0.0, 0.0); }`;

// 外形（Equal Earth の輪郭）までの符号付き距離（device px・内側が負）。縮小下限で外形の外が画面に出る＝
// 塗り（被せ・国の合成・海）はこれで切り抜く。扇の遠点 F/T が作る余分な偶奇/巻き数は外形の外にしか出ない＝ここで消える
const OUTLINE = `
uniform vec2 u_vp; uniform float u_ppu, u_yc;
const float OA1=${A1}, OA2=${A2}, OA3=${A3}, OA4=${A4}, OM=${M}, OY_MAX=1.3173627591574, OPI=3.141592653589793;
float outlineDist(vec2 fc) {
	vec2 u = (fc - u_vp * 0.5) / u_ppu; u.y += u_yc;
	float y = clamp(u.y, -OY_MAX, OY_MAX), l = y / OA1;
	for (int i = 0; i < 6; i++) {
		float l2 = l * l, l6 = l2 * l2 * l2;
		l -= (l * (OA1 + OA2 * l2 + l6 * (OA3 + OA4 * l2)) - y) / (OA1 + 3.0 * OA2 * l2 + l6 * (7.0 * OA3 + 9.0 * OA4 * l2));
	}
	float l2 = l * l, l6 = l2 * l2 * l2;
	float xe = OPI * cos(l) / (OM * (OA1 + 3.0 * OA2 * l2 + l6 * (7.0 * OA3 + 9.0 * OA4 * l2)));   // 高さ y での経線 ±180° の x
	return max((abs(u.x) - xe) * u_ppu, (abs(u.y) - OY_MAX) * u_ppu);
}
float insideK(vec2 fc) { return 1.0 - smoothstep(-0.5, 0.5, outlineDist(fc)); }
`;
// 海＋外形の外＋輪郭線（全画面の三角形1枚・各層より先）
const SEA_FS = `#version 300 es
precision highp float;
${OUTLINE}
uniform vec3 u_sea, u_bg; uniform vec4 u_edge;
out vec4 o;
void main() {
	float d = outlineDist(gl_FragCoord.xy);
	vec3 c = mix(u_bg, u_sea, 1.0 - smoothstep(-0.5, 0.5, d));
	c = mix(c, u_edge.rgb, u_edge.a * (1.0 - smoothstep(0.4, 1.2, abs(d))));
	o = vec4(c, 1.0);
}`;

// 被せ（ステンシル奇数の画素だけ色）＝全画面の三角形1枚
const COVER_VS = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`;
const COVER_FS = `#version 300 es
precision highp float;
${OUTLINE}
uniform vec4 u_col; out vec4 o;
void main() { float a = u_col.a * insideK(gl_FragCoord.xy); if (a <= 0.0) discard; o = vec4(u_col.rgb * a, a); }`;

// 全球ハイプソ：ortho-core gl/glsl.js WORLD_HYPSO と同式（標高×気候の cross-blend＋5段ランプ＋氷床＋脱彩度）。
// 色は ortho-core/worldpal の正準既定＝japan と同じ顔。
const WORLD_HYPSO = `
uniform sampler2D u_climTex; uniform float u_hasClim;
uniform vec3 u_whLowH, u_whLowA, u_whMidH, u_whMidA, u_whR1, u_whR2, u_whPeak, u_whSnow;
float wetBox(vec2 ll, vec4 b) {
	return smoothstep(b.x - 3.0, b.x + 3.0, ll.x) * (1.0 - smoothstep(b.y - 3.0, b.y + 3.0, ll.x))
	     * smoothstep(b.z - 3.0, b.z + 3.0, ll.y) * (1.0 - smoothstep(b.w - 3.0, b.w + 3.0, ll.y));
}
vec3 worldHypso(float e, vec2 ll) {
	float latD = ll.y, al = abs(latD), arid, pol;
	if (u_hasClim > 0.5) {
		vec2 c2 = texture(u_climTex, vec2(fract(ll.x / 360.0 + 0.5), 0.5 - latD / 180.0)).rg;
		arid = c2.r; pol = c2.g;
	} else {
		arid = smoothstep(10.0, 17.0, al) * (1.0 - smoothstep(32.0, 45.0, al));
		float wet = wetBox(ll, vec4(95.0, 148.0, 17.0, 40.0));
		wet = max(wet, wetBox(ll, vec4(118.0, 150.0, 40.0, 55.0)));
		wet = max(wet, wetBox(ll, vec4(-100.0, -70.0, 24.0, 40.0)));
		wet = max(wet, wetBox(ll, vec4(-63.0, -35.0, -35.0, -15.0)));
		wet = max(wet, wetBox(ll, vec4(74.0, 95.0, 8.0, 30.0)));
		arid *= 1.0 - wet;
		pol = 1.0 - smoothstep(-64.0, -58.0, latD);
	}
	vec3 low = mix(u_whLowH, u_whLowA, arid), mid = mix(u_whMidH, u_whMidA, arid);
	vec3 c = mix(low, mid, smoothstep(0.0, 400.0, e));
	c = mix(c, u_whR1, smoothstep(400.0, 1300.0, e));
	c = mix(c, u_whR2, smoothstep(1300.0, 2800.0, e));
	c = mix(c, u_whPeak, smoothstep(2800.0, 4800.0, e));
	float snow = pol + smoothstep(56.0, 62.0, latD) * smoothstep(1100.0, 1900.0, e);
	c = mix(c, u_whSnow, clamp(snow, 0.0, 1.0));
	return mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.10);
}`;

// 国の合成（全画面三角形）：陸色 → ハイプソ（不透明度）→ コロプレス（fid の塗り表×不透明度）→ ホバー
const COMPOSITE_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_id; uniform float u_hasId;       // 0＝ID 無し（float blend 非対応機）＝ステンシルで陸だけ
uniform float u_lon0;
${OUTLINE}
uniform vec3 u_land;
uniform float u_hypsoA; uniform sampler2D u_elevTex; uniform float u_hasElev;
uniform sampler2D u_nearTex; uniform float u_hasNear; uniform vec4 u_nearB;   // 近景 R10 窓（x0,y0,spanLon,spanLat・行0=南）
const float A1=${A1}, A2=${A2}, A3=${A3}, A4=${A4}, M=${M};
const float D2R = 0.017453292519943295, Y_MAX = 1.3173627591574;
${WORLD_HYPSO}
vec2 eeInv(vec2 u) {   // 単位座標 → (dλ°, φ°)（Newton・CPU equalearth.js latOfY と同じ反復）
	float y = clamp(u.y, -Y_MAX, Y_MAX), l = y / A1;
	for (int i = 0; i < 6; i++) {
		float l2 = l * l, l6 = l2 * l2 * l2;
		l -= (l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)) - y) / (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2));
	}
	float l2 = l * l, l6 = l2 * l2 * l2;
	return vec2(M * u.x * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2)) / cos(l) / D2R,
	            asin(clamp(sin(l) / M, -1.0, 1.0)) / D2R);
}
// 標高＝近景 R10 窓（窓内）→ 遠景 R90 全球（窓外・縁 0.5° でフェード）。経度は周期＝窓の西端からの差を 360 で畳む
float elevAt(vec2 ll) {
	float e = texture(u_elevTex, vec2(fract((ll.x + 180.0) / 360.0), (ll.y + 90.0) / 180.0)).r;
	if (u_hasNear > 0.5) {
		vec2 d = vec2(mod(ll.x - u_nearB.x, 360.0), ll.y - u_nearB.y);
		vec2 uv = d / u_nearB.zw;
		if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
			vec2 m = min(d, u_nearB.zw - d);
			float w = smoothstep(0.0, 0.5, min(m.x, m.y));
			e = mix(e, texture(u_nearTex, uv).r, w);
		}
	}
	return max(e, 0.0);
}
out vec4 o;
void main() {
	float id = 0.0;
	float cov = insideK(gl_FragCoord.xy); if (cov <= 0.0) discard;
	if (u_hasId > 0.5) { id = floor(abs(texelFetch(u_id, ivec2(gl_FragCoord.xy), 0).r) + 0.5); if (id < 0.5) discard; }
	vec3 c = u_land;
	if (u_hypsoA > 0.001 && u_hasElev > 0.5) {
		vec2 p = (gl_FragCoord.xy - u_vp * 0.5) / u_ppu;
		vec2 dl = eeInv(vec2(p.x, p.y + u_yc));
		vec2 ll = vec2(u_lon0 + dl.x, dl.y);
		float e = elevAt(ll);
		// 陰影：差分の歩幅＝画面 1 texel 相当（R90 の歩幅を下限・近景窓の texel を上限）。係数は R90 歩幅で japan と同値＝
		// 歩幅が細かいほど √比で持ち上げる（線形に比例させると R10 の急斜面が塗り潰れる・√は見た目の折衷）
		float farStep = 180.0 / float(textureSize(u_elevTex, 0).y);
		float pxDeg = 57.29578 / u_ppu;
		float dstep = farStep;
		if (u_hasNear > 0.5) dstep = clamp(pxDeg, u_nearB.w / float(textureSize(u_nearTex, 0).y), farStep);
		float hx = elevAt(ll + vec2(dstep, 0.0)) - e, hy = elevAt(ll + vec2(0.0, dstep)) - e;
		float shade = clamp(0.86 + (-hx + hy) * 0.00013 * sqrt(farStep / dstep), 0.62, 1.08);   // japan の全球ハイプソと同じ NW 光
		c = mix(c, worldHypso(e, ll) * shade, u_hypsoA);
	}
	o = vec4(c * cov, cov);
}`;

// コロプレス＝層から独立した被せパス（2026-09-18 本人裁定「コロプレス機能をレイヤーから分離」）。
// 材料は国 ID バッファと塗り表テクスチャだけ＝どの層の幾何にも依存しない。国の面を描いたパスが残した ID を読むので、
// 描画順（ops の order）を呼び出し側が自由に決められる＝「湖や市街地の下に敷く／上に乗せる」が設定になる。
// ホバーの明暗も同じ ID 読みで済む＝1 パス 1 テクスチャフェッチに相乗り（別パスにすると ID を二度読む）。
// 塗りとホバーは source-over で自前合成してから 1 回だけ画面へブレンド（＝旧・合成パス内の二段 mix と同じ絵）。
const CHORO_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_id;
uniform sampler2D u_paint; uniform int u_paintW; uniform float u_choroA;
uniform float u_hover; uniform vec4 u_hoverC;   // rgb＋強さ
${OUTLINE}
out vec4 o;
void main() {
	float cov = insideK(gl_FragCoord.xy); if (cov <= 0.0) discard;
	float id = floor(abs(texelFetch(u_id, ivec2(gl_FragCoord.xy), 0).r) + 0.5);
	if (id < 0.5) discard;
	int fid = int(id) - 1;
	vec4 pc = texelFetch(u_paint, ivec2(fid % u_paintW, fid / u_paintW), 0);
	float a1 = pc.a * u_choroA;
	float a2 = abs(float(fid) - u_hover) < 0.5 ? u_hoverC.a : 0.0;
	float a = a1 + a2 * (1.0 - a1);
	if (a <= 0.0) discard;
	vec3 pm = pc.rgb * a1 + u_hoverC.rgb * a2 * (1.0 - a1);   // 事前乗算のまま重ねる
	o = vec4(pm * cov, a * cov);
}`;

// 点：(ix,iy) を直接インスタンス属性で＝テクスチャ不要。円＋縁取り
const POINT_VS = COMMON + `
layout(location=0) in uvec3 a_p;
uniform vec4 u_color[16]; uniform vec4 u_param[16];   // param.x=直径(CSS px)
out vec4 v_color; out vec2 v_q; out float v_r;
void main() {
	uint cls = a_p.z & 255u; vec4 prm = u_param[cls];
	if (u_zoom < float(a_p.z >> 8u) * 0.1 || prm.x <= 0.0) { gl_Position = OFF; return; }
	float dlon = dlonE7(a_p.x, u_ix0) * 1e-7, lat = float(int(a_p.y) - 900000000) * 1e-7;
	int c = gl_VertexID;
	vec2 q = vec2((c == 1 || c == 2 || c == 4) ? 1.0 : -1.0, (c == 2 || c == 4 || c == 5) ? 1.0 : -1.0);
	float r = prm.x * u_dpr * 0.5 + 1.5;
	gl_Position = clipOf(px(ee(dlon, lat)) + q * r);
	v_color = u_color[cls]; v_q = q * r; v_r = prm.x * u_dpr * 0.5;
}`;
const POINT_FS = `#version 300 es
precision highp float;
in vec4 v_color; in vec2 v_q; in float v_r; out vec4 o;
void main() {
	float d = length(v_q);
	float aOut = clamp(v_r + 1.5 - d, 0.0, 1.0);            // 外周（白い縁）
	float aIn = clamp(v_r - 0.5 - d, 0.0, 1.0);              // 中身
	vec3 rgb = mix(vec3(1.0), v_color.rgb, aIn);
	float a = aOut * v_color.a; o = vec4(rgb * a, a);
}`;

function compile(gl, vs, fs) {
	const mk = (type, src) => {
		const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) + "\n" + src.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n"));
		return sh;
	};
	const p = gl.createProgram();
	gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
	for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, info.name); }
	return { p, u };
}

export function createRenderer(canvas) {
	const gl = canvas.getContext("webgl2", { antialias: true, stencil: true, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
	if (!gl) return null;
	const MAX_TEX = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
	// 国 ID は R32F への加算（float blend）。無い機体は陸マスクだけステンシルで作る＝コロプレス/ホバー無しで動く
	const hasFloatId = !!(gl.getExtension("EXT_color_buffer_float") && gl.getExtension("EXT_float_blend"));
	if (!hasFloatId) console.warn("[equal] EXT_color_buffer_float / EXT_float_blend unavailable -> no choropleth / hover (land mask via stencil)");
	gl.getExtension("OES_texture_float_linear");
	const prog = {
		line: compile(gl, LINE_VS, LINE_FS),
		fill: compile(gl, FILL_VS, FILL_FS),
		id: compile(gl, FILL_VS, ID_FS),
		cover: compile(gl, COVER_VS, COVER_FS),
		sea: compile(gl, COVER_VS, SEA_FS),
		composite: compile(gl, COVER_VS, COMPOSITE_FS),
		choro: compile(gl, COVER_VS, CHORO_FS),
		point: compile(gl, POINT_VS, POINT_FS),
	};
	let frame = null;   // 今フレームの共通 uniform 値
	let idsThisFrame = false;   // このフレームで国 ID バッファ（またはステンシル陸マスク）を描いたか＝drawLand/drawChoropleth の前提

	// 頂点テクスチャ（RG32UI・幅 4096 折り返し）
	function uploadVertices(xy, count) {
		const w = Math.max(1, Math.min(MAX_TEX, count)), h = Math.max(1, Math.ceil(count / w));
		const data = new Uint32Array(w * h * 2); data.set(xy.subarray(0, count * 2));
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI, w, h, 0, gl.RG_INTEGER, gl.UNSIGNED_INT, data);
		texParams(gl.NEAREST, gl.CLAMP_TO_EDGE);
		return { tex, w };
	}
	function texParams(filter, wrapS, wrapT = gl.CLAMP_TO_EDGE) {
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
	}
	// インスタンス配列 → VAO（uint の整数属性・divisor 1）
	function instanceVAO(u32, comps) {
		const vao = gl.createVertexArray(), buf = gl.createBuffer();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, u32, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribIPointer(0, comps, gl.UNSIGNED_INT, 0, 0);
		gl.vertexAttribDivisor(0, 1);
		gl.bindVertexArray(null);
		return { vao, buf, count: u32.length / comps };
	}

	function freeVAO(v) { if (v) { gl.deleteVertexArray(v.vao); gl.deleteBuffer(v.buf); } }

	// ── 国 ID バッファ（R32F・MSAA なし・canvas と同寸）──
	let idTex = null, idFbo = null, idW = 0, idH = 0;
	function ensureIdTarget(W, H) {
		if (!hasFloatId || (idW === W && idH === H)) return;
		if (idTex) gl.deleteTexture(idTex);
		if (idFbo) gl.deleteFramebuffer(idFbo);
		idTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, idTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, null);
		texParams(gl.NEAREST, gl.CLAMP_TO_EDGE);
		idFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, idFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, idTex, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		idW = W; idH = H;
	}

	// ── ハイプソの材料：標高アトラス（R16F 等経緯度・行0=南）・気候場（koppen-clim.png）・塗り表（fid→RGBA）──
	let elevTex = null, climTex = null, paintTex = null, paintW = 1, nearTex = null, nearB = null;
	function setNearElevation(atlas) {   // null＝近景なし（R90 だけ）
		if (!atlas) { nearB = null; return; }
		if (!nearTex) nearTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, nearTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, atlas.width, atlas.height, 0, gl.RED, gl.FLOAT, atlas.data);
		texParams(gl.LINEAR, gl.CLAMP_TO_EDGE);
		nearB = atlas.bounds;
	}
	function setElevation(f32, w, h) {
		if (!elevTex) elevTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, elevTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, f32);
		texParams(gl.LINEAR, gl.REPEAT);
	}
	function setClimate(img) {
		climTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, climTex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
		texParams(gl.LINEAR, gl.REPEAT);
	}
	function setPaint(rgba8, count) {   // rgba8 = Uint8Array(count*4)（0..255・a=0 は塗らない）
		const w = Math.max(1, Math.min(1024, count)), h = Math.max(1, Math.ceil(count / w));
		const data = new Uint8Array(w * h * 4); data.set(rgba8.subarray(0, Math.min(rgba8.length, w * h * 4)));
		if (!paintTex) paintTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, paintTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		texParams(gl.NEAREST, gl.CLAMP_TO_EDGE);
		paintW = w;
	}

	function beginFrame(view, clearRGB) {
		idsThisFrame = false;   // ID バッファは毎フレーム描き直す＝前フレームの残りを当てにしない
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
		if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }   // リサイズは描画フレーム先頭（白抜け点滅の轍）
		ensureIdTarget(W, H);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, W, H);
		gl.clearColor(clearRGB[0], clearRGB[1], clearRGB[2], 1);
		gl.clearStencil(0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
		gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
		frame = {
			lon0: view.lon, ix0: Math.round((((view.lon + 180) % 360 + 360) % 360) * 1e7) >>> 0,
			yc: yOfLat(view.lat), ppu: pxPerUnit(view.zoom) * dpr, vp: [W, H], zoom: view.zoom, dpr,
		};
	}
	function setCommon(pr, vtx) {
		const u = pr.u, f = frame;
		gl.useProgram(pr.p);
		if (vtx) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vtx.tex); gl.uniform1i(u.u_vtx, 0); gl.uniform1i(u.u_vw, vtx.w); }
		gl.uniform1ui(u.u_ix0, f.ix0); gl.uniform1f(u.u_yc, f.yc); gl.uniform1f(u.u_ppu, f.ppu);
		gl.uniform2f(u.u_vp, f.vp[0], f.vp[1]); gl.uniform1f(u.u_zoom, f.zoom);
		if (u.u_dpr) gl.uniform1f(u.u_dpr, f.dpr);
	}
	function setStyles(pr, styles) {   // styles[cls] = { color:[r,g,b,a], width }
		const col = new Float32Array(64), prm = new Float32Array(64);
		styles.forEach((s, i) => { if (!s) return; col.set(s.color, i * 4); prm[i * 4] = s.width ?? s.size ?? 0; });
		gl.uniform4fv(pr.u.u_color, col); gl.uniform4fv(pr.u.u_param, prm);
	}
	const fanDraw = vao => { gl.bindVertexArray(vao.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, vao.count); gl.bindVertexArray(null); };

	function drawLines(vtx, vao, styles) {
		if (!vao?.count) return;
		const pr = prog.line; setCommon(pr, vtx); setStyles(pr, styles);
		gl.bindVertexArray(vao.vao);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 12, vao.count);
		gl.bindVertexArray(null);
	}
	// 単色の面（湖・市街地）＝ステンシル偶奇
	function stencilFan(vtx, vao) {
		gl.clear(gl.STENCIL_BUFFER_BIT);   // 層ごとに偶奇をやり直す（外形の外に残る余分なビットを次層へ持ち越さない）
		gl.enable(gl.STENCIL_TEST);
		gl.colorMask(false, false, false, false);
		gl.stencilMask(1); gl.stencilFunc(gl.ALWAYS, 0, 1); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
		setCommon(prog.fill, vtx);
		fanDraw(vao);
		gl.colorMask(true, true, true, true);
		gl.stencilFunc(gl.EQUAL, 1, 1); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
	}
	// テクスチャユニットの割り当て（合成・コロプレス共通）。使わない時も各ユニットへ向ける＝unit0 の奪い合いを避ける
	const bind = (unit, name, tex, u) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], unit); };
	// 外形の三つ組（被せ系のプログラム共通）
	function setOutline(pr) { const u = pr.u, f = frame; gl.uniform2f(u.u_vp, f.vp[0], f.vp[1]); gl.uniform1f(u.u_ppu, f.ppu); gl.uniform1f(u.u_yc, f.yc); }
	function drawSea(sea, bg, edge) {
		const pr = prog.sea; gl.useProgram(pr.p); setOutline(pr);
		gl.uniform3f(pr.u.u_sea, sea[0], sea[1], sea[2]); gl.uniform3f(pr.u.u_bg, bg[0], bg[1], bg[2]); gl.uniform4fv(pr.u.u_edge, edge);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
	function drawFill(vtx, vao, color) {
		if (!vao?.count) return;
		stencilFan(vtx, vao);
		gl.useProgram(prog.cover.p); setOutline(prog.cover); gl.uniform4fv(prog.cover.u.u_col, color);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.disable(gl.STENCIL_TEST);
	}
	// ── 国 ID バッファ＝「どの画素がどの国か」だけを持つ独立した資源 ──────────────────────
	// 面の塗り（drawLand）・コロプレス（drawChoropleth）・ホバー識別（readFid）の 3 者が読む共有の材料で、
	// どれか一つの持ち物ではない＝ここで単独に描く（2026-09-18 本人裁定「コロプレスをレイヤーから独立させて」）。
	// float ID を作れない機体は代わりにステンシルで陸マスクだけ立てる＝面は塗れる（コロプレス/ホバーは成立しない）。
	function drawIds(vtx, vao) {
		if (!vao?.count) return false;
		if (hasFloatId) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, idFbo);
			gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
			gl.blendFunc(gl.ONE, gl.ONE);
			setCommon(prog.id, vtx);
			fanDraw(vao);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		} else stencilFan(vtx, vao);   // ステンシルは次の drawLand が消費する（直後に呼ぶこと）
		return idsThisFrame = true;
	}
	// 面の塗り＝陸色＋ハイプソ。ID バッファ（またはステンシル）で陸だけに乗せる。コロプレスもホバーもここには居ない。
	// o = { land:[r,g,b], hypso: 0..1, pal: WORLD_PAL }
	function drawLand(o) {
		if (!idsThisFrame) return;   // 材料（ID/ステンシル）が無い＝塗る場所が決まらない
		const pr = prog.composite, u = pr.u, f = frame;
		gl.useProgram(pr.p);
		gl.uniform1f(u.u_hasId, hasFloatId ? 1 : 0);
		setOutline(pr); gl.uniform1f(u.u_lon0, f.lon0);
		gl.uniform3f(u.u_land, o.land[0], o.land[1], o.land[2]);
		gl.uniform1f(u.u_hypsoA, o.hypso || 0); gl.uniform1f(u.u_hasElev, elevTex ? 1 : 0); gl.uniform1f(u.u_hasClim, climTex ? 1 : 0);
		const P = o.pal;
		gl.uniform3fv(u.u_whLowH, P.lowHumid); gl.uniform3fv(u.u_whLowA, P.lowArid); gl.uniform3fv(u.u_whMidH, P.midHumid); gl.uniform3fv(u.u_whMidA, P.midArid);
		gl.uniform3fv(u.u_whR1, P.ramp1); gl.uniform3fv(u.u_whR2, P.ramp2); gl.uniform3fv(u.u_whPeak, P.peak); gl.uniform3fv(u.u_whSnow, P.snow);
		// サンプラは使わない時も各ユニットへ向ける（未設定＝unit0 を奪い合う轍）
		bind(1, "u_id", hasFloatId ? idTex : null, u); bind(2, "u_elevTex", elevTex, u); bind(3, "u_climTex", climTex, u); bind(5, "u_nearTex", nearTex, u);
		gl.uniform1f(u.u_hasNear, nearB && elevTex ? 1 : 0);
		if (nearB) gl.uniform4f(u.u_nearB, nearB[0], nearB[1], nearB[2], nearB[3]);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		bind(1, "u_id", null, u);   // 次フレームの ID パスで FBO 自身を読み書きしない
		gl.activeTexture(gl.TEXTURE0);
		gl.disable(gl.STENCIL_TEST);
	}
	// コロプレス＝国 ID バッファの被せパス（層の幾何に依存しない＝呼び出し側が描画順を決める）。
	// o = { alpha: 0..1, hover: fid|-1, hoverColor?:[r,g,b,a] }。同じフレームで drawIds が済んでいること（材料＝ID バッファ）。
	// float ID が無い機体（ID バッファを作れない）＝コロプレスもホバーも成立しない＝何もしない（陸は合成パスが塗り済み）。
	const HOVER_DEFAULT = [0.10, 0.14, 0.20, 0.14];
	function drawChoropleth(o = {}) {
		if (!hasFloatId || !idTex || !idsThisFrame) return;
		const alpha = paintTex ? (o.alpha || 0) : 0, hover = o.hover ?? -1;
		if (alpha <= 0.001 && hover < 0) return;
		const pr = prog.choro, u = pr.u;
		gl.useProgram(pr.p); setOutline(pr);
		gl.uniform1f(u.u_choroA, alpha); gl.uniform1i(u.u_paintW, paintW);
		gl.uniform1f(u.u_hover, hover);
		gl.uniform4fv(u.u_hoverC, o.hoverColor || HOVER_DEFAULT);
		bind(1, "u_id", idTex, u); bind(4, "u_paint", paintTex, u);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		bind(1, "u_id", null, u);   // 次フレームの ID パスで FBO 自身を読み書きしない
		gl.activeTexture(gl.TEXTURE0);
	}
	// 画面 CSS px（左上原点）の国 → fid | -1（ID バッファの直読み・1px）
	const px4 = new Float32Array(4);
	function readFid(cssX, cssY) {
		if (!hasFloatId || !idFbo || !frame) return -1;
		const x = Math.floor(cssX * frame.dpr), y = idH - 1 - Math.floor(cssY * frame.dpr);
		if (x < 0 || y < 0 || x >= idW || y >= idH) return -1;
		gl.bindFramebuffer(gl.FRAMEBUFFER, idFbo);
		gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, px4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const id = Math.round(Math.abs(px4[0]));
		return id > 0 ? id - 1 : -1;
	}
	function drawPoints(vao, styles) {
		if (!vao?.count) return;
		const pr = prog.point; setCommon(pr, null); setStyles(pr, styles);
		gl.bindVertexArray(vao.vao);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, vao.count);
		gl.bindVertexArray(null);
	}

	return { gl, hasFloatId, uploadVertices, instanceVAO, freeVAO, beginFrame, drawSea, drawLines, drawFill, drawIds, drawLand, drawChoropleth, drawPoints, readFid, setElevation, setNearElevation, setClimate, setPaint };
}
