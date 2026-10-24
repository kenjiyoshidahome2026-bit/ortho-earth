import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";
import { crossOriginIsolation, noChunkOptimization, engineAliases, bootScreen, moduleUrlAsChunk } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// splat＝/globe/splat。2026-10-24 に ortho-globe の頁から 1 つのアプリへ（本人「全アプリが横並びで生成される方が綺麗」→「それでやりますか！」・apps/hex と同じ形）。
// 自前の Worker は持たない＝出力 dist/site/globe/ を ortho-globe の build（packages/globe/scripts/lib/gather-apps.mjs＝package.json の servedAt で拾う）が集めて /globe/ の Worker が配る（URL は変わらない）。
// エンジンは共有エンジン（/globe/engine/<版>/）を URL で読む＝build の時だけ（dev はソース直）。地域の申告は持たない。
const ROOT = resolve(import.meta.dirname, "../..");

export default defineConfig(({ command }) => ({
	base: "/globe/",
	define: { __WORLD_OUT__: JSON.stringify(command === "serve" ? "/globe/@fs" + resolve(import.meta.dirname, "../../packages/world/out") + "/" : "") },
	server: { port: 5217, fs: { allow: [ROOT] } },
	build: { outDir: resolve(import.meta.dirname, "dist/site/globe"), emptyOutDir: true, rollupOptions: { input: { splat: resolve(import.meta.dirname, "splat.html") }, ...noChunkOptimization } },
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), moduleUrlAsChunk, bootScreen],
}));
