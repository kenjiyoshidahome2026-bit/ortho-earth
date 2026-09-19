// geopbf/parquet ── Parquet / GeoParquet を**読む側**の公開口（依存ゼロ・部分読み）。
//   import { openParquet } from "geopbf/parquet";
//   const pq = await openParquet(url | File | Uint8Array);        // footer（末尾 64KB）だけ読む＝列・row group・統計・geo メタ
//   const { groups } = pq.select({ bbox: [w, s, e, n] });         // GeoParquet の bbox 覆域列の統計で視野に触れる row group だけ
//   const m = await pq.readRowGroup(g, { columns: ["geometry"] }); // その row group の必要な列チャンクだけ Range で取る → Map(列名 → 値[])
// 書く側（GeoPBF → GeoParquet）と全量変換（GeoParquet → GeoPBF）は geopbf/geoparquet（toGeoParquet / fromGeoParquet）。
// 前提：Range（206）を返す配信元で効く（返さなければ全量モードへ自動で落ちる＝COG と同じ梯子）。zstd はブラウザでは読めない。
export { openParquet, readParquet } from "./convert/parquet-read.js";
export { parseWkb } from "./convert/wkb.js";
