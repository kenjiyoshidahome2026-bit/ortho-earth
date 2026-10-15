// 登録簿へ渡す形式の項（@ortho-earth/core/tileformat の registerTileFormat の引数・#88）。
// name＝style の vector source の "encoding"（MapLibre と同じ "mlt"）・pmtilesType 6＝PMTiles ヘッダの tileType（pmtiles.js TileType.Mlt）。
// 解読器は遅延読み込み（load）＝最初の MLT タイルまで @maplibre/mlt（数百 KB）を読まない＝MVT だけの頁・起動の束には入らない。
export const MLT_FORMAT = { name: "mlt", pmtilesType: 6, load: () => import("./mlt.js").then(m => m.decodeMLT) };
