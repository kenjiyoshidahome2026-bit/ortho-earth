let canvas, gl, dpr, width, height;
let renderProgram, stencilProgram, fillProgram;
let arcTex = null, metaTex = null;
let arcBufferObj = null, metaBufferObj = null;
let emptyVAO = null;
let totalTriangles = 0;
let wasmConverter = null;
let activeId = -1;

const funcs = { init, set, resize, drawing, move, leave, click, destroy };
onmessage = e => { (funcs[e.data.type] ?? (() => {}))(e.data); };

function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
}

function linkProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
}

const VS_RENDER = `#version 300 es
uniform samplerBuffer u_arc_buffer;
uniform usamplerBuffer u_polygon_meta_buffer;
uniform float u_zoom_threshold;
uniform mat4 u_mvp_matrix;
uniform vec3 u_camera_pos;
uniform int u_active_id;
uniform vec4 u_style_table[256];
out vec4 v_color;
const float INV_SCALE_E = 1.0 / 10000000.0;
const float RAD = 3.141592653589793 / 180.0;

uint compact16(uint m) {
    m &= 0x55555555u;
    m = (m | (m >> 1)) & 0x33333333u;
    m = (m | (m >> 2)) & 0x0F0F0F0Fu;
    m = (m | (m >> 4)) & 0x00FF00FFu;
    m = (m | (m >> 8)) & 0x0000FFFFu;
    return m & 0xFFFFu;
}

vec3 unpack_gint_to_sphere(uint low32, uint high32) {
    uint ix = ((compact16(high32) << 16) | compact16(low32)) & 0xFFFFFFFFuint;
    uint iy = ((compact16(high32 >> 1) << 16) | compact16(low32 >> 1)) & 0xFFFFFFFFuint;
    float lng = (float(ix) * INV_SCALE_E) - 180.0;
    float lat = (float(iy) * INV_SCALE_E) - 90.0;
    float lambda = lng * RAD;
    float phi = lat * RAD;
    float cos_phi = cos(phi);
    return vec3(cos_phi * sin(lambda), sin(phi), cos_phi * cos(lambda));
}

void main() {
    int triangle_id = gl_VertexID / 3;
    int vertex_sub_id = gl_VertexID % 3;
    uvec4 polygon_data = texelFetch(u_polygon_meta_buffer, triangle_id);
    uint arc_offset = polygon_data.x;
    uint arc_len = polygon_data.y;
    uint style_id = polygon_data.z;
    int feat_id = int(polygon_data.w);
    
    uint target_vertex_idx = arc_offset;
    if (vertex_sub_id == 1) target_vertex_idx = arc_offset + uint(triangle_id + 1) % (arc_len - 1u);
    if (vertex_sub_id == 2) target_vertex_idx = arc_offset + uint(triangle_id + 2) % (arc_len - 1u);
    
    uvec4 raw_pixel = texelFetch(u_arc_buffer, int(target_vertex_idx));
    uint low32 = raw_pixel.r;
    uint high32 = raw_pixel.g;
    uint node_weight = high32 & 0x3Fuint;
    
    if (node_weight < uint(u_zoom_threshold) && target_vertex_idx != arc_offset) {
        target_vertex_idx = arc_offset;
        raw_pixel = texelFetch(u_arc_buffer, int(target_vertex_idx));
        low32 = raw_pixel.r;
        high32 = raw_pixel.g;
    }
    
    vec3 sphere_pos = unpack_gint_to_sphere(low32, high32);
    vec3 normal = normalize(sphere_pos);
    vec3 view_dir = normalize(sphere_pos - u_camera_pos);
    if (dot(normal, view_dir) >= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    
    v_color = (feat_id == u_active_id) ? vec4(1.0, 0.9, 0.0, 1.0) : u_style_table[style_id & 0xFFuint];
    gl_Position = u_mvp_matrix * vec4(sphere_pos, 1.0);
}
`;

const FS_RENDER = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() {
    if (v_color.a == 0.0) discard;
    fragColor = v_color;
}
`;

const VS_STENCIL = `#version 300 es
uniform samplerBuffer u_arc_buffer;
uniform usamplerBuffer u_polygon_meta_buffer;
uniform float u_zoom_threshold;
uniform mat4 u_mvp_matrix;
uniform vec3 u_camera_pos;
const float INV_SCALE_E = 1.0 / 10000000.0;
const float RAD = 3.141592653589793 / 180.0;

uint compact16(uint m) {
    m &= 0x55555555u;
    m = (m | (m >> 1)) & 0x33333333u;
    m = (m | (m >> 2)) & 0x0F0F0F0Fu;
    m = (m | (m >> 4)) & 0x00FF00FFu;
    m = (m | (m >> 8)) & 0x0000FFFFu;
    return m & 0xFFFFu;
}

vec3 unpack_gint_to_sphere(uint low32, uint high32) {
    uint ix = ((compact16(high32) << 16) | compact16(low32)) & 0xFFFFFFFFuint;
    uint iy = ((compact16(high32 >> 1) << 16) | compact16(low32 >> 1)) & 0xFFFFFFFFuint;
    float lng = (float(ix) * INV_SCALE_E) - 180.0;
    float lat = (float(iy) * INV_SCALE_E) - 90.0;
    float lambda = lng * RAD;
    float phi = lat * RAD;
    float cos_phi = cos(phi);
    return vec3(cos_phi * sin(lambda), sin(phi), cos_phi * cos(lambda));
}

void main() {
    int triangle_id = gl_VertexID / 3;
    int vertex_sub_id = gl_VertexID % 3;
    uvec4 polygon_data = texelFetch(u_polygon_meta_buffer, triangle_id);
    uint arc_offset = polygon_data.x;
    uint arc_len = polygon_data.y;
    
    uint target_vertex_idx = arc_offset;
    if (vertex_sub_id == 1) target_vertex_idx = arc_offset + uint(triangle_id + 1) % (arc_len - 1u);
    if (vertex_sub_id == 2) target_vertex_idx = arc_offset + uint(triangle_id + 2) % (arc_len - 1u);
    
    uvec4 raw_pixel = texelFetch(u_arc_buffer, int(target_vertex_idx));
    uint low32 = raw_pixel.r;
    uint high32 = raw_pixel.g;
    uint node_weight = high32 & 0x3Fuint;
    
    if (node_weight < uint(u_zoom_threshold) && target_vertex_idx != arc_offset) {
        target_vertex_idx = arc_offset;
        raw_pixel = texelFetch(u_arc_buffer, int(target_vertex_idx));
        low32 = raw_pixel.r;
        high32 = raw_pixel.g;
    }
    
    vec3 sphere_pos = unpack_gint_to_sphere(low32, high32);
    vec3 normal = normalize(sphere_pos);
    vec3 view_dir = normalize(sphere_pos - u_camera_pos);
    if (dot(normal, view_dir) >= 0.0) {
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    
    gl_Position = u_mvp_matrix * vec4(sphere_pos, 1.0);
}
`;

const FS_STENCIL = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }
`;

const VS_FILL = `#version 300 es
void main() {
    vec2 p;
    if (gl_VertexID == 0) p = vec2(-1.0, -1.0);
    else if (gl_VertexID == 1) p = vec2(1.0, -1.0);
    else if (gl_VertexID == 2) p = vec2(-1.0, 1.0);
    else p = vec2(1.0, 1.0);
    gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FS_FILL = `#version 300 es
precision highp float;
uniform vec4 u_fill_color;
out vec4 fragColor;
void main() { fragColor = u_fill_color; }
`;

function init(data) {
    canvas = data.offscreen;
    dpr = data.dpr;
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, stencil: true, premultipliedAlpha: false });
    if (!gl) return;

    renderProgram = linkProgram(VS_RENDER, FS_RENDER);
    stencilProgram = linkProgram(VS_STENCIL, FS_STENCIL);
    fillProgram = linkProgram(VS_FILL, FS_FILL);

    emptyVAO = gl.createVertexArray();
    gl.bindVertexArray(emptyVAO);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    postMessage({ action: "done", type: "init" });
}

function set(data) {
    if (data.cmd === "gint" && data.data) {
        const { arcBuffer, arcMeta, totalTriCount, wasmInstance } = data.data;
        wasmConverter = wasmInstance;
        totalTriangles = totalTriCount;

        if (arcTex) gl.deleteTexture(arcTex);
        if (arcBufferObj) gl.deleteBuffer(arcBufferObj);
        arcBufferObj = gl.createBuffer();
        gl.bindBuffer(gl.TEXTURE_BUFFER, arcBufferObj);
        gl.bufferData(gl.TEXTURE_BUFFER, arcBuffer, gl.STATIC_DRAW);
        arcTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_BUFFER, arcTex);
        gl.texBuffer(gl.TEXTURE_BUFFER, gl.RGBA32UI, arcBufferObj);

        if (metaTex) gl.deleteTexture(metaTex);
        if (metaBufferObj) gl.deleteBuffer(metaBufferObj);
        metaBufferObj = gl.createBuffer();
        gl.bindBuffer(gl.TEXTURE_BUFFER, metaBufferObj);
        gl.bufferData(gl.TEXTURE_BUFFER, arcMeta, gl.STATIC_DRAW);
        metaTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_BUFFER, metaTex);
        gl.texBuffer(gl.TEXTURE_BUFFER, gl.RGBA32UI, metaBufferObj);

        activeId = -1;
    }
    postMessage({ action: "done", type: "set" });
}

function resize(data) {
    width = data.width; height = data.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, width * dpr, height * dpr);
    postMessage({ action: "done", type: "resize" });
}

function drawing(data) {
    if (totalTriangles === 0) return;

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xFF);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
    gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
    gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);

    gl.useProgram(stencilProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_BUFFER, arcTex);
    gl.uniform1i(gl.getUniformLocation(stencilProgram, "u_arc_buffer"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_BUFFER, metaTex);
    gl.uniform1i(gl.getUniformLocation(stencilProgram, "u_polygon_meta_buffer"), 1);

    gl.uniform1f(gl.getUniformLocation(stencilProgram, "u_zoom_threshold"), data.zoomThreshold);
    gl.uniformMatrix4fv(gl.getUniformLocation(stencilProgram, "u_mvp_matrix"), false, data.mvpMatrix);
    gl.uniform3fv(gl.getUniformLocation(stencilProgram, "u_camera_pos"), data.cameraPos);

    gl.bindVertexArray(emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, totalTriangles * 3);

    gl.colorMask(true, true, true, true);
    gl.stencilMask(0x00);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

    gl.useProgram(fillProgram);
    gl.uniform4fv(gl.getUniformLocation(fillProgram, "u_fill_color"), data.fillColor);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disable(gl.STENCIL_TEST);

    gl.useProgram(renderProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_BUFFER, arcTex);
    gl.uniform1i(gl.getUniformLocation(renderProgram, "u_arc_buffer"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_BUFFER, metaTex);
    gl.uniform1i(gl.getUniformLocation(renderProgram, "u_polygon_meta_buffer"), 1);

    gl.uniform1f(gl.getUniformLocation(renderProgram, "u_zoom_threshold"), data.zoomThreshold);
    gl.uniformMatrix4fv(gl.getUniformLocation(renderProgram, "u_mvp_matrix"), false, data.mvpMatrix);
    gl.uniform3fv(gl.getUniformLocation(renderProgram, "u_camera_pos"), data.cameraPos);
    gl.uniform1i(gl.getUniformLocation(renderProgram, "u_active_id"), activeId);
    gl.uniform4fv(gl.getUniformLocation(renderProgram, "u_style_table"), data.styleTable);

    gl.drawArrays(gl.TRIANGLES, 0, totalTriangles * 3);
}

function move(data) {
    if (!wasmConverter) return;
    const hitId = wasmConverter.identify_polygon(data.mix, data.miy);
    if (hitId !== activeId) {
        activeId = hitId;
        postMessage({ action: "identify", featureId: hitId === -1 ? null : hitId });
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
        if (arcTex) gl.deleteTexture(arcTex);
        if (metaTex) gl.deleteTexture(metaTex);
        if (arcBufferObj) gl.deleteBuffer(arcBufferObj);
        if (metaBufferObj) gl.deleteBuffer(metaBufferObj);
        if (emptyVAO) gl.deleteVertexArray(emptyVAO);
    }
    arcTex = metaTex = arcBufferObj = metaBufferObj = emptyVAO = null;
    wasmConverter = null;
    totalTriangles = 0;
    activeId = -1;
    postMessage({ action: "done", type: "destroy" });
}