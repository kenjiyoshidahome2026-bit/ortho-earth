import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

// lib×ES では vite が esbuild/terser とも whitespace minify を強制スキップする（v5.4 実装確認・下流バンドラ向け
// PURE 注釈保持の思想）。本ライブラリは事前ビルド一枚岩＝下流の木刈り効果は無く、本番 /japan/lib の app が
// 627KB raw で配られるパース代の方が高い（Lighthouse mobile 実測 2026-08-21）。renderChunk(post) で空白だけ
// 追い minify＝識別子/構文は vite の esbuild が済ませた後・rollup が sourcemap を合成＝map の正しさは保たれる。
const forceMinifyWhitespace = {
	name: "force-minify-whitespace",
	renderChunk: {
		order: "post",
		handler: (code) => transform(code, { minifyWhitespace: true, sourcemap: true, charset: "utf8" }),
	},
};

// .wasm を base64 で JS に埋めない（処方①・#12）。vite 5 の lib モードは資産を大きさに関わらず必ず inline する
// （shouldInline: `if (config.build.lib) return true`）ため、wasm-pack glue の `new URL('gint_wasm_bg.wasm', import.meta.url)`
// が 126 KB → 173 KB の data: URI になり、glue を抱える 7 チャンク全部に複製されていた（2026-09-14 計量＝−855 KB の元凶）。
// ここで .wasm を rollup の asset として emit し、参照を import.meta.ROLLUP_FILE_URL_ に差し替える＝assets/ に実体 1 つ・
// 各チャンクは相対 URL で指す（同じ内容＝同じハッシュ名＝worker の別ビルドが何本あってもファイルは 1 つ）。ブラウザキャッシュも効く。
// worker ビルドは `worker.plugins` でしか plugin が効かないので、主ビルドと worker の両方へ挿す。
const wasmAsFile = {
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

// `import x from "./mod.js?url"` を base64 で埋めない（wasm と同じ理由＝lib モードは資産を必ず inline する）。
// 用途＝レンダーワーカーが URL で import() する同一フレームのオーバーレイのモジュール（gadgets/anno-draw.js 等・依存ゼロ）。
// asset として emit し、既定 export を実体ファイルの URL（chunk 相対＝import.meta.url 基準）にする。
const urlAsFile = {
	name: "js-url-as-file",
	enforce: "pre",
	async resolveId(source, importer) {
		if (!/\.js\?url$/.test(source) || !importer) return null;
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

// SDK ビルド（ライブラリ形式）＝第三者のページへ埋め込むための出荷形。
// サイトビルド（vite.config.js）とは別物：あちらは index.html を持つ「作品」、こちらは import される「部品」。
//
// 出荷物（dist/lib/）：
//   ortho-japan.js   … ESM 本体（npm名=@ortho-earth/japan）。worker チャンクは同ディレクトリへ分割出力
//   ortho-japan.css  … 意匠（quiet-mono トークン＋部品＋app 固有）。maplibre-gl と同じ作法で利用者が明示 import する
//   assets/…         … worker と動的 import（measure/print/qr/shot/demo 等）のチャンク
//
// 掟：
//  - CSS は #map の外へ書かない（2026-08-19 移設済）＝ホストページのレイアウトを壊さない
//  - 実行時アセット（plateau-sets.json 等）は同梱しない。利用者のサイトに置くか CDN を指す＝`assetBase` オプション
//    （ここで bundle すると数MBの plateau-names.json 等を全員に配ることになる）
//  - worker は ES module 形式固定（vite 既定の iife は worker 内 code-splitting を弾く＝サイトビルドと同じ理由）
//  - COOP/COEP は要求しない：SAB が無ければ geopbf がコピー経路へ落ちる（fallback-ladder.md §3.5・verify:nocoi で実測）
export default defineConfig({
	plugins: [urlAsFile, wasmAsFile, forceMinifyWhitespace],
	build: {
		outDir: "dist/lib",
		emptyOutDir: true,
		sourcemap: true,
		lib: {
			entry: resolve(import.meta.dirname, "app.js"),
			name: "orthoJapan",
			formats: ["es"],            // UMD は不可＝worker/動的 import を含む以上 ESM 一択
			fileName: () => "ortho-japan.js",
		},
		rollupOptions: {
			output: {
				assetFileNames: (info) => (info.names?.[0] || info.name || "").endsWith(".css")
					? "ortho-japan.css" : "assets/[name]-[hash][extname]",
				chunkFileNames: "assets/[name]-[hash].js",
			},
		},
	},
	// public/ を出荷物へ混ぜない。vite は lib モードでも publicDir を既定でコピーするため、放っておくと
	// plateau-names.json(2.9MB)・開発専用の moj-local/・OGP画像、そして **sw.js** まで dist/lib へ入る。
	// 実行時アセットは assetBase で指す設計（同梱すると数MBを全利用者に配ることになる）＝ここで断つ。
	// ★sw.js の混入は特に不可：SDK がホストのオリジンへ Service Worker を持ち込む口になる
	//   （本体は index.html が登録する＝スタンドアロン専用の作法。ライブラリ経路は一切登録しない）。
	// 利用者へ渡すアセットは apps/ortho-japan/public/ からアプリ側で配る（README の assetBase 節）。
	publicDir: false,
	// worker の別ビルドには `plugins` が効かない（vite 5：build では worker.plugins のみ）＝.wasm 実体化と空白 minify を両方ここにも挿す。
	// 空白 minify を worker に入れ忘れていた実測（2026-09-14）：renderworker 6,380 行・meshworker 11,377 行のまま配っていた。
	// 部品（geopbf・ortho-core・altpbf・geoedit）の worker はアプリの入口（worker.js）で走らせる（app.js の hostWorker）＝部品自身の worker は組み立てない
	// ＝各部品の builtinWorkers.js（new Worker の唯一の直書き）を「作らない版」（geopbf/no-builtin-workers・中身は汎用）に差し替える（2026-09-22・標準の作法）
	resolve: { alias: [{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(import.meta.dirname, "../../packages/geopbf/src/modules/builtinWorkers.none.js") },
		{ find: "#extra-roles", replacement: resolve(import.meta.dirname, "../../packages/jp/src/worker-roles.js") }] },   // 地域の worker 役（e-Stat）＝globe の入口の既定 {} を日本の役表へ（S4 2026-09-23）
	worker: { format: "es", plugins: () => [wasmAsFile, forceMinifyWhitespace] },
	// ★base は必ず相対（"./"）＝worker・チャンクのURLが import.meta.url 起点になり、lib を**どこに置いても**動く。
	//   base:"/" だと worker がドメイン直下 /assets/ を指す＝/japan/lib/ 配下に置いた本番で worker 全滅
	//   （2026-08-20 本番事故の真因。www の SPA フォールバックが HTML を 200 で返し、module worker の
	//    MIME 検査で静かに死ぬ＝DOMだけ見るスモークでは見逃す。検定は request 台帳で worker 取得まで見ること）。
	//   assetBase 未指定の既定は "./"＝ページ相対（利用者は orthoJapan({ assetBase }) で指し直す前提は不変）。
	base: "./",
});
