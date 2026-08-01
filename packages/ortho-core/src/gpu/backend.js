// WebGPU バックエンドの入口。既定(WebGL2)経路のバンドルに紛れ込ませない＝renderworker が
// gpu フラグ時のみ dynamic import する（ortho-core 本体の index.js からは export しない）。
export { createRendererGPU } from "./renderer.js";
