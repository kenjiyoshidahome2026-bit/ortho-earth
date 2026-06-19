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
// Hover identify flow:
//   drawn() → _renderCleanScene(baseFBO) + _renderPickingBuffer
//           → _doIdentify: readPixels → activeId 変化なら _drawOverlay() 直接描画
//   postMessage("redraw") は不使用。主スレッド往復ゼロ。

import { geoOrthographic } from 'common';
import { createGintPrograms } from './shared/gintPrograms.js';
import { uploadTex2D, buildEdgeMeta, bindSharedUniforms, checkZoomRange } from './shared/gintUtility.js';
import { findPolygon } from 'geopbf/src/extension/identify.js';

// ── GL state ──────────────────────────────────────────────────────────────────
let canvas, gl, dpr, width, height;
let programs = null;
let arcTex = null, metaTex = null, ptTex = null, ptMetaTex = null;
let totalEdges = 0, totalPoints = 0;
let TEX_ARC_W = 4096, TEX_META_W = 4096;
let activeId = -1;

// ── FBO state ─────────────────────────────────────────────────────────────────
// baseFBO : クリーンシーン（ハイライトなし）キャッシュ。hover で blit 再利用。
// pickFBO : GPU picking ID バッファ。drawn() 後に更新。
let baseFBO = null, baseColorTex = null, baseDepthStencilRBO = null;
let pickFBO = null, pickColorTex = null, pickDepthStencilRBO = null;
let lastViewBbox = null;  // ビューポート bbox（Morton 整数空間）
let lastDrawData = null;  // drawn() で FBO 更新に使う描画パラメータ

// ── Polygon edge ranges（アクティブ feature のエッジ範囲 O(1) 引き） ──────────
let polyEdgeRanges = null;  // Int32Array [eStart, eCount, ...] per polygon feature
let polygonIdToIdx = null;  // Map<featureId, polygonArrayIndex>

// ── Zoom visibility range ─────────────────────────────────────────────────────
let minZoom = null, maxZoom = null;  // GeoPBF 由来。null = 制限なし

// ── Hit-test / move state ─────────────────────────────────────────────────────
let gintData = null;
let lastR = [0,0,0], lastS = 1, lastW = 0, lastH = 0;
let lastProj = null;
let lastMX = NaN, lastMY = NaN;
let _isDrawing = false;
let _moveTimer   = null;
let _pendingMove = null;
const MOVE_THROTTLE_MS = 32;

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
    gl = canvas.getContext("webgl2", { antialias: false, alpha: true, stencil: true, premultipliedAlpha: false });
    if (!gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }

    TEX_ARC_W  = Math.min(TEX_ARC_W,  gl.getParameter(gl.MAX_TEXTURE_SIZE));
    TEX_META_W = Math.min(TEX_META_W, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    programs = createGintPrograms(gl);

    canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        arcTex = metaTex = ptTex = ptMetaTex = null;
        baseFBO = baseColorTex = baseDepthStencilRBO = null;
        pickFBO = pickColorTex = pickDepthStencilRBO = null;
        programs = null;
        lastDrawData = null;
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
        programs = createGintPrograms(gl);
        _createFBOs();
        _reuploadTextures();
        postMessage({ action: "redraw" });
    }, false);

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
        const { metaU32, edgeCount, polyEdgeRanges: per } = buildEdgeMeta(am, pg, pl);
        totalEdges     = edgeCount;
        polyEdgeRanges = per;
        polygonIdToIdx = pg ? new Map(pg.map(([id], i) => [id, i])) : null;
        if (totalEdges > 0) {
            const metaH   = Math.ceil(totalEdges / TEX_META_W);
            const metaPad = new Uint32Array(TEX_META_W * metaH * 4);
            metaPad.set(metaU32);
            metaTex = uploadTex2D(gl, metaPad, TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
        }

        // ptTex: RG32UI — same layout as arcTex, L1 vertices only
        if (ptTex) { gl.deleteTexture(ptTex); ptTex = null; }
        if (ptMetaTex) { gl.deleteTexture(ptMetaTex); ptMetaTex = null; }
        if (pb?.length) {
            const ptU32 = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
            totalPoints  = ptU32.length / 2;
            const ptH    = Math.ceil(totalPoints / TEX_ARC_W);
            const ptPad  = new Uint32Array(TEX_ARC_W * ptH * 2);
            ptPad.set(ptU32);
            ptTex = uploadTex2D(gl, ptPad, TEX_ARC_W, ptH, gl.RG32UI, gl.RG_INTEGER);
            // ptMetaTex: R32UI — feature ID per point (gintData.point[pt_id])
            const ptMetaH   = Math.ceil(totalPoints / TEX_ARC_W);
            const ptMetaPad = new Uint32Array(TEX_ARC_W * ptMetaH);
            ptMetaPad.set(gintData.point.subarray(0, totalPoints));
            ptMetaTex = uploadTex2D(gl, ptMetaPad, TEX_ARC_W, ptMetaH, gl.R32UI, gl.RED_INTEGER);
        } else { totalPoints = 0; }

        ({ minZoom, maxZoom } = checkZoomRange({
            arcMeta: am,
            minZoom: data.data.minZoom ?? null,
            maxZoom: data.data.maxZoom ?? null,
            precision: data.data.precision ?? 6,
        }));

        activeId = -1;
        lastDrawData = null;  // baseFBO 無効化
    }
    postMessage({ action: "done", type: "set" });
}

function resize(data) {
    width = data.width; height = data.height;
    canvas.width  = width  * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, width * dpr, height * dpr);
    _createFBOs();
    postMessage({ action: "done", type: "resize" });
}

function _createFBOs() {
    const w = width * dpr, h = height * dpr;

    // baseFBO
    if (baseFBO)             gl.deleteFramebuffer(baseFBO);
    if (baseColorTex)        gl.deleteTexture(baseColorTex);
    if (baseDepthStencilRBO) gl.deleteRenderbuffer(baseDepthStencilRBO);
    baseColorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, baseColorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    baseDepthStencilRBO = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, baseDepthStencilRBO);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    baseFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, baseColorTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, baseDepthStencilRBO);

    // pickFBO
    if (pickFBO)             gl.deleteFramebuffer(pickFBO);
    if (pickColorTex)        gl.deleteTexture(pickColorTex);
    if (pickDepthStencilRBO) gl.deleteRenderbuffer(pickDepthStencilRBO);
    pickColorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pickColorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    pickDepthStencilRBO = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepthStencilRBO);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    pickFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickColorTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, pickDepthStencilRBO);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    lastDrawData = null;  // FBO 再生成 → baseFBO 無効
}

// ── _renderCleanScene: ハイライト/マスクなしのシーンを描画 ───────────────────
// targetFBO=null → canvas 直接、baseFBO → キャッシュ
function _renderCleanScene(data, targetFBO = null) {
    const { renderProgram, stencilProgram, fillProgram,
            pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
    gl.clearColor(0, 0, 0, 0);
    gl.stencilMask(0xFF);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.bindVertexArray(emptyVAO);

    // ── Stencil + Fill pass ──
    const fc = data.fillColor ?? DEF_FILL;
    if (fc[3] > 0 && totalEdges > 0) {
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
    if (totalEdges > 0) {
        gl.useProgram(renderProgram);
        bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
        gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);
        gl.uniform1i(uRender.u_active_id,    -1);
        gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
        gl.uniform1i(uRender.u_pass, 0);
        gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
    }

    // ── Point pass ──
    if (totalPoints > 0 && ptTex && ptMetaTex) {
        const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
        gl.useProgram(pointProgram);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ptMetaTex);
        gl.uniform1i(uPoint.u_pt_tex,      0);
        gl.uniform1i(uPoint.u_pt_meta_tex, 1);
        gl.uniform1i(uPoint.u_pt_w,        TEX_ARC_W);
        gl.uniform3f(uPoint.u_rotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
        gl.uniform1f(uPoint.u_scale,     data.scale);
        gl.uniform2f(uPoint.u_viewport,  width, height);
        gl.uniform4f(uPoint.u_rsincos,   Math.cos(r1), Math.sin(r1), Math.cos(r2), Math.sin(r2));
        gl.uniform1f(uPoint.u_pt_radius, data.ptRadius ?? 1.5);
        gl.uniform1i(uPoint.u_active_id, -1);
        gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ── _drawOverlay: baseFBO を blit してアクティブ feature だけ上書き ───────────
// move() から直接呼ぶ。主スレッド往復なし。
function _drawOverlay() {
    if (!baseFBO || !lastDrawData) return;
    // baseFBO → canvas（クリーンシーンで上書きして前回のオーバーレイを消す）
    const w = width * dpr, h = height * dpr;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, baseFBO);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.stencilMask(0xFF);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    if (activeId === -1) return;
    if (!arcTex && !ptTex) return;

    const data = lastDrawData;
    const { renderProgram, stencilProgram, fillProgram,
            pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;
    gl.bindVertexArray(emptyVAO);

    // アクティブ polygon のエッジ範囲を取得
    const rangeIdx = polygonIdToIdx?.get(activeId);
    const eStart   = (rangeIdx != null) ? polyEdgeRanges[rangeIdx * 2]     : null;
    const eCount   = (rangeIdx != null) ? polyEdgeRanges[rangeIdx * 2 + 1] : null;
    const hasRange = eStart != null && eCount > 0;

    // ── ハイライト（アクティブ feature のエッジのみ） ──
    gl.useProgram(renderProgram);
    bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
    gl.uniform1f(uRender.u_line_width,   (data.lineWidth ?? 1.0) + 2.0);
    gl.uniform1i(uRender.u_active_id,    activeId);
    gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
    gl.uniform1i(uRender.u_pass, 1);
    if (hasRange) {
        gl.drawArrays(gl.TRIANGLES, eStart * 6, eCount * 6);
    } else if (totalEdges > 0) {
        gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);  // ポリライン等のフォールバック
    }

    // ── ポイントハイライト ──
    if (totalPoints > 0 && ptTex && ptMetaTex) {
        const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
        gl.useProgram(pointProgram);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ptMetaTex);
        gl.uniform1i(uPoint.u_pt_tex,      0);
        gl.uniform1i(uPoint.u_pt_meta_tex, 1);
        gl.uniform1i(uPoint.u_pt_w,        TEX_ARC_W);
        gl.uniform3f(uPoint.u_rotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
        gl.uniform1f(uPoint.u_scale,     data.scale);
        gl.uniform2f(uPoint.u_viewport,  width, height);
        gl.uniform4f(uPoint.u_rsincos,   Math.cos(r1), Math.sin(r1), Math.cos(r2), Math.sin(r2));
        gl.uniform1f(uPoint.u_pt_radius, data.ptRadius ?? 1.5);
        gl.uniform1i(uPoint.u_active_id, activeId);
        gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
    }

    // ── マスク（アクティブ polygon のエッジ範囲のみで stencil → 外側を dim） ──
    const mc = data.maskColor ?? DEF_MASK;
    if (mc[3] > 0 && hasRange) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0xFF);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
        gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
        gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
        gl.useProgram(stencilProgram);
        bindSharedUniforms(gl, uStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
        gl.drawArrays(gl.TRIANGLES, eStart * 3, eCount * 3);
        gl.colorMask(true, true, true, true);
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, 0, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.useProgram(fillProgram);
        gl.uniform4fv(uFill.u_fill_color, mc);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disable(gl.STENCIL_TEST);
    }
}

// ── drawing: pan/zoom 中はクリーンシーンのみ ─────────────────────────────────
function drawing(data) {
    if (data.panning) {
        _isDrawing = true;
        clearTimeout(_moveTimer); _moveTimer = null;
        _pendingMove = null;
    } else {
        _isDrawing = false;
    }
    lastMX = NaN; lastMY = NaN;

    // ズーム範囲外はキャンバスをクリアして終了（GeoPBF AND map 両方の範囲）
    const zoom = Math.log2(data.scale / 40.74);
    const effMin = Math.max(minZoom ?? 0,  data.minZoom ?? 0);
    const effMax = Math.min(maxZoom ?? 22, data.maxZoom ?? 22);
    if (zoom < effMin || zoom > effMax) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 0);
        gl.stencilMask(0xFF);
        gl.clear(gl.COLOR_BUFFER_BIT);
        lastDrawData = null;
        return;
    }

    if (totalEdges === 0 && totalPoints === 0) return;

    lastR = data.rotate; lastS = data.scale; lastW = width; lastH = height;
    lastProj = geoOrthographic().rotate(lastR).scale(lastS).translate([lastW/2, lastH/2]);

    // ビューポート → Morton 整数空間 bbox（polygon カリング用）
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
    lastViewBbox = vxMin <= vxMax ? [vxMin, vyMin, vxMax, vyMax] : null;

    _renderCleanScene(data, null);  // canvas に直接描画
    lastDrawData = data;
}

// ── drawn: pan/zoom 終了 → baseFBO キャッシュ + pickFBO 更新 → move 処理 ──────
function drawn() {
    _isDrawing = false;
    if (!lastDrawData) return;
    _renderCleanScene(lastDrawData, baseFBO);  // hover 用キャッシュ更新
    _renderPickingBuffer(lastDrawData);
    if (_pendingMove) {
        const m = _pendingMove; _pendingMove = null;
        _doIdentify(m);
    }
}

function _renderPickingBuffer(data) {
    if (!pickFBO) return;
    if (!arcTex && !ptTex) return;
    const { pickLineProgram, pickPointProgram, uPickLine, uPickPoint } = programs;
    try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO);
        gl.clearColor(0, 0, 0, 0);
        gl.stencilMask(0xFF);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.disable(gl.BLEND);

        if (totalEdges > 0 && metaTex) {
            gl.useProgram(pickLineProgram);
            bindSharedUniforms(gl, uPickLine, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
            gl.uniform1f(uPickLine.u_line_width, data.lineWidth ?? 1.0);
            gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
        }

        if (totalPoints > 0 && ptTex && ptMetaTex) {
            const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
            gl.useProgram(pickPointProgram);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ptMetaTex);
            gl.uniform1i(uPickPoint.u_pt_tex,      0);
            gl.uniform1i(uPickPoint.u_pt_meta_tex, 1);
            gl.uniform1i(uPickPoint.u_pt_w,        TEX_ARC_W);
            gl.uniform3f(uPickPoint.u_rotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
            gl.uniform1f(uPickPoint.u_scale,     data.scale);
            gl.uniform2f(uPickPoint.u_viewport,  width, height);
            gl.uniform4f(uPickPoint.u_rsincos,   Math.cos(r1), Math.sin(r1), Math.cos(r2), Math.sin(r2));
            gl.uniform1f(uPickPoint.u_pt_radius, data.ptRadius ?? 1.5);
            gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
        }

        gl.enable(gl.BLEND);
    } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.colorMask(true, true, true, true);
        gl.stencilMask(0xFF);
        gl.disable(gl.STENCIL_TEST);
    }
}

// ── move: picking バッファを覗くだけ ─────────────────────────────────────────
function move(data) {
    if (!lastProj || !gintData || _isDrawing) {
        if (_isDrawing) _pendingMove = data;
        return;
    }
    if (_moveTimer !== null) { _pendingMove = data; return; }
    _doIdentify(data);
    _moveTimer = setTimeout(() => {
        _moveTimer = null;
        if (_pendingMove) { _doIdentify(_pendingMove); _pendingMove = null; }
    }, MOVE_THROTTLE_MS);
}

function _doIdentify(data) {
    if (data.x === lastMX && data.y === lastMY) return;
    lastMX = data.x; lastMY = data.y;
    if (!pickFBO) return;

    // readPixels: picking バッファから 1px 読み取り
    const px = new Uint8Array(4);
    const pickX = Math.max(0, Math.min(Math.round(width  * dpr) - 1, Math.round(data.x * dpr)));
    const pickY = Math.max(0, Math.min(Math.round(height * dpr) - 1, Math.round((height - data.y) * dpr)));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, pickFBO);
    gl.readPixels(pickX, pickY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const fid1 = px[0] | (px[1] << 8) | (px[2] << 16);
    let featureId = fid1 === 0 ? null : fid1 - 1;

    // GPU がエッジ/ポイントを拾わなかった → JS ポリゴン内包判定にフォールバック
    if (fid1 === 0 && gintData?.polygon && lastViewBbox) {
        const geo = lastProj?.invert([data.x, data.y]);
        if (geo) {
            const SE = 1e7;
            featureId = findPolygon(
                gintData.arcBuffer, gintData.arcMeta, gintData.polygon,
                Math.round((geo[0] + 180) * SE),
                Math.round((geo[1] +  90) * SE),
                gintData.polyBbox, lastViewBbox
            );
        }
    }

    const newId = featureId ?? -1;
    if (newId === activeId) return;
    activeId = newId;
    postMessage({ action: "identify", featureId: featureId ?? null, x: data.x, y: data.y });
    _drawOverlay();  // 主スレッド往復なしに直接描画
}

function leave() {
    clearTimeout(_moveTimer); _moveTimer = null;
    _pendingMove = null;
    if (activeId === -1) return;
    activeId = -1;
    postMessage({ action: "identify", featureId: null });
    // baseFBO をそのまま blit → ハイライト・マスクが即座に消える
    if (baseFBO && lastDrawData) {
        const w = width * dpr, h = height * dpr;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, baseFBO);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
}

function click() {
    if (activeId === -1) return;
    const geo = lastProj?.invert([lastMX, lastMY]);
    postMessage({ action: "click", featureId: activeId, x: lastMX, y: lastMY, lng: geo?.[0] ?? null, lat: geo?.[1] ?? null });
}

function _reuploadTextures() {
    if (!gintData || !gl) return;
    const { arcBuffer: ab, arcMeta: am, polygon: pg, polyline: pl, pointBuffer: pb } = gintData;

    arcTex = null;
    if (ab?.length) {
        const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
        const arcH   = Math.ceil(arcU32.length / 2 / TEX_ARC_W);
        const arcPad = new Uint32Array(TEX_ARC_W * arcH * 2);
        arcPad.set(arcU32);
        arcTex = uploadTex2D(gl, arcPad, TEX_ARC_W, arcH, gl.RG32UI, gl.RG_INTEGER);
    }

    metaTex = null;
    if (totalEdges > 0) {
        const { metaU32 } = buildEdgeMeta(am, pg, pl);
        const metaH   = Math.ceil(totalEdges / TEX_META_W);
        const metaPad = new Uint32Array(TEX_META_W * metaH * 4);
        metaPad.set(metaU32);
        metaTex = uploadTex2D(gl, metaPad, TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
    }

    ptTex = ptMetaTex = null;
    if (pb?.length) {
        const ptU32    = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
        const ptH      = Math.ceil(totalPoints / TEX_ARC_W);
        const ptPad    = new Uint32Array(TEX_ARC_W * ptH * 2);
        ptPad.set(ptU32);
        ptTex = uploadTex2D(gl, ptPad, TEX_ARC_W, ptH, gl.RG32UI, gl.RG_INTEGER);
        const ptMetaH   = Math.ceil(totalPoints / TEX_ARC_W);
        const ptMetaPad = new Uint32Array(TEX_ARC_W * ptMetaH);
        ptMetaPad.set(gintData.point.subarray(0, totalPoints));
        ptMetaTex = uploadTex2D(gl, ptMetaPad, TEX_ARC_W, ptMetaH, gl.R32UI, gl.RED_INTEGER);
    }
}

function destroy() {
    if (gl) {
        if (arcTex)     gl.deleteTexture(arcTex);
        if (metaTex)    gl.deleteTexture(metaTex);
        if (ptTex)      gl.deleteTexture(ptTex);
        if (ptMetaTex)  gl.deleteTexture(ptMetaTex);
        if (baseFBO)             gl.deleteFramebuffer(baseFBO);
        if (baseColorTex)        gl.deleteTexture(baseColorTex);
        if (baseDepthStencilRBO) gl.deleteRenderbuffer(baseDepthStencilRBO);
        if (pickFBO)             gl.deleteFramebuffer(pickFBO);
        if (pickColorTex)        gl.deleteTexture(pickColorTex);
        if (pickDepthStencilRBO) gl.deleteRenderbuffer(pickDepthStencilRBO);
        if (programs) {
            const { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
                    pointProgram, pickLineProgram, pickPointProgram, emptyVAO } = programs;
            if (emptyVAO)           gl.deleteVertexArray(emptyVAO);
            if (renderProgram)      gl.deleteProgram(renderProgram);
            if (stencilProgram)     gl.deleteProgram(stencilProgram);
            if (fillProgram)        gl.deleteProgram(fillProgram);
            if (maskStencilProgram) gl.deleteProgram(maskStencilProgram);
            if (pointProgram)       gl.deleteProgram(pointProgram);
            if (pickLineProgram)    gl.deleteProgram(pickLineProgram);
            if (pickPointProgram)   gl.deleteProgram(pickPointProgram);
        }
    }
    arcTex = metaTex = ptTex = ptMetaTex = null;
    baseFBO = baseColorTex = baseDepthStencilRBO = null;
    pickFBO = pickColorTex = pickDepthStencilRBO = null;
    programs = null;
    gintData = null;
    polyEdgeRanges = null;
    polygonIdToIdx = null;
    totalEdges = totalPoints = 0;
    activeId = -1;
    lastDrawData = null;
    postMessage({ action: "done", type: "destroy" });
}
