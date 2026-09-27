// @ortho-earth/tile-formats＝MLT（MapLibre Tile）を @ortho-earth/core の差し込み口へ載せるプラグイン（#88）。
//   ・ビルド時の差し替え（推奨）：vite の alias で "#tile-formats" → "@ortho-earth/tile-formats/register"
//   ・手で登録：import { registerMLT } from "@ortho-earth/tile-formats"; registerMLT();（decode.js を読む realm＝main と worker のそれぞれで）
//   ・変換だけ使う：decodeMLT(bytes, need?) → decodeMVT と同じ中間表現
import { registerTileFormat } from "@ortho-earth/core/tileformat";
import { MLT_FORMAT } from "./format.js";
export { MLT_FORMAT };
export { decodeMLT } from "./mlt.js";
export const registerMLT = () => registerTileFormat(MLT_FORMAT);
