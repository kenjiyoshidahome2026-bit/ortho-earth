// gint worker（v2）── v1(ortho-map) の workers/gint.js を japan の心臓へ生まれ直させたもの。
// メッセージ面は v1 と同一（init/set/resize/drawing/drawn/move/leave/click/destroy）＝バックワード互換。
//
// 【site 3】drawing() で cam(cameraState) から mvp/eye/origin を一度だけ生成し drawData に載せる。
//   v1 の `geoOrthographic().rotate(rotate).scale(scale)` の建て替え。以降 passes は受け取って描くだけ。
// 【site 4 準備】視野コーナーを unproject → Morton 整数 bbox（JS polygon identify の絞り込み）。
// 単位は device px 一本（app が innerWidth*dpr で width/height を渡す。cameraState/unproject と同座標系）。

import { createGintPrograms } from './programs.js';
import { checkZoomRange } from './utility.js';
import { s } from './state.js';
import { uploadGintTextures, deleteTextures } from './textures.js';
import { createFBOs, deleteFBOs } from './fbo.js';
import { renderCleanScene, drawOverlay, renderPickingBuffer } from './passes.js';
import { doIdentify, handleMove, handleLeave } from './identify.js';
import { cameraState, unproject } from '../../camera.js';

const funcs = { init, set, resize, drawing, drawn, move, leave, click, destroy };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

function init(data) {
	s.canvas = data.offscreen;
	s.dpr    = data.dpr ?? 1;
	s.gl = s.canvas.getContext("webgl2", { antialias: false, alpha: true, stencil: true, premultipliedAlpha: false });
	if (!s.gl) { postMessage({ action: "done", type: "init", ctx: null }); return; }

	s.TEX_ARC_W  = Math.min(s.TEX_ARC_W,  s.gl.getParameter(s.gl.MAX_TEXTURE_SIZE));
	s.TEX_META_W = Math.min(s.TEX_META_W, s.gl.getParameter(s.gl.MAX_TEXTURE_SIZE));
	s.programs   = createGintPrograms(s.gl);

	s.canvas.addEventListener('webglcontextlost', e => {
		e.preventDefault();
		s.arcTex = s.metaTex = s.ptTex = s.ptMetaTex = null;
		s.baseFBO = s.baseColorTex = s.baseDepthStencilRBO = null;
		s.pickFBO = s.pickColorTex = s.pickDepthStencilRBO = null;
		s.programs = null; s.lastDrawData = null;
	}, false);
	s.canvas.addEventListener('webglcontextrestored', () => {
		s.programs = createGintPrograms(s.gl);
		createFBOs(); uploadGintTextures();
		postMessage({ action: "redraw" });
	}, false);

	postMessage({ action: "done", type: "init", ctx: s.gl.constructor.name });
}

function set(data) {
	if (data.cmd === "gint" && data.data) {
		const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point, polyCompBbox } = data.data;
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
		s.activeId = -1; s.lastDrawData = null;
	}
	postMessage({ action: "done", type: "set" });
}

function resize(data) {
	s.width  = data.width;   // device px
	s.height = data.height;
	s.canvas.width  = s.width;
	s.canvas.height = s.height;
	s.gl.viewport(0, 0, s.width, s.height);
	createFBOs();
	postMessage({ action: "done", type: "resize" });
}

// Morton 整数（1e-7°）へ。antimeridian は下流の dlonE7 が畳むのでここは素直に。
const SE = 1e7;
function toMortonX(lon) { return (Math.round((lon + 180) * SE)) >>> 0; }
function toMortonY(lat) { return (Math.round((lat +  90) * SE)) >>> 0; }

function drawing(data) {
	// data: { cam, panning, lineWidth?, fillColor?, styleTable?, dashTable?, maskColor?, ptRadius? }
	if (data.panning) {
		s._isDrawing = true;
		clearTimeout(s._moveTimer); s._moveTimer = null; s._pendingMove = null;
	} else {
		s._isDrawing = false;
	}
	s.lastMX = NaN; s.lastMY = NaN;

	const zoom  = data.cam.zoom;
	const effMin = Math.max(s.minZoom ?? 0,  data.minZoom ?? 0);
	const effMax = Math.min(s.maxZoom ?? 22, data.maxZoom ?? 22);
	if (zoom < effMin || zoom > effMax) {
		// アニメ中(panning)は前フレーム保持（zoomToFeature が範囲外を一瞬通っても消えないように）。
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

	// ── site 3：japan の心室で cam → mvp/eye/origin（v1 の d3 lastProj の建て替え）──
	const st = cameraState(data.cam, s.width, s.height);
	s.cam = st;                                    // identify の unproject 用（site 4）
	const origin = data.cam.center;                // 視野中心＝Morton 中心（origin が視野を追う＝精度）
	const drawData = {
		mvp:        st.mvp instanceof Float32Array ? st.mvp : Float32Array.from(st.mvp),
		eye:        st.eye,
		origin,
		lineWidth:  (data.lineWidth ?? 1.0) * s.dpr,   // device px 一本化（shader は u_dpr=1 前提）
		fillColor:  data.fillColor,
		styleTable: data.styleTable,
		dashTable:  data.dashTable,
		maskColor:  data.maskColor,
		ptRadius:   (data.ptRadius ?? 1.5) * s.dpr,
	};

	// 視野コーナー → Morton 整数 bbox（JS polygon fallback の絞り込み。unproject＝site 4）。
	let vxMin = 0xFFFFFFFF, vyMin = 0xFFFFFFFF, vxMax = 0, vyMax = 0;
	for (const [cx, cy] of [
		[0, 0], [s.width, 0], [0, s.height], [s.width, s.height],
		[s.width * .5, 0], [s.width * .5, s.height], [0, s.height * .5], [s.width, s.height * .5],
	]) {
		const g = unproject(st, cx, cy);
		if (!g) continue;
		const vx = toMortonX(g[0]), vy = toMortonY(g[1]);
		if (vx < vxMin) vxMin = vx; if (vx > vxMax) vxMax = vx;
		if (vy < vyMin) vyMin = vy; if (vy > vyMax) vyMax = vy;
	}
	s.lastViewBbox = vxMin <= vxMax ? [vxMin, vyMin, vxMax, vyMax] : null;

	renderCleanScene(drawData, null);
	s.lastDrawData = drawData;
}

function drawn() {
	s._isDrawing = false;
	if (!s.lastDrawData) return;
	renderCleanScene(s.lastDrawData, s.baseFBO);
	renderPickingBuffer(s.lastDrawData);
	drawOverlay();
	if (s._pendingMove) { const m = s._pendingMove; s._pendingMove = null; doIdentify(m); }
}

function move(data) { handleMove(data); }
function leave()    { handleLeave(); }

function click() {
	if (s.activeId === -1) return;
	const geo = s.cam ? unproject(s.cam, s.lastMX * s.dpr, s.lastMY * s.dpr) : null;
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
	s.programs = null; s.gintData = null;
	s.polyEdgeByFid = null; s.polyBboxByFid = null;
	s.totalEdges = s.totalPoints = 0;
	s.activeId = -1; s.lastDrawData = null;
	postMessage({ action: "done", type: "destroy" });
}
