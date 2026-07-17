// ── gint programs（v2：ortho-map から移植）─────────────────────────────────
// v1(ortho-map) の gintPrograms を japan の substrate へ生まれ直させたもの。
// 【d3⇒mat4 の swap はここ一点】fetchProject の投影本体だけを
//   gint(ix,iy) → 中心からの delta → d3-ortho(rotate/scale/trig/jac) → screen px
// から
//   gint(ix,iy) → 中心からの delta → lonlat(u_origin+delta) → lonlatTo3D(単位球) → u_mvp → screen px
// へ差し替えた。Morton decode / dlonE7(antimeridian, 360e7周期) は不変。
// fetchProject が返すのは screen px＋zr(手前半球>0) ＝ v1 と同じ契約なので、
// 下流の全シェーダ（線幅・stencil・dash・AA・pick）は px 空間のまま丸ごと不変。

// ── 共有 VS ヘッダ：Morton decode ＋ 球面投影（mat4）─────────────────────────
// 返り値 vec3(screen_x, screen_y, zr)。zr < 0 は裏半球（v1 の horizon-clip 判定と同符号）。
const GLSL_VS_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_arc_tex;
uniform usampler2D u_meta_tex;
uniform int        u_arc_w;
uniform int        u_meta_w;
uniform mat4       u_mvp;        // japan の MVP（cameraState 由来）
uniform vec3       u_eye;        // カメラ位置（単位球ワールド）＝手前/裏半球判定
uniform vec2       u_origin;     // シーン原点 lon/lat (deg)＝Morton 中心
uniform vec2       u_viewport;   // canvas 幅高 (device px)
uniform uint       u_ix_center;  // u_origin の Morton 整数（経度）
uniform uint       u_iy_center;  // u_origin の Morton 整数（緯度）
uniform float      u_lod_rank;   // GPU Dynamic LOD 閾値（VW rank 0-63）。辺の max(rankA,rankB) 未満は VS で discard
const float D2R = 0.017453292519943295;

vec3 lonlatTo3D(vec2 ll) {
	float a = ll.x * D2R, b = ll.y * D2R, cb = cos(b);
	return vec3(cb * cos(a), sin(b), cb * sin(a));
}

uint compact16(uint m) {
	m &= 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}

// 経度 Δ（1e-7°単位, 符号付き最短）。経度は 360e7 周期で、素朴な int(a-b) は 2^32 で
// 折れて ±180° 越えを誤ラップする。max/min で |Δ| を厳密に取り、360e7 で正しく畳む。
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b);   // |Δ| ∈ [0, 360e7], exact
	float f = float(d);
	float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { f = 3.6e9 - f; s = -s; }  // take the short way around
	return f * s;
}

// 【swap 本体】gint 整数 → 単位球 → mat4 → screen px。
vec3 fetchProject(uint idx) {
	ivec2 tc = ivec2(int(idx) % u_arc_w, int(idx) / u_arc_w);
	uvec4 px = texelFetch(u_arc_tex, tc, 0);
	uint lo = px.r, hi = px.g;
	uint lo_c = ((hi >> 31u) != 0u) ? lo : (lo & 0xFFFFFFC0u);
	uint hi_c = hi & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c) << 16u) | compact16(lo_c);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(lo_c >> 1u);
	// 中心(=シーン原点)からの delta を整数空間で計算（精度確保・antimeridian 対応）。
	float dlon = dlonE7(ix, u_ix_center) * 1e-7;
	float dlat = float(int(iy - u_iy_center)) * 1e-7;
	vec3 dir = lonlatTo3D(vec2(u_origin.x + dlon, u_origin.y + dlat));
	float zr = dot(dir, u_eye) - 1.0;             // >0 手前半球（v1 の zr と同符号）
	vec4 clip = u_mvp * vec4(dir, 1.0);
	if (clip.w <= 0.0) return vec3(u_viewport * 0.5, -1.0);   // カメラ背後 → 裏扱い
	vec2 ndc = clip.xy / clip.w;
	return vec3((ndc.x * 0.5 + 0.5) * u_viewport.x,
				(1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y,
				zr);
}

vec4 toNDC(vec2 p) {
	return vec4(2.0 * p.x / u_viewport.x - 1.0,
				1.0 - 2.0 * p.y / u_viewport.y,
				0.0, 1.0);
}

uvec4 fetchEdgeMeta(int edge_id) {
	ivec2 mtc = ivec2(edge_id % u_meta_w, edge_id / u_meta_w);
	return texelFetch(u_meta_tex, mtc, 0);
}
// 頂点の VW rank（LOD 重要度 0-63）。terminal(L1 anchor)=63 常時保持、L2=低6bit（rust WEIGHT_MASK=0x3F）。
uint fetchRank(uint idx) {
	uvec4 px = texelFetch(u_arc_tex, ivec2(int(idx) % u_arc_w, int(idx) / u_arc_w), 0);
	return ((px.g >> 31u) != 0u) ? 63u : (px.r & 0x3Fu);
}
`;

// 点用の投影ヘッダ（u_pt_tex から decode。fetchProject と同じ mat4 swap）。
const GLSL_PT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_pt_tex;
uniform usampler2D u_pt_meta_tex;
uniform int        u_pt_w;
uniform mat4       u_mvp;
uniform vec3       u_eye;
uniform vec2       u_origin;
uniform vec2       u_viewport;
uniform float      u_pt_radius;
uniform uint       u_ix_center;
uniform uint       u_iy_center;
const float D2R = 0.017453292519943295;

vec3 lonlatTo3D(vec2 ll) {
	float a = ll.x * D2R, b = ll.y * D2R, cb = cos(b);
	return vec3(cb * cos(a), sin(b), cb * sin(a));
}
uint compact16(uint m) {
	m &= 0x55555555u; m = (m | (m >> 1u)) & 0x33333333u; m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu; m = (m | (m >> 8u)) & 0x0000FFFFu; return m;
}
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b); float f = float(d); float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { f = 3.6e9 - f; s = -s; } return f * s;
}
// pt_id → screen px（zr>0 手前）。
vec3 fetchPoint(int pt_id) {
	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	uvec4 px = texelFetch(u_pt_tex, tc, 0);
	uint hi_c = px.g & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c)       << 16u) | compact16(px.r);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(px.r >> 1u);
	float dlon = dlonE7(ix, u_ix_center) * 1e-7;
	float dlat = float(int(iy - u_iy_center)) * 1e-7;
	vec3 dir = lonlatTo3D(vec2(u_origin.x + dlon, u_origin.y + dlat));
	float zr = dot(dir, u_eye) - 1.0;
	vec4 clip = u_mvp * vec4(dir, 1.0);
	if (clip.w <= 0.0) return vec3(u_viewport * 0.5, -1.0);
	vec2 ndc = clip.xy / clip.w;
	return vec3((ndc.x * 0.5 + 0.5) * u_viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y, zr);
}
`;

// sub=0 → NDC原点(fan pivot); sub=1 → 頂点A; sub=2 → 頂点B。
// 14条地図(市街地)は手前半球のみ＝v1 の horizon-circle push は不要。裏半球頂点は toNDC のまま
// （深いチルト/低ズームで背面を含む layer を載せる時に押し出しを足す＝そこは低ズーム精緻化）。
const VS_STENCIL = `${GLSL_VS_HEADER}
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	uvec4 meta = fetchEdgeMeta(edge_id);
	// GPU Dynamic LOD（gap無し・線と同骨格）：始点が閾値未満なら捨て、終点は次の kept へ前方スナップ。
	uint lodA = meta.r, lodB = meta.g;
	if (float(fetchRank(lodA)) < u_lod_rank) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	// 走査は arc の向きに追従（reversed arc は edge meta が index 降順＝+1 固定だと A 側へ逆走し
	// 辺が潰れ stencil 輪郭が破れる）。arc 両端は anchor(rank63) なのでどちら向きでも arc 内で停止。
	int lodStep = (lodB > lodA) ? 1 : -1;
	for (int k = 0; k < 4096; k++) { if (float(fetchRank(lodB)) >= u_lod_rank) break; lodB = uint(int(lodB) + lodStep); }
	if (sub == 0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
	vec3  p    = fetchProject(sub == 1 ? lodA : lodB);
	gl_Position = toNDC(p.xy);
}`;

// Mask stencil：アクティブ地物のリングだけ stencil を切り抜く。
const VS_STENCIL_MASK = `${GLSL_VS_HEADER}
flat out int v_feat_id;
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	if (sub == 0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
	uvec4 meta = fetchEdgeMeta(edge_id);
	v_feat_id  = int(meta.a);
	vec3  p    = fetchProject(sub == 1 ? meta.r : meta.g);
	gl_Position = toNDC(p.xy);
}`;

const FS_STENCIL_MASK = `#version 300 es
precision mediump float;
uniform int  u_active_id;
flat in  int v_feat_id;
out vec4 fragColor;
void main() {
	if (v_feat_id != u_active_id) discard;
	fragColor = vec4(0.0);
}`;

// 6 verts/edge: (A-)(A+)(B+)(A-)(B+)(B-)。u_pass=0: 非アクティブ, u_pass=1: アクティブのみ(最後に描き z-fight 解消)。
const VS_RENDER = `${GLSL_VS_HEADER}
uniform float u_line_width;
uniform float u_dpr;
uniform int   u_active_id;
uniform int   u_pass;
uniform vec4  u_style_table[256];
uniform vec2  u_dash_table[256];   // [dash_len, gap_len] in px; gap=0 → solid
out vec4  v_color;
out float v_zr;
out float v_dist;
out float v_perp;
flat out float v_halfw;
flat out vec2  v_dash;
flat out float v_dist_base;
out vec2       v_frag;   // 頂点の実スクリーン位置（device px）＝カプセルSDF用
flat out vec2  v_ea;     // 線分端A（device px）
flat out vec2  v_eb;     // 線分端B（clip済, device px）

void main() {
	int edge_id = gl_VertexID / 6;
	int sub     = gl_VertexID % 6;
	uvec4 meta  = fetchEdgeMeta(edge_id);
	int feat_id = int(meta.a);

	// GPU Dynamic LOD（gap無し）：始点A(meta.r)が閾値未満の辺は捨てる（直前の辺が跨いで描く）。
	// 終点は「次に閾値を満たす頂点」まで前方スナップ＝間引き頂点を飛ばして kept 同士を直結。
	// arc 末尾は anchor(rank63) なので走査は必ず arc 内で停止（隣の arc へ漏れない）。
	uint lodA = meta.r, lodB = meta.g;
	if (float(fetchRank(lodA)) < u_lod_rank) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	// 走査は arc の向きに追従（reversed arc は edge meta が index 降順＝+1 固定だと A 側へ逆走し
	// 辺が潰れ stencil 輪郭が破れる）。arc 両端は anchor(rank63) なのでどちら向きでも arc 内で停止。
	int lodStep = (lodB > lodA) ? 1 : -1;
	for (int k = 0; k < 4096; k++) { if (float(fetchRank(lodB)) >= u_lod_rank) break; lodB = uint(int(lodB) + lodStep); }

	if (u_pass == 0 && feat_id == u_active_id) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	if (u_pass == 1 && feat_id != u_active_id) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	bool  useA = (sub == 0 || sub == 1 || sub == 3);
	float side = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	uint  si   = useA ? lodA : lodB;
	uint  oi   = useA ? lodB : lodA;

	vec3 ps = fetchProject(si);
	v_zr = ps.z;

	vec3  po  = fetchProject(oi);
	vec2 oXY  = (po.z < 0.0 && ps.z > 0.0)
		? ps.xy + (ps.z / (ps.z - po.z)) * (po.xy - ps.xy)
		: po.xy;

	vec2 dir = oXY - ps.xy;
	float len = length(dir);
	if (len < 1e-4) { gl_Position = toNDC(ps.xy); return; }
	vec2 tang = dir / len;
	vec2 perp = vec2(-tang.y, tang.x);
	float halfCss = u_line_width * 0.5 + 1.0 / u_dpr;
	vec2 qpos = ps.xy + side * halfCss * perp - tang * halfCss;   // AA余白込みのクアッド（端は FS のカプセルSDFで丸める）
	gl_Position = toNDC(qpos);
	v_frag = qpos; v_ea = ps.xy; v_eb = oXY;

	int style_idx = int(meta.b & 0xFFu);
	v_color = (u_pass == 1)
		? vec4(1.0, 0.9, 0.0, 1.0)
		: u_style_table[style_idx];
	v_dash      = u_dash_table[style_idx];
	v_dist_base = float(meta.b >> 8u) * 0.017453292;   // 累積px距離の基底（scale 非依存の相対）
	v_dist = useA ? 0.0 : len;
	v_perp  = side * halfCss * u_dpr;
	v_halfw = u_line_width * 0.5 * u_dpr;
}`;

const FS_RENDER = `#version 300 es
precision mediump float;
in  vec4  v_color;
in  float v_zr;
in  float v_dist;
in  float v_perp;
flat in float v_halfw;
flat in vec2  v_dash;
flat in float v_dist_base;
in  vec2  v_frag;
flat in vec2  v_ea;
flat in vec2  v_eb;
out vec4  fragColor;
void main() {
	if (v_zr < -0.05)     discard;
	if (v_color.a == 0.0) discard;
	float alpha = v_color.a * smoothstep(-0.01, 0.02, v_zr);
	if (v_dash.y > 0.0) {
		float d      = v_dist_base + v_dist;
		float period = v_dash.x + v_dash.y;
		float t      = mod(d, period);
		float aa     = max(fwidth(v_dist), 0.001);
		alpha *= 1.0 - smoothstep(v_dash.x - aa, v_dash.x + aa, t);
	}
	// カプセルSDF：線分[v_ea,v_eb]への距離で塗る＝両端が半円(丸キャップ)。
	// 鋭角の繋ぎ目でも隣接線分の丸端が重なり、四角キャップのトゲ(イガイガ)が出ない。
	vec2 pa = v_frag - v_ea, ba = v_eb - v_ea;
	float t2 = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	float dcap = length(pa - ba * t2);
	float aaW = max(fwidth(dcap), 1e-3);
	alpha *= clamp((v_halfw - dcap) / aaW + 0.5, 0.0, 1.0);
	if (alpha < 0.004) discard;
	fragColor = vec4(v_color.rgb, alpha);
}`;

// GPU picking：fid+1 を RGB 24bit に。(0,0,0)=地物なし。
const VS_PICK_LINE = `${GLSL_VS_HEADER}
uniform float u_line_width;
out vec4  v_color;
out float v_zr;

void main() {
	int edge_id = gl_VertexID / 6;
	int sub     = gl_VertexID % 6;
	uvec4 meta  = fetchEdgeMeta(edge_id);

	// style 0 = polygon edge（JS レイキャストで識別）→ここでは捨てる。1 = polyline。
	if ((meta.b & 255u) == 0u) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	bool  useA = (sub == 0 || sub == 1 || sub == 3);
	float side = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	uint  si   = useA ? meta.r : meta.g;
	uint  oi   = useA ? meta.g : meta.r;

	vec3 ps = fetchProject(si);
	v_zr = ps.z;
	vec3 po  = fetchProject(oi);
	vec2 oXY = (po.z < 0.0 && ps.z > 0.0)
		? ps.xy + (ps.z / (ps.z - po.z)) * (po.xy - ps.xy)
		: po.xy;

	vec2 dir = oXY - ps.xy;
	float len = length(dir);
	if (len < 1e-4) { gl_Position = toNDC(ps.xy); return; }
	vec2 tang = dir / len;
	vec2 perp = vec2(-tang.y, tang.x);
	gl_Position = toNDC(ps.xy + side * (u_line_width * 0.5) * perp
	                          - tang * (u_line_width * 0.5));

	uint fid1 = meta.a + 1u;
	v_color = vec4(float(fid1 & 255u)/255.0, float((fid1>>8u)&255u)/255.0, float((fid1>>16u)&255u)/255.0, 1.0);
}`;

const FS_PICK = `#version 300 es
precision mediump float;
in  vec4  v_color;
in  float v_zr;
out vec4  fragColor;
void main() {
	if (v_zr < 0.0) discard;
	fragColor = v_color;
}`;

// 点 picking：fid 色の円 quad。
const VS_PICK_POINT = `${GLSL_PT_HEADER}
out float v_zr;
out vec2  v_uv;
out vec4  v_color;
void main() {
	int pt_id = gl_VertexID / 6;
	int sub   = gl_VertexID % 6;
	float ox = (sub == 2 || sub == 4 || sub == 5) ? 1.0 : -1.0;
	float oy = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	vec3 p = fetchPoint(pt_id);
	v_zr = p.z;
	v_uv = vec2(ox, oy);
	gl_Position = vec4(2.0*(p.x + ox*u_pt_radius)/u_viewport.x - 1.0,
					   1.0 - 2.0*(p.y + oy*u_pt_radius)/u_viewport.y, 0.0, 1.0);
	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	uint fid1 = texelFetch(u_pt_meta_tex, tc, 0).r + 1u;
	v_color = vec4(float(fid1 & 255u)/255.0, float((fid1>>8u)&255u)/255.0, float((fid1>>16u)&255u)/255.0, 1.0);
}`;

const FS_PICK_POINT = `#version 300 es
precision mediump float;
in  float v_zr;
in  vec2  v_uv;
in  vec4  v_color;
out vec4  fragColor;
void main() {
	if (v_zr < 0.0)            discard;
	if (dot(v_uv, v_uv) > 1.0) discard;
	fragColor = v_color;
}`;

// 6 verts/point: 投影点を中心にした quad。
const VS_POINT = `${GLSL_PT_HEADER}
uniform int u_active_id;
out float v_zr;
out vec2  v_uv;
out vec4  v_color;
void main() {
	int pt_id = gl_VertexID / 6;
	int sub   = gl_VertexID % 6;
	float ox = (sub == 2 || sub == 4 || sub == 5) ? 1.0 : -1.0;
	float oy = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	vec3 p = fetchPoint(pt_id);
	v_zr = p.z;
	v_uv = vec2(ox, oy);
	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	int feat_id = int(texelFetch(u_pt_meta_tex, tc, 0).r);
	bool isActive = (feat_id == u_active_id);
	float r = isActive ? u_pt_radius * 1.6 : u_pt_radius;
	gl_Position = vec4(2.0*(p.x + ox*r)/u_viewport.x - 1.0,
					   1.0 - 2.0*(p.y + oy*r)/u_viewport.y, 0.0, 1.0);
	v_color = isActive ? vec4(1.0, 0.9, 0.0, 1.0) : vec4(1.0, 0.420, 0.208, 1.0);
}`;

const FS_POINT = `#version 300 es
precision mediump float;
in  float v_zr;
in  vec2  v_uv;
in  vec4  v_color;
out vec4  fragColor;
void main() {
	if (v_zr < 0.0)            discard;
	if (dot(v_uv, v_uv) > 1.0) discard;
	fragColor = v_color;
}`;

const FS_STENCIL = `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`;

const VS_FILL = `#version 300 es
void main() {
	vec2[4] p = vec2[4](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1));
	gl_Position = vec4(p[gl_VertexID], 0.0, 1.0);
}`;

const FS_FILL = `#version 300 es
precision mediump float;
uniform vec4 u_fill_color;
out vec4 fragColor;
void main() { fragColor = u_fill_color; }`;

// 共有 uniform（v1 の rotate/scale/rsincos/jac を廃し、mat4/eye/origin へ）。
const SHARED_UNIFORM_NAMES = [
	'u_arc_tex','u_meta_tex','u_arc_w','u_meta_w',
	'u_mvp','u_eye','u_origin','u_viewport',
	'u_ix_center','u_iy_center','u_lod_rank',
];
const PT_UNIFORM_NAMES = [
	'u_pt_tex','u_pt_meta_tex','u_pt_w',
	'u_mvp','u_eye','u_origin','u_viewport','u_pt_radius',
	'u_ix_center','u_iy_center',
];

export function createGintPrograms(gl) {
	const renderProgram      = linkProgram(gl, VS_RENDER,        FS_RENDER);
	const stencilProgram     = linkProgram(gl, VS_STENCIL,       FS_STENCIL);
	const fillProgram        = linkProgram(gl, VS_FILL,          FS_FILL);
	const maskStencilProgram = linkProgram(gl, VS_STENCIL_MASK,  FS_STENCIL_MASK);
	const pointProgram       = linkProgram(gl, VS_POINT,         FS_POINT);
	const pickLineProgram    = linkProgram(gl, VS_PICK_LINE,     FS_PICK);
	const pickPointProgram   = linkProgram(gl, VS_PICK_POINT,    FS_PICK_POINT);

	const uRender      = getUniforms(gl, renderProgram,      [...SHARED_UNIFORM_NAMES, 'u_line_width', 'u_dpr', 'u_active_id', 'u_pass', 'u_style_table', 'u_dash_table']);
	const uStencil     = getUniforms(gl, stencilProgram,     SHARED_UNIFORM_NAMES);
	const uFill        = getUniforms(gl, fillProgram,        ['u_fill_color']);
	const uMaskStencil = getUniforms(gl, maskStencilProgram, [...SHARED_UNIFORM_NAMES, 'u_active_id']);
	const uPoint       = getUniforms(gl, pointProgram,       [...PT_UNIFORM_NAMES, 'u_active_id']);
	const uPickLine    = getUniforms(gl, pickLineProgram,    [...SHARED_UNIFORM_NAMES, 'u_line_width']);
	const uPickPoint   = getUniforms(gl, pickPointProgram,   PT_UNIFORM_NAMES);

	const emptyVAO = gl.createVertexArray();
	gl.enable(gl.BLEND);
	gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

	return { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
			 pointProgram, pickLineProgram, pickPointProgram,
			 uRender, uStencil, uFill, uMaskStencil, uPoint, uPickLine, uPickPoint, emptyVAO };
}

function compileShader(gl, type, src) {
	const s = gl.createShader(type);
	gl.shaderSource(s, src);
	gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
	return s;
}

function linkProgram(gl, vs, fs) {
	const p = gl.createProgram();
	gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
	gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	return p;
}

function getUniforms(gl, prog, names) {
	const u = {};
	for (const n of names) u[n] = gl.getUniformLocation(prog, n);
	return u;
}
