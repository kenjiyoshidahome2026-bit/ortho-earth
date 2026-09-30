// 共有エンジンの 5 本目の入口（/globe/engine/<版>/maplibre.js・2026-10-01）＝MapLibre GL JS 互換の口（@ortho-earth/globe/maplibre）。
// www の /maplibre/（MapLibre 公式例を ortho で走らせる頁）が import map でこの入口を指す＝例の本文は `import * as maplibregl from "@ortho-earth/globe/maplibre"` のまま。
// 通訳は ../globe.js（エンジン本体）を import する＝globe 入口と同じ束の同じ実体（チャンクを分かち合う）。CSS は globe 入口が貼る。
import "./globe.js";
export * from "@ortho-earth/globe/maplibre";
