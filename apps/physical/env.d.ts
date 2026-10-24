// 頁の入口（physical-page.ts）の型の補い。window.__map 等＝console 検証用の窓の手すり
declare const __WORLD_OUT__: string;   // vite.config の define（dev＝手元の packages/world/out/・本番＝空）
interface Window { __map?: unknown; __physical?: unknown }
