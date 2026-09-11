// SDK ビルド（ライブラリ形式）＝第三者のページへ埋め込むための出荷形。
// サイトビルド（vite.config.js）とは別物：あちらは index.html を持つ「作品」、こちらは import される「部品」。
//
// 出荷物（dist/lib/）：
//   ortho-world.js   … ESM 本体（npm 名 = ortho-world）
//   ortho-world.css  … 意匠（.ortho-world 配下に閉じてある）。maplibre-gl と同じ作法で利用者が明示 import する
//
// 掟：
//   ・依存は**全部焼き込む**（common / native-bucket はモノレポ内の非公開パッケージ＝消費者は持っていない）。
//     external を足すなら、それが npm に在ることを確かめてからにすること。
//   ・出荷物に body/html へのスタイルが混ざっていないこと（部品がページを汚さない）＝verify:npm が見張る。
import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			common: path.resolve(__dirname, "../../packages/common/src"),
			"native-bucket": path.resolve(__dirname, "../../packages/native-bucket/src"),
		},
	},
	build: {
		outDir: "dist/lib",
		emptyOutDir: true,
		sourcemap: true,
		target: "esnext",
		cssCodeSplit: false,
		lib: {
			entry: path.resolve(__dirname, "src/world.js"),
			formats: ["es"],
			fileName: () => "ortho-world.js",
		},
		rollupOptions: {
			external: [],   // 全部焼き込む（下の掟）
			output: { assetFileNames: "ortho-world.[ext]" },
		},
	},
});
