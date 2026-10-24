import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";
import { crossOriginIsolation, noChunkOptimization, engineAliases, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// clouds＝/globe/clouds。2026-10-24 に ortho-globe の頁から 1 つのアプリへ（本人「全アプリが横並びで生成される方が綺麗」→「それでやりますか！」・apps/hex と同じ形）。
// 自前の Worker は持たない＝出力 dist/site/globe/ を ortho-globe の build（scripts/gather-apps.mjs＝package.json の servedAt で拾う）が集めて /globe/ の Worker が配る（URL は変わらない）。
// エンジンは共有エンジン（/globe/engine/<版>/）を URL で読む＝build の時だけ（dev はソース直）。地域の申告は持たない。
const ROOT = resolve(import.meta.dirname, "../..");

export default defineConfig(() => ({
	base: "/globe/",
	server: { port: 5213, fs: { allow: [ROOT] } },
	build: { outDir: resolve(import.meta.dirname, "dist/site/globe"), emptyOutDir: true, rollupOptions: { input: { clouds: resolve(import.meta.dirname, "clouds.html") }, ...noChunkOptimization } },
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), bootScreen],
}));
