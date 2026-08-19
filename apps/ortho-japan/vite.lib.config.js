import { defineConfig } from "vite";
import { resolve } from "node:path";

// SDK ビルド（ライブラリ形式）＝第三者のページへ埋め込むための出荷形。
// サイトビルド（vite.config.js）とは別物：あちらは index.html を持つ「作品」、こちらは import される「部品」。
//
// 出荷物（dist/lib/）：
//   ortho-japan.js   … ESM 本体（`import orthoJapan from "ortho-japan"`）。worker チャンクは同ディレクトリへ分割出力
//   ortho-japan.css  … 意匠（quiet-mono トークン＋部品＋app 固有）。maplibre-gl と同じ作法で利用者が明示 import する
//   assets/…         … worker と動的 import（measure/print/qr/shot/demo/ai 等）のチャンク
//
// 掟：
//  - CSS は #map の外へ書かない（2026-08-19 移設済）＝ホストページのレイアウトを壊さない
//  - 実行時アセット（plateau-sets.json 等）は同梱しない。利用者のサイトに置くか CDN を指す＝`assetBase` オプション
//    （ここで bundle すると数MBの plateau-names.json 等を全員に配ることになる）
//  - worker は ES module 形式固定（vite 既定の iife は worker 内 code-splitting を弾く＝サイトビルドと同じ理由）
//  - COOP/COEP は要求しない：SAB が無ければ geopbf がコピー経路へ落ちる（fallback-ladder.md §3.5・verify:nocoi で実測）
export default defineConfig({
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
	worker: { format: "es" },
	// 実行時アセットの既定ベース。ライブラリ利用者は orthoJapan({ assetBase: "…" }) で必ず指し直す前提だが、
	// 未指定でも "/" を向くように（相手のサイト直下に置いた場合の素直な既定）。
	base: "/",
});
