// 頁の入口（scene-page.ts）の型の補い。window.__map 等＝console 検証用の窓の手すり
interface Window { __map?: unknown; __editor?: unknown }
