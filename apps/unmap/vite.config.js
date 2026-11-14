import { defineConfig } from "vite";
import { resolve } from "node:path";
import { crossOriginIsolation, noChunkOptimization, engineAliases, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり

// unmap＝UNMAP のオフライン版（実験・国連職員だけ・公開しない＝本人 2026-11-14）。
// package.json に servedAt を持たない＝globe-host の gather-apps に拾われない＝www.ortho-earth.com/globe/ には出ない。
// 配る場所（UN の認証の後ろ）は M5 で決める。出力は dist/site/unmap/。
// 共有エンジン（/globe/engine/<版>/・sharedEngine）は使わない＝エンジンをこの束に焼く：オフラインで丸ごと SW に収める・公開の /globe/ に依らない・UN の置き場だけで完結させるため。
const ROOT = resolve(import.meta.dirname, "../..");

export default defineConfig(() => ({
	base: "/unmap/",
	server: { port: 5230, host: true, fs: { allow: [ROOT] } },   // host＝同じ LAN のスマホから開いて試す
	build: { outDir: resolve(import.meta.dirname, "dist/site/unmap"), emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html") },
		...noChunkOptimization,
	} },
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), bootScreen],
}));
