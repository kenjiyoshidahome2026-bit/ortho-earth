// 頁の入口（main.ts）の型の補い。
// ・window.__map 等＝console 検証用の窓の手すり
// ・@ortho-earth/equal（index.html の Equal Earth）は src の .ts を直に束ねる＝equal の型検査と同じ補い（WebGPU の定数・vite の glob・globe のサブパス）をここでも読む
/// <reference path="../../packages/equal/src/ambient.d.ts" />
interface Window { __map?: unknown }
