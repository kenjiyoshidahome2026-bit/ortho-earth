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
    vec2 dir = po.xy - ps.xy;
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

// ── Worker message handlers ───────────────────────────────────────────────────

const funcs = { init, set, resize, drawing, drawn, destroy };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

function init(data) {
    canvas = data.offscreen;
    dpr    = data.dpr;
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
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

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    postMessage({ action: "done", type: "init", ctx: gl.constructor.name });
}

function set(data) {
    if (data.cmd === "gint" && data.data) {
        const { arcBuffer, arcMeta: am, polygon: pg, polyline: pl, pointBuffer: ptBuf } = data.data;

        arcMeta  = am ?? null;
        polygon  = pg?.length  ? pg : null;
        polyline = pl?.length  ? pl : null;
        hasArcData = !!(arcBuffer && arcMeta && (polygon || polyline));
        hasPtData  = !!(ptBuf?.length);

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

    gl.bindVertexArray(null);
}

function drawn() {}

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
        if (program)      { gl.deleteProgram(program);       program      = null; }
        if (pointProgram) { gl.deleteProgram(pointProgram);  pointProgram = null; }
    }
    arcMeta = polygon = polyline = null;
    hasArcData = hasPtData = false;
    postMessage({ action: "done", type: "destroy" });
}
