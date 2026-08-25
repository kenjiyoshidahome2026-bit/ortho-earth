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
import { computeDrawData, zoomInRange } from './drawdata.js';
import { uploadFidStyle, clearFidStyle, restoreFidStyle, idFillContextLost, disposeIdFill } from './idfill.js';
import { unproject } from '../../camera.js';

const funcs = { init, set, resize, drawing, drawn, move, leave, click, destroy, style, paint, snapshot, bench };

// paint（fid スタイル表）の差し替え（gint draw spec.md §7.1）。main が style.js の buildFidStyle で
// 式を評価済み＝ここは Uint32Array を受けてテクスチャ更新1回のみ。null=解除（従来塗りへ）。
function paint(data) {
	if (data.table && data.count > 0) uploadFidStyle(data.table, data.count);
	else clearFidStyle();
	s.idOverlapMode = !!data.overlap;   // 重複可視化モード（品質監査プローブ）
	if (s.lastDrawData) renderCleanScene(s.lastDrawData, null);   // 静止中の即時反映（次の drawing を待たない）
}

// 描画コスト計測フック（ベンチハーネス用・通常経路では呼ばれない。v1 gint.js の bench と同形）：
// drawNow 一式を発行し readPixels(1px) で GPU 完了まで待った実時間を返す（gl.finish は ANGLE で遅延され得る）。
function bench(data) {
	const t0 = performance.now();
	drawNow(data);
	const px = new Uint8Array(4);
	s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
	s.gl.readPixels(0, 0, 1, 1, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
	postMessage({ action: "bench", ms: performance.now() - t0,
		stats: { edges: s.totalEdges, polyEdges: s.polyEdges, outlineZoom: s.outlineZoom,
			lodRank: s.lastDrawData?.lodRank, tiers: (s.lodTiers ?? []).map(t => [t.minW, t.edgeCount]) } });
}
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
function onSync(d) {
	if (!d || !d.cam) return;
	// カメラが実際に動いた時だけ panning（＝ホバー識別を止める＝移動中の pick buffer は古い）。
	// fog追従・ラベル/タイル/PLATEAUロード等でカメラ静止中も同期が来続ける＝それを panning 扱いすると
	// 識別が settle まで永久に止まる（＝ホバーで内容が変わらない）。静止中の再描画は panning:false＝識別を通す。
	const c = d.cam, l = s._lastSyncCam;
	const moved = !l || l.center[0] !== c.center[0] || l.center[1] !== c.center[1] || l.zoom !== c.zoom || l.pitch !== c.pitch || l.bearing !== c.bearing;
	s._lastSyncCam = { center: [c.center[0], c.center[1]], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing };
	drawNow({ cam: c, panning: moved, ...(s.drawStyle || {}) });
}

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
		s.arcTex = s.metaTex = s.metaTexB = s.ptTex = s.ptMetaTex = null;
		s.totalEdgesB = s.polyEdgesB = 0;
		s.lodTiers = []; s.tierGen = (s.tierGen ?? 0) + 1;   // 遅延 tier 構築も中止（復元時に作り直す）
		s.baseFBO = s.baseColorTex = s.baseDepthStencilRBO = null;
		s.pickFBO = s.pickColorTex = s.pickDepthStencilRBO = null;
		s.programs = null; s.lastDrawData = null;
		idFillContextLost();   // ID塗りの GL 資産も消滅（CPU 側 fid 表は保持＝restore で再上げ）
	}, false);
	s.canvas.addEventListener('webglcontextrestored', () => {
		s.programs = createGintPrograms(s.gl);
		createFBOs(); uploadGintTextures(); restoreFidStyle();
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
			fillMaxEdges: data.data.fillMaxEdges ?? null,   // 同期フォールバックでも層別の塗り上限/低ズーム塗りを落とさない（bakeworker と同じ台帳）
			lowFill:      data.data.lowFill      ?? false,
		};
		uploadGintTextures();
		({ minZoom: s.minZoom, maxZoom: s.maxZoom } = checkZoomRange({
			arcMeta:   s.gintData.arcMeta,
			minZoom:   data.data.minZoom   ?? null,
			maxZoom:   data.data.maxZoom   ?? null,
			precision: data.data.precision ?? 6,
		}));
		s.activeId = -1; s.lastDrawData = null;
	} else if (data.cmd === "gint") {   // data 無し＝gint スロットを空に（ドロップ図形のクリア）。
		// totalEdges===0 の drawNow はキャンバスを消さず早期 return する＝残像が残るので、ここで明示的に1枚消す。
		deleteTextures();
		s.gintData = null; s.polyEdgeByFid = null; s.polyBboxByFid = null; s.outlineZoom = null; s.fillOff = false; s.lowFill = false;
		s.totalEdges = s.totalPoints = s.polyEdges = 0;
		s.activeId = -1; s.lastDrawData = null;
		if (s.gl) { s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null); s.gl.clearColor(0, 0, 0, 0); s.gl.stencilMask(0xFF); s.gl.clear(s.gl.COLOR_BUFFER_BIT); }
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
		// カメラ操作に入った瞬間に tip とハイライトを即消す（embedded 側と同挙動）。
		if (s.activeId !== -1) { s.activeId = -1; postMessage({ action: "identify", featureId: null }); }
	} else {
		s._isDrawing = false;
	}
	s.lastMX = NaN; s.lastMY = NaN;

	if (!zoomInRange(data)) {
		// 範囲外は常にクリア（panning中も）。ズームインで z>maxZoom を跨いだ瞬間に消す＝「消し忘れ」防止。
		// ※v1 は zoomToFeature が範囲外を一瞬通る対策で panning中は前フレーム保持していたが、
		//   ortho-japan には zoomToFeature が無いので保持不要。将来 fly-to を足すなら要再考。
		s._inRange = false;   // 描画されていない＝identify(tip) も抑止（handleMove が空振りを返す）
		s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
		s.gl.clearColor(0, 0, 0, 0);
		s.gl.stencilMask(0xFF);
		s.gl.clear(s.gl.COLOR_BUFFER_BIT);
		s.lastDrawData = null;
		return;
	}
	s._inRange = true;
	if (s.totalEdges === 0 && s.totalPoints === 0) return;

	// site 3（cam→mvp/eye/origin/RTE錨/LODランク/視野bbox）は drawdata.js（embedded モードと共用）。
	const drawData = computeDrawData(data);
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
	disposeIdFill();
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
	s.polyEdgeByFid = null; s.polyBboxByFid = null; s.fillOff = false; s.lowFill = false;
	s.totalEdges = s.totalPoints = s.polyEdges = 0;
	s.activeId = -1; s.lastDrawData = null;
	postMessage({ action: "done", type: "destroy" });
}
