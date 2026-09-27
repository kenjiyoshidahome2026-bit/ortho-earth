// "#columnar-sources" の既定＝同梱の読み手 2 つ（GeoParquet・GeoPBF）を登録する（副作用だけ・#90）。
// 任意の読み手（GeoArrow・FlatGeobuf 等）を足すアプリは、vite の alias で "#columnar-sources" を自前の登録モジュールへ向ける
//（そのモジュールがこの 2 つも要るなら import "@ortho-earth/columnar/sources/builtin" を書く）。関数は postMessage できないので worker 側の登録は import で。
import { registerColumnarSource } from "./registry.js";
import { GEOPARQUET_SOURCE } from "./geoparquet.js";
import { GEOPBF_SOURCE } from "./geopbf.js";
registerColumnarSource(GEOPARQUET_SOURCE);
registerColumnarSource(GEOPBF_SOURCE);
