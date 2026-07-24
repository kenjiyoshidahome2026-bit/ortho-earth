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

// arcMeta（arc毎8要素 [off,len,weight,0,xmin,ymin,xmax,ymax]、bbox は ix 整数単位）を走査し、
// bbox が ±180（ix=0 または 3.6e9）に正確に載る arc が1つでもあるか＝継ぎ目辺の有無を返す。
// 全球ラップ多角形（NE ocean 等）や antimeridianCut 済み交差データでのみ true。roads や大陸
// データは ±180 に頂点を持たず false＝シェーダのアンチメリディアン判定を無効化しコスト 0。
// 判定はシェーダの辺テスト（両端 ix=0/3.6e9）と同じ閾値なので取りこぼしなし。
function hasAntimeridianSeam(arcMeta) {
	if (!arcMeta) return false;
	const IXMAX = 3600000000;
	for (let i = 0, n = (arcMeta.length / 8) | 0; i < n; i++) {
		const b = i * 8, xmin = arcMeta[b + 4], xmax = arcMeta[b + 6];
		if (xmin <= 2 || xmax >= IXMAX - 2) return true;
	}
	return false;
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

		// このデータに ±180 継ぎ目辺（全球ラップ多角形の平面スリット）があるか一度だけ判定。
		// arcMeta の bbox が x で退化（xmin==xmax）かつ ±180（ix=0 / 3.6e9）に載る arc＝縦の継ぎ目。
		// 無ければシェーダのアンチメリディアン判定を丸ごとスキップ＝roads 等で追加コスト 0。
		s.hasAnti = hasAntimeridianSeam(s.gintData.arcMeta);

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

// キャンバスを確実に消す。毎フレームの提示と同じ経路（baseFBO をクリア→canvas へ blit）を通す。
// 単なる default-FB clear は OffscreenCanvas 自動提示で前フレーム（blit 済み）を消し切れず残像が出る。
function clearScreen() {
	const gl = s.gl, w = s.width * s.dpr, h = s.height * s.dpr;
	gl.stencilMask(0xFF);
	if (s.baseFBO) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, s.baseFBO);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	if (s.baseFBO) {
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.baseFBO);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
		gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}
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
	const effMin = s._effMin = Math.max(s.minZoom ?? 0,  data.minZoom ?? 0);
	const effMax = s._effMax = Math.min(s.maxZoom ?? 22, data.maxZoom ?? 22);
	if (zoom < effMin) {
		// 引きすぎ（minZoom 割れ）＝データを見せない領域。panning 中でも即クリア。
		// 前フレーム保持だと、ズームアウト操作中ずっと図形が凍りついて残像になる。
		clearScreen();
		s.lastDrawData = null;
		return;
	}
	if (zoom > effMax) {
		// 寄りすぎ（maxZoom 超過）は panning 中は直前フレームを保持（フライ/ズーム中の
		// 消失防止）。停止時のみクリア。
		if (!data.panning) {
			clearScreen();
			s.lastDrawData = null;
		}
		return;
	}

	if (s.totalEdges === 0 && s.totalPoints === 0) return;

	s.lastProj = geoOrthographic()
		.rotate(data.rotate).scale(data.scale).translate([s.width / 2, s.height / 2]);

	// Map viewport corners to Morton integer-space bbox (JS polygon fallback ＋ 可視チャンクカリング).
	// 8点のどれかが invert 不能/NaN（地球外＝地平線が画面内）なら bbox は「部分」＝信頼できない
	// → null（カリング全描画・identify 全走査）。部分 bbox でカリングすると画面内の地物を誤って落とす。
	const SE = 1e7;
	let vxMin = 0xFFFFFFFF, vyMin = 0xFFFFFFFF, vxMax = 0, vyMax = 0, nValid = 0;
	for (const [cx, cy] of [
		[0, 0], [s.width, 0], [0, s.height], [s.width, s.height],
		[s.width * .5, 0], [s.width * .5, s.height],
		[0, s.height * .5], [s.width, s.height * .5],
	]) {
		const g = s.lastProj.invert([cx, cy]);
		if (!g || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) continue;
		nValid++;
		const vx = Math.round((g[0] + 180) * SE) >>> 0;
		const vy = Math.round((g[1] +  90) * SE) >>> 0;
		if (vx < vxMin) vxMin = vx; if (vx > vxMax) vxMax = vx;
		if (vy < vyMin) vyMin = vy; if (vy > vyMax) vyMax = vy;
	}
	s.lastViewBbox = (nValid === 8 && vxMin <= vxMax) ? [vxMin, vyMin, vxMax, vyMax] : null;

	renderCleanScene(data, null);
	s.lastDrawData = data;
}

function drawn(data) {
	s._isDrawing = false;
	// remote gint レイヤーの Drawing は常に panning=true で来るため、範囲外クリアは
	// drawing() では発火しない。停止時のここで最終ズームを判定し、範囲外なら確定的に消す。
	const scale = data?.scale;
	if (scale != null) {
		const zoom = Math.log2(scale / 40.74);
		if (zoom < (s._effMin ?? 0) || zoom > (s._effMax ?? 22)) {
			clearScreen();
			s.lastDrawData = null;
			s.activeId = -1;
			return;
		}
	}
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
	s.fillOff      = false;
	s.activeId     = -1;
	s.lastDrawData = null;
	postMessage({ action: "done", type: "destroy" });
}
