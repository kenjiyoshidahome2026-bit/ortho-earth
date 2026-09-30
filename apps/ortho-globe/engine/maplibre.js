// 共有エンジンの 5 本目の入口（/globe/engine/<版>/maplibre.js・2026-10-01）＝MapLibre GL JS 互換の口（@ortho-earth/globe/maplibre）。
// www の /maplibre/（MapLibre 公式例を ortho で走らせる頁）が import map でこの入口を指す＝例の本文は `import * as maplibregl from "@ortho-earth/globe/maplibre"` のまま。
// 焼き方は vite.engine-ml.config.js（本体の束とは別）：通訳が import する ../globe.js（公開の顔）は隣の ./globe.js（共有エンジンの入口）へ差し替える＝同じ実体。CSS は globe 入口が貼る。
import "./globe.js";
export * from "@ortho-earth/globe/maplibre";
