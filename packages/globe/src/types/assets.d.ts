// vite の ?url（ファイルの URL を文字列で受ける）＝installer が同一フレームのオーバーレイの module を渡す（TS 化 段 4・batch 1）
declare module "*?url" {
	const url: string;
	export default url;
}
// 素の CSS の副作用 import（globe.ts の "./globe.css"＝vite が頁へ差す・TS 化 段 4・batch 3）
declare module "*.css";
// vite の import.meta.env（globe.ts が BASE_URL を読む）
interface ImportMeta { readonly env: { readonly BASE_URL: string; readonly [k: string]: unknown } }
// clearTimeout／clearInterval は null も受ける（WebIDL の long＝0＝何もしない）＝globe.ts の「止めた印の null」をそのまま渡す
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
