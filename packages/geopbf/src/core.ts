// geopbf/core＝「読むだけ」の軽い入口（geopbf 改良点 10・2026-10-12・俯瞰 §2-B 6「静的 import 閉包が 29 ファイル／204 KB」）。
// GeoPBF の器（pbf-base）＋ GeoJSON へ戻す共通ローダ（modules/geojson-load）だけ＝wasm glue・identify・dissolve・pbf-io・worker の入口を載せない。
//   import { GeoPBF, loadGeopbf } from "geopbf/core";
//   const pbf = await new GeoPBF().set(bytes);            // ファイルを読む／geojson を書く
//   const { geojson, name } = await loadGeopbf(url);      // fetch → gzip 透過 → noeval 復号 → サニタイズ済み FeatureCollection
// Gint（identifyAt / contain / topojson / dissolve）や形式変換（Shapefile 等）は従来どおり "geopbf"（full）か各 subpath から。
// pbf-base の GeoPBF（＝GeoPBFBase）は拡張メソッド（centroid・clone・identifyAt …）を持たない＝別の class（段 4・2026-10-16）。拡張つきは "geopbf" の GeoPBF（extends GeoPBFBase）。
export { GeoPBF, makeKeys, propsKeyOf } from "./pbf-base.ts";
export { loadGeopbf, decodeToGeojson, fetchAndDecode, sanitizeProperties, resolveInnerUrl } from "./modules/geojson-load.ts";
export { gzip, gunzip, isGzip } from "./modules/gzip.ts";
