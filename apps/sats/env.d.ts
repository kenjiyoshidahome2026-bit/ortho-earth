// 頁の入口（sats-page.ts）の型の補い。window.__map 等＝console 検証用の窓の手すり
interface Window { __map?: unknown; __sats?: unknown }
