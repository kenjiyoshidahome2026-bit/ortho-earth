// 頁の入口（site.ts・*-page.ts）の型の補い。
// ・__DATA_JAPAN__＝vite.config の define（ortho-data/japan/ の置き場の URL の頭）
// ・window.__map 等＝console 検証用の窓の手すり
// ・@ortho-earth/equal（site.ts の Equal Earth）は src の .ts を直に束ねる＝equal の型検査と同じ補い（WebGPU の定数・vite の glob・globe のサブパス）をここでも読む
/// <reference path="../../packages/equal/src/ambient.d.ts" />
declare const __DATA_JAPAN__: string;
interface Window { __map?: unknown; __fw?: unknown; __editor?: unknown; __models?: unknown; __onsen?: unknown; __parks?: unknown; __tellus?: unknown; __terrain?: unknown }
