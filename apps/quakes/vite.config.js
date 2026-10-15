import { defineConfig } from "vite";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";
import { crossOriginIsolation, noChunkOptimization, engineAliases } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// ortho-quakes＝世界の地震（/globe/quakes/）。2026-10-15 に ortho-globe から独立＝頁・読み込み worker・USGS の形（usgs.js）・archive を焼く道具を一つの家に持つ。
// エンジンは共有エンジン（/globe/engine/<版>/）を URL で読む＝build の時だけ（dev はソース直）。地域の申告は持たない（ortho-globe と同じ）。
// COOP/COEP（credentialless）＝gint の SharedArrayBuffer（ゼロコピー）の点火条件＝crossOriginIsolation()。本番は deploy-worker.js が同じ 2 ヘッダを刻む。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/globe/quakes");

// dev の地震データ（public/dev/*.geopbf・gitignore・24MB）は出荷しない＝本番は /quakes/（quakes-mirror）から読む
const dropDevData = { name: "drop-dev-data", apply: "build", closeBundle() { rmSync(resolve(OUT, "dev"), { recursive: true, force: true }); } };

export default defineConfig({
	base: "/globe/quakes/",
	server: { port: 5200, fs: { allow: [ROOT] } },
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引く＝dist/site/ をルートに globe/quakes/ へ出す（wrangler.toml の directory＝dist/site）
	build: { outDir: OUT, emptyOutDir: true, rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") }, ...noChunkOptimization } },
	// 部品（geopbf・ortho-core・altpbf）の worker はアプリの入口（globe の worker.js）で走らせる＝engineAliases（ortho-globe と同じ作法）
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), dropDevData],
});
