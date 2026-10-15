// 日本の実行時アセット（plateau-sets.json・airports.json 等＝packages/jp/assets）の既定の置き場（2026-10-15・旧＝packages/jp/src/app.js の中）。
// dev＝packages/jp/assets/。共有エンジンでは入口（regions/app.js）か共有チャンク（assets/*.js）の 1 つ上の assets/＝/globe/engine/<版>/assets/（エンジンの build が複写）。
const DIR = "../assets/";   // 変数で渡す＝vite の new URL(リテラル) 解析（実体を探して束に入れる）を通さない
export const JP_ASSETS = new URL(DIR, import.meta.url).href;
