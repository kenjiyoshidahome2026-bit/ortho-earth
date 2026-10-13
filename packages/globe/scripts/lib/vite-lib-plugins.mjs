// lib×ES（ライブラリ形式）のビルドで資産を base64 で埋めないための vite プラグイン（japan の SDK と共有エンジンが共用・2026-09-30 に
// apps/ortho-japan/vite.lib.config.js から移設＝中身はそのまま）。vite の lib モードは資産を大きさに関わらず必ず inline する。
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";

// .wasm を base64 で JS に埋めない（処方①・#12）。vite 5 の lib モードは資産を大きさに関わらず必ず inline する
// （shouldInline: `if (config.build.lib) return true`）ため、wasm-pack glue の `new URL('gint_wasm_bg.wasm', import.meta.url)`
// が 126 KB → 173 KB の data: URI になり、glue を抱える 7 チャンク全部に複製されていた（2026-09-14 計量＝−855 KB の元凶）。
// ここで .wasm を rollup の asset として emit し、参照を import.meta.ROLLUP_FILE_URL_ に差し替える＝assets/ に実体 1 つ・
// 各チャンクは相対 URL で指す（同じ内容＝同じハッシュ名＝worker の別ビルドが何本あってもファイルは 1 つ）。ブラウザキャッシュも効く。
// worker ビルドは `worker.plugins` でしか plugin が効かないので、主ビルドと worker の両方へ挿す。
export const wasmAsFile = {
	name: "wasm-as-file",
	enforce: "pre",
	async transform(code, id) {
		if (!/\/wasm\/pkg\/gint_wasm\.js$/.test(id)) return;
		const wasmPath = resolve(dirname(id), "gint_wasm_bg.wasm");
		const ref = this.emitFile({ type: "asset", name: "gint_wasm_bg.wasm", source: await readFile(wasmPath) });
		const from = "new URL('gint_wasm_bg.wasm', import.meta.url)";
		if (!code.includes(from)) throw new Error("wasm-as-file: glue の .wasm 参照が見つからない（wasm-pack の出力形式が変わった？）");
		return { code: code.replace(from, `new URL(import.meta.ROLLUP_FILE_URL_${ref})`), map: null };
	},
};

// `import x from "./mod.js?url"`・`import w from "pkg/x.wasm?url"` を base64 で埋めない（wasm と同じ理由＝lib モードは資産を必ず inline する）。
// 用途＝レンダーワーカーが URL で import() する同一フレームのオーバーレイのモジュール（gadgets/anno-draw.js 等・依存ゼロ）と、
// worker が場所を渡して読む emscripten の .wasm（#178 の laz-perf＝COPC の worker・214KB を base64 で束に抱えない）。
// asset として emit し、既定 export を実体ファイルの URL（chunk 相対＝import.meta.url 基準）にする。
export const urlAsFile = {
	name: "js-url-as-file",
	enforce: "pre",
	async resolveId(source, importer) {
		if (!/\.(js|wasm)\?url$/.test(source) || !importer) return null;
		const r = await this.resolve(source.replace(/\?url$/, ""), importer, { skipSelf: true });
		return r ? r.id + "?js-url-as-file" : null;
	},
	async load(id) {
		if (!id.endsWith("?js-url-as-file")) return null;
		const file = id.replace(/\?js-url-as-file$/, "");
		const ref = this.emitFile({ type: "asset", name: file.split("/").pop(), source: await readFile(file) });
		return `export default new URL(import.meta.ROLLUP_FILE_URL_${ref}).href;`;
	},
};

// `new URL("./x.bin", import.meta.url)` の資産（ortho-core の EGM96 格子 298KB・2026-09-30）も base64 で埋めない（wasm・?url と同じ理由）。
// 放っておくと lib モードは data: URI（398KB）にして、geoid.js を静的に抱える renderworker へまで焼き込む（実測 492KB）。
// asset として emit し参照を import.meta.ROLLUP_FILE_URL_ に差し替える＝主ビルドと worker の別ビルドで同じ内容＝同じハッシュ名＝実体は 1 つ。
export const assetUrlAsFile = (exts, name = "bin-url-as-file") => ({
	name,
	enforce: "pre",
	async transform(code, id) {
		if (!code.includes("import.meta.url") || !exts.some(e => code.includes("." + e))) return;
		const re = new RegExp(`new URL\\((["'\`])(\\.{1,2}\\/[^"'\`]+\\.(?:${exts.join("|")}))\\1,\\s*import\\.meta\\.url\\)`, "g");
		let out = code, hit = false;
		for (const m of code.matchAll(re)) {
			const file = resolve(dirname(id.split("?")[0]), m[2]);
			const ref = this.emitFile({ type: "asset", name: file.split("/").pop(), source: await readFile(file) });
			out = out.replace(m[0], `new URL(import.meta.ROLLUP_FILE_URL_${ref})`); hit = true;
		}
		return hit ? { code: out, map: null } : undefined;
	},
});
export const binUrlAsFile = assetUrlAsFile(["bin"]);
// 共有エンジンは globe 同梱の気候場（assets/koppen-clim.png 82KB）も実体にする（japan の SDK は assetBase で公開側の物を指すので対象外）
