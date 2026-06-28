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

uint compact16(uint m) {
	m &= 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}

vec3 fetchProject(uint idx) {
	ivec2 tc = ivec2(int(idx) % u_arc_w, int(idx) / u_arc_w);
	uvec4 px = texelFetch(u_arc_tex, tc, 0);
	uint lo = px.r, hi = px.g;
	uint lo_c = ((hi >> 31u) != 0u) ? lo : (lo & 0xFFFFFFC0u);
	uint hi_c = hi & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c) << 16u) | compact16(lo_c);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(lo_c >> 1u);
	float lng = float(ix) * 1e-7 - 180.0;
	float lat = float(iy) * 1e-7 - 90.0;
	const float RAD = 0.017453292519943295;
	float r0 = u_rotate.x;
	float l  = (lng + r0) * RAD;
	float phi = lat * RAD;
	float cf = u_rsincos.x, sf = u_rsincos.y;
	float cg = u_rsincos.z, sg = u_rsincos.w;
	float cp = cos(phi), sp = sin(phi), cl = cos(l), sl = sin(l);
	float x = cp * sl, y = sp, z = cp * cl;
	float yr = y * cf + z * sf;
	float zr = z * cf - y * sf;
	float hw = u_viewport.x * 0.5, hh = u_viewport.y * 0.5;
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
uniform int   u_active_id;
uniform int   u_pass;
uniform vec4  u_style_table[256];
uniform vec2  u_dash_table[256];   // [dash_len, gap_len] in px; gap=0 → solid
out vec4  v_color;
out float v_zr;
out float v_dist;       // screen-pixel distance from edge-A to this vert
out float v_perp;       // perpendicular offset: -1.0 (left) to +1.0 (right)
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
	vec2 perp = vec2(-dir.y, dir.x) / len;
	gl_Position = toNDC(ps.xy + side * (u_line_width * 0.5) * perp);

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
	v_perp = side;
}`;

const FS_RENDER = `#version 300 es
precision mediump float;
in  vec4  v_color;
in  float v_zr;
in  float v_dist;
in  float v_perp;
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

	// edge antialiasing
	float edgeAA = max(fwidth(v_perp), 0.001);
	alpha *= 1.0 - smoothstep(1.0 - edgeAA, 1.0 + edgeAA, abs(v_perp));

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
	vec2 perp = vec2(-dir.y, dir.x) / len;
	gl_Position = toNDC(ps.xy + side * (u_line_width * 0.5) * perp);

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
	float lng = float(ix) * 1e-7 - 180.0;
	float lat = float(iy) * 1e-7 - 90.0;
	const float RAD = 0.017453292519943295;
	float l = (lng + u_rotate.x) * RAD, phi = lat * RAD;
	float cf = u_rsincos.x, sf = u_rsincos.y;
	float cg = u_rsincos.z, sg = u_rsincos.w;
	float cp = cos(phi), sp = sin(phi), cl = cos(l), sl = sin(l);
	float x = cp*sl, y = sp, z = cp*cl;
	float yr = y*cf + z*sf, zr = z*cf - y*sf;
	float hw = u_viewport.x*0.5, hh = u_viewport.y*0.5;
	float px_ = hw + u_scale*(x*cg - yr*sg);
	float py_ = hh - u_scale*(x*sg + yr*cg);
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
	float lng = float(ix) * 1e-7 - 180.0;
	float lat = float(iy) * 1e-7 - 90.0;
	const float RAD = 0.017453292519943295;
	float l = (lng + u_rotate.x) * RAD, phi = lat * RAD;
	float cf = u_rsincos.x, sf = u_rsincos.y;
	float cg = u_rsincos.z, sg = u_rsincos.w;
	float cp = cos(phi), sp = sin(phi), cl = cos(l), sl = sin(l);
	float x = cp*sl, y = sp, z = cp*cl;
	float yr = y*cf + z*sf, zr = z*cf - y*sf;
	float hw = u_viewport.x*0.5, hh = u_viewport.y*0.5;
	float px_ = hw + u_scale*(x*cg - yr*sg);
	float py_ = hh - u_scale*(x*sg + yr*cg);
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

	const uRender      = getUniforms(gl, renderProgram,      [...SHARED_UNIFORM_NAMES, 'u_line_width', 'u_active_id', 'u_pass', 'u_style_table', 'u_dash_table']);
	const uStencil     = getUniforms(gl, stencilProgram,     SHARED_UNIFORM_NAMES);
	const uFill        = getUniforms(gl, fillProgram,        ['u_fill_color']);
	const uMaskStencil = getUniforms(gl, maskStencilProgram, [...SHARED_UNIFORM_NAMES, 'u_active_id']);
	const uPoint       = getUniforms(gl, pointProgram,       ['u_pt_tex','u_pt_meta_tex','u_pt_w','u_rotate','u_scale','u_viewport','u_rsincos','u_pt_radius','u_active_id']);
	const uPickLine    = getUniforms(gl, pickLineProgram,    [...SHARED_UNIFORM_NAMES, 'u_line_width']);
	const uPickPoint   = getUniforms(gl, pickPointProgram,   ['u_pt_tex','u_pt_meta_tex','u_pt_w','u_rotate','u_scale','u_viewport','u_rsincos','u_pt_radius']);

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


