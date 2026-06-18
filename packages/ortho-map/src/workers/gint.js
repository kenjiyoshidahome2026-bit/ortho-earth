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
// Projection uniforms: u_rotate (degrees), u_scale (px/rad), u_viewport (px).

import { geoOrthographic } from 'common';
import { identify, buildConverter, setViewBbox } from 'geopbf/src/extension/identify.js';
import { createGintPrograms } from './shared/gintPrograms.js';
import { uploadTex2D, buildEdgeMeta, bindSharedUniforms } from './shared/gintUtility.js';

// ── GL state ──────────────────────────────────────────────────────────────────
let canvas, gl, dpr, width, height;
let programs = null;  // { renderProgram, stencilProgram, fillProgram, pointProgram,
                      //   uRender, uStencil, uFill, uPoint, emptyVAO }
let arcTex = null, metaTex = null, ptTex = null;
let totalEdges = 0, totalPoints = 0;
let TEX_ARC_W = 4096, TEX_META_W = 4096;
let activeId = -1;

// ── Hit-test state ────────────────────────────────────────────────────────────
let gintData = null;  // { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point }
let lastR = [0,0,0], lastS = 1, lastW = 0, lastH = 0;
let lastProj = null;
let lastMX = NaN, lastMY = NaN;  // 前回 identify を実行したピクセル座標
let _moveTimer = null;           // スロットリング用タイマー
let _pendingMove = null;         // スロットル中に届いた最新の move イベント
const MOVE_THROTTLE_MS = 32;    // ~30fps

// ── Style defaults ────────────────────────────────────────────────────────────
const DEF_STYLE = new Float32Array(256 * 4);
DEF_STYLE.set([1.0, 0.420, 0.208, 1.0]);      // style 0: polygon  #FF6B35
DEF_STYLE.set([0.0, 0.706, 0.847, 1.0],  4);  // style 1: polyline #00B4D8
const DEF_FILL = new Float32Array([0, 0, 0, 0]);
const DEF_MASK = new Float32Array([0, 0, 0, 0.4]);

// ── Worker entry point ────────────────────────────────────────────────────────
const funcs = { init, set, resize, drawing, drawn, move, leave, click, destroy };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

// ── Handlers ──────────────────────────────────────────────────────────────────

function init(data) {
    canvas = data.offscreen;
    dpr    = data.dpr;
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, stencil: true, premultipliedAlpha: false });
    if (!gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }

    TEX_ARC_W  = Math.min(TEX_ARC_W,  gl.getParameter(gl.MAX_TEXTURE_SIZE));
    TEX_META_W = Math.min(TEX_META_W, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    programs = createGintPrograms(gl);

    postMessage({ action: "done", type: "init", ctx: gl.constructor.name });
}

function set(data) {
    if (data.cmd === "gint" && data.data) {
        const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point, polyBbox, lineBbox, polyCompBbox } = data.data;
        gintData = {
            arcBuffer:    arcBuffer   ?? null,
            arcMeta:      arcMeta     ?? null,
            polygon:      polygon?.length  ? polygon  : null,
            polyline:     polyline?.length ? polyline : null,
            pointBuffer:  pointBuffer?.length ? pointBuffer : null,
            point:        point ?? null,
            polyBbox:     polyBbox     ?? null,
            lineBbox:     lineBbox     ?? null,
            polyCompBbox: polyCompBbox ?? null,
        };

        const { arcBuffer: ab, arcMeta: am, polygon: pg, polyline: pl, pointBuffer: pb } = gintData;

        // arcTex: RG32UI — each texel = one 64-bit Morton vertex (lo32, hi32)
        if (arcTex) gl.deleteTexture(arcTex);
        arcTex = null;
        if (ab?.length) {
            const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
            const arcH   = Math.ceil(arcU32.length / 2 / TEX_ARC_W);
            const arcPad = new Uint32Array(TEX_ARC_W * arcH * 2);
            arcPad.set(arcU32);
            arcTex = uploadTex2D(gl, arcPad, TEX_ARC_W, arcH, gl.RG32UI, gl.RG_INTEGER);
        }

        // metaTex: RGBA32UI — one texel per arc edge (vert_A, vert_B, style_id, feat_id)
        if (metaTex) gl.deleteTexture(metaTex);
        metaTex = null;
        const { metaU32, edgeCount } = buildEdgeMeta(am, pg, pl);
        totalEdges = edgeCount;
        if (totalEdges > 0) {
            const metaH   = Math.ceil(totalEdges / TEX_META_W);
            const metaPad = new Uint32Array(TEX_META_W * metaH * 4);
            metaPad.set(metaU32);
            metaTex = uploadTex2D(gl, metaPad, TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
        }

        // ptTex: RG32UI — same layout as arcTex, L1 vertices only
        if (ptTex) { gl.deleteTexture(ptTex); ptTex = null; }
        if (pb?.length) {
            const ptU32 = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
            totalPoints  = ptU32.length / 2;
            const ptH    = Math.ceil(totalPoints / TEX_ARC_W);
            const ptPad  = new Uint32Array(TEX_ARC_W * ptH * 2);
            ptPad.set(ptU32);
            ptTex = uploadTex2D(gl, ptPad, TEX_ARC_W, ptH, gl.RG32UI, gl.RG_INTEGER);
        } else { totalPoints = 0; }

        activeId = -1;
        buildConverter(gintData);  // WASM コンバーターを非同期で構築（準備でき次第 identify() が使用）
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

function drawing(data) {
    if (totalEdges === 0 && totalPoints === 0) return;
    lastR = data.rotate; lastS = data.scale; lastW = width; lastH = height;
    lastProj = geoOrthographic().rotate(lastR).scale(lastS).translate([lastW/2, lastH/2]);
    lastMX = NaN; lastMY = NaN;  // 投影変更 → 位置キャッシュ無効化

    // ビューポートの四隅を地理座標 → Morton 整数空間に変換してビュー bbox を更新
    const SE = 1e7;
    let vxMin = 0xFFFFFFFF, vyMin = 0xFFFFFFFF, vxMax = 0, vyMax = 0;
    for (const [cx, cy] of [[0,0],[width,0],[0,height],[width,height],[width*.5,0],[width*.5,height],[0,height*.5],[width,height*.5]]) {
        const g = lastProj.invert([cx, cy]);
        if (!g) continue;
        const vx = Math.round((g[0] + 180) * SE) >>> 0;
        const vy = Math.round((g[1] +  90) * SE) >>> 0;
        if (vx < vxMin) vxMin = vx; if (vx > vxMax) vxMax = vx;
        if (vy < vyMin) vyMin = vy; if (vy > vyMax) vyMax = vy;
    }
    setViewBbox(vxMin <= vxMax ? [vxMin, vyMin, vxMax, vyMax] : null);

    const { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
            pointProgram, uRender, uStencil, uFill, uMaskStencil, uPoint, emptyVAO } = programs;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.bindVertexArray(emptyVAO);

    // ── Stencil + Fill pass ──
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
        bindSharedUniforms(gl, uStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
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

    // ── Render pass: fat-line outlines ──
    // 2 パスに分けてアクティブ Feature のエッジを最後に描く。
    // 隣接ポリゴン間で共有されるアークが metaTex に 2 エントリ存在する場合、
    // 後から描いた方が上書きするため、アクティブ側を 2 パス目に回すことで確実に黄色が勝つ。
    gl.useProgram(renderProgram);
    bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
    gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);
    gl.uniform1i(uRender.u_active_id,    activeId);
    gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
    if (totalEdges > 0) {
        gl.uniform1i(uRender.u_pass, 0);  // パス 0: アクティブ以外
        gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
        if (activeId !== -1) {
            gl.uniform1i(uRender.u_pass, 1);  // パス 1: アクティブのみ（上に重ねる）
            gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
        }
    }

    // ── Mask pass: アクティブ Feature 以外を半透明でディム ──
    // 全体を塗りつぶしてアクティブ Feature の内側だけを抜く（2D の clearRect 相当）。
    const mc = data.maskColor ?? DEF_MASK;
    if (activeId !== -1 && mc[3] > 0 && totalEdges > 0) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xFF);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
        gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);

        gl.useProgram(maskStencilProgram);
        bindSharedUniforms(gl, uMaskStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
        gl.uniform1i(uMaskStencil.u_active_id, activeId);
        gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 3);

        gl.colorMask(true, true, true, true);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, 0, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

        gl.useProgram(fillProgram);
        gl.uniform4fv(uFill.u_fill_color, mc);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.STENCIL_TEST);
    }

    // ── Point pass: circle quads ──
    if (totalPoints > 0 && ptTex) {
        const _r1 = data.rotate[1] * Math.PI / 180, _r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
        gl.useProgram(pointProgram);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
        gl.uniform1i(uPoint.u_pt_tex,    0);
        gl.uniform1i(uPoint.u_pt_w,      TEX_ARC_W);
        gl.uniform3f(uPoint.u_rotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
        gl.uniform1f(uPoint.u_scale,     data.scale);
        gl.uniform2f(uPoint.u_viewport,  width, height);
        gl.uniform4f(uPoint.u_rsincos,   Math.cos(_r1), Math.sin(_r1), Math.cos(_r2), Math.sin(_r2));
        gl.uniform1f(uPoint.u_pt_radius, data.ptRadius ?? 1.5);
        gl.uniform1i(uPoint.u_active_id, activeId);
        gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
    }
}

function drawn() {}

function move(data) {
    if (!lastProj || !gintData) return;
    if (_moveTimer !== null) {
        _pendingMove = data;  // スロットル中は最新位置だけ保持
        return;
    }
    _doIdentify(data);
    _moveTimer = setTimeout(() => {
        _moveTimer = null;
        if (_pendingMove) { _doIdentify(_pendingMove); _pendingMove = null; }
    }, MOVE_THROTTLE_MS);
}

function _doIdentify(data) {
    if (data.x === lastMX && data.y === lastMY) return;
    lastMX = data.x; lastMY = data.y;
    const featureId = identify({ unPackGint: gintData }, data.x, data.y, lastProj);
    const newId = featureId ?? -1;
    if (newId !== activeId) {
        activeId = newId;
        postMessage({ action: "identify", featureId: featureId ?? null, x: data.x, y: data.y });
        postMessage({ action: "redraw" });
    }
}

function leave() {
    if (_moveTimer !== null) { clearTimeout(_moveTimer); _moveTimer = null; }
    _pendingMove = null;
    if (activeId === -1) return;
    activeId = -1;
    postMessage({ action: "identify", featureId: null });
    postMessage({ action: "redraw" });
}

function click() {
    if (activeId === -1) return;
    const geo = lastProj?.invert([lastMX, lastMY]);
    postMessage({ action: "click", featureId: activeId, x: lastMX, y: lastMY, lng: geo?.[0] ?? null, lat: geo?.[1] ?? null });
}

function destroy() {
    if (gl) {
        if (arcTex)  gl.deleteTexture(arcTex);
        if (metaTex) gl.deleteTexture(metaTex);
        if (ptTex)   gl.deleteTexture(ptTex);
        if (programs) {
            const { renderProgram, stencilProgram, fillProgram, maskStencilProgram, pointProgram, emptyVAO } = programs;
            if (emptyVAO)           gl.deleteVertexArray(emptyVAO);
            if (renderProgram)      gl.deleteProgram(renderProgram);
            if (stencilProgram)     gl.deleteProgram(stencilProgram);
            if (fillProgram)        gl.deleteProgram(fillProgram);
            if (maskStencilProgram) gl.deleteProgram(maskStencilProgram);
            if (pointProgram)       gl.deleteProgram(pointProgram);
        }
    }
    arcTex = metaTex = ptTex = null;
    programs = null;
    gintData = null;
    totalEdges = totalPoints = 0;
    activeId = -1;
    postMessage({ action: "done", type: "destroy" });
}

