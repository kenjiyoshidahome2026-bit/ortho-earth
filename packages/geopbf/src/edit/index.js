// geopbf/edit — GeoPBF 編集 SDK（v1.3）。geoedit で実戦投入済みの臓器を昇格（proven organ の一方向移植）。
// 全て純データモジュール（DOM なし・worker 安全・Node 試験可）。
//   buildTopology  : FeatureCollection → 編集用トポロジ（共有辺は1本の arc を N フィーチャが参照）
//   createModel    : トポロジを包む編集モデル＝moveVertex/insert/delete/addFeature/setProperties…（undo コマンド返し）
//   createLargeModel: 大規模モード＝GeoPBF バイト列+GintBUF を真実源のまま in-place 編集（数千万頂点・OOM 回避）
//   createSnapIndex: スナップ索引（格子 10^-gridExp 連動）／createHistory: undo/redo コマンド台帳
//   smoothRing/smoothGeom: @spline の Catmull-Rom 細分（エディタと再生の共通幾何）
// 個別 import は geopbf/edit/<name>（model / large-model / topo-extract / snap / history / spline）。
export { buildTopology, createExtractor, quantize, quantizeLine } from "./topo-extract.js";
export { createModel, rebuildModel, adoptRebuilt, retopoTopo, topoToTransfer, topoFromTransfer, stitchGeometry, listsOf } from "./model.js";
export { createLargeModel } from "./large-model.js";   // listsOf は model 側を正とする（同実装の私有ヘルパ）
export { createSnapIndex, buildBase, normLon } from "./snap.js";
export { createHistory } from "./history.js";
export { smoothRing, smoothGeom } from "./spline.js";
