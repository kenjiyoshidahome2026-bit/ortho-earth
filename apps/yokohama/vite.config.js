import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sharedEngine, ENGINE_DIR } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, orthoData, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// yokohama＝横浜市デジタルツインの独立した入口（/yokohama/・2026-10-18）。中身は ortho-japan と同じエンジン（@ortho-earth/regions/app＝本番は共有エンジンの入口 regions/app.js）＝choju と同型。
// 違うのは base・既定の視点・案内板（twin.ts）だけ。建物＝PLATEAU の配信・ハザード＝地理院タイル・避難場所＝bucket bousai/hinan。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝ortho-data/japan/yokohama/（scripts/bake-yokohama.mjs が組む・dev は手元の正本・vite-app.mjs の orthoData・DATA.md）。
// public＝yokohama 自前の棚（favicon だけ）。jp の台帳は共有エンジンの assets/（dev は packages/jp/assets を直）。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/yokohama");
const DATA = resolve(ROOT, "ortho-data/japan/yokohama");   // 台帳の正本（GitHub Pages の ortho-data と同じ物）

// 通信なしで使う束の目録（offline.json・2026-11-12）＝このビルドのファイル・エンジンの版とファイル・台帳のファイル。offline.ts がこれを見て端末に詰める。
// build＝ファイル名（content-hash 入り）とエンジンの版の要約＝デプロイで中身が変われば変わる
function offlineManifest() {
	const walk = (dir, pre = "") => readdirSync(dir).flatMap(n => statSync(resolve(dir, n)).isDirectory() ? walk(resolve(dir, n), pre + n + "/") : [pre + n]);
	return {
		name: "yokohama-offline-manifest", apply: "build",
		closeBundle() {
			const files = walk(OUT).filter(f => !/(\.map|\.DS_Store)$/.test(f) && !["offline.json", "sw.js", "index.html"].includes(f)).sort();
			const engine = JSON.parse(readFileSync(resolve(ENGINE_DIR, "current.json"), "utf8"));
			const data = walk(DATA).filter(f => !/\.DS_Store$/.test(f)).sort();
			const build = createHash("sha256").update(files.join("\n")).update(engine.version).digest("hex").slice(0, 12);
			writeFileSync(resolve(OUT, "offline.json"), JSON.stringify({ build, base: "/yokohama/", files, engine: { version: engine.version, files: engine.files }, data }));
		},
	};
}

export default defineConfig(({ command }) => ({
	base: "/yokohama/",
	define: { __DATA_JAPAN__: orthoData(command, "/yokohama/", ROOT, "japan") },
	server: { port: 5201, fs: { allow: [ROOT] } },   // root の外（packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, bootScreen, offlineManifest()],
}));
