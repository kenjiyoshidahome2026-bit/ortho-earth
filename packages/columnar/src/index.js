// @ortho-earth/columnar ── GeoPBF と GeoParquet を gint を通さず「Parquet 流」に描く列チャンク層（#90）。
//   main：createColumnarView(map, src, opts) → 手綱（setPaint/setFilter/setVisible/query/on/remove …）
//   worker：@ortho-earth/columnar/worker（役割名 "columnar"）＝ホストの worker 入口に載せる（setWorkerFactory で入口を差し替え）
//   描画：@ortho-earth/columnar/draw（依存ゼロ・map.overlay が URL で import する）
//   読み手：@ortho-earth/columnar/sources（登録簿・registerColumnarSource）。既定は GeoParquet と GeoPBF（"#columnar-sources"）
export { createColumnarView, setWorkerFactory } from "./view.js";
export { registerColumnarSource, listColumnarSources, findColumnarSource } from "./sources/registry.js";
export { buildChunk, LOD_ZOOMS } from "./chunk.js";
export { DEFAULT_PAINT } from "./style.js";
export const COLUMNAR_EXT = /\.(geopbf|parquet|geoparquet)$/i;
