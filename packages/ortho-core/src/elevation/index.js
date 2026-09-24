// 標高（@ortho-earth/core/elevation）＝altpbf の標高タイルを取って読む口（2026-09-25 に altpbf から移設）。
// 形式（encode/decode・名前規約）は altpbf（MIT）。取得・IndexedDB の保存・高さの引き当て・全球アトラスはエンジン（GPL）。
// worker は core の口（setWorkerFactory・役割 "ortho:height"）で走る＝ホストの入口は import("@ortho-earth/core/workers/elevation")。
export { createGetHeight, createTileLoader, staleDSM } from "./createGetHeight.js";   // staleDSM＝地域申告の検定用（apps/ortho-japan/tests/t-dtm.mjs）
export { setApiUrl, getNB, tiff2data } from "./loader.js";
export { setWorkerFactory } from "../workerFactory.js";   // core の口（ortho:tile/scene と同じ）＝render worker など core の index を読まないスレッド向けの近道
export { encode, decode, encodeName, decodeName } from "altpbf";
export { WORLD_ATLAS, WORLD_ATLAS_CELL, resampleTile, bakeWorldAtlas, worldAtlasCell, sampleWorldAtlas } from "./worldatlas.js";   // 全球アトラス（R90 8 枚→1 枚）
