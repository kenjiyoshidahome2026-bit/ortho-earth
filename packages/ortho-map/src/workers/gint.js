// WebGL2 gint renderer — fully gl_VertexID driven, no vertex buffers.
//
// Architecture:
//   gintState.js        — shared GL state object (s)
//   gintTextures.js     — texture create/delete
//   gintFBO.js          — FBO create/delete
//   gintRenderPasses.js — renderCleanScene / drawOverlay / renderPickingBuffer
//   gintIdentify.js     — GPU picking, JS polygon fallback, hover/leave
//
// Hover identify flow:
//   drawn() → renderCleanScene(baseFBO) + renderPickingBuffer
//           → doIdentify: readPixels → if activeId changed, drawOverlay immediately
//   postMessage("redraw") is not used — no main-thread round-trip.

import { geoOrthographic } from 'common';
import { createGintPrograms } from './shared/gintPrograms.js';
import { checkZoomRange } from './shared/gintUtility.js';
import { s } from './shared/gintState.js';
import { uploadGintTextures, deleteTextures } from './shared/gintTextures.js';
import { createFBOs, deleteFBOs } from './shared/gintFBO.js';
import { renderCleanScene, drawOverlay, renderPickingBuffer } from './shared/gintRenderPasses.js';
import { doIdentify, handleMove, handleLeave } from './shared/gintIdentify.js';

const funcs = { init, set, resize, drawing, drawn, move, leave, click, destroy, bench };

// 描画コスト計測フック（ベンチハーネス用・通常経路では呼ばれない）：
// drawing 一式を発行し readPixels(1px) で GPU 完了まで待った実時間を返す
//（gl.finish は ANGLE で遅延され得る＝readPixels が確実な同期点）。
function bench(data) {
	const t0 = performance.now();
	drawing(data);
	const px = new Uint8Array(4);
	s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
	s.gl.readPixels(0, 0, 1, 1, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
	postMessage({ action: "bench", ms: performance.now() - t0,
		stats: { edges: s.totalEdges, edgesB: s.totalEdgesB, polyEdges: s.polyEdges, polyEdgesB: s.polyEdgesB,
			outlineZoom: s.outlineZoom, tiers: (s.lodTiers ?? []).map(t => [t.minW, t.edgeCount]) } });
}
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

function init(data) {
	s.canvas = data.offscreen;
	s.dpr    = data.dpr;
	s.gl = s.canvas.getContext("webgl2", { antialias: false, alpha: true, stencil: true, premultipliedAlpha: false });
	if (!s.gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }

	s.TEX_ARC_W  = Math.min(s.TEX_ARC_W,  s.gl.getParameter(s.gl.MAX_TEXTURE_SIZE));
	s.TEX_META_W = Math.min(s.TEX_META_W, s.gl.getParameter(s.gl.MAX_TEXTURE_SIZE));
	s.programs   = createGintPrograms(s.gl);

	s.canvas.addEventListener('webglcontextlost', e => {
		e.preventDefault();
		s.arcTex = s.metaTex = s.metaTexB = s.ptTex = s.ptMetaTex = null;
		s.lodTiers = [];
		s.tierB = null;
		s.baseFBO = s.baseColorTex = s.baseDepthStencilRBO = null;
		s.pickFBO = s.pickColorTex = s.pickDepthStencilRBO = null;
		s.programs = null;
		s.lastDrawData = null;
	}, false);

	s.canvas.addEventListener('webglcontextrestored', () => {
		s.programs   = createGintPrograms(s.gl);
		createFBOs();
		uploadGintTextures();
		postMessage({ action: "redraw" });
	}, false);

	postMessage({ action: "done", type: "init", ctx: s.gl.constructor.name });
}

function set(data) {
	if (data.cmd === "gint" && data.data) {
		const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point,
				polyCompBbox } = data.data;
		s.gintData = {
			arcBuffer:    arcBuffer   ?? null,
			arcMeta:      arcMeta     ?? null,
			polyStream:   polyStream?.length  ? polyStream  : null,
			lineStream:   lineStream?.length  ? lineStream  : null,
			pointBuffer:  pointBuffer?.length ? pointBuffer : null,
			point:        point ?? null,
			polyCompBbox: polyCompBbox ?? null,
		};

		uploadGintTextures();

		({ minZoom: s.minZoom, maxZoom: s.maxZoom } = checkZoomRange({
			arcMeta:   s.gintData.arcMeta,
			minZoom:   data.data.minZoom   ?? null,
			maxZoom:   data.data.maxZoom   ?? null,
			precision: data.data.precision ?? 6,
		}));

		s.activeId    = -1;
		s.lastDrawData = null;
	}
	postMessage({ action: "done", type: "set" });
}

function resize(data) {
	s.width = data.width; s.height = data.height;
	s.canvas.width  = s.width  * s.dpr;
	s.canvas.height = s.height * s.dpr;
	s.gl.viewport(0, 0, s.width * s.dpr, s.height * s.dpr);
	createFBOs();
	postMessage({ action: "done", type: "resize" });
}

function drawing(data) {
	if (data.panning) {
		s._isDrawing = true;
		clearTimeout(s._moveTimer); s._moveTimer = null;
		s._pendingMove = null;
	} else {
		s._isDrawing = false;
	}
	s.lastMX = NaN; s.lastMY = NaN;

	const zoom = Math.log2(data.scale / 40.74);
	const effMin = Math.max(s.minZoom ?? 0,  data.minZoom ?? 0);
	const effMax = Math.min(s.maxZoom ?? 22, data.maxZoom ?? 22);
	if (zoom < effMin || zoom > effMax) {
		// During animation (panning=true), keep the previous frame so features
		// don't vanish mid-flight when zoomToFeature temporarily passes through
		// a zoom level outside the data range.
		if (!data.panning) {
			s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
			s.gl.clearColor(0, 0, 0, 0);
			s.gl.stencilMask(0xFF);
			s.gl.clear(s.gl.COLOR_BUFFER_BIT);
			s.lastDrawData = null;
		}
		return;
	}

	if (s.totalEdges === 0 && s.totalPoints === 0) return;

	s.lastProj = geoOrthographic()
		.rotate(data.rotate).scale(data.scale).translate([s.width / 2, s.height / 2]);

	// Map viewport corners to Morton integer-space bbox (used by the JS polygon fallback).
	const SE = 1e7;
	let vxMin = 0xFFFFFFFF, vyMin = 0xFFFFFFFF, vxMax = 0, vyMax = 0;
	for (const [cx, cy] of [
		[0, 0], [s.width, 0], [0, s.height], [s.width, s.height],
		[s.width * .5, 0], [s.width * .5, s.height],
		[0, s.height * .5], [s.width, s.height * .5],
	]) {
		const g = s.lastProj.invert([cx, cy]);
		if (!g) continue;
		const vx = Math.round((g[0] + 180) * SE) >>> 0;
		const vy = Math.round((g[1] +  90) * SE) >>> 0;
		if (vx < vxMin) vxMin = vx; if (vx > vxMax) vxMax = vx;
		if (vy < vyMin) vyMin = vy; if (vy > vyMax) vyMax = vy;
	}
	s.lastViewBbox = vxMin <= vxMax ? [vxMin, vyMin, vxMax, vyMax] : null;

	renderCleanScene(data, null);
	s.lastDrawData = data;
}

function drawn() {
	s._isDrawing = false;
	if (!s.lastDrawData) return;
	renderCleanScene(s.lastDrawData, s.baseFBO);
	renderPickingBuffer(s.lastDrawData);
	drawOverlay();
	if (s._pendingMove) {
		const m = s._pendingMove; s._pendingMove = null;
		doIdentify(m);
	}
}

function move(data)  { handleMove(data); }
function leave()     { handleLeave(); }

function click() {
	if (s.activeId === -1) return;
	const geo = s.lastProj?.invert([s.lastMX, s.lastMY]);
	postMessage({ action: "click", featureId: s.activeId,
				  x: s.lastMX, y: s.lastMY,
				  lng: geo?.[0] ?? null, lat: geo?.[1] ?? null });
}

function destroy() {
	deleteTextures();
	deleteFBOs();
	if (s.gl && s.programs) {
		const { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
				pointProgram, pickLineProgram, pickPointProgram, emptyVAO } = s.programs;
		if (emptyVAO)           s.gl.deleteVertexArray(emptyVAO);
		if (renderProgram)      s.gl.deleteProgram(renderProgram);
		if (stencilProgram)     s.gl.deleteProgram(stencilProgram);
		if (fillProgram)        s.gl.deleteProgram(fillProgram);
		if (maskStencilProgram) s.gl.deleteProgram(maskStencilProgram);
		if (pointProgram)       s.gl.deleteProgram(pointProgram);
		if (pickLineProgram)    s.gl.deleteProgram(pickLineProgram);
		if (pickPointProgram)   s.gl.deleteProgram(pickPointProgram);
	}
	s.programs     = null;
	s.gintData     = null;
	s.polyEdgeByFid = null;
	s.polyBboxByFid = null;
	s.totalEdges   = s.totalEdgesB = s.totalPoints = s.polyEdges = s.polyEdgesB = 0;
	s.outlineZoom  = null;
	s.activeId     = -1;
	s.lastDrawData = null;
	postMessage({ action: "done", type: "destroy" });
}
