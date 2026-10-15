// "#tile-formats" の差し替え先＝MLT を載せる版（副作用＝登録だけ・#88）。アプリの vite で
//   resolve.alias: [{ find: "#tile-formats", replacement: "@ortho-earth/core/tileformats-mlt" }]
// とすると、core の decode.js を読む realm（main と各 worker）で "mlt" が登録される。解読器の本体（@maplibre/mlt）は最初の MLT タイルで動的 import。
// 登録は core が持つ（2026-10-15）＝部品 @ortho-earth/tile-formats は core を知らない（形式の項 MLT_FORMAT と解読器 decodeMLT だけを出す）。
import { registerTileFormat } from "./tileformat.js";
import { MLT_FORMAT } from "@ortho-earth/tile-formats/format";
registerTileFormat(MLT_FORMAT);
