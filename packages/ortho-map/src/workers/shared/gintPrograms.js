// ── GLSL shared vertex shader header ─────────────────────────────────────────
// Morton decode + orthographic projection shared by all gint vertex shaders.
// Returns vec3(screen_x, screen_y, zr); zr < 0 means back hemisphere.
const GLSL_VS_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_arc_tex;
uniform usampler2D u_meta_tex;
uniform int        u_arc_w;
uniform int        u_meta_w;
uniform vec3       u_rotate;
uniform float      u_scale;
uniform vec2       u_viewport;
uniform vec4       u_rsincos;  // x=cos(r1), y=sin(r1), z=cos(r2), w=sin(r2)
uniform uint       u_ix_center;
uniform uint       u_iy_center;
uniform vec4       u_jac;  // Jacobian [J00,J10,J01,J11] col-major; all-zero → full trig

uint compact16(uint m) {
	m &= 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}

// Signed shortest Δlongitude in 1e-7° units (float). Longitude is periodic with
// period 360e7; a plain int(a - b) folds at 2^32 (≠ 360e7) and mis-wraps points
// across the ±180° antimeridian by (2^32 − 360e7) ≈ 69.5° when the view is centred
// near ±180°. max/min keeps the raw |Δ| exact (both operands ∈ [0, 360e7] < 2^32),
// then we fold with the correct 360e7 period.
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b);   // |Δ| ∈ [0, 360e7], exact
	float f = float(d);
	float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { f = 3.6e9 - f; s = -s; }  // take the short way around
	return f * s;
}

vec3 fetchProject(uint idx) {
	ivec2 tc = ivec2(int(idx) % u_arc_w, int(idx) / u_arc_w);
	uvec4 px = texelFetch(u_arc_tex, tc, 0);
	uint lo = px.r, hi = px.g;
	uint lo_c = ((hi >> 31u) != 0u) ? lo : (lo & 0xFFFFFFC0u);
	uint hi_c = hi & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c) << 16u) | compact16(lo_c);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(lo_c >> 1u);
	float dx = dlonE7(ix, u_ix_center);   // antimeridian-correct (360e7 period)
	float dy = float(int(iy - u_iy_center));  // latitude: no wrap, fits int32
	float hw = u_viewport.x * 0.5, hh = u_viewport.y * 0.5;
	if (dot(u_jac, u_jac) > 0.0) {
		// Jacobian (linear) path — active at high zoom (z≳13) where curvature
		// is negligible.  The 2×2 Jacobian is pre-computed in JS at float64;
		// per-vertex work is two MADs — no trig, no catastrophic cancellation.
		float sx = u_jac.x * dx + u_jac.z * dy;
		float sy = u_jac.y * dx + u_jac.w * dy;
		float d2 = (sx * sx + sy * sy) / (u_scale * u_scale);
		float zr = d2 < 1.0 ? sqrt(1.0 - d2) : -1.0;
		return vec3(hw + sx, hh + sy, zr);
	}
	// Full trig path — accurate at all zoom levels; used at low zoom.
	const float DEG2RAD_E7 = 1.7453292519943295e-9;
	float dl   = dx * DEG2RAD_E7;
	float dphi = dy * DEG2RAD_E7;
	float cf = u_rsincos.x, sf = u_rsincos.y;
	float cg = u_rsincos.z, sg = u_rsincos.w;
	float sdphi = sin(dphi), cdphi = cos(dphi);
	float sdl   = sin(dl);
	float cp = cf * cdphi + sf * sdphi;
	float sp = cf * sdphi - sf * cdphi;
	float x  = cp * sdl;
	float shalf = sin(dl * 0.5);
	float one_minus_cdl = 2.0 * shalf * shalf;
	float cdl = 1.0 - one_minus_cdl;
	float yr = sdphi - cp * one_minus_cdl * sf;
	float zr = cp * cdl * cf - sp * sf;
	return vec3(hw + u_scale * (x * cg - yr * sg),
				hh - u_scale * (x * sg + yr * cg),
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
`;

// sub=0 → NDC origin (fan pivot); sub=1 → vertex A; sub=2 → vertex B.
// Back-hemisphere verts are clipped to the horizon (same as VS_RENDER).
// Both-back edges collapse to origin → degenerate triangle (zero area, safe).
const VS_STENCIL = `${GLSL_VS_HEADER}
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	if (sub == 0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
	uvec4 meta = fetchEdgeMeta(edge_id);
	vec3  p    = fetchProject(sub == 1 ? meta.r : meta.g);
	if (p.z < 0.0) {
		// Back-facing vertex: push outward along its own direction onto the horizon circle (radius u_scale).
		vec2 v = p.xy - u_viewport * 0.5;
		float d = length(v);
		gl_Position = d < 1e-4
			? vec4(0.0, 0.0, 0.0, 1.0)
			: toNDC(u_viewport * 0.5 + v * (u_scale / d));
		return;
	}
	gl_Position = toNDC(p.xy);
}`;

// Mask stencil: cuts stencil only for the active feature's rings.
// v_feat_id is a flat varying — the probing vertex (sub=2) value is used.
const VS_STENCIL_MASK = `${GLSL_VS_HEADER}
flat out int v_feat_id;
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	if (sub == 0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
	uvec4 meta = fetchEdgeMeta(edge_id);
	v_feat_id  = int(meta.a);
	vec3  p    = fetchProject(sub == 1 ? meta.r : meta.g);
	if (p.z < 0.0) {
		vec2 v = p.xy - u_viewport * 0.5;
		float d = length(v);
		gl_Position = d < 1e-4
			? vec4(0.0, 0.0, 0.0, 1.0)
			: toNDC(u_viewport * 0.5 + v * (u_scale / d));
		return;
	}
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

// 6 verts per edge: (A-)(A+)(B+)(A-)(B+)(B-)
// u_pass=0: all non-active edges; u_pass=1: active edges only (drawn last to resolve z-fighting).
// Excluded edges are pushed outside the clip volume so the GPU skips rasterization.
const VS_RENDER = `${GLSL_VS_HEADER}
uniform float u_line_width;
uniform float u_dpr;
uniform int   u_active_id;
uniform int   u_pass;
uniform vec4  u_style_table[256];
uniform vec2  u_dash_table[256];   // [dash_len, gap_len] in px; gap=0 → solid
out vec4  v_color;
out float v_zr;
out float v_dist;       // screen-pixel distance from edge-A to this vert
out float v_perp;       // perpendicular offset from centerline, in DEVICE px
flat out float v_halfw; // half line-width in DEVICE px (solid-core radius)
flat out vec2  v_dash;
flat out float v_dist_base;  // cumulative screen-pixel distance to edge-A (px)

void main() {
	int edge_id = gl_VertexID / 6;
	int sub     = gl_VertexID % 6;
	uvec4 meta  = fetchEdgeMeta(edge_id);
	int feat_id = int(meta.a);

	if (u_pass == 0 && feat_id == u_active_id) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	if (u_pass == 1 && feat_id != u_active_id) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	bool  useA = (sub == 0 || sub == 1 || sub == 3);
	float side = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	uint  si   = useA ? meta.r : meta.g;
	uint  oi   = useA ? meta.g : meta.r;

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
	// Perpendicular half-extent in CSS px = nominal half-width + 1 device-px of
	// AA feather (1/u_dpr CSS px), so the alpha ramp has room OUTSIDE the nominal
	// edge instead of being clipped by the quad boundary.
	float halfCss = u_line_width * 0.5 + 1.0 / u_dpr;
	// Square cap: each endpoint extends away from the other vertex by half
	// line-width.  dir always points from ps toward the other vertex, so
	// -tang is the "away" direction for both the A-end and B-end vertices.
	// This makes adjacent quads overlap at junctions and closes the angle
	// gap that caused pikapika during zoom/pan.
	gl_Position = toNDC(ps.xy + side * halfCss * perp
	                          - tang * (u_line_width * 0.5));

	int style_idx = int(meta.b & 0xFFu);
	v_color = (u_pass == 1)
		? vec4(1.0, 0.9, 0.0, 1.0)
		: u_style_table[style_idx];
	v_dash      = u_dash_table[style_idx];
	// Dash in screen pixels (constant visual size across zoom levels).
	// v_dist_base: cumulative pixel distance to edge-A = vertex_index × (u_scale × sin1°).
	// v_dist: local pixel distance 0→len within this edge.
	v_dist_base = float(meta.b >> 8u) * u_scale * 0.017453292;
	v_dist = useA ? 0.0 : len;
	// Signed perpendicular distance from centerline in DEVICE px (= CSS px × dpr).
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
out vec4  fragColor;
void main() {
	if (v_zr < -0.05)     discard;
	if (v_color.a == 0.0) discard;

	// horizon soft fade
	float alpha = v_color.a * smoothstep(-0.01, 0.02, v_zr);

	// dash pattern
	if (v_dash.y > 0.0) {
		float d      = v_dist_base + v_dist;
		float period = v_dash.x + v_dash.y;
		float t      = mod(d, period);
		float aa     = max(fwidth(v_dist), 0.001);
		alpha *= 1.0 - smoothstep(v_dash.x - aa, v_dash.x + aa, t);
	}

	// edge antialiasing — v_perp is signed device-px distance from the centerline,
	// so fwidth(v_perp) ≈ 1 device px regardless of line width. Coverage is full
	// (1.0) within the solid core (|v_perp| ≤ v_halfw) and ramps over ~1px at the
	// edge, giving a crisp solid line even at sub-pixel widths.
	float aaW = max(fwidth(v_perp), 1e-3);
	alpha *= clamp((v_halfw - abs(v_perp)) / aaW + 0.5, 0.0, 1.0);

	if (alpha < 0.004) discard;
	fragColor = vec4(v_color.rgb, alpha);
}`;

// GPU picking shaders: encode fid+1 as RGB 24-bit. (0,0,0) means "no feature".

// Polyline picking: outputs fid color as a fat-line quad. Single pass, no stencil.
const VS_PICK_LINE = `${GLSL_VS_HEADER}
uniform float u_line_width;
out vec4  v_color;
out float v_zr;

void main() {
	int edge_id = gl_VertexID / 6;
	int sub     = gl_VertexID % 6;
	uvec4 meta  = fetchEdgeMeta(edge_id);

	// style 0 = polygon edge, 1 = polyline. Polygon edges are identified
	// by JS ray-casting (findPolygon), so discard them here.
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

// Point picking: outputs fid color as a circle quad.
const VS_PICK_POINT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_pt_tex;
uniform usampler2D u_pt_meta_tex;
uniform int        u_pt_w;
uniform vec3       u_rotate;
uniform float      u_scale;
uniform vec2       u_viewport;
uniform vec4       u_rsincos;
uniform float      u_pt_radius;
uniform uint       u_ix_center;
uniform uint       u_iy_center;
uniform vec4       u_jac;
out float v_zr;
out vec2  v_uv;
out vec4  v_color;

uint compact16(uint m) {
	m &= 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}

// Signed shortest Δlongitude in 1e-7° units; folds with the correct 360e7 period
// so points across the ±180° antimeridian are not mis-wrapped (see VS_RENDER header).
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b);
	float f = float(d);
	float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { f = 3.6e9 - f; s = -s; }
	return f * s;
}

void main() {
	int pt_id = gl_VertexID / 6;
	int sub   = gl_VertexID % 6;
	float ox = (sub == 2 || sub == 4 || sub == 5) ? 1.0 : -1.0;
	float oy = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;

	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	uvec4 px = texelFetch(u_pt_tex, tc, 0);
	uint hi_c = px.g & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c)       << 16u) | compact16(px.r);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(px.r >> 1u);
	float dx = dlonE7(ix, u_ix_center);   // antimeridian-correct (360e7 period)
	float dy = float(int(iy - u_iy_center));
	float hw = u_viewport.x * 0.5, hh = u_viewport.y * 0.5;
	float px_, py_, zr;
	if (dot(u_jac, u_jac) > 0.0) {
		float sx = u_jac.x * dx + u_jac.z * dy;
		float sy = u_jac.y * dx + u_jac.w * dy;
		float d2 = (sx*sx + sy*sy) / (u_scale * u_scale);
		zr = d2 < 1.0 ? sqrt(1.0 - d2) : -1.0;
		px_ = hw + sx; py_ = hh + sy;
	} else {
		const float DEG2RAD_E7 = 1.7453292519943295e-9;
		float dl = dx * DEG2RAD_E7, dphi = dy * DEG2RAD_E7;
		float cf = u_rsincos.x, sf = u_rsincos.y, cg = u_rsincos.z, sg = u_rsincos.w;
		float sdphi = sin(dphi), cdphi = cos(dphi), sdl = sin(dl);
		float cp = cf*cdphi + sf*sdphi, sp = cf*sdphi - sf*cdphi;
		float shalf = sin(dl*0.5), omc = 2.0*shalf*shalf;
		float x = cp*sdl, yr = sdphi - cp*omc*sf;
		zr = cp*(1.0-omc)*cf - sp*sf;
		px_ = hw + u_scale*(x*cg - yr*sg); py_ = hh - u_scale*(x*sg + yr*cg);
	}
	v_zr = zr;
	v_uv = vec2(ox, oy);
	gl_Position = vec4(2.0*(px_ + ox*u_pt_radius)/u_viewport.x - 1.0,
					   1.0 - 2.0*(py_ + oy*u_pt_radius)/u_viewport.y,
					   0.0, 1.0);

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

// 6 verts/point: quad centred on projected point. All vertices are L1 (no masking).
const VS_POINT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_pt_tex;
uniform usampler2D u_pt_meta_tex;
uniform int        u_pt_w;
uniform vec3       u_rotate;
uniform float      u_scale;
uniform vec2       u_viewport;
uniform vec4       u_rsincos;
uniform float      u_pt_radius;
uniform int        u_active_id;
uniform uint       u_ix_center;
uniform uint       u_iy_center;
uniform vec4       u_jac;
out float v_zr;
out vec2  v_uv;
out vec4  v_color;

uint compact16(uint m) {
	m &= 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}

// Signed shortest Δlongitude in 1e-7° units; folds with the correct 360e7 period
// so points across the ±180° antimeridian are not mis-wrapped (see VS_RENDER header).
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b);
	float f = float(d);
	float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { f = 3.6e9 - f; s = -s; }
	return f * s;
}

void main() {
	int pt_id = gl_VertexID / 6;
	int sub   = gl_VertexID % 6;
	float ox = (sub == 2 || sub == 4 || sub == 5) ? 1.0 : -1.0;
	float oy = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;

	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	uvec4 px = texelFetch(u_pt_tex, tc, 0);
	uint hi_c = px.g & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c)       << 16u) | compact16(px.r);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(px.r >> 1u);
	float dx = dlonE7(ix, u_ix_center);   // antimeridian-correct (360e7 period)
	float dy = float(int(iy - u_iy_center));
	float hw = u_viewport.x * 0.5, hh = u_viewport.y * 0.5;
	float px_, py_, zr;
	if (dot(u_jac, u_jac) > 0.0) {
		float sx = u_jac.x * dx + u_jac.z * dy;
		float sy = u_jac.y * dx + u_jac.w * dy;
		float d2 = (sx*sx + sy*sy) / (u_scale * u_scale);
		zr = d2 < 1.0 ? sqrt(1.0 - d2) : -1.0;
		px_ = hw + sx; py_ = hh + sy;
	} else {
		const float DEG2RAD_E7 = 1.7453292519943295e-9;
		float dl = dx * DEG2RAD_E7, dphi = dy * DEG2RAD_E7;
		float cf = u_rsincos.x, sf = u_rsincos.y, cg = u_rsincos.z, sg = u_rsincos.w;
		float sdphi = sin(dphi), cdphi = cos(dphi), sdl = sin(dl);
		float cp = cf*cdphi + sf*sdphi, sp = cf*sdphi - sf*cdphi;
		float shalf = sin(dl*0.5), omc = 2.0*shalf*shalf;
		float x = cp*sdl, yr = sdphi - cp*omc*sf;
		zr = cp*(1.0-omc)*cf - sp*sf;
		px_ = hw + u_scale*(x*cg - yr*sg); py_ = hh - u_scale*(x*sg + yr*cg);
	}
	v_zr = zr;
	v_uv = vec2(ox, oy);
	int feat_id = int(texelFetch(u_pt_meta_tex, tc, 0).r);
	bool isActive = (feat_id == u_active_id);
	float r = isActive ? u_pt_radius * 1.6 : u_pt_radius;
	gl_Position = vec4(2.0*(px_ + ox*r)/u_viewport.x - 1.0,
					   1.0 - 2.0*(py_ + oy*r)/u_viewport.y,
					   0.0, 1.0);
	v_color = isActive
		? vec4(1.0, 0.9, 0.0, 1.0)
		: vec4(1.0, 0.420, 0.208, 1.0);
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

const SHARED_UNIFORM_NAMES = [
	'u_arc_tex','u_meta_tex','u_arc_w','u_meta_w',
	'u_rotate','u_scale','u_viewport','u_rsincos',
	'u_ix_center','u_iy_center','u_jac',
];

// Compile all gint programs, collect uniforms, set up blend state.
// Returns { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
//           pointProgram, pickLineProgram, pickPointProgram,
//           uRender, uStencil, uFill, uMaskStencil, uPoint, uPickLine, uPickPoint, emptyVAO }
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
	const uPoint       = getUniforms(gl, pointProgram,       ['u_pt_tex','u_pt_meta_tex','u_pt_w','u_rotate','u_scale','u_viewport','u_rsincos','u_pt_radius','u_active_id','u_ix_center','u_iy_center','u_jac']);
	const uPickLine    = getUniforms(gl, pickLineProgram,    [...SHARED_UNIFORM_NAMES, 'u_line_width']);
	const uPickPoint   = getUniforms(gl, pickPointProgram,   ['u_pt_tex','u_pt_meta_tex','u_pt_w','u_rotate','u_scale','u_viewport','u_rsincos','u_pt_radius','u_ix_center','u_iy_center','u_jac']);

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


