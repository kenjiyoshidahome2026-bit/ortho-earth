// WebGL2 arc renderer for gint format.
// Morton decode + orthographic projection in vertex shader (GPU).
// Fat lines via geometry expansion: each segment → 2 triangles (quad).
// Back-hemisphere clipping via v_zr < 0 discard in fragment shader.

let canvas, gl, dpr, width, height;

// GL resources
let program;
let aVself, aVother, aVside, uArcBuf, uTexWidth, uRotate, uScale, uTranslate, uViewport, uColor, uLineWidth;
let polyVAO, polyVBO, polyCount = 0;
let lineVAO, lineVBO, lineCount = 0;
let arcTex = null;
let TEX_WIDTH = 4096; // clamped to MAX_TEXTURE_SIZE after GL init

// Data
let arcMeta = null, polygon = null, polyline = null, hasData = false;

// ── Shaders ───────────────────────────────────────────────────────────────────

const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_arcBuf;
uniform int        u_texWidth;
uniform vec3       u_rotate;    // [lambda, phi, gamma] degrees
uniform float      u_scale;     // sphere radius in logical pixels
uniform vec2       u_translate; // [tx, ty] logical pixels
uniform vec2       u_viewport;  // [width, height] logical pixels
uniform float      u_lineWidth; // full line width in logical pixels

in int a_self;   // this endpoint's arc buffer index
in int a_other;  // other endpoint's arc buffer index
in int a_side;   // -1 or +1: which side of the segment normal

out float v_zr;

const float PI  = 3.14159265358979;
const float RAD = PI / 180.0;

uint compact(uint m) {
    m &= 0x55555555u;
    m = (m | (m >> 1u)) & 0x33333333u;
    m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
    m = (m | (m >> 4u)) & 0x00FF00FFu;
    m = (m | (m >> 8u)) & 0x0000FFFFu;
    return m;
}

// Decode arc buffer entry → (screen_x, screen_y, zr) in logical pixels
vec3 fetchProject(int vi) {
    ivec2 tc = ivec2(vi % u_texWidth, vi / u_texWidth);
    uvec4 t  = texelFetch(u_arcBuf, tc, 0);
    uint lo = t.r, hi = t.g;
    bool isL1 = (hi >> 31u) != 0u;
    uint lo_c = isL1 ? lo : (lo & 0xFFFFFFC0u);
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
}

void main() {
    vec3 ps = fetchProject(a_self);
    vec3 po = fetchProject(a_other);

    v_zr = ps.z;

    // Screen-space perpendicular (logical pixels)
    vec2 dir = po.xy - ps.xy;
    float len = length(dir);
    if (len < 1e-4) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
    vec2 perp = vec2(-dir.y, dir.x) / len;

    vec2 pos = ps.xy + float(a_side) * (u_lineWidth * 0.5) * perp;

    gl_Position = vec4(2.0 * pos.x / u_viewport.x - 1.0,
                       1.0 - 2.0 * pos.y / u_viewport.y,
                       0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in  float v_zr;
out vec4  fragColor;
void main() {
    if (v_zr < 0.0) discard;
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

function linkProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER,   vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p));
    return p;
}

// Stride-3 Int32 VBO: [self, other, side] per vertex
function makeVAO(vbo) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 12; // 3 × 4 bytes
    gl.enableVertexAttribArray(aVself);
    gl.vertexAttribIPointer(aVself,  1, gl.INT, stride, 0);
    gl.enableVertexAttribArray(aVother);
    gl.vertexAttribIPointer(aVother, 1, gl.INT, stride, 4);
    gl.enableVertexAttribArray(aVside);
    gl.vertexAttribIPointer(aVside,  1, gl.INT, stride, 8);
    gl.bindVertexArray(null);
    return vao;
}

// Each segment (A→B) expands to 2 triangles (6 vertices):
//   tri0: (A,B,-1), (A,B,+1), (B,A,+1)  →  A_bot, A_top, B_bot
//   tri1: (A,B,-1), (B,A,+1), (B,A,-1)  →  A_bot, B_bot, B_top
function buildIndices(groups, isPolygon) {
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

function uploadVBO(vbo, data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
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
    program = linkProgram(VS, FS);
    gl.useProgram(program);

    aVself     = gl.getAttribLocation(program,  "a_self");
    aVother    = gl.getAttribLocation(program,  "a_other");
    aVside     = gl.getAttribLocation(program,  "a_side");
    uArcBuf    = gl.getUniformLocation(program, "u_arcBuf");
    uTexWidth  = gl.getUniformLocation(program, "u_texWidth");
    uRotate    = gl.getUniformLocation(program, "u_rotate");
    uScale     = gl.getUniformLocation(program, "u_scale");
    uTranslate = gl.getUniformLocation(program, "u_translate");
    uViewport  = gl.getUniformLocation(program, "u_viewport");
    uColor     = gl.getUniformLocation(program, "u_color");
    uLineWidth = gl.getUniformLocation(program, "u_lineWidth");

    polyVBO = gl.createBuffer();
    lineVBO = gl.createBuffer();
    polyVAO = makeVAO(polyVBO);
    lineVAO = makeVAO(lineVBO);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    postMessage({ action: "done", type: "init", ctx: gl.constructor.name });
}

function set(data) {
    if (data.cmd === "gint" && data.data) {
        const { arcBuffer, arcMeta: am, polygon: pg, polyline: pl } = data.data;

        arcMeta  = am ?? null;
        polygon  = pg?.length  ? pg : null;
        polyline = pl?.length  ? pl : null;
        hasData  = !!(arcBuffer && arcMeta && (polygon || polyline));

        if (hasData) {
            // Upload arcBuffer as RG32UI texture
            const u32      = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);
            const numVerts = u32.length / 2;
            const texH     = Math.ceil(numVerts / TEX_WIDTH);
            const padded   = new Uint32Array(TEX_WIDTH * texH * 2);
            padded.set(u32);

            if (arcTex) gl.deleteTexture(arcTex);
            arcTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, arcTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI,
                          TEX_WIDTH, texH, 0,
                          gl.RG_INTEGER, gl.UNSIGNED_INT, padded);

            // Build stride-3 VBOs (6 verts per segment → idx.length / 3 draw vertices)
            if (polygon) {
                const idx = buildIndices(polygon, true);
                polyCount = idx.length / 3;
                uploadVBO(polyVBO, idx);
            } else { polyCount = 0; }

            if (polyline) {
                const idx = buildIndices(polyline, false);
                lineCount = idx.length / 3;
                uploadVBO(lineVBO, idx);
            } else { lineCount = 0; }

            console.log(`[gint] loaded: arcs=${am.length / 8}, polyVerts=${polyCount}, lineVerts=${lineCount}`);
        }
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
    if (!hasData || !arcTex) return;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, arcTex);
    gl.uniform1i(uArcBuf,    0);
    gl.uniform1i(uTexWidth,  TEX_WIDTH);
    gl.uniform3f(uRotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
    gl.uniform1f(uScale,     data.scale);
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
    gl.bindVertexArray(null);
}

function drawn() {}

function destroy(data) {
    if (gl) {
        if (arcTex)  { gl.deleteTexture(arcTex);       arcTex  = null; }
        if (polyVAO) { gl.deleteVertexArray(polyVAO);  polyVAO = null; }
        if (lineVAO) { gl.deleteVertexArray(lineVAO);  lineVAO = null; }
        if (polyVBO) { gl.deleteBuffer(polyVBO);       polyVBO = null; }
        if (lineVBO) { gl.deleteBuffer(lineVBO);       lineVBO = null; }
        if (program) { gl.deleteProgram(program);      program = null; }
    }
    arcMeta = polygon = polyline = null;
    hasData = false;
    postMessage({ action: "done", type: "destroy" });
}
