// WebGL2 arc + point renderer for gint format.
// Morton decode + orthographic projection runs entirely in the vertex shader.
// Fat lines via geometry expansion (gl.TRIANGLES).
// Points rendered as circles via UV discard in fragment shader.
// Back-hemisphere clipping via v_zr < 0 discard.

let canvas, gl, dpr, width, height;

// GL resources — arcs
let program;
let uArcBuf, uTexWidth, uRotate, uScale, uTranslate, uViewport, uColor, uLineWidth;
let polyVAO, polyVBO, polyCount = 0;
let lineVAO, lineVBO, lineCount = 0;
let arcTex = null;

// GL resources — points
let pointProgram;
let uPArcBuf, uPTexWidth, uPRotate, uPScale, uPTranslate, uPViewport, uPColor, uPRadius;
let ptVAO, ptVBO, ptCount = 0;
let pointTex = null;

let TEX_WIDTH = 4096; // clamped to MAX_TEXTURE_SIZE after GL init

let arcMeta = null, polygon = null, polyline = null;
let hasArcData = false, hasPtData = false;

// GL resources — highlight outline
let hlVAO, hlVBO, highlightCount = 0;

// GL resources — stencil polygon fill
let stencilProgram;
let uStArcBuf, uStTexWidth, uStRotate, uStScale, uStTranslate, uStViewport;
let fillProgram, uFillColor;
let hlStVBO, hlStVAO, hlStCount = 0;
let emptyVAO;

// Hit testing state (JS-side mirror of GPU data)
let arcBufJS = null; // BigUint64Array kept for JS hit test
let ptBufJS  = null; // BigUint64Array kept for JS hit test
let ptFeatureIds = null; // Uint32Array: point index → featureId
let arcIdToFeature = null; // Map<arcId, {featureId, geomType}>

// Cached drawing params for move() hit testing
let lastR = [0, 0, 0], lastS = 1, lastW = 0, lastH = 0;

// Active identify state
let activeId = null, activeType = null;

// Per-feature bbox (degrees) for polygon PIP pre-cull
let polyBbox = null; // Map<featureId, {xmin,ymin,xmax,ymax}>

// ── Shared GLSL: Morton decode + orthographic projection ──────────────────────
// l1Only=true → pointBuffer (all L1); GPU compiler eliminates dead branch.

function makeSharedVS(l1Only = false) {
    const decodeL1 = l1Only
        ? `uint lo_c = lo;`
        : `bool isL1 = (hi >> 31u) != 0u;\n    uint lo_c = isL1 ? lo : (lo & 0xFFFFFFC0u);`;
    return `precision highp float;
precision highp int;
precision highp usampler2D;
const float PI  = 3.14159265358979;
const float RAD = PI / 180.0;
uniform usampler2D u_arcBuf;
uniform int        u_texWidth;
uniform vec3       u_rotate;
uniform float      u_scale;
uniform vec2       u_translate;
uniform vec2       u_viewport;
uint compact(uint m) {
    m &= 0x55555555u;
    m = (m | (m >> 1u)) & 0x33333333u;
    m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
    m = (m | (m >> 4u)) & 0x00FF00FFu;
    m = (m | (m >> 8u)) & 0x0000FFFFu;
    return m;
}
vec3 fetchProject(int vi) {
    ivec2 tc = ivec2(vi % u_texWidth, vi / u_texWidth);
    uvec4 t  = texelFetch(u_arcBuf, tc, 0);
    uint lo = t.r, hi = t.g;
    ${decodeL1}
    uint hi_c = hi & 0x7FFFFFFFu;
    uint ux = (compact(hi_c)       << 16u) | compact(lo_c);
    uint uy = (compact(hi_c >> 1u) << 16u) | compact(lo_c >> 1u);
    float lng = float(ux) * 1.0e-7 - 180.0;
    float lat = float(uy) * 1.0e-7 -  90.0;
    float r0 = u_rotate.x, r1 = u_rotate.y, r2 = u_rotate.z;
    float l   = (lng + r0) * RAD;
    float phi = lat * RAD;
    float cf = cos(r1 * RAD), sf = sin(r1 * RAD);
    float cg = cos(r2 * RAD), sg = sin(r2 * RAD);
    float cp = cos(phi), sp = sin(phi), cl = cos(l), sl = sin(l);
    float x  = cp * sl, y = sp, z = cp * cl;
    float yr = y * cf + z * sf;
    float zr = z * cf - y * sf;
    float px = u_translate.x + u_scale * (x * cg - yr * sg);
    float py = u_translate.y - u_scale * (x * sg + yr * cg);
    return vec3(px, py, zr);
}`;
}

// ── Arc vertex shader (fat lines via geometry expansion) ──────────────────────

const VS = `#version 300 es
${makeSharedVS()}
uniform float u_lineWidth;
in int   a_self;
in int   a_other;
in int   a_side;
out float v_zr;
void main() {
    vec3 ps = fetchProject(a_self);
    vec3 po = fetchProject(a_other);
    v_zr = ps.z;
    // Clamp other endpoint to the horizon when it's on the back hemisphere.
    // Without this, the fat-line quad extends toward the unprojected back-face
    // coordinate and streaks outside the globe disc when zoomed out.
    vec2 oXY = (po.z < 0.0 && ps.z > 0.0)
        ? ps.xy + (ps.z / (ps.z - po.z)) * (po.xy - ps.xy)
        : po.xy;
    vec2 dir = oXY - ps.xy;
    float len = length(dir);
    if (len < 1e-4) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
    vec2 perp = vec2(-dir.y, dir.x) / len;
    vec2 pos  = ps.xy + float(a_side) * (u_lineWidth * 0.5) * perp;
    gl_Position = vec4(2.0 * pos.x / u_viewport.x - 1.0,
                       1.0 - 2.0 * pos.y / u_viewport.y, 0.0, 1.0);
}`;

// ── Point vertex shader (circle quad expansion) ───────────────────────────────
// a_other = x offset (-1/+1), a_side = y offset (-1/+1); all points are L1.

const VS_POINT = `#version 300 es
${makeSharedVS(true)}
uniform float u_radius;
in int   a_self;
in int   a_other;
in int   a_side;
out float v_zr;
out vec2  v_uv;
void main() {
    vec3 ps = fetchProject(a_self);
    v_zr = ps.z;
    float ox = float(a_other), oy = float(a_side);
    v_uv = vec2(ox, oy);
    vec2 pos = ps.xy + vec2(ox, oy) * u_radius;
    gl_Position = vec4(2.0 * pos.x / u_viewport.x - 1.0,
                       1.0 - 2.0 * pos.y / u_viewport.y, 0.0, 1.0);
}`;

// ── Fragment shaders ──────────────────────────────────────────────────────────

const FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in  float v_zr;
out vec4  fragColor;
void main() {
    if (v_zr < 0.0) discard;
    fragColor = u_color;
}`;

const FS_POINT = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in  float v_zr;
in  vec2  v_uv;
out vec4  fragColor;
void main() {
    if (v_zr < 0.0) discard;
    if (dot(v_uv, v_uv) > 1.0) discard;
    fragColor = u_color;
}`;

// ── Stencil fill shaders ──────────────────────────────────────────────────────
// Fan triangles from NDC origin → each arc edge, using INVERT stencil op.
// Back-hemisphere vertices are clamped to the origin so triangles degenerate.

const VS_STENCIL = `#version 300 es
${makeSharedVS()}
in int a_self;
in int a_other;
in int a_side;
void main() {
    if (a_self < 0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 ps = fetchProject(a_self);
    if (ps.z < 0.0)  { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }
    gl_Position = vec4(2.0*ps.x/u_viewport.x-1.0, 1.0-2.0*ps.y/u_viewport.y, 0.0, 1.0);
}`;

const FS_STENCIL = `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`;

// Full-screen quad via gl_VertexID — no VBO needed.
const VS_FILL = `#version 300 es
void main() {
    vec2 p;
    if      (gl_VertexID == 0) p = vec2(-1.0, -1.0);
    else if (gl_VertexID == 1) p = vec2( 1.0, -1.0);
    else if (gl_VertexID == 2) p = vec2(-1.0,  1.0);
    else                        p = vec2( 1.0,  1.0);
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS_FILL = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;

// ── GL helpers ────────────────────────────────────────────────────────────────

function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s));
    return s;
}

// Bind a_self=0, a_other=1, a_side=2 explicitly so all programs share the VAO layout.
function linkProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER,   vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "a_self");
    gl.bindAttribLocation(p, 1, "a_other");
    gl.bindAttribLocation(p, 2, "a_side");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p));
    return p;
}

// Stride-3 Int32 VBO: [a_self, a_other, a_side] — shared layout for arcs and points.
function makeVAO(vbo) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 12; // 3 × 4 bytes
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 1, gl.INT, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.INT, stride, 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.INT, stride, 8);
    gl.bindVertexArray(null);
    return vao;
}

// Upload arcBuffer (or pointBuffer) as RG32UI texture.
function uploadTexture(bigU64) {
    const u32     = new Uint32Array(bigU64.buffer, bigU64.byteOffset, bigU64.byteLength / 4);
    const nVerts  = u32.length / 2;
    const texH    = Math.ceil(nVerts / TEX_WIDTH);
    const padded  = new Uint32Array(TEX_WIDTH * texH * 2);
    padded.set(u32);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI, TEX_WIDTH, texH, 0,
                  gl.RG_INTEGER, gl.UNSIGNED_INT, padded);
    return tex;
}

function uploadVBO(vbo, data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
}

// Each arc segment (A→B) → 2 triangles / 6 stride-3 vertices.
// tri0: A_bot, A_top, B_bot  |  tri1: A_bot, B_bot, B_top
function buildArcIndices(groups, isPolygon) {
    const arr = [];
    const addArc = (arcIdx) => {
        const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
        const off = arcMeta[aid * 8];
        const len = arcMeta[aid * 8 + 1];
        for (let i = 0; i < len - 1; i++) {
            const A = off + i, B = off + i + 1;
            arr.push(A, B, -1,  A, B, 1,  B, A, 1,
                     A, B, -1,  B, A, 1,  B, A, -1);
        }
    };
    if (isPolygon) {
        for (const [, components] of groups)
            for (const rings of components)
                for (const ring of rings)
                    for (const arcIdx of ring) addArc(arcIdx);
    } else {
        for (const [, lineSets] of groups)
            for (const arcs of lineSets)
                for (const arcIdx of arcs) addArc(arcIdx);
    }
    return new Int32Array(arr);
}

// Each point → 2 triangles / 6 stride-3 vertices (a_other=ox, a_side=oy ∈ {-1,+1}).
function buildPointIndices(nPoints) {
    const arr = new Int32Array(nPoints * 18);
    let j = 0;
    for (let i = 0; i < nPoints; i++) {
        arr[j++]=i; arr[j++]=-1; arr[j++]=-1;
        arr[j++]=i; arr[j++]=-1; arr[j++]= 1;
        arr[j++]=i; arr[j++]= 1; arr[j++]= 1;
        arr[j++]=i; arr[j++]=-1; arr[j++]=-1;
        arr[j++]=i; arr[j++]= 1; arr[j++]= 1;
        arr[j++]=i; arr[j++]= 1; arr[j++]=-1;
    }
    return arr;
}

// ── JS hit testing helpers (mirror of GLSL compact / fetchProject) ────────────

function jsCompact(m) {
    m &= 0x55555555;
    m = (m | (m >>> 1)) & 0x33333333;
    m = (m | (m >>> 2)) & 0x0F0F0F0F;
    m = (m | (m >>> 4)) & 0x00FF00FF;
    m = (m | (m >>> 8)) & 0x0000FFFF;
    return m >>> 0;
}

// Decode lng/lat from a BigUint64Array slot.
// isL1 = true for pointBuffer (all L1 — skip the bit63 check).
function decodeLL(buf, vi, isL1 = false) {
    const word = buf[vi];
    const lo    = Number(word & 0xFFFFFFFFn) >>> 0;
    const hiRaw = Number(word >> 32n)        >>> 0;
    const lo_c  = (isL1 || (hiRaw >>> 31) !== 0) ? lo : (lo & 0xFFFFFFC0) >>> 0;
    const hi_c  = hiRaw & 0x7FFFFFFF;
    const ux    = ((jsCompact(hi_c)       << 16) | jsCompact(lo_c))       >>> 0;
    const uy    = ((jsCompact(hi_c >>> 1) << 16) | jsCompact(lo_c >>> 1)) >>> 0;
    return [ux * 1e-7 - 180, uy * 1e-7 - 90];
}

// Ray casting PIP — counts edge crossings for ALL rings (outer + holes) combined.
// Crossing count is odd → inside. Direction of arc traversal is irrelevant for
// crossing count, so we always walk forward through the arc buffer.
function pointInPolygon(clng, clat, components) {
    let crossings = 0;
    for (const rings of components) {
        for (const ringArcs of rings) {
            for (const arcIdx of ringArcs) {
                const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
                const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
                for (let i = 0; i < len - 1; i++) {
                    const [alng, alat] = decodeLL(arcBufJS, off + i);
                    const [blng, blat] = decodeLL(arcBufJS, off + i + 1);
                    if ((alat <= clat && blat > clat) || (blat <= clat && alat > clat)) {
                        const xLng = alng + (clat - alat) / (blat - alat) * (blng - alng);
                        if (xLng > clng) crossings++;
                    }
                }
            }
        }
    }
    return (crossings & 1) === 1;
}

// Rebuild highlightVBO for the current activeId / activeType.
function rebuildHighlight() {
    if (activeId == null || !arcMeta) { highlightCount = 0; return; }
    const arr = [];
    const push6 = (aid) => {
        const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
        for (let i = 0; i < len - 1; i++) {
            const A = off + i, B = off + i + 1;
            arr.push(A, B, -1,  A, B, 1,  B, A, 1,
                     A, B, -1,  B, A, 1,  B, A, -1);
        }
    };
    const addIdx = ai => push6(ai < 0 ? ~ai : ai);
    if (activeType === 'polygon' && polygon) {
        for (const [fid, comps] of polygon) {
            if (fid !== activeId) continue;
            for (const rings of comps) for (const ring of rings) for (const ai of ring) addIdx(ai);
            break;
        }
    } else if (activeType === 'polyline' && polyline) {
        for (const [fid, sets] of polyline) {
            if (fid !== activeId) continue;
            for (const arcs of sets) for (const ai of arcs) addIdx(ai);
            break;
        }
    }
    highlightCount = arr.length / 3;
    if (highlightCount > 0) uploadVBO(hlVBO, new Int32Array(arr));
    rebuildStencil();
}

// Build fan triangles for the stencil fill of the active polygon.
// Each edge (A, B) → triangle [-1 (origin), A, B].
// INVERT stencil op implements even-odd fill; holes cancel automatically.
function rebuildStencil() {
    if (activeId == null || activeType !== 'polygon' || !polygon || !arcMeta) {
        hlStCount = 0; return;
    }
    const arr = [];
    for (const [fid, comps] of polygon) {
        if (fid !== activeId) continue;
        for (const rings of comps) for (const ringArcs of rings) for (const arcIdx of ringArcs) {
            const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
            const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
            if (arcIdx >= 0) {
                for (let i = 0; i < len - 1; i++) {
                    const A = off + i, B = off + i + 1;
                    arr.push(-1, 0, 0,  A, 0, 0,  B, 0, 0);
                }
            } else {
                for (let i = len - 1; i > 0; i--) {
                    const A = off + i, B = off + i - 1;
                    arr.push(-1, 0, 0,  A, 0, 0,  B, 0, 0);
                }
            }
        }
        break;
    }
    hlStCount = arr.length / 3;
    if (hlStCount > 0) uploadVBO(hlStVBO, new Int32Array(arr));
}

// ── Worker message handlers ───────────────────────────────────────────────────

const funcs = { init, set, resize, drawing, drawn, destroy, move, leave, click };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

function init(data) {
    canvas = data.offscreen;
    dpr    = data.dpr;
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false, stencil: true });
    if (!gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }

    TEX_WIDTH = Math.min(TEX_WIDTH, gl.getParameter(gl.MAX_TEXTURE_SIZE));

    // Arc program
    program    = linkProgram(VS, FS);
    gl.useProgram(program);
    uArcBuf    = gl.getUniformLocation(program, "u_arcBuf");
    uTexWidth  = gl.getUniformLocation(program, "u_texWidth");
    uRotate    = gl.getUniformLocation(program, "u_rotate");
    uScale     = gl.getUniformLocation(program, "u_scale");
    uTranslate = gl.getUniformLocation(program, "u_translate");
    uViewport  = gl.getUniformLocation(program, "u_viewport");
    uColor     = gl.getUniformLocation(program, "u_color");
    uLineWidth = gl.getUniformLocation(program, "u_lineWidth");

    // Point program
    pointProgram = linkProgram(VS_POINT, FS_POINT);
    uPArcBuf    = gl.getUniformLocation(pointProgram, "u_arcBuf");
    uPTexWidth  = gl.getUniformLocation(pointProgram, "u_texWidth");
    uPRotate    = gl.getUniformLocation(pointProgram, "u_rotate");
    uPScale     = gl.getUniformLocation(pointProgram, "u_scale");
    uPTranslate = gl.getUniformLocation(pointProgram, "u_translate");
    uPViewport  = gl.getUniformLocation(pointProgram, "u_viewport");
    uPColor     = gl.getUniformLocation(pointProgram, "u_color");
    uPRadius    = gl.getUniformLocation(pointProgram, "u_radius");

    polyVBO = gl.createBuffer(); polyVAO = makeVAO(polyVBO);
    lineVBO = gl.createBuffer(); lineVAO = makeVAO(lineVBO);
    ptVBO   = gl.createBuffer(); ptVAO   = makeVAO(ptVBO);
    hlVBO   = gl.createBuffer(); hlVAO   = makeVAO(hlVBO);
    hlStVBO = gl.createBuffer(); hlStVAO = makeVAO(hlStVBO);
    emptyVAO = gl.createVertexArray();

    // Stencil fill programs
    stencilProgram = linkProgram(VS_STENCIL, FS_STENCIL);
    uStArcBuf    = gl.getUniformLocation(stencilProgram, "u_arcBuf");
    uStTexWidth  = gl.getUniformLocation(stencilProgram, "u_texWidth");
    uStRotate    = gl.getUniformLocation(stencilProgram, "u_rotate");
    uStScale     = gl.getUniformLocation(stencilProgram, "u_scale");
    uStTranslate = gl.getUniformLocation(stencilProgram, "u_translate");
    uStViewport  = gl.getUniformLocation(stencilProgram, "u_viewport");

    fillProgram = linkProgram(VS_FILL, FS_FILL);
    uFillColor  = gl.getUniformLocation(fillProgram, "u_color");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    postMessage({ action: "done", type: "init", ctx: gl.constructor.name });
}

function set(data) {
    if (data.cmd === "gint" && data.data) {
        const { arcBuffer, arcMeta: am, polygon: pg, polyline: pl, pointBuffer: ptBuf, point: ptFids } = data.data;

        arcMeta  = am ?? null;
        polygon  = pg?.length  ? pg : null;
        polyline = pl?.length  ? pl : null;
        hasArcData = !!(arcBuffer && arcMeta && (polygon || polyline));
        hasPtData  = !!(ptBuf?.length);

        // Keep JS references for hit testing
        arcBufJS     = hasArcData ? arcBuffer : null;
        ptBufJS      = hasPtData  ? ptBuf     : null;
        ptFeatureIds = ptFids     ?? null;

        // Reverse map: arcId → {featureId, geomType}
        arcIdToFeature = new Map();
        if (polygon)  for (const [fid, comps]  of polygon)
            for (const rings  of comps) for (const ring  of rings) for (const ai of ring)
                arcIdToFeature.set(ai < 0 ? ~ai : ai, { featureId: fid, geomType: 'polygon' });
        if (polyline) for (const [fid, sets]   of polyline)
            for (const arcs   of sets) for (const ai of arcs)
                arcIdToFeature.set(ai < 0 ? ~ai : ai, { featureId: fid, geomType: 'polyline' });

        // Per-feature bbox for PIP pre-cull
        polyBbox = new Map();
        if (polygon) for (const [fid, comps] of polygon) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const rings of comps) for (const ring of rings) for (const ai of ring) {
                const aid = ai < 0 ? ~ai : ai;
                const xmn = arcMeta[aid*8+4]*1e-7-180, ymn = arcMeta[aid*8+5]*1e-7-90;
                const xmx = arcMeta[aid*8+6]*1e-7-180, ymx = arcMeta[aid*8+7]*1e-7-90;
                if (xmn < x0) x0=xmn; if (ymn < y0) y0=ymn;
                if (xmx > x1) x1=xmx; if (ymx > y1) y1=ymx;
            }
            polyBbox.set(fid, { x0, y0, x1, y1 });
        }

        // Reset identify state
        activeId = null; activeType = null; highlightCount = 0;

        if (hasArcData) {
            if (arcTex) gl.deleteTexture(arcTex);
            arcTex = uploadTexture(arcBuffer);

            if (polygon) {
                const idx = buildArcIndices(polygon, true);
                polyCount = idx.length / 3;
                uploadVBO(polyVBO, idx);
            } else { polyCount = 0; }

            if (polyline) {
                const idx = buildArcIndices(polyline, false);
                lineCount = idx.length / 3;
                uploadVBO(lineVBO, idx);
            } else { lineCount = 0; }
        }

        if (hasPtData) {
            if (pointTex) gl.deleteTexture(pointTex);
            pointTex = uploadTexture(ptBuf);
            const idx = buildPointIndices(ptBuf.length);
            ptCount = ptBuf.length * 6;
            uploadVBO(ptVBO, idx);
        } else { ptCount = 0; }

        console.log(`[gint] arcs=${am?.length / 8 ?? 0}, polyVerts=${polyCount}, lineVerts=${lineCount}, points=${ptCount / 6}`);
    }
    postMessage({ action: "done", type: "set", cmd: data.cmd });
}

function resize(data) {
    width = data.width; height = data.height;
    canvas.width  = width  * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, width * dpr, height * dpr);
    postMessage({ action: "done", type: "resize" });
}

function drawing(data) {
    if (!hasArcData && !hasPtData) return;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const r = data.rotate, s = data.scale;
    lastR = r; lastS = s; lastW = width; lastH = height;

    // ── Arc pass ──
    if (hasArcData) {
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, arcTex);
        gl.uniform1i(uArcBuf,    0);
        gl.uniform1i(uTexWidth,  TEX_WIDTH);
        gl.uniform3f(uRotate,    r[0], r[1], r[2] ?? 0);
        gl.uniform1f(uScale,     s);
        gl.uniform2f(uTranslate, width / 2, height / 2);
        gl.uniform2f(uViewport,  width, height);

        if (polygon && polyCount > 0) {
            gl.uniform4f(uColor, 1.0, 0.420, 0.208, 1.0); // #FF6B35
            gl.uniform1f(uLineWidth, 1.0);
            gl.bindVertexArray(polyVAO);
            gl.drawArrays(gl.TRIANGLES, 0, polyCount);
        }
        if (polyline && lineCount > 0) {
            gl.uniform4f(uColor, 0.0, 0.706, 0.847, 1.0); // #00B4D8
            gl.uniform1f(uLineWidth, 1.5);
            gl.bindVertexArray(lineVAO);
            gl.drawArrays(gl.TRIANGLES, 0, lineCount);
        }
    }

    // ── Point pass ──
    if (hasPtData && ptCount > 0) {
        gl.useProgram(pointProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pointTex);
        gl.uniform1i(uPArcBuf,    0);
        gl.uniform1i(uPTexWidth,  TEX_WIDTH);
        gl.uniform3f(uPRotate,    r[0], r[1], r[2] ?? 0);
        gl.uniform1f(uPScale,     s);
        gl.uniform2f(uPTranslate, width / 2, height / 2);
        gl.uniform2f(uPViewport,  width, height);
        gl.uniform4f(uPColor,     1.0, 0.420, 0.208, 1.0); // #FF6B35
        gl.uniform1f(uPRadius,    1.5); // 3px diameter
        gl.bindVertexArray(ptVAO);
        gl.drawArrays(gl.TRIANGLES, 0, ptCount);
    }

    // ── Stencil fill pass (active polygon interior) ──
    if (hasArcData && hlStCount > 0) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xFF);
        gl.clear(gl.STENCIL_BUFFER_BIT);

        // Pass 1: fan triangles → winding number via INCR_WRAP(front) / DECR_WRAP(back).
        // Works regardless of origin position; holes cancel automatically.
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
        gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);

        gl.useProgram(stencilProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, arcTex);
        gl.uniform1i(uStArcBuf,    0);
        gl.uniform1i(uStTexWidth,  TEX_WIDTH);
        gl.uniform3f(uStRotate,    r[0], r[1], r[2] ?? 0);
        gl.uniform1f(uStScale,     s);
        gl.uniform2f(uStTranslate, width / 2, height / 2);
        gl.uniform2f(uStViewport,  width, height);
        gl.bindVertexArray(hlStVAO);
        gl.drawArrays(gl.TRIANGLES, 0, hlStCount);

        // Pass 2: fill where winding number != 0 (= inside polygon)
        gl.colorMask(true, true, true, true);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

        gl.useProgram(fillProgram);
        gl.uniform4f(uFillColor, 1.0, 0.9, 0.0, 0.22); // semi-transparent yellow
        gl.bindVertexArray(emptyVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.stencilMask(0xFF);
        gl.disable(gl.STENCIL_TEST);
    }

    // ── Highlight pass (yellow outline, drawn on top) ──
    if (hasArcData && highlightCount > 0) {
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, arcTex);
        gl.uniform1i(uArcBuf,    0);
        gl.uniform1i(uTexWidth,  TEX_WIDTH);
        gl.uniform3f(uRotate,    r[0], r[1], r[2] ?? 0);
        gl.uniform1f(uScale,     s);
        gl.uniform2f(uTranslate, width / 2, height / 2);
        gl.uniform2f(uViewport,  width, height);
        gl.uniform4f(uColor,     1.0, 0.9, 0.0, 1.0); // yellow
        gl.uniform1f(uLineWidth, 2.5);
        gl.bindVertexArray(hlVAO);
        gl.drawArrays(gl.TRIANGLES, 0, highlightCount);
    }

    gl.bindVertexArray(null);
}

function drawn() {}

function move(data) {
    if (!lastW || (!hasArcData && !hasPtData)) return;

    const mx = data.x, my = data.y;
    const RAD = Math.PI / 180;
    const r0 = lastR[0] || 0, r1 = lastR[1] || 0, r2 = lastR[2] || 0;
    const cf = Math.cos(r1 * RAD), sf = Math.sin(r1 * RAD);
    const cg = Math.cos(r2 * RAD), sg = Math.sin(r2 * RAD);
    const hw = lastW / 2, hh = lastH / 2, S = lastS;

    function proj(lng, lat) {
        const l = (lng + r0) * RAD, phi = lat * RAD;
        const cp = Math.cos(phi), sp = Math.sin(phi), cl = Math.cos(l), sl = Math.sin(l);
        const x = cp * sl, y = sp, z = cp * cl;
        const yr = y * cf + z * sf, zr = z * cf - y * sf;
        return [hw + S * (x * cg - yr * sg), hh - S * (x * sg + yr * cg), zr];
    }

    const THR_SQ = 64; // 8px hit radius
    let bestId = null, bestType = null, bestDistSq = THR_SQ;

    // Points (prefer over arcs when equidistant)
    if (hasPtData && ptBufJS) {
        for (let i = 0; i < ptBufJS.length; i++) {
            const [lng, lat] = decodeLL(ptBufJS, i, true);
            const [px, py, pzr] = proj(lng, lat);
            if (pzr < 0) continue;
            const d = (px - mx) ** 2 + (py - my) ** 2;
            if (d < bestDistSq) { bestDistSq = d; bestId = ptFeatureIds ? ptFeatureIds[i] : i; bestType = 'point'; }
        }
    }

    // Arcs with bbox pre-cull
    if (hasArcData && arcBufJS && arcMeta) {
        const nArcs = arcMeta.length / 8;
        for (let aid = 0; aid < nArcs; aid++) {
            const xmin = arcMeta[aid*8+4], ymin = arcMeta[aid*8+5];
            const xmax = arcMeta[aid*8+6], ymax = arcMeta[aid*8+7];
            const bcLng = (xmin + xmax) * 0.5e-7 - 180;
            const bcLat = (ymin + ymax) * 0.5e-7 - 90;
            const [cx, cy, czr] = proj(bcLng, bcLat);
            if (czr < 0) continue;
            const dLat = (ymax - ymin) * 1e-7 * S * RAD;
            const dLng = (xmax - xmin) * 1e-7 * S * RAD * Math.cos(bcLat * RAD);
            const screenR = Math.sqrt(dLat * dLat + dLng * dLng) + 8;
            const dx = cx - mx, dy = cy - my;
            if (dx * dx + dy * dy > (screenR + 8) * (screenR + 8)) continue;

            const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
            const verts = [];
            for (let i = 0; i < len; i++) verts.push(proj(...decodeLL(arcBufJS, off + i)));
            for (let i = 0; i < len - 1; i++) {
                const [ax, ay, azr] = verts[i], [bx, by] = verts[i + 1];
                if (azr < 0) continue;
                const ddx = bx - ax, ddy = by - ay;
                const segSq = ddx * ddx + ddy * ddy;
                if (segSq < 0.01) continue;
                const t = Math.max(0, Math.min(1, ((mx - ax) * ddx + (my - ay) * ddy) / segSq));
                const nx = ax + t * ddx - mx, ny = ay + t * ddy - my;
                const d = nx * nx + ny * ny;
                if (d < bestDistSq) {
                    const info = arcIdToFeature.get(aid);
                    if (info) { bestDistSq = d; bestId = info.featureId; bestType = info.geomType; }
                }
            }
        }
    }

    // Polygon containment (PIP) fallback — fires when cursor is inside a polygon
    // but not within 8px of any arc edge.
    if (bestId == null && polygon && polyBbox) {
        // Inverse orthographic: screen (mx,my) → (lng, lat)
        const U = (mx - hw) / S, V = (hh - my) / S;
        const xS  =  U * cg + V * sg;
        const yrS = -U * sg + V * cg;
        if (xS * xS + yrS * yrS <= 1.0) {
            const zrS = Math.sqrt(1 - xS * xS - yrS * yrS);
            const yOrig = yrS * cf - zrS * sf;
            const zOrig = yrS * sf + zrS * cf;
            let clng = Math.atan2(xS, zOrig) * (180 / Math.PI) - r0;
            clng = ((clng + 180) % 360 + 360) % 360 - 180; // normalise to [-180,180]
            const clat = Math.asin(Math.max(-1, Math.min(1, yOrig))) * (180 / Math.PI);
            for (const [fid, comps] of polygon) {
                const bb = polyBbox.get(fid);
                if (!bb || clng < bb.x0 || clng > bb.x1 || clat < bb.y0 || clat > bb.y1) continue;
                if (pointInPolygon(clng, clat, comps)) { bestId = fid; bestType = 'polygon'; break; }
            }
        }
    }

    if (bestId !== activeId || bestType !== activeType) {
        activeId = bestId; activeType = bestType;
        rebuildHighlight();
        postMessage({ action: "identify", featureId: bestId, geomType: bestType, x: mx, y: my });
        postMessage({ action: "redraw" });
    }
}

function leave() {
    if (activeId == null) return;
    activeId = null; activeType = null; highlightCount = 0;
    postMessage({ action: "identify", featureId: null });
    postMessage({ action: "redraw" });
}

function click() {
    if (activeId == null) return;
    postMessage({ action: "click", featureId: activeId, geomType: activeType });
}

function destroy(data) {
    if (gl) {
        if (arcTex)   { gl.deleteTexture(arcTex);        arcTex   = null; }
        if (pointTex) { gl.deleteTexture(pointTex);      pointTex = null; }
        if (polyVAO)  { gl.deleteVertexArray(polyVAO);   polyVAO  = null; }
        if (lineVAO)  { gl.deleteVertexArray(lineVAO);   lineVAO  = null; }
        if (ptVAO)    { gl.deleteVertexArray(ptVAO);     ptVAO    = null; }
        if (polyVBO)  { gl.deleteBuffer(polyVBO);        polyVBO  = null; }
        if (lineVBO)  { gl.deleteBuffer(lineVBO);        lineVBO  = null; }
        if (ptVBO)    { gl.deleteBuffer(ptVBO);          ptVBO    = null; }
        if (hlVAO)    { gl.deleteVertexArray(hlVAO);     hlVAO    = null; }
        if (hlVBO)    { gl.deleteBuffer(hlVBO);          hlVBO    = null; }
        if (hlStVAO)  { gl.deleteVertexArray(hlStVAO);   hlStVAO  = null; }
        if (hlStVBO)  { gl.deleteBuffer(hlStVBO);        hlStVBO  = null; }
        if (emptyVAO) { gl.deleteVertexArray(emptyVAO);  emptyVAO = null; }
        if (program)        { gl.deleteProgram(program);        program        = null; }
        if (pointProgram)   { gl.deleteProgram(pointProgram);   pointProgram   = null; }
        if (stencilProgram) { gl.deleteProgram(stencilProgram); stencilProgram = null; }
        if (fillProgram)    { gl.deleteProgram(fillProgram);    fillProgram    = null; }
    }
    arcMeta = polygon = polyline = null;
    arcBufJS = ptBufJS = ptFeatureIds = arcIdToFeature = polyBbox = null;
    hasArcData = hasPtData = false;
    activeId = null; activeType = null; highlightCount = 0; hlStCount = 0;
    postMessage({ action: "done", type: "destroy" });
}
