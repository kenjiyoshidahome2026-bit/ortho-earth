import { defineConfig } from "vite";
import { resolve } from "node:path";
import { urlAsFile, wasmAsFile, assetUrlAsFile } from "../../packages/globe/scripts/lib/vite-lib-plugins.mjs";
const assetAsFile = assetUrlAsFile(["bin", "png"], "asset-url-as-file");   // EGM96 の格子と気候場の PNG を実体に（base64 で globe.js に埋めない）

// 共有エンジン（縮小計画 項目 9・本人裁定 2026-09-30「アプリ間でエンジンのチャンクを共有」）＝@ortho-earth/globe を
// japan の SDK と同じ作法（lib×ES・worker 分割・資産は実体ファイル）で 1 度だけ焼き、www.ortho-earth.com/globe/engine/<版>/ に置く。
// 地域の無いアプリ（ortho-globe・world・geopbf-demo）は build の時だけ下の入口を URL で import する（scripts/lib/shared-engine.mjs）。
// 同じ URL の同じチャンク＝ブラウザのキャッシュがアプリを跨いで効く。<版>＝出力の中身のハッシュ（scripts/build-engine.mjs が決める）。
//
// 入口を 4 本に分ける訳＝モジュールの状態を 1 つに保つため。アプリがエンジンと別に束ねると別の実体になる：
//   globe  … createGlobe（CSS はこの入口が貼る＝engine/globe.js）
//   i18n   … 言語の状態（setLang）＝頁とエンジンが同じ辞書を見る
//   core   … 楕円体の切替（ellipsoidOn）等の状態＝quakes/sats が読む
//   geopbf … worker の口（setWorkerFactory）と既定の bucket（createGeopbf）＝geopbf-demo が設定する
const ROOT = resolve(import.meta.dirname, "../..");
export default defineConfig({
	root: import.meta.dirname,   // outDir はここ起点（どこから呼んでも apps/ortho-globe/dist/engine）
	plugins: [urlAsFile, wasmAsFile, assetAsFile],
	publicDir: false,
	base: "./",   // worker・チャンクの URL を import.meta.url 起点に＝どこに置いても動く（japan の SDK と同じ・/ だと worker がドメイン直下を指す）
	build: {
		outDir: "dist/engine/_build",
		emptyOutDir: true,
		sourcemap: true,
		lib: {
			entry: {
				globe: resolve(import.meta.dirname, "engine/globe.js"),
				maplibre: resolve(import.meta.dirname, "engine/maplibre.js"),   // MapLibre 互換の口（www の /maplibre/ が import map で指す・2026-10-01）
				i18n: resolve(ROOT, "packages/globe/src/i18n.js"),
				core: resolve(ROOT, "packages/ortho-core/src/index.js"),
				geopbf: resolve(ROOT, "packages/geopbf/src/index.js"),
			},
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
	resolve: { alias: [{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(ROOT, "packages/geopbf/src/modules/builtinWorkers.none.js") },
		{ find: "#tile-formats", replacement: resolve(ROOT, "packages/tile-formats/src/register.js") },
		{ find: "#pointcloud-formats", replacement: resolve(ROOT, "packages/tile-formats/src/pointcloud.js") }] },
	worker: { format: "es", plugins: () => [urlAsFile, wasmAsFile, assetAsFile], rolldownOptions: { experimental: { chunkOptimization: false } } },
});
