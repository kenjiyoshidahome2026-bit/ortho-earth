// 基準点で歪みを直して重ねる（#177・Georeference Annotation＝Allmaps 互換・IIIF）。MIT 側の正典＝変換の当てはめ・注記の読み書き・IIIF の段とタイルの選び。
// 描く側（画像タイルに焼く worker）は各地図エンジンの持ち物＝ortho は packages/globe/src/iiif-worker.js。
export { fitTransform, residuals, minPoints, lonLatToWorld, worldToLonLat } from "./transform.js";
export { parseGeoreference, toGeoreferenceAnnotation, georefMapping, parseSvgPolygon } from "./annotation.js";
export { iiifImage, infoUrl } from "./iiif.js";
