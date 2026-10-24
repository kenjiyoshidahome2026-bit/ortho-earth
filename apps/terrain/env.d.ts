// 頁の入口（terrain-page.ts）の型の補い。window.__map 等＝console 検証用の窓の手すり
declare const __DATA_JAPAN__: string;   // vite.config の define（ortho-data/japan/ の置き場の URL の頭）
interface Window { __map?: unknown; __terrain?: unknown }
