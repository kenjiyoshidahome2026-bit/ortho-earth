import { defineConfig } from "vite";
import { resolve } from "node:path";
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

// SDK ビルド（ライブラリ形式）＝第三者のページへ埋め込むための出荷形。
// サイトビルド（vite.config.js）とは別物：あちらは index.html を持つ「作品」、こちらは import される「部品」。
//
// 出荷物（dist/lib/）：
//   ortho-japan.js   … ESM 本体（npm名=@ortho-earth/japan）。worker チャンクは同ディレクトリへ分割出力
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
	plugins: [forceMinifyWhitespace],
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
	worker: { format: "es" },
	// ★base は必ず相対（"./"）＝worker・チャンクのURLが import.meta.url 起点になり、lib を**どこに置いても**動く。
	//   base:"/" だと worker がドメイン直下 /assets/ を指す＝/japan/lib/ 配下に置いた本番で worker 全滅
	//   （2026-08-20 本番事故の真因。www の SPA フォールバックが HTML を 200 で返し、module worker の
	//    MIME 検査で静かに死ぬ＝DOMだけ見るスモークでは見逃す。検定は request 台帳で worker 取得まで見ること）。
	//   assetBase 未指定の既定は "./"＝ページ相対（利用者は orthoJapan({ assetBase }) で指し直す前提は不変）。
	base: "./",
});
