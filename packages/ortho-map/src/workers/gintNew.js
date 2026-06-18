// WebGL2 gint renderer — fully gl_VertexID driven, no vertex buffers.
//
// metaTex (RGBA32UI): one texel per arc edge after LOD filtering.
//   r = vert_A index, g = vert_B index, b = style_id, a = feat_id
//
// Stencil pass (3 verts/edge): fan triangle (NDC-origin, A, B) for every edge across
//   ALL rings of ALL polygons including holes.  INCR_WRAP(front)/DECR_WRAP(back) makes
//   hole rings cancel their outer ring — no CPU tessellation needed.
//
// Fill pass: flood-fill NOTEQUAL-0 stencil area with fillColor.
//
// Render pass (6 verts/edge): fat-line quad per edge, per-feature color from style_table.
//
// Projection uniforms match gint.js: u_rotate (degrees), u_scale (px/rad), u_viewport (px).

let canvas, gl, dpr, width, height;
let renderProgram, stencilProgram, fillProgram, pointProgram;
let uRender, uStencil, uFill, uPoint;
let arcTex = null, metaTex = null, ptTex = null;
let emptyVAO = null;
let totalEdges = 0, totalPoints = 0;
let TEX_ARC_W = 4096, TEX_META_W = 4096;
let wasmConverter = null;
let activeId = -1;

// JS hit-test state (mirrors gint.js)
let arcBufJS = null, arcMetaJS = null, polygonJS = null, polylineJS = null;
let ptBufJS = null, ptFeatureIdsJS = null;
let arcIdToFeature = null, polyBboxJS = null;
let lastR = [0,0,0], lastS = 1, lastW = 0, lastH = 0;

// Style defaults (set once; caller may override via drawing data)
const DEF_STYLE = new Float32Array(256 * 4);
DEF_STYLE.set([1.0, 0.420, 0.208, 1.0]);      // style 0: polygon  #FF6B35
DEF_STYLE.set([0.0, 0.706, 0.847, 1.0],  4);  // style 1: polyline #00B4D8
const DEF_FILL  = new Float32Array([0, 0, 0, 0]); // transparent — outlines only

const funcs = { init, set, resize, drawing, drawn, move, leave, click, destroy };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

// ── GLSL shared vertex shader header ─────────────────────────────────────────
// fetchProject: Morton decode + orthographic projection — identical to gint.js.
// Returns vec3(screen_x, screen_y, zr) where zr < 0 means back hemisphere.

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

// ── Stencil vertex shader ─────────────────────────────────────────────────────
// sub=0 → NDC origin (screen center = winding fan pivot)
// sub=1 → vertex A,  sub=2 → vertex B
// Back-hemisphere verts collapse to NDC origin → degenerate triangle.

const VS_STENCIL = `${GLSL_VS_HEADER}
void main() {
    int edge_id = gl_VertexID / 3;
    int sub     = gl_VertexID % 3;
    if (sub == 0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
    uvec4 meta = fetchEdgeMeta(edge_id);
    vec3  p    = fetchProject(sub == 1 ? meta.r : meta.g);
    if (p.z < 0.0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
    gl_Position = toNDC(p.xy);
}`;

// ── Render vertex shader (fat lines) ─────────────────────────────────────────
// 6 verts per edge: sub layout matches gint.js buildArcIndices
//   (A-) (A+) (B+)  (A-) (B+) (B-)
// Other-endpoint on back hemisphere → clamped to horizon.

const VS_RENDER = `${GLSL_VS_HEADER}
uniform float u_line_width;
uniform int   u_active_id;
uniform vec4  u_style_table[256];
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
    v_zr = ps.z;  // FSで v_zr < 0 → discard。早期returnしないことでGPUクリッピングを回避

    vec3  po  = fetchProject(oi);
    // 他端が背面半球のとき地平線にクランプ。しないと fat-line quad が地球外へ伸びる
    vec2 oXY  = (po.z < 0.0 && ps.z > 0.0)
        ? ps.xy + (ps.z / (ps.z - po.z)) * (po.xy - ps.xy)
        : po.xy;

    vec2 dir = oXY - ps.xy;
    float len = length(dir);
    if (len < 1e-4) { gl_Position = toNDC(ps.xy); return; }  // 零面積→描画なし
    vec2 perp = vec2(-dir.y, dir.x) / len;
    gl_Position = toNDC(ps.xy + side * (u_line_width * 0.5) * perp);

    int feat_id = int(meta.a);
    v_color = (feat_id == u_active_id)
        ? vec4(1.0, 0.9, 0.0, 1.0)
        : u_style_table[meta.b & 0xFFu];
}`;

// ── Fragment shaders ──────────────────────────────────────────────────────────

const FS_RENDER = `#version 300 es
precision mediump float;
in  vec4  v_color;
in  float v_zr;
out vec4  fragColor;
void main() {
    if (v_zr < 0.0)       discard;
    if (v_color.a == 0.0) discard;
    fragColor = v_color;
}`;

// ── Point shaders ─────────────────────────────────────────────────────────────
// 6 verts/point: quad (ox,oy ∈ {-1,+1}) centred on the projected point.
// All point buffer vertices are L1 — bit63 check omitted, no masking.

const VS_POINT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_pt_tex;
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
    gl_Position = vec4(2.0*(px_ + ox*u_pt_radius)/u_viewport.x - 1.0,
                       1.0 - 2.0*(py_ + oy*u_pt_radius)/u_viewport.y,
                       0.0, 1.0);
    v_color = (pt_id == u_active_id)
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

// ── GL helpers ────────────────────────────────────────────────────────────────

function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
}

function linkProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER,   vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
}

function getUniforms(prog, names) {
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return u;
}

function uploadTex2D(u32, w, h, internalFmt, fmt) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, gl.UNSIGNED_INT, u32);
    return tex;
}

// ── Worker message handlers ───────────────────────────────────────────────────

function init(data) {
    canvas = data.offscreen;
    dpr    = data.dpr;
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, stencil: true, premultipliedAlpha: false });
    if (!gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }

    TEX_ARC_W  = Math.min(TEX_ARC_W,  gl.getParameter(gl.MAX_TEXTURE_SIZE));
    TEX_META_W = Math.min(TEX_META_W, gl.getParameter(gl.MAX_TEXTURE_SIZE));

    renderProgram  = linkProgram(VS_RENDER,  FS_RENDER);
    stencilProgram = linkProgram(VS_STENCIL, FS_STENCIL);
    fillProgram    = linkProgram(VS_FILL,    FS_FILL);
    pointProgram   = linkProgram(VS_POINT,   FS_POINT);

    const sharedNames = ['u_arc_tex','u_meta_tex','u_arc_w','u_meta_w','u_rotate','u_scale','u_viewport','u_rsincos'];
    uRender  = getUniforms(renderProgram,  [...sharedNames, 'u_line_width', 'u_active_id', 'u_style_table']);
    uStencil = getUniforms(stencilProgram, sharedNames);
    uFill    = getUniforms(fillProgram,    ['u_fill_color']);
    uPoint   = getUniforms(pointProgram,   ['u_pt_tex','u_pt_w','u_rotate','u_scale','u_viewport','u_rsincos','u_pt_radius','u_active_id']);

    emptyVAO = gl.createVertexArray();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    postMessage({ action: "done", type: "init", ctx: gl.constructor.name });
}

// ── Edge meta builder ─────────────────────────────────────────────────────────
// Converts gint.js-format polygon/polyline structures into a flat Uint32Array.
// One entry per arc edge: [vert_A, vert_B, style_id, feat_id].
// Reversed arcs (arcIdx < 0) swap A/B to preserve correct stencil winding.

function buildEdgeMeta(arcMeta, polygon, polyline) {
    // Pass 1: count total edges to pre-allocate TypedArray (avoids repeated realloc)
    let total = 0;
    const countArcs = arcs => {
        for (const arcIdx of arcs) total += arcMeta[(arcIdx < 0 ? ~arcIdx : arcIdx) * 8 + 1] - 1;
    };
    if (polygon)  for (const [, comps] of polygon)
        for (const rings of comps) for (const ring of rings) countArcs(ring);
    if (polyline) for (const [, sets]  of polyline)
        for (const arcs of sets) countArcs(arcs);

    // Pass 2: fill pre-allocated buffer
    const buf = new Uint32Array(total * 4);
    let j = 0;
    const addArcs = (arcs, styleId, featId) => {
        const fid = featId >>> 0;
        for (const arcIdx of arcs) {
            const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
            const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
            for (let i = 0; i < len - 1; i++) {
                buf[j++] = arcIdx >= 0 ? off + i         : off + len - 1 - i;
                buf[j++] = arcIdx >= 0 ? off + i + 1     : off + len - 2 - i;
                buf[j++] = styleId;
                buf[j++] = fid;
            }
        }
    };
    if (polygon)  for (const [fid, comps] of polygon)
        for (const rings of comps) for (const ring of rings) addArcs(ring, 0, fid);
    if (polyline) for (const [fid, sets]  of polyline)
        for (const arcs of sets) addArcs(arcs, 1, fid);

    return { metaU32: buf, edgeCount: total };
}

// ── arcIdToFeature + polyBbox (for JS hit testing) ───────────────────────────

function buildHitState() {
    arcIdToFeature = new Map();
    if (polygonJS)  for (const [fid, comps] of polygonJS)
        for (const rings of comps) for (const ring of rings) for (const ai of ring)
            arcIdToFeature.set(ai < 0 ? ~ai : ai, { featureId: fid, geomType: 'polygon' });
    if (polylineJS) for (const [fid, sets]  of polylineJS)
        for (const arcs of sets) for (const ai of arcs)
            arcIdToFeature.set(ai < 0 ? ~ai : ai, { featureId: fid, geomType: 'polyline' });

    polyBboxJS = new Map();
    if (polygonJS && arcMetaJS) for (const [fid, comps] of polygonJS) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const rings of comps) for (const ring of rings) for (const ai of ring) {
            const aid = ai < 0 ? ~ai : ai;
            const xmn = arcMetaJS[aid*8+4]*1e-7-180, ymn = arcMetaJS[aid*8+5]*1e-7-90;
            const xmx = arcMetaJS[aid*8+6]*1e-7-180, ymx = arcMetaJS[aid*8+7]*1e-7-90;
            if (xmn < x0) x0=xmn; if (ymn < y0) y0=ymn;
            if (xmx > x1) x1=xmx; if (ymx > y1) y1=ymx;
        }
        polyBboxJS.set(fid, { x0, y0, x1, y1 });
    }
}

function set(data) {
    if (data.cmd === "gint" && data.data) {
        const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point, wasmInstance } = data.data;
        wasmConverter = wasmInstance ?? null;

        // Store JS refs for hit testing
        arcBufJS        = arcBuffer    ?? null;
        arcMetaJS       = arcMeta      ?? null;
        polygonJS       = polygon?.length  ? polygon  : null;
        polylineJS      = polyline?.length ? polyline : null;
        ptBufJS         = pointBuffer?.length ? pointBuffer : null;
        ptFeatureIdsJS  = point        ?? null;
        buildHitState();

        // arcTex: RG32UI — each texel = one 64-bit Morton vertex (lo32, hi32)
        if (arcTex) gl.deleteTexture(arcTex);
        arcTex = null;
        if (arcBuffer?.length) {
            const arcU32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset,
                                           arcBuffer.byteLength / 4);
            const arcH   = Math.ceil(arcU32.length / 2 / TEX_ARC_W);
            const arcPad = new Uint32Array(TEX_ARC_W * arcH * 2);
            arcPad.set(arcU32);
            arcTex = uploadTex2D(arcPad, TEX_ARC_W, arcH, gl.RG32UI, gl.RG_INTEGER);
        }

        // Build metaTex from polygon/polyline structures
        if (metaTex) gl.deleteTexture(metaTex);
        metaTex = null;
        const { metaU32, edgeCount } = buildEdgeMeta(arcMetaJS, polygonJS, polylineJS);
        totalEdges = edgeCount;
        if (totalEdges > 0) {
            const metaH   = Math.ceil(totalEdges / TEX_META_W);
            const metaPad = new Uint32Array(TEX_META_W * metaH * 4);
            metaPad.set(metaU32);
            metaTex = uploadTex2D(metaPad, TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
        }

        // Point texture (RG32UI, L1 only — same layout as arcTex)
        if (ptTex) { gl.deleteTexture(ptTex); ptTex = null; }
        if (ptBufJS?.length) {
            const ptU32  = new Uint32Array(ptBufJS.buffer, ptBufJS.byteOffset, ptBufJS.byteLength / 4);
            totalPoints  = ptU32.length / 2;
            const ptH    = Math.ceil(totalPoints / TEX_ARC_W);
            const ptPad  = new Uint32Array(TEX_ARC_W * ptH * 2);
            ptPad.set(ptU32);
            ptTex = uploadTex2D(ptPad, TEX_ARC_W, ptH, gl.RG32UI, gl.RG_INTEGER);
        } else { totalPoints = 0; }

        activeId = -1;
    }
    postMessage({ action: "done", type: "set" });
}

function resize(data) {
    width = data.width; height = data.height;
    canvas.width  = width  * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, width * dpr, height * dpr);
    postMessage({ action: "done", type: "resize" });
}

function bindSharedUniforms(u, data) {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, arcTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, metaTex);
    gl.uniform1i(u.u_arc_tex,  0);
    gl.uniform1i(u.u_meta_tex, 1);
    gl.uniform1i(u.u_arc_w,    TEX_ARC_W);
    gl.uniform1i(u.u_meta_w,   TEX_META_W);
    gl.uniform3f(u.u_rotate,   data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
    gl.uniform1f(u.u_scale,    data.scale);
    gl.uniform2f(u.u_viewport, width, height);
    const _r1 = data.rotate[1] * Math.PI / 180, _r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
    gl.uniform4f(u.u_rsincos,  Math.cos(_r1), Math.sin(_r1), Math.cos(_r2), Math.sin(_r2));
}

function drawing(data) {
    if (totalEdges === 0 && totalPoints === 0) return;
    lastR = data.rotate; lastS = data.scale; lastW = width; lastH = height;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.bindVertexArray(emptyVAO);

    // ── Stencil + Fill pass (skipped when fillColor is transparent) ──
    // All rings (outer + holes) rendered together. Hole rings have opposite winding
    // → DECR_WRAP cancels INCR_WRAP → correct fill without CPU tessellation.
    const fc = data.fillColor ?? DEF_FILL;
    if (fc[3] > 0) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xFF);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
        gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);

        gl.useProgram(stencilProgram);
        bindSharedUniforms(uStencil, data);
        gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 3);

        gl.colorMask(true, true, true, true);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

        gl.useProgram(fillProgram);
        gl.uniform4fv(uFill.u_fill_color, fc);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.STENCIL_TEST);
    }

    // ── Render pass: fat-line outlines with per-feature colors ──
    gl.useProgram(renderProgram);
    bindSharedUniforms(uRender, data);
    gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);
    gl.uniform1i(uRender.u_active_id,    activeId);
    gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
    if (totalEdges > 0) gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);

    // ── Point pass: circle quads (6 verts/point) ──
    if (totalPoints > 0 && ptTex) {
        gl.useProgram(pointProgram);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
        gl.uniform1i(uPoint.u_pt_tex,    0);
        gl.uniform1i(uPoint.u_pt_w,      TEX_ARC_W);
        gl.uniform3f(uPoint.u_rotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
        gl.uniform1f(uPoint.u_scale,     data.scale);
        gl.uniform2f(uPoint.u_viewport,  width, height);
        const _r1 = data.rotate[1] * Math.PI / 180, _r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
        gl.uniform4f(uPoint.u_rsincos,   Math.cos(_r1), Math.sin(_r1), Math.cos(_r2), Math.sin(_r2));
        gl.uniform1f(uPoint.u_pt_radius, data.ptRadius ?? 1.5);
        gl.uniform1i(uPoint.u_active_id, activeId);
        gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
    }
}

function drawn() {}

// ── JS hit testing (mirrors gint.js; used when no WASM) ──────────────────────

function jsCompact(m) {
    m &= 0x55555555;
    m = (m | (m >>> 1)) & 0x33333333;
    m = (m | (m >>> 2)) & 0x0F0F0F0F;
    m = (m | (m >>> 4)) & 0x00FF00FF;
    m = (m | (m >>> 8)) & 0x0000FFFF;
    return m >>> 0;
}

function decodeLL(buf, vi, isL1 = false) {
    const word  = buf[vi];
    const lo    = Number(word & 0xFFFFFFFFn) >>> 0;
    const hiRaw = Number(word >> 32n)        >>> 0;
    const lo_c  = (isL1 || (hiRaw >>> 31) !== 0) ? lo : (lo & 0xFFFFFFC0) >>> 0;
    const hi_c  = hiRaw & 0x7FFFFFFF;
    const ux    = ((jsCompact(hi_c)       << 16) | jsCompact(lo_c))       >>> 0;
    const uy    = ((jsCompact(hi_c >>> 1) << 16) | jsCompact(lo_c >>> 1)) >>> 0;
    return [ux * 1e-7 - 180, uy * 1e-7 - 90];
}

function pointInPolygon(clng, clat, components) {
    let crossings = 0;
    for (const rings of components) for (const ringArcs of rings) for (const arcIdx of ringArcs) {
        const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
        const off = arcMetaJS[aid*8], len = arcMetaJS[aid*8+1];
        for (let i = 0; i < len - 1; i++) {
            const [alng, alat] = decodeLL(arcBufJS, off + i);
            const [blng, blat] = decodeLL(arcBufJS, off + i + 1);
            if ((alat <= clat && blat > clat) || (blat <= clat && alat > clat)) {
                if (alng + (clat - alat) / (blat - alat) * (blng - alng) > clng) crossings++;
            }
        }
    }
    return (crossings & 1) === 1;
}

function move(data) {
    if (!lastW || (!arcBufJS && !ptBufJS && !wasmConverter)) return;

    // WASM path
    if (wasmConverter) {
        const hitId = wasmConverter.identify(data.x, data.y);
        if (hitId !== activeId) {
            activeId = hitId;
            postMessage({ action: "identify", featureId: hitId === -1 ? null : hitId });
            postMessage({ action: "redraw" });
        }
        return;
    }

    // JS fallback path
    const mx = data.x, my = data.y;
    const RAD = Math.PI / 180;
    const r0 = lastR[0]||0, r1 = lastR[1]||0, r2 = lastR[2]||0;
    const cf = Math.cos(r1*RAD), sf = Math.sin(r1*RAD);
    const cg = Math.cos(r2*RAD), sg = Math.sin(r2*RAD);
    const hw = lastW/2, hh = lastH/2, S = lastS;

    function proj(lng, lat) {
        const l = (lng+r0)*RAD, phi = lat*RAD;
        const cp = Math.cos(phi), sp = Math.sin(phi), cl = Math.cos(l), sl = Math.sin(l);
        const x = cp*sl, y = sp, z = cp*cl;
        const yr = y*cf + z*sf, zr = z*cf - y*sf;
        return [hw + S*(x*cg - yr*sg), hh - S*(x*sg + yr*cg), zr];
    }

    const THR_SQ = 64;
    let bestId = null, bestType = null, bestDist = THR_SQ;

    // Points (prefer over arcs when closer)
    if (ptBufJS) {
        for (let i = 0; i < ptBufJS.length; i++) {
            const [lng, lat] = decodeLL(ptBufJS, i, true);
            const [px, py, pzr] = proj(lng, lat);
            if (pzr < 0) continue;
            const d = (px - mx) ** 2 + (py - my) ** 2;
            if (d < bestDist) {
                bestDist = d;
                bestId   = ptFeatureIdsJS ? ptFeatureIdsJS[i] : i;
                bestType = 'point';
            }
        }
    }

    if (arcBufJS && arcMetaJS && arcIdToFeature) {
        const nArcs = arcMetaJS.length / 8;
        for (let aid = 0; aid < nArcs; aid++) {
            const bcLng = (arcMetaJS[aid*8+4] + arcMetaJS[aid*8+6]) * 0.5e-7 - 180;
            const bcLat = (arcMetaJS[aid*8+5] + arcMetaJS[aid*8+7]) * 0.5e-7 - 90;
            const [cx, cy, czr] = proj(bcLng, bcLat);
            if (czr < 0) continue;
            const dLat = (arcMetaJS[aid*8+7]-arcMetaJS[aid*8+5])*1e-7*S*RAD;
            const dLng = (arcMetaJS[aid*8+6]-arcMetaJS[aid*8+4])*1e-7*S*RAD*Math.cos(bcLat*RAD);
            const sr = Math.sqrt(dLat*dLat + dLng*dLng) + 8;
            if ((cx-mx)**2 + (cy-my)**2 > (sr+8)**2) continue;

            const off = arcMetaJS[aid*8], len = arcMetaJS[aid*8+1];
            const verts = [];
            for (let i = 0; i < len; i++) verts.push(proj(...decodeLL(arcBufJS, off+i)));
            for (let i = 0; i < len-1; i++) {
                const [ax,ay,azr] = verts[i], [bx,by] = verts[i+1];
                if (azr < 0) continue;
                const ddx = bx-ax, ddy = by-ay, segSq = ddx*ddx+ddy*ddy;
                if (segSq < 0.01) continue;
                const t = Math.max(0, Math.min(1, ((mx-ax)*ddx+(my-ay)*ddy)/segSq));
                const d = (ax+t*ddx-mx)**2 + (ay+t*ddy-my)**2;
                if (d < bestDist) {
                    const info = arcIdToFeature.get(aid);
                    if (info) { bestDist = d; bestId = info.featureId; bestType = info.geomType; }
                }
            }
        }
    }

    // PIP fallback for polygon interior
    if (bestId == null && polygonJS && polyBboxJS) {
        const U = (mx-hw)/S, V = (hh-my)/S;
        if (U*U + V*V <= 1.0) {
            const zrS = Math.sqrt(1 - U*U - V*V);
            const xS =  U*cg + V*sg, yrS = -U*sg + V*cg;
            const yOrig = yrS*cf - zrS*sf, zOrig = yrS*sf + zrS*cf;
            let clng = Math.atan2(xS, zOrig)*(180/Math.PI) - r0;
            clng = ((clng+180)%360+360)%360 - 180;
            const clat = Math.asin(Math.max(-1, Math.min(1, yOrig)))*(180/Math.PI);
            for (const [fid, comps] of polygonJS) {
                const bb = polyBboxJS.get(fid);
                if (!bb || clng<bb.x0 || clng>bb.x1 || clat<bb.y0 || clat>bb.y1) continue;
                if (pointInPolygon(clng, clat, comps)) { bestId = fid; bestType = 'polygon'; break; }
            }
        }
    }

    const newId = bestId ?? -1;
    if (newId !== activeId) {
        activeId = newId;
        postMessage({ action: "identify", featureId: bestId ?? null, geomType: bestType });
        postMessage({ action: "redraw" });
    }
}

function leave() {
    if (activeId === -1) return;
    activeId = -1;
    postMessage({ action: "identify", featureId: null });
    postMessage({ action: "redraw" });
}

function click() {
    if (activeId === -1) return;
    postMessage({ action: "click", featureId: activeId });
}

function destroy() {
    if (gl) {
        if (arcTex)         gl.deleteTexture(arcTex);
        if (metaTex)        gl.deleteTexture(metaTex);
        if (ptTex)          gl.deleteTexture(ptTex);
        if (emptyVAO)       gl.deleteVertexArray(emptyVAO);
        if (renderProgram)  gl.deleteProgram(renderProgram);
        if (stencilProgram) gl.deleteProgram(stencilProgram);
        if (fillProgram)    gl.deleteProgram(fillProgram);
        if (pointProgram)   gl.deleteProgram(pointProgram);
    }
    arcTex = metaTex = ptTex = emptyVAO = null;
    renderProgram = stencilProgram = fillProgram = pointProgram = null;
    uRender = uStencil = uFill = uPoint = null;
    wasmConverter = null;
    totalEdges = totalPoints = 0;
    activeId = -1;
    arcBufJS = arcMetaJS = polygonJS = polylineJS = null;
    ptBufJS = ptFeatureIdsJS = null;
    arcIdToFeature = polyBboxJS = null;
    postMessage({ action: "done", type: "destroy" });
}
