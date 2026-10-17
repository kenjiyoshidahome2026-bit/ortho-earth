// 列チャンク層（@ortho-earth/globe の src/columnar・2026-10-15 に旧 @ortho-earth/columnar を吸収）── GeoPBF と GeoParquet を gint を通さず「Parquet 流」に描く列チャンク層（#90）。
//   main：createColumnarView(map, src, opts) → 手綱（setPaint/setFilter/setVisible/query/on/remove …）
//   worker：./worker.js（役割名 "columnar"）＝ホストの worker 入口に載せる（setWorkerFactory で入口を差し替え）
//   描画：./draw-gl.ts（render worker の組み込みのオーバーレイ "columnar"）
//   読み手：./sources/registry.js（登録簿・registerColumnarSource）。既定は GeoParquet と GeoPBF（"#columnar-sources"）
export { createColumnarView, setWorkerFactory } from "./view.ts";
export { registerColumnarSource, listColumnarSources, findColumnarSource } from "./sources/registry.ts";
export { buildChunk, LOD_ZOOMS } from "./chunk.ts";
export { DEFAULT_PAINT } from "./style.ts";
export { shareStats, gintPreferred } from "./share.ts";
export const COLUMNAR_EXT = /\.(geopbf|parquet|geoparquet|fgb)$/i;
