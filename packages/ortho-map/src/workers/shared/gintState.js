// ── 共有 GL 状態オブジェクト ───────────────────────────────────────────────────
// Worker はシングルトンなので、全モジュールがこの同一オブジェクトを参照・変更する。

export const s = {
    // GL コア
    canvas: null, gl: null, dpr: 1, width: 0, height: 0,
    programs: null,
    TEX_ARC_W: 4096, TEX_META_W: 4096,

    // テクスチャ
    arcTex: null, metaTex: null, ptTex: null, ptMetaTex: null,
    totalEdges: 0, totalPoints: 0,

    // FBO
    baseFBO: null, baseColorTex: null, baseDepthStencilRBO: null,
    pickFBO: null, pickColorTex: null, pickDepthStencilRBO: null,
    lastDrawData: null,

    // ポリゴン エッジ範囲（O(1) アクティブ feature 引き）
    polyEdgeByFid: null,    // Map<featureId, [edgeStart, edgeCount]>
    polyBboxByFid: null,    // Map<featureId, [xMin,yMin,xMax,yMax]>（JS fallback 用）

    // ズーム範囲
    minZoom: null, maxZoom: null,

    // identify / hover
    activeId: -1,
    gintData: null,
    lastViewBbox: null,
    lastProj: null, lastMX: NaN, lastMY: NaN,
    _isDrawing: false, _moveTimer: null, _pendingMove: null,

};

// ── スタイルデフォルト ─────────────────────────────────────────────────────────
export const DEF_STYLE = new Float32Array(256 * 4);
DEF_STYLE.set([1.0, 0.420, 0.208, 1.0]);      // style 0: polygon  #FF6B35
DEF_STYLE.set([0.0, 0.706, 0.847, 1.0],  4);  // style 1: polyline #00B4D8
// u_dash_table[i] = [dash_len, period] (px). period=0 → solid line.
export const DEF_DASH = new Float32Array(256 * 2);
export const DEF_FILL = new Float32Array([0, 0, 0, 0]);
export const DEF_MASK = new Float32Array([0, 0, 0, 0.4]);

export const MOVE_THROTTLE_MS = 32;
