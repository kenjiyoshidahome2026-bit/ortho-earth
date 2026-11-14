// 頁の入口（main.ts）の型の補い。__DATA_JAPAN__＝vite.config の define（ortho-data/japan/ の置き場の URL の頭）・window.__map 等＝console 検証用の窓の手すり
declare const __DATA_JAPAN__: string;
interface Window { __map?: unknown; __twin?: unknown }
