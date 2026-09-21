export { createGetHeight, createTileLoader, staleDSM } from './createGetHeight.js';   // staleDSM＝地域申告の検定用（apps/ortho-japan/tests/t-dtm.mjs）
export { setWorkerFactory } from './workerFactory.js';   // worker の入口を差し替える（役割 "altpbf:height"・2026-09-22）
export { GEBCO } from './gebco.js';
export { setApiUrl } from './altpbf.js';
export { encode, decode } from './format.js';   // uploader の焼き（bakeWorldAtlas → encode）用
export { WORLD_ATLAS, WORLD_ATLAS_CELL, resampleTile, bakeWorldAtlas, worldAtlasCell, sampleWorldAtlas } from './worldatlas.js';   // 全球アトラス（R90 8 枚→1 枚）
