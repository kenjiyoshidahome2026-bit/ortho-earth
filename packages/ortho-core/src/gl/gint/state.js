// 共有 GL 状態（v2）。worker は singleton なので全モジュールがこの s を読み書きする。
// v1(ortho-map) の gintState を移植。唯一の差分＝d3 の lastProj を japan の cam(cameraState)へ。
// cam は identify の unproject（JSレイキャストの逆写像＝site 4）に使う。

export const s = {
	// GL core
	canvas: null, gl: null, dpr: 1, width: 0, height: 0,
	programs: null,
	TEX_ARC_W: 4096, TEX_META_W: 4096,

	// Textures
	arcTex: null, metaTex: null, ptTex: null, ptMetaTex: null,
	fidStyleTex: null, fidStyleW: 0, fidStyleCount: 0,   // fid スタイル表（RGBA32UI・paint の実体＝idfill.js）。CPU 控えは _fidStyleData（context restore 用）
	pivotTex: null, pivotW: 0,     // stencil塗りの per-feature 扇要（fid→bbox中心 e7整数）。null=従来のクリップ原点
	lodTiers: [],                  // 段階別 LOD メタ [{minW, edgeCount, tex}] minW 昇順（粗いほど後ろ）
	metaChunks: null,              // 基準メタのチャンク台帳 [{start,end,bbox}]（可視カリング用）
	totalEdges: 0, totalPoints: 0,
	polyEdges: 0,                  // メタ先頭のポリゴン辺数（stencil 塗りはこの範囲だけ＝折れ線をファンさせない）
	fillOff: false,                // 巨大ポリゴンデータの自動ベタ塗り停止（塗り stencil は LOD/カリング非対応＝辺数がそのまま毎フレーム コスト。uploadGintTextures が判定）
	tiersDone: false,              // tier梯子の遅延構築が完了したか（未完の間だけ pickLineTier が「最細の既存tier」で代用描画）

	// FBOs
	baseFBO: null, baseColorTex: null, baseDepthStencilRBO: null,
	pickFBO: null, pickColorTex: null, pickDepthStencilRBO: null,
	lastDrawData: null,

	// Polygon edge ranges — O(1) active-feature lookup.
	polyEdgeByFid: null,    // Map<featureId, [edgeStart, edgeCount]>
	polyBboxByFid: null,    // Map<featureId, [xMin,yMin,xMax,yMax]> — JS fallback（Morton整数空間）

	// Zoom range
	minZoom: null, maxZoom: null,

	// Embedded モード（1canvas統合＝renderworker の GL コンテキストに同居）。
	// embedded=true の間は「自分のcanvasを clear して描く」worker 前提を全て外す：
	// renderCleanScene は色を消さず現フレームの地図の上に blend、識別のハイライト反映は
	// drawOverlay(blit) でなく requestDraw()（＝render worker の dirty）で全再描画に委ねる。
	embedded: false,
	requestDraw: null,

	// Identify / hover
	activeId: -1,
	gintData: null,
	lastViewBbox: null,
	cam: null, lastMX: NaN, lastMY: NaN,   // ← v1 の lastProj を cam(cameraState)へ置換
	_isDrawing: false, _moveTimer: null, _pendingMove: null,
	_inRange: false,   // 現ズームが [minZoom,maxZoom] 内で実描画されているか＝identify(tip) の可否。描画されない地物にホバー tip を出さない。
};

export const DEF_STYLE = new Float32Array(256 * 4);
DEF_STYLE.set([1.0, 0.420, 0.208, 1.0]);      // style 0: polygon  #FF6B35
DEF_STYLE.set([0.0, 0.706, 0.847, 1.0],  4);  // style 1: polyline #00B4D8
export const DEF_DASH = new Float32Array(256 * 2);
export const DEF_FILL = new Float32Array([0, 0, 0, 0]);
export const DEF_MASK = new Float32Array([0, 0, 0, 0.4]);

export const MOVE_THROTTLE_MS = 32;
