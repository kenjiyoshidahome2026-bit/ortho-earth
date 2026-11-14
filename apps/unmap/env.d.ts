// 頁の入口（main.ts）の型の補い。window.__map＝console 検証用の窓
// ・@ortho-earth/equal（範囲の選択の画面＝area-picker.ts）は src の .ts を直に束ねる＝equal の型検査と同じ補い（apps/engine と同じ）
/// <reference path="../../packages/equal/src/ambient.d.ts" />
interface Window { __map?: unknown }
