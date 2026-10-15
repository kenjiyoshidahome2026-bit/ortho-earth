// @ortho-earth/tile-formats＝MLT（MapLibre Tile）の解読器と、core の登録簿へ渡す形式の項（#88）。core も globe も import しない部品。
//   ・ビルド時の差し替え（推奨）：vite の alias で "#tile-formats" → "@ortho-earth/core/tileformats-mlt"（登録は core が持つ・2026-10-15）
//   ・手で登録：import { registerTileFormat } from "@ortho-earth/core/tileformat"; registerTileFormat(MLT_FORMAT);（decode.js を読む realm＝main と worker のそれぞれで）
//   ・変換だけ使う：decodeMLT(bytes, need?) → decodeMVT と同じ中間表現
export { MLT_FORMAT } from "./format.ts";
export type { TileFormatEntry } from "./format.ts";
export { decodeMLT } from "./mlt.ts";
export type { MltFeature, MltGeom, MltLayer, MltTile } from "./mlt.ts";
