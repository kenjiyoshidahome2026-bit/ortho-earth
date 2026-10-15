// @ortho-earth/jp＝日本の地域パック。エンジン（@ortho-earth/core）と altpbf は地域を知らない＝この国の知識は全部ここにあり、
// アプリが地域宣言 JP_REGION を合成して注入する（apps/ortho-japan の app.js・2026-09-22 に apps/ortho-japan/jp/ から独立）。
// 地域宣言は「データの記述子」でありクラスではない（region.js の注記を見よ）。オランダ（apps/ortho-japan/nl/region.js）が同じ形の二国目。
// UI の文言（i18n）はアプリ側の辞書＝このパックは t() を呼ばない（出典・画像タイルの key は英語キーをデータとして持つだけ）。
export { JP_REGION } from "./region.js";
export { JP_DTM, JP_BOX } from "./dtm.js";
export { gsiSearch, PREF, preprocess, rerank } from "./search-gsi.js";
export { createPoiLedger, applyPoiOvr, poiOvrDist, POI_CODE } from "./poi.js";
export { createN02Overlay } from "./n02.js";
