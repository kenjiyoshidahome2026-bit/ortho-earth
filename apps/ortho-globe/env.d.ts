// 頁の入口（main.ts・*-page.ts）の型の補い。
// ・__DATA_US__／__WORLD_OUT__＝vite.config の define（データの置き場の URL の頭）
// ・window.__map 等＝console 検証用の窓の手すり
// ・@ortho-earth/equal（index.html の Equal Earth）は src の .ts を直に束ねる＝equal の型検査と同じ補い（WebGPU の定数・vite の glob・globe のサブパス）をここでも読む
/// <reference path="../../packages/equal/src/ambient.d.ts" />
declare const __DATA_US__: string;
declare const __WORLD_OUT__: string;
interface Window { __map?: unknown; __arcs?: unknown; __clock?: unknown; __clouds?: unknown; __hex?: unknown; __parks?: unknown; __physical?: unknown; __sats?: unknown }
