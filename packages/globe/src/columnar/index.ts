// 列チャンク層（@ortho-earth/globe の src/columnar・2026-10-15 に旧 @ortho-earth/columnar を吸収）── GeoPBF と GeoParquet を gint を通さず「Parquet 流」に描く列チャンク層（#90）。
//   main：createColumnarView(map, src, opts) → 手綱（setPaint/setFilter/setVisible/query/on/remove …）
//   worker：./worker.js（役割名 "columnar"）＝ホストの worker 入口に載せる（setWorkerFactory で入口を差し替え）
//   描画：./draw-gl.js（依存ゼロ・map.overlay が URL で import する）
//   読み手：./sources/registry.js（登録簿・registerColumnarSource）。既定は GeoParquet と GeoPBF（"#columnar-sources"）
export { createColumnarView, setWorkerFactory } from "./view.js";
export { registerColumnarSource, listColumnarSources, findColumnarSource } from "./sources/registry.js";
export { buildChunk, LOD_ZOOMS } from "./chunk.js";
export { DEFAULT_PAINT } from "./style.js";
export { shareStats, gintPreferred } from "./share.js";
export const COLUMNAR_EXT = /\.(geopbf|parquet|geoparquet|fgb)$/i;
