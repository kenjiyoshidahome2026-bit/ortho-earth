// geopbf/edit — GeoPBF 編集 SDK（v1.3）。geoedit で実戦投入済みの臓器を昇格（proven organ の一方向移植）。
// 全て純データモジュール（DOM なし・worker 安全・Node 試験可）。
//   buildTopology  : FeatureCollection → 編集用トポロジ（共有辺は1本の arc を N フィーチャが参照）
//   createModel    : トポロジを包む編集モデル＝moveVertex/insert/delete/addFeature/setProperties…（undo コマンド返し）
//   createLargeModel: 大規模モード＝GeoPBF バイト列+GintBUF を真実源のまま in-place 編集（数千万頂点・OOM 回避）
//   createSnapIndex: スナップ索引（格子 10^-gridExp 連動）／createHistory: undo/redo コマンド台帳
//   smoothRing/smoothGeom: @spline の Catmull-Rom 細分（エディタと再生の共通幾何）
//   sphere         : 完全球体の幾何＝大円補間・球面回転（四元数）・小円。頂点は大円で結ぶ／移動は回転（本人裁定 2026-09-14）
// 個別 import は geopbf/edit/<name>（model / large-model / topo-extract / snap / history / spline）。
export { buildTopology, createExtractor, quantize, quantizeLine } from "./topo-extract.ts";
export type { Topology, TopoArc, TopoFeature, TopoNode, ArcTree, Extractor } from "./topo-extract.ts";
export { createModel, rebuildModel, adoptRebuilt, retopoTopo, topoToTransfer, topoFromTransfer, stitchGeometry, listsOf } from "./model.ts";
export type { EditModel, EditCmd, Addr, ArcList, FeatureVerts, TopoTransfer, TopoPayload } from "./model.ts";
export { createLargeModel } from "./large-model.ts";   // listsOf は model 側の物（large-model も同じ関数を再輸出）
export type { LargeModel, LargeFeature, LargeCmd, LargeAddr } from "./large-model.ts";
export { createSnapIndex, buildBase, normLon } from "./snap.ts";
export type { SnapIndex, SnapBase, SnapEntry, SnapRef } from "./snap.ts";
export { createHistory } from "./history.ts";
export type { History } from "./history.ts";
export { smoothRing, smoothGeom } from "./spline.ts";
export { toVec, toLL, slerp, gcInterpolate, gcMidpoint, gcDistanceDeg, angleBetween, quatBetween, quatFromAxisAngle, quatMul, quatInverse, quatAngle, rotateVec, rotateLL, smallCircle, gcCentroid } from "./sphere.ts";   // 完全球体の幾何（大円・回転・小円）
export type { Vec3, Quat, LonLat } from "./sphere.ts";
