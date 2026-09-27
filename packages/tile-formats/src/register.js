// "#tile-formats" の差し替え先（副作用＝登録だけ・#88）。アプリの vite で
//   resolve.alias: [{ find: "#tile-formats", replacement: "@ortho-earth/tile-formats/register" }]
// とすると、core の decode.js を読む realm（main と各 worker）で "mlt" が登録される。解読器の本体は最初の MLT タイルで動的 import。
import { registerTileFormat } from "@ortho-earth/core/tileformat";
import { MLT_FORMAT } from "./format.js";
registerTileFormat(MLT_FORMAT);
