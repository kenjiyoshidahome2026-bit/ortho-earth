// 入口（src/main.ts）の型の補い。
// ・@ortho-earth/equal は src の .ts を直に束ねる＝equal の型検査と同じ補い（WebGPU の定数・vite の glob・globe のサブパス）をここでも読む
// ・globalThis.equal＝検証・コンソール用の口
/// <reference path="../../packages/equal/src/ambient.d.ts" />
declare var equal: unknown;
