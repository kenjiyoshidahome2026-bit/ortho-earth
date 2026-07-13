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

const funcs = { init, set, resize, drawing, drawn, move, leave, click, destroy, style, snapshot };
onmessage = e => (funcs[e.data.type] ?? (() => {}))(e.data);

// shot（画面保存）用：直近の cam で1枚描き直して（WebGLは別タスクでは読めない＝同一タスクで捕獲）
// ImageBitmap を返す。lastDrawData が無い（範囲外/未描画）なら透明のまま返る＝main が合成でそのまま重ねる。
function snapshot(data) {
	try {
		if (s.lastDrawData) renderCleanScene(s.lastDrawData, null);   // 今の cam で1枚（無ければ透明のまま）
		// readPixels＝GLを確実に読む（createImageBitmap/transferToImageBitmap は headless GL で詰まる）。上下反転で返る＝main で戻す。
		const gl = s.gl, w = s.width, h = s.height;
		const base = new Uint8Array(w * h * 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, base);
		postMessage({ action: "snapshot", id: data.id, base: base.buffer, w, h }, [base.buffer]);
	} catch (e) { console.error("[gint] snapshot例外", e?.message); }
}

// main が持つ描画スタイル(styleTable/lineWidth 等=gintDrawOpts)を保持。従属描画(onSync)で使う。
function style(data) { s.drawStyle = data.data ?? null; }
// render worker から「この cam で描け」の合図＝地図フレームに従属（地図と同じ cam を同じフレームで出す＝スライド消滅）。
function onSync(d) { if (d && d.cam) drawNow({ cam: d.cam, panning: true, ...(s.drawStyle || {}) }); }

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

	if (data.syncPort) { s.syncPort = data.syncPort; s.syncPort.onmessage = ev => onSync(ev.data); }   // 地図フレーム従属の入口
	requestAnimationFrame(gintFrame);   // （従属時は idle。set/redraw 時の保険として残置）
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

// worker-driven：drawing メッセージは「最新の描画要求を記録するだけ」。実描画は自前 rAF(gintFrame)が
// 次の vsync で最新 cam を描く（renderworker.js と同モデル）。地図(renderWorker)と同じクロックに乗り、
// 「海岸線が即描画で先行→地図が rAF で遅れて追う」位相ズレを解消。溜まった要求は最新一枚に畳む。
function drawing(data) { s._pendingDrawMsg = data; s._drawDirty = true; }
function gintFrame() {
	if (s._drawDirty && s._pendingDrawMsg) { s._drawDirty = false; drawNow(s._pendingDrawMsg); }
	requestAnimationFrame(gintFrame);
}

function drawNow(data) {
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
		// 範囲外は常にクリア（panning中も）。ズームインで z>maxZoom を跨いだ瞬間に消す＝「消し忘れ」防止。
		// ※v1 は zoomToFeature が範囲外を一瞬通る対策で panning中は前フレーム保持していたが、
		//   ortho-japan には zoomToFeature が無いので保持不要。将来 fly-to を足すなら要再考。
		s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
		s.gl.clearColor(0, 0, 0, 0);
		s.gl.stencilMask(0xFF);
		s.gl.clear(s.gl.COLOR_BUFFER_BIT);
		s.lastDrawData = null;
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

	// ── GPU Dynamic LOD 閾値：現ビューの 1px が覆う地表面積(sq-deg, cos-lat 補正) を rust get_phys_rank と
	// 同式で rank 化。この rank 未満の頂点(辺)は VS で discard＝毎フレームの描画頂点を桁で削減。
	// gap は「discard される辺=サブピクセル」なので原理的に不可視（VW eff-area の単調性＝strict superset）。
	{
		const c  = unproject(st, s.width * 0.5,       s.height * 0.5);
		const ex = unproject(st, s.width * 0.5 + 1.0, s.height * 0.5);
		const ey = unproject(st, s.width * 0.5,       s.height * 0.5 + 1.0);
		let rank = 0;
		if (c && ex && ey) {
			const cl = Math.cos(c[1] * Math.PI / 180);
			const ax = (ex[0] - c[0]) * cl, ay = ex[1] - c[1];
			const bx = (ey[0] - c[0]) * cl, by = ey[1] - c[1];
			const pxArea = Math.abs(ax * by - ay * bx);   // 1px が覆う地表面積 (sq-deg)
			// LOD_BIAS：閾値を下げるほど頂点を多く残す。0=物理px基準（1px未満を捨てる＝厳密で LOD が最も効く）。
			// イガイガ対策は丸キャップ(capsule SDF)で幾何的に解決済なので、bias は 0 でよい（正なら滑らか寄り・LODは弱まる）。
			const LOD_BIAS = 0;
			if (pxArea > 0) rank = Math.max(0, Math.min(63, Math.floor(1.5 * Math.log2(pxArea) + 61.524) - LOD_BIAS));
		}
		drawData.lodRank = rank;
	}

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
	// settle 時：保留中の最新描画を先に流し込んでから picking/overlay（drawing→drawn の順序を保つ）。
	if (s._drawDirty && s._pendingDrawMsg) { s._drawDirty = false; drawNow(s._pendingDrawMsg); }
	s._isDrawing = false;
	if (!s.lastDrawData) return;
	// 非interactive（識別ジオメトリ無し＝海岸線 lineStream のみ）は baseFBO 再描画/picking/overlay を丸ごと省略。
	// drawNow が既に canvas へ最終フレームを描いている＝ハイライト機構は不要＝settle 毎の全ジオメトリ2パスを節約。
	if (!s.polyBboxByFid && s.totalPoints === 0) return;
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
