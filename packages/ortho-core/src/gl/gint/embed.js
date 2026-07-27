// gint embedded（1canvas統合）── gintworker の心臓を render worker の GL コンテキストへ同居させる。
// 別 canvas + 従属駆動（gintSyncChan）で生じていた「地図に対し1フレーム級遅れて泳ぐ」を、
// 地図フレームの末尾（夜面の後＝最前面）で同一 cam から描く1パスに置き換えて根治する。
//
// worker モードとの差分（s.embedded=true が各臓器で分岐）：
//  - renderCleanScene は色を clear せず現フレームの地図の上へ blend（stencil だけ消す）
//  - baseFBO/blit のハイライト復元機構は廃止＝activeId があれば毎フレーム drawHighlight を inline 描画
//  - 識別の画面反映は requestDraw()（render worker の dirty）＝地図ごと1枚描き直し
//  - blend は gint=straight alpha / renderer=premultiplied ＝パス前後で blendFunc を切替復元
//  - サイズは毎フレーム canvas 実寸へ追随（動的解像度で縮む）。pick FBO は settle(drawn) 時にだけ作り直す
//
// メッセージ面（postMessage）は worker 版と同じ action（identify/click/tiers）＝main 側は受信元が
// gintWorker→renderWorker へ変わるだけ。

import { createGintPrograms } from './programs.js';
import { checkZoomRange } from './utility.js';
import { s } from './state.js';
import { uploadGintTextures, deleteTextures } from './textures.js';
import { createFBOs, deleteFBOs } from './fbo.js';
import { renderCleanScene, drawHighlight, renderPickingBuffer } from './passes.js';
import { doIdentify, handleMove, handleLeave } from './identify.js';
import { computeDrawData, zoomInRange } from './drawdata.js';
import { uploadFidStyle, clearFidStyle, disposeIdFill } from './idfill.js';
import { unproject } from '../../camera.js';

export function createGintLayer(gl, { requestDraw } = {}) {
	s.embedded = true;
	s.requestDraw = requestDraw ?? null;
	s.gl = gl;
	s.TEX_ARC_W  = Math.min(s.TEX_ARC_W,  gl.getParameter(gl.MAX_TEXTURE_SIZE));
	s.TEX_META_W = Math.min(s.TEX_META_W, gl.getParameter(gl.MAX_TEXTURE_SIZE));
	s.programs   = createGintPrograms(gl);   // 初期化時の blend 設定は renderer が毎フレーム上書きする＝無害

	let drawStyle = null;    // main が set("gintStyle") で預ける描画スタイル（styleTable/lineWidth 等）
	let visible = true;      // main が set("gintVis") で切替（旧 #gint canvas の display:none 相当）
	let fboW = 0, fboH = 0;  // pick FBO の実寸（canvas と食い違ったら settle で作り直す）

	// gint ペイロードの差し替え（null/undefined＝空化）。worker 版 set() と同じ台帳更新。
	// embedded では canvas の明示クリア不要＝地図の再描画（requestDraw）が残像ごと消す。
	function set(data) {
		if (data) {
			const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point, polyCompBbox } = data;
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
				minZoom:   data.minZoom   ?? null,
				maxZoom:   data.maxZoom   ?? null,
				precision: data.precision ?? 6,
			}));
		} else {
			deleteTextures();
			s.gintData = null; s.polyEdgeByFid = null; s.polyBboxByFid = null; s.outlineZoom = null; s.fillOff = false;
			s.totalEdges = s.totalPoints = s.polyEdges = 0;
		}
		s.activeId = -1; s.lastDrawData = null;
		s.requestDraw?.();
	}

	function style(data)   { drawStyle = data ?? null; s.requestDraw?.(); }
	function setVisible(v) { visible = !!v; s.requestDraw?.(); }

	// paint（fid スタイル表）の差し替え（gint draw spec.md §7.1）。main が style.js の buildFidStyle で
	// 式を評価済み＝ここは Uint32Array を受けてテクスチャ更新1回のみ（restyle 契約）。null=解除（従来塗りへ）。
	function paint(data) {
		if (data?.table && data.count > 0) uploadFidStyle(data.table, data.count);
		else clearFidStyle();
		s.idOverlapMode = !!data?.overlap;   // 重複可視化モード（品質監査プローブ。通常 paint では false に戻る）
		s.requestDraw?.();
	}

	// 地図フレーム末尾の gint パス。cam は renderer.draw と同じ glCam（動的解像度中は dpr×resScale 済み）
	// ＝幾何・線幅とも地図と厳密同期。旧 onSync の「実移動判定」もここで行う（識別の panning 抑止）。
	// ctx＝renderer.gintCtx()：山岳ビュー（terrainDepth）の間だけ非null＝線を地形深度に参加させる
	//（対数深度＋標高ドレープ＋隠線淡破線）。null なら段階A と同じ最前面描画。
	function draw(cam, ctx) {
		if (!s.programs) return;
		// 非表示でも識別ジオメトリ(polyBbox/点)を持つ層は下へ進み lastDrawData/pick を建てる＝視覚を消しても hover 識別は生かす
		// （筆界はチルトで視覚を消す設計だが、draped 線を hover して tip を出すために identify は生存させる）。純装飾(線のみ=海岸線)は従来通り bail。
		if (!visible && !s.polyBboxByFid && s.totalPoints === 0) { s._inRange = false; s.lastDrawData = null; return; }
		s.width  = gl.canvas.width;    // 毎フレーム実寸へ追随（resize/動的解像度）。FBO は drawn() で追随
		s.height = gl.canvas.height;
		s.dpr    = cam.dpr || 1;       // 線幅・identify の CSS→device 変換も同じ実効 dpr を共有

		// カメラが実際に動いた時だけ panning（＝ホバー識別を止める＝移動中の pick buffer は古い）。
		// fog追従・ラベル/タイル/PLATEAUロード等でカメラ静止中も再描画が続く＝それを panning 扱いすると
		// 識別が settle まで永久に止まる。静止中の再描画は panning:false＝識別を通す（旧 onSync と同判断）。
		const l = s._lastSyncCam;
		const moved = !l || l.center[0] !== cam.center[0] || l.center[1] !== cam.center[1]
			|| l.zoom !== cam.zoom || l.pitch !== cam.pitch || l.bearing !== cam.bearing;
		s._lastSyncCam = { center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing };
		if (moved) {
			s._isDrawing = true;
			clearTimeout(s._moveTimer); s._moveTimer = null; s._pendingMove = null;
			s._staticN = 0;
			// カメラ操作（zoom/pan）に入った瞬間に tip とハイライトを即消す（handleLeave と同形の通知）。
			// activeId ガード＝遷移の1回だけ発火（移動中の毎フレーム postMessage はしない）。
			if (s.activeId !== -1) { s.activeId = -1; postMessage({ action: "identify", featureId: null }); }
		} else {
			s._isDrawing = false;
			s._staticN = (s._staticN ?? 0) + 1;
		}
		s.lastMX = NaN; s.lastMY = NaN;

		// 移動中の描画予算：可視辺数（前フレーム実測 _pfLineEdges）が予算超の巨大層は、動いている間は描かず
		// 静止（数フレーム連続＝ためらいパンで点滅しない）で描く。VW-LOD も tier も効かない筆系巨大層
		//（短arc＝anchor支配）の「チルト/広域＝数十万辺×毎フレーム＝GPU 100ms級」から地図の応答性を守る
		//（旧 #gint canvas opacity 手当ての一般化＝データ量で自動発動。海岸線19万辺級は予算内＝常時同フレーム）。
		// settle(150ms) までに静止フレームが必ず数枚入る＝drawn() の picking は新鮮な lastDrawData で走る。
		// 予算は drawStyle.moveBudget で可変（既定 250k）。根拠だった「GPU 100ms級」実測は pivotClip/隠線ガード
		// 導入前のもの＝実機で測り直して閾値を決め直すためのノブ（Infinity=移動中も常時描画）。
		const MOVE_EDGE_BUDGET = drawStyle?.moveBudget ?? 250_000;
		if ((s._pfLineEdges ?? 0) > MOVE_EDGE_BUDGET && s._staticN < 4) {
			s.lastDrawData = null;   // この間の identify/picking は抑止（古い cam の pick を残さない）
			s._budgetSkipped = true; // settle(drawn) の復帰フック用＝「スキップ中に地図が idle 化」を検出
			return;
		}

		const data = { cam, ...(drawStyle || {}) };
		if (!zoomInRange(data)) { s._inRange = false; s.lastDrawData = null; s._pfLineEdges = 0; s._pfTierW = -1; return; }   // 範囲外＝描かない（identify も抑止）
		s._inRange = true;
		if (s.totalEdges === 0 && s.totalPoints === 0) { s.lastDrawData = null; s._pfLineEdges = 0; s._pfTierW = -1; return; }

		s._budgetSkipped = false;   // ここから先は必ず描く＝スキップ状態を解除（settle 復帰フックは drawn 側）

		const drawData = computeDrawData(data);
		if (ctx && ctx.terrainDepth) drawData.depth = ctx;   // passes.js が線パスだけ深度テスト＋隠線2パスに切替

		// ── GL 状態の切替と退避復元 ──
		// renderer は premultiplied（ONE, ONE_MINUS_SRC_ALPHA）・gint シェーダは straight alpha 出力。
		// 深度は段階A＝最前面（renderer は夜面の後で DEPTH_TEST off のまま渡してくるが、明示 off で自衛）。
		if (visible) {   // 実描画は表示中だけ。非表示層（チルトで消した筆界など）はここを飛ばし、下の lastDrawData/pick だけ建てて hover 識別を生かす
			gl.disable(gl.DEPTH_TEST);
			gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			renderCleanScene(drawData, null);   // embedded＝色を消さず上書き blend（passes.js の分岐）
			drawHighlight(drawData);            // ホバー中の地物（activeId≥0）＝blit 復元でなく毎フレーム inline
		}
		s.lastDrawData = drawData;
		if (s._pickPending) { s._pickPending = false; drawn(); }   // settle 復帰フレーム＝picking もここで建てる（下記 drawn の復帰フック）
		// 復元：renderer は次フレーム冒頭で blend を張り直すが、同一タスク内の後続描画（snapshot 経路）と
		// フレーム間規約のため明示的に戻す。stencil/VAO/テクスチャユニットも中立へ。
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.STENCIL_TEST);
		gl.stencilMask(0xFF);
		gl.bindVertexArray(null);
		gl.activeTexture(gl.TEXTURE0);
	}

	// settle（地図静止）：picking buffer を描いて hover 識別を有効化。
	// 非interactive（識別ジオメトリ無し＝海岸線 lineStream のみ）は丸ごと省略（worker 版 drawn と同判断）。
	function drawn() {
		s._isDrawing = false;
		s._pfDrawn = (s._pfDrawn ?? 0) + 1;   // perf 計測用（settle 到達数。?perf=1 の行に出る）
		// 移動中予算スキップ（MOVE_EDGE_BUDGET）の復帰は「静止フレーム4枚」を待つが、フレームは地図が
		// dirty の間しか回らない＝タイル/ラベルが全てキャッシュ済みだと静止直後に idle 化して4枚に届かず、
		// レイヤが次の操作まで消えたままになる（実症状）。settle は静止の確定合図＝ここで予算ゲートを
		// 通過扱いにし、自前でフレームを要求して復帰させる。picking はその復帰フレームの直後に建てる（上記フック）。
		if (!s.lastDrawData) {
			if (s._budgetSkipped) { s._budgetSkipped = false; s._staticN = 4; s._pickPending = true; s.requestDraw?.(); }
			return;
		}
		if (!s.polyBboxByFid && s.totalPoints === 0) return;
		if (!s.pickFBO || fboW !== s.width || fboH !== s.height) {
			const keep = s.lastDrawData;   // createFBOs は lastDrawData を無効化する（worker 規約）＝ここでは維持
			createFBOs();                  // embedded＝pick FBO のみ生成（fbo.js の分岐）
			s.lastDrawData = keep;
			fboW = s.width; fboH = s.height;
			s._pfFbo = (s._pfFbo ?? 0) + 1;   // perf 計測用（pick FBO 再生成数＝解像度フリップ毎に起きていないか）
		}
		const t0 = performance.now();
		renderPickingBuffer(s.lastDrawData);
		s._pfPickMs = (s._pfPickMs ?? 0) + (performance.now() - t0);   // perf 計測用（pick 描画の CPU 発行累計）
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

	function dispose() {
		deleteTextures();
		deleteFBOs();
		disposeIdFill();
		if (s.gl && s.programs) {
			const { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
					pointProgram, pickLineProgram, pickPointProgram, emptyVAO } = s.programs;
			if (emptyVAO)           gl.deleteVertexArray(emptyVAO);
			for (const p of [renderProgram, stencilProgram, fillProgram, maskStencilProgram,
							 pointProgram, pickLineProgram, pickPointProgram]) if (p) gl.deleteProgram(p);
		}
		s.programs = null; s.gintData = null;
		s.polyEdgeByFid = null; s.polyBboxByFid = null; s.fillOff = false;
		s.totalEdges = s.totalPoints = s.polyEdges = 0;
		s.activeId = -1; s.lastDrawData = null;
	}

	// perf 計測用（?perf=1 の行に出す settle 系カウンタと LOD の効き。読み出しは renderworker）
	function stats() {
		return { drawn: s._pfDrawn ?? 0, fbo: s._pfFbo ?? 0, pickMs: s._pfPickMs ?? 0,
			rank: s.lastDrawData?.lodRank ?? -1, tierW: s._pfTierW ?? -1, edges: s._pfLineEdges ?? 0,
			tiers: s.lodTiers?.length ?? 0, tiersDone: !!s.tiersDone, total: s.totalEdges,
			runs: s._pfRuns ?? -1, chunks: s._pfChunks ?? -1, vb: s.lastViewBbox };
	}

	return { set, style, setVisible, paint, draw, drawn, move, leave, click, dispose, stats };
}
