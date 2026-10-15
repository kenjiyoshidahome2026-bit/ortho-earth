import { defineConfig } from "vite";
import { resolve } from "node:path";
import { urlAsFile, wasmAsFile, assetUrlAsFile } from "../../packages/globe/scripts/lib/vite-lib-plugins.mjs";
import { engineAliases } from "../../packages/globe/scripts/lib/vite-app.mjs";
import { libEntry } from "./engine/entries.mjs";
import { engineStale } from "../../packages/globe/scripts/lib/engine-stale.mjs";   // 旧版の入口を握ったままの頁が部品で 404 に落ちたら 1 回だけ読み直す（恒久対策 A・2026-10-14）   // 部品の worker を作らない版へ・MLT／点群のプラグイン（アプリ共通）
const assetAsFile = assetUrlAsFile(["bin", "png"], "asset-url-as-file");   // EGM96 の格子と気候場の PNG を実体に（base64 で globe.js に埋めない）

// 共有エンジン（縮小計画 項目 9・本人裁定 2026-09-30「アプリ間でエンジンのチャンクを共有」）＝@ortho-earth/globe を
// japan の SDK と同じ作法（lib×ES・worker 分割・資産は実体ファイル）で 1 度だけ焼き、www.ortho-earth.com/globe/engine/<版>/ に置く。
// 地域の無いアプリ（ortho-globe・world・geopbf-demo）は build の時だけ下の入口を URL で import する（scripts/lib/shared-engine.mjs）。
// 同じ URL の同じチャンク＝ブラウザのキャッシュがアプリを跨いで効く。<版>＝出力の中身のハッシュ（scripts/build-engine.mjs が決める）。
//
// 入口を分ける訳＝モジュールの状態を 1 つに保つため。アプリがエンジンと別に束ねると別の実体になる：
//   globe  … createGlobe（CSS はこの入口が貼る＝engine/globe.js）
//   i18n   … 言語の状態（setLang）＝頁とエンジンが同じ辞書を見る
//   core   … 楕円体の切替（ellipsoidOn）等の状態＝quakes/sats が読む
//   geopbf … worker の口（setWorkerFactory）と既定の bucket（createGeopbf）＝geopbf-demo が設定する
//   h3     … h3-js（@ortho-earth/h3/core）＝状態は無いが重い（約 65KB）。エンジンの map.addH3 も同じ実体を読む＝/globe/hex が 2 つ目を束に持たない（2026-10-14）
//   jp/*・nl/* … 2 つ以上のアプリが使う地域パック（orthoJapan・コード表・共有データの口）＝各アプリに焼かない（2026-10-14・engine/entries.mjs）
const ROOT = resolve(import.meta.dirname, "../..");
export default defineConfig({
	root: import.meta.dirname,   // outDir はここ起点（どこから呼んでも apps/ortho-globe/dist/engine）
	plugins: [urlAsFile, wasmAsFile, assetAsFile, engineStale()],
	publicDir: false,
	base: "./",   // worker・チャンクの URL を import.meta.url 起点に＝どこに置いても動く（japan の SDK と同じ・/ だと worker がドメイン直下を指す）
	build: {
		outDir: "dist/engine/_build",
		emptyOutDir: true,
		sourcemap: true,
		lib: {
			entry: libEntry(),   // 入口の一覧＝engine/entries.mjs（globe・i18n・core・geopbf・h3・jp/*・nl/*）
			formats: ["es"],
		},
		rollupOptions: {
			experimental: { chunkOptimization: false },   // rolldown（vite 8）の決まり＝worker が mesh-loaders を静的 import する罠（全アプリ共通）
			output: {
				minify: true,   // lib×ES の既定は空白を残す＝rolldown に空白まで縮めさせる（japan の SDK と同じ）
				entryFileNames: "[name].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: info => (info.names?.[0] || info.name || "").endsWith(".css") ? "globe.css" : "assets/[name]-[hash][extname]",
			},
		},
	},
	// 部品（geopbf・ortho-core・altpbf）の worker はエンジンの入口（globe の worker.js）で走らせる＝builtinWorkers を「作らない版」へ（ortho-globe と同じ）。
	// #tile-formats＝MLT・#pointcloud-formats＝COPC（どちらも動的チャンク＝起動の束に入らない）
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", plugins: () => [urlAsFile, wasmAsFile, assetAsFile], rolldownOptions: { experimental: { chunkOptimization: false } } },
});
