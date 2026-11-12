// 入口（src/main.ts）の型の補い。common（packages/common）は src の .ts を直に束ねる＝common の型検査と同じ補い（File System Access API・*.scss）をここでも読む
/// <reference path="../../packages/common/src/ambient.d.ts" />
// __SHARED_DATA_DIR__／__BAKE_OUT_DIR__＝vite.config の define（共有データの正本・焼きスクリプトの出力の絶対パス＝dev の /@fs で読む）
declare const __SHARED_DATA_DIR__: string;
declare const __BAKE_OUT_DIR__: string;
