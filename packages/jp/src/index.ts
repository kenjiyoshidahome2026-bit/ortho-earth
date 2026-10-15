// @ortho-earth/jp＝日本の地域パック。エンジン（@ortho-earth/core）と altpbf は地域を知らない＝この国の知識は全部ここにあり、
// アプリが地域宣言 JP_REGION を合成して注入する（apps/ortho-japan の app.js・2026-09-22 に apps/ortho-japan/jp/ から独立）。
// 地域宣言は「データの記述子」でありクラスではない（region.ts の注記を見よ）。オランダ（packages/nl/src/region.js）が同じ形の二国目。
// UI の文言（i18n）はアプリ側の辞書＝このパックは t() を呼ばない（出典・画像タイルの key は英語キーをデータとして持つだけ）。
export { JP_REGION } from "./region.ts";
export type { JpRegion, RegionBuildings, RegionBasemap, RegionRaster, RegionAttribution, RegionHome } from "./region.ts";
export { JP_DTM, JP_BOX } from "./dtm.ts";
export type { DtmDecl } from "./dtm.ts";
export { gsiSearch, PREF, preprocess, rerank } from "./search-gsi.ts";
export type { GsiHit, SearchCandidate, SearchProvider } from "./search-gsi.ts";
export { createPoiLedger, applyPoiOvr, poiOvrDist, POI_CODE } from "./poi.ts";
export type { PoiDecl, PoiEnv, PoiLedger, PoiPoint, PoiOvrRec, PoiOverrides } from "./poi.ts";
export { createN02Overlay } from "./n02.ts";
export type { RailEnv, RailOverlay } from "./n02.ts";
