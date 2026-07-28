// gint bake worker エントリ（bake-ahead＝GintBUF→メタ/tier梯子を render worker の外で焼く）。
// エンジン本体は ortho-core。ここは vite に worker として束ねさせる薄い入口（gintworker.js と同流儀）。
import "../../packages/ortho-core/src/gl/gint/bakeworker.js";
