import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, orthoData } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// yokohama＝横浜市デジタルツインの独立した入口（/yokohama/・2026-10-18）。中身は ortho-japan と同じエンジン（@ortho-earth/regions/app＝本番は共有エンジンの入口 regions/app.js）＝choju と同型。
// 違うのは base・既定の視点・案内板（twin.ts）だけ。建物＝PLATEAU の配信・ハザード＝地理院タイル・避難場所＝bucket bousai/hinan。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝ortho-data/japan/yokohama/（scripts/bake-yokohama.mjs が組む・dev は手元の正本・vite-app.mjs の orthoData・DATA.md）。
// public＝yokohama 自前の棚（favicon だけ）。jp の台帳は共有エンジンの assets/（dev は packages/jp/assets を直）。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/yokohama");

export default defineConfig(({ command }) => ({
	base: "/yokohama/",
	define: { __DATA_JAPAN__: orthoData(command, "/yokohama/", ROOT, "japan") },
	server: { port: 5201, fs: { allow: [ROOT] } },   // root の外（packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss],
}));
