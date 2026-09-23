// gint bake worker エントリ（bake-ahead＝GintBUF→メタ/tier梯子を render worker の外で焼く）。
// エンジン本体は ortho-core。ここは vite に worker として束ねさせる薄い入口（gintworker.js と同流儀）。
import "@ortho-earth/core/workers/gintbake";   // core の公開面（相対で内部を掴まない・S4 2026-09-23）
