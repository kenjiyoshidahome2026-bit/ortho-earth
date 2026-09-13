// WebGL2 バックエンドの入口（gpu/backend.js と対）。renderworker は選んだバックエンドだけを dynamic import する＝
// WebGPU 機では GL2 のレンダラ（renderer.js ＋ glsl.js ＋ gint/embed.js ≈ 106 KB）を読まない（ortho-japan 起動ロードの計量・2026-09-14）。
// index.js の `createRenderer` / `createGintLayer` export は他の消費者向けにそのまま残す。
export { createRenderer } from "./renderer.js";
export { createGintLayer } from "./gint/embed.js";
