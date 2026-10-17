// 入口（main.ts）の型の補い。common（packages/common）は src の .ts を直に束ねる＝common の型検査と同じ補い（File System Access API・*.scss）をここでも読む
/// <reference path="../../packages/common/src/ambient.d.ts" />
// geopbf の convert/pool.ts は Node でも動く（typeof process で見分ける）＝その判定が読む欄だけ（@types/node は入れない＝setTimeout 等の型をブラウザのまま保つ）
declare var process: { versions?: { node?: string } } | undefined;
