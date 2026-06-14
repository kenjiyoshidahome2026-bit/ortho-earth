import { geoOrthographic } from "common";
const { PI, round } = Math;
let gl, dpr, width, height;
let proj = geoOrthographic();
let ringBuckets = [];   // [{ vao, count, maxPV }]
let mortonPoolTex, stitchedIboTex;
let program;
let diagFirstLng = NaN, diagFirstLat = NaN, drawCount = 0;

const BUCKET_THRESHOLDS = [16, 64, 256, 1024, 4096, 8192, 16384, 32768]; // arcLen 上限

const gintVs = `#version 300 es
precision highp float;
precision highp int;

layout(location=0) in uint a_arc_offset;
layout(location=1) in uint a_arc_len;

uniform highp usampler2D u_ibo;
uniform highp usampler2D u_morton;
uniform int  u_tex_width;
uniform mat2 u_jacobian;
uniform uvec2 u_center_int;
uniform vec2 u_center_px;
uniform vec2 u_viewport;
uniform float u_globe_radius;

uint compact(uint m) {
    m &= 0x55555555u;
    m = (m|(m>>1u))&0x33333333u;
    m = (m|(m>>2u))&0x0F0F0F0Fu;
    m = (m|(m>>4u))&0x00FF00FFu;
    return (m|(m>>8u))&0x0000FFFFu;
}

void main() {
    vec2 px;
    if (uint(gl_VertexID) == 0u) {
        px = u_center_px;
    } else {
        uint safe = min(uint(gl_VertexID) - 1u, a_arc_len - 1u);
        int iboIdx = int(a_arc_offset + safe);
        uint ptr = texelFetch(u_ibo,    ivec2(iboIdx % u_tex_width, iboIdx / u_tex_width), 0).r;
        int  mIdx = int(ptr);
        uvec2 m64 = texelFetch(u_morton, ivec2(mIdx  % u_tex_width, mIdx  / u_tex_width), 0).rg;
        uint lo = m64.x, hi = m64.y;
        if ((hi >> 31u) == 0u) lo &= 0xFFFFFFC0u;
        uint mhi = hi & 0x7FFFFFFFu;
        uint ux = (compact(mhi)     << 16u) | compact(lo);
        uint uy = (compact(mhi>>1u) << 16u) | compact(lo>>1u);
        // unsigned差分 → 符号付き再解釈（差が±2.147e9未満なら正確）
        int dix = int(ux - u_center_int.x);
        int diy = int(uy - u_center_int.y);
        vec2 dDeg = vec2(float(dix), float(diy)) * 1e-7;
        px = u_center_px + u_jacobian * dDeg;

        // 裏面カリング: 地球半径より遠い頂点はゼロ面積に折り畳む
        if (length(px - u_center_px) > u_globe_radius) px = u_center_px;
    }

    vec2 ndc = px / u_viewport * 2.0 - 1.0;
    gl_Position = vec4(ndc.x, -ndc.y, 0., 1.);
}`;

const gintFs = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;

onmessage = e => {
    const { type, ...data } = e.data;
    if (type === 'init')    init(data);
    else if (type === 'set')     set(data);
    else if (type === 'resize')  resize(data);
    else if (type === 'drawing') drawing(data);
};

function init(data) {
    dpr = data.dpr;
    const ctx = data.offscreen.getContext("webgl2", { stencil: true });
    if (ctx) console.log('[gint] stencil:', ctx.getParameter(ctx.STENCIL_BITS),
                          'maxTex:', ctx.getParameter(ctx.MAX_TEXTURE_SIZE));
    gl = ctx ? initWebGL(ctx) : null;
    postMessage({ action: 'done', type: 'init', ctx: gl ? 'WebGL2RenderingContext' : null });
}

function set(data) {
    if (data.cmd === 'gint' && data.data?.polygon?.length) {
        const { arcBuffer, arcMeta, polygon } = data.data;
        loadGintBuffers(arcBuffer, arcMeta, polygon);
    }
    postMessage({ action: 'done', type: 'set', cmd: data.cmd });
}

function resize(data) {
    if (!gl) return;
    gl.resizeBySize(width = data.width, height = data.height);
    proj.fitExtent([[1,1],[width-1,height-1]], {type:"Sphere"});
}

function drawing(data) {
    if (!gl || !ringBuckets.length) return;
    proj.rotate(data.rotate).scale(data.scale);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    const jacob = updateJacobian(proj);
    if (!drawing._logged) { drawing._logged = true;
        const c = jacob.centerInt;
        console.log(`[gint] drawing: rotate=${JSON.stringify(data.rotate)} scale=${data.scale.toFixed(1)}`);
        console.log(`[gint] centerInt=[${c[0]}, ${c[1]}]  → lng=${(c[0]/1e7-180).toFixed(3)}, lat=${(c[1]/1e7-90).toFixed(3)}`);
        console.log(`[gint] jacobian=[${Array.from(jacob.matrix).map(v=>v.toFixed(3)).join(',')}]`);
    }
    gl.useProgram(program);
    gl.uniformMatrix2fv(gl.jacobian_loc,     false, jacob.matrix);
    gl.uniform2ui(gl.center_int_loc,         jacob.centerInt[0], jacob.centerInt[1]);
    gl.uniform1f(gl.globe_radius_loc,        data.scale);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, stitchedIboTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mortonPoolTex);

    const draw = () => {
        for (const b of ringBuckets) {
            gl.bindVertexArray(b.vao);
            gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, b.maxPV, b.count);
        }
    };

    // PASS 1: 偶奇ステンシル
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0xFF);
    gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    draw();

    // PASS 2: stencil≠0 を着色してクリア
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    draw();

    gl.disable(gl.STENCIL_TEST);
    gl.bindVertexArray(null);
}

function loadGintBuffers(arcBuffer, arcMeta, polygon) {
    // リング収集
    const allRings = [];   // { off, arcLen }
    const indicesStream = [];
    let iboOffset = 0;

    // polygon 構造診断（初回のみ）
    if (polygon.length) {
        const p0comp = polygon[0]?.[1];
        const p0part = p0comp?.[0];
        const p0ring = p0part?.[0];
        const p0arc  = p0ring?.[0];  // should be integer arc index
        console.log(`[gint] polygon[0]: id=${polygon[0][0]}, components.len=${p0comp?.length}, parts[0].len=${p0part?.length}, rings[0].len=${p0ring?.length}, firstArcIdx=${p0arc}`);
        // arcMeta bbox for first arc
        if (typeof p0arc === 'number') {
            const aid = p0arc < 0 ? ~p0arc : p0arc;
            const off = arcMeta[aid*8], alen = arcMeta[aid*8+1];
            const xmin = arcMeta[aid*8+4], ymin = arcMeta[aid*8+5];
            const xmax = arcMeta[aid*8+6], ymax = arcMeta[aid*8+7];
            console.log(`[gint] firstArc[aid=${aid}]: off=${off}, len=${alen}, bbox lng=[${(xmin/1e7-180).toFixed(2)},${(xmax/1e7-180).toFixed(2)}] lat=[${(ymin/1e7-90).toFixed(2)},${(ymax/1e7-90).toFixed(2)}]`);
        }
    }

    for (const [, components] of polygon) {
        for (const rings of components) {
            for (const ring of rings) {
                if (!ring?.length) continue;
                const start = iboOffset;
                let len = 0;
                for (const rawIdx of ring) {
                    const aid = rawIdx < 0 ? ~rawIdx : rawIdx;
                    const off  = arcMeta[aid * 8];
                    const alen = arcMeta[aid * 8 + 1];
                    if (!alen) continue;
                    for (let k = 0; k < alen; k++) indicesStream.push(off + k);
                    len += alen;
                }
                if (len < 3) continue;
                indicesStream.push(indicesStream[start]); // 閉じる
                const arcLen = len + 1;
                allRings.push({ off: start, arcLen });
                iboOffset += arcLen;
            }
        }
    }

    if (!allRings.length) { console.warn('[gint] no rings'); return; }

    // CPU側で最初の頂点をデコードして座標確認
    {
        const firstPtr = indicesStream[0];
        const m = arcBuffer[firstPtr];
        const lo32 = Number(m & 0xFFFFFFFFn);
        const hi32 = Number(m >> 32n);
        const mhi = hi32 & 0x7FFFFFFF;
        const cpt = n => { n&=0x55555555; n=(n|(n>>1))&0x33333333; n=(n|(n>>2))&0x0F0F0F0F; n=(n|(n>>4))&0x00FF00FF; return (n|(n>>8))&0x0000FFFF; };
        const ux = (((cpt(mhi)<<16)|cpt(lo32))>>>0);
        const uy = (((cpt(mhi>>1)<<16)|cpt(lo32>>1))>>>0);
        console.log(`[gint] first vertex: lng=${(ux/1e7-180).toFixed(3)}, lat=${(uy/1e7-90).toFixed(3)}  rings=${allRings.length} maxArcLen=${allRings.reduce((m,r)=>Math.max(m,r.arcLen),0)}`);
    }

    // サイズバケット分割: 最長リングに全リングを揃えず、グループ内最大に合わせる
    const bucketGroups = [...BUCKET_THRESHOLDS.map(() => []), []];
    for (const r of allRings) {
        let placed = false;
        for (let b = 0; b < BUCKET_THRESHOLDS.length; b++) {
            if (r.arcLen <= BUCKET_THRESHOLDS[b]) { bucketGroups[b].push(r); placed = true; break; }
        }
        if (!placed) bucketGroups[BUCKET_THRESHOLDS.length].push(r);
    }

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const TEX_W  = Math.min(4096, maxTex);

    // IBO テクスチャ (R32UI)
    const iboData = new Uint32Array(indicesStream);
    const iboH    = Math.ceil(iboData.length / TEX_W);
    const iboPad  = new Uint32Array(TEX_W * iboH);
    iboPad.set(iboData);
    stitchedIboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, stitchedIboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, TEX_W, iboH, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, iboPad);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Morton テクスチャ (RG32UI)
    const arcU32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);
    const mortN  = arcBuffer.length;
    const mortH  = Math.ceil(mortN / TEX_W);
    const mortPad = new Uint32Array(TEX_W * mortH * 2);
    mortPad.set(arcU32);
    mortonPoolTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, mortonPoolTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI, TEX_W, mortH, 0, gl.RG_INTEGER, gl.UNSIGNED_INT, mortPad);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.useProgram(program);
    gl.uniform1i(gl.tex_width_loc, TEX_W);

    // VAO をバケットごとに生成
    ringBuckets = [];
    let totalV = 0;
    for (const group of bucketGroups) {
        if (!group.length) continue;
        const maxArcLen = group.reduce((m, r) => Math.max(m, r.arcLen), 0);
        const maxPV = maxArcLen + 1; // vid=0 が扇の固定原点
        const meta  = new Uint32Array(group.length * 2);
        group.forEach(({ off, arcLen }, i) => { meta[i*2] = off; meta[i*2+1] = arcLen; });
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, meta, gl.STATIC_DRAW);
        // location 0: a_arc_offset, location 1: a_arc_len (stride=8, 各4byte)
        gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 8, 0); gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 8, 4); gl.vertexAttribDivisor(1, 1);
        gl.bindVertexArray(null);
        ringBuckets.push({ vao, count: group.length, maxPV });
        totalV += maxPV * group.length;
    }

    const summary = ringBuckets.map(b => `${b.count}×${b.maxPV}`).join(', ');
    console.log(`[gint] buckets=[${summary}] totalRings=${allRings.length} totalV=${totalV} mortN=${mortN}`);
}

function initWebGL(ctx) {
    ctx.clearColor(0, 0, 0, 0);
    ctx.enable(ctx.BLEND);
    ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);

    const compile = (type, src) => {
        const s = ctx.createShader(type);
        ctx.shaderSource(s, src); ctx.compileShader(s);
        if (!ctx.getShaderParameter(s, ctx.COMPILE_STATUS))
            console.error('[gint] shader:', ctx.getShaderInfoLog(s));
        return s;
    };
    program = ctx.createProgram();
    ctx.attachShader(program, compile(ctx.VERTEX_SHADER, gintVs));
    ctx.attachShader(program, compile(ctx.FRAGMENT_SHADER, gintFs));
    ctx.linkProgram(program);
    if (!ctx.getProgramParameter(program, ctx.LINK_STATUS))
        console.error('[gint] link:', ctx.getProgramInfoLog(program));
    ctx.useProgram(program);

    ctx.jacobian_loc     = ctx.getUniformLocation(program, 'u_jacobian');
    ctx.center_int_loc   = ctx.getUniformLocation(program, 'u_center_int');
    ctx.center_px_loc    = ctx.getUniformLocation(program, 'u_center_px');
    ctx.viewport_loc     = ctx.getUniformLocation(program, 'u_viewport');
    ctx.color_loc        = ctx.getUniformLocation(program, 'u_color');
    ctx.tex_width_loc    = ctx.getUniformLocation(program, 'u_tex_width');
    ctx.globe_radius_loc = ctx.getUniformLocation(program, 'u_globe_radius');
    ctx.uniform1i(ctx.getUniformLocation(program, 'u_ibo'),    0);
    ctx.uniform1i(ctx.getUniformLocation(program, 'u_morton'), 1);
    ctx.uniform4f(ctx.color_loc, 1.0, 0.42, 0.2, 0.4);

    ctx.resizeBySize = (w, h) => {
        ctx.viewport(0, 0, ctx.canvas.width = w * dpr, ctx.canvas.height = h * dpr);
        ctx.useProgram(program);
        ctx.uniform2f(ctx.viewport_loc,   w, h);
        ctx.uniform2f(ctx.center_px_loc,  w / 2, h / 2);
    };
    return ctx;
}

function updateJacobian(proj) {
    const [r0, r1, r2 = 0] = proj.rotate();
    const s   = proj.scale() * PI / 180;
    const rad = PI / 180;
    const cosPhi = Math.cos(-r1 * rad);
    const cosG = Math.cos(r2 * rad), sinG = Math.sin(r2 * rad);
    return {
        // column-major mat2 for uniformMatrix2fv (transpose=false)
        // col0=[j11,j21], col1=[j12,j22]
        matrix: new Float32Array([
            s * cosPhi * cosG,   // j11  dx/dlng
            s * cosPhi * sinG,   // j21  dy/dlng
           -s * sinG,            // j12  dx/dlat
           -s * cosG,            // j22  dy/dlat  (北=y減少)
        ]),
        centerInt: [
            // r0が180°を超えると(-r0+180)が負になるため[0,360)に正規化する
            (round(((180 - r0) % 360 + 360) % 360 * 1e7)) >>> 0,
            (round((-r1 +  90) * 1e7)) >>> 0,
        ],
    };
}
