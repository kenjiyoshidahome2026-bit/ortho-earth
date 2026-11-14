import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { crossOriginIsolation, noChunkOptimization, engineAliases, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり

// unmap＝UNMAP のオフライン版（実験・国連職員だけ・公開しない＝本人 2026-11-14）。
// package.json に servedAt を持たない＝globe-host の gather-apps に拾われない＝www.ortho-earth.com/globe/ には出ない。
// 配る場所（UN の認証の後ろ）は M5 で決める。出力は dist/site/unmap/。
// 共有エンジン（/globe/engine/<版>/・sharedEngine）は使わない＝エンジンをこの束に焼く：オフラインで丸ごと SW に収める・公開の /globe/ に依らない・UN の置き場だけで完結させるため。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/unmap");

// 通信なしで開くための目録（offline.json・M4）＝このビルドの全ファイル（エンジンも束に焼いてある）。app-pack.ts がこれを見て Cache "oj-pack-unmap" に詰め、
// 共有の Service Worker（public/sw.js＝packages/globe/scripts/lib/sw.js）が通信なしで返す。build＝ファイル名（content-hash 入り）の要約＝デプロイで変わる
function offlineManifest() {
	const walk = (dir, pre = "") => readdirSync(dir).flatMap(n => statSync(resolve(dir, n)).isDirectory() ? walk(resolve(dir, n), pre + n + "/") : [pre + n]);
	return {
		name: "unmap-offline-manifest", apply: "build",
		closeBundle() {
			const files = walk(OUT).filter(f => !/(\.map|\.DS_Store)$/.test(f) && !["offline.json", "sw.js", "index.html"].includes(f)).sort();
			const build = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
			writeFileSync(resolve(OUT, "offline.json"), JSON.stringify({ build, base: "/unmap/", files }));
		},
	};
}

export default defineConfig(() => ({
	base: "/unmap/",
	server: { port: 5230, host: true, fs: { allow: [ROOT] } },   // host＝同じ LAN のスマホから開いて試す
	build: { outDir: OUT, emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html") },
		...noChunkOptimization,
	} },
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), bootScreen, offlineManifest()],
}));
