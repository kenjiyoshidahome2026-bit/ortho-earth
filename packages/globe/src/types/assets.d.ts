// 素の CSS の副作用 import（globe.ts の "./globe.css"＝vite が頁へ差す・TS 化 段 4・batch 3）
declare module "*.css";
// vite の import.meta.env（globe.ts が BASE_URL を読む）
interface ImportMeta { readonly env: { readonly BASE_URL: string; readonly [k: string]: unknown } }
// clearTimeout／clearInterval は null も受ける（WebIDL の long＝0＝何もしない）＝globe.ts の「止めた印の null」をそのまま渡す
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
// `import("./x.wasm?url")`・`import("./x.js?url")`＝ビルドが実体ファイルにして URL を既定 export で返す（vite の ?url・lib モードは vite-lib-plugins.mjs の urlAsFile）
declare module "*?url" { const url: string; export default url; }
