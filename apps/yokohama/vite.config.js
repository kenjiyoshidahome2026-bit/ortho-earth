import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// yokohama＝横浜市デジタルツインの独立した入口（/yokohama/・2026-10-18）。中身は ortho-japan と同じエンジン（@ortho-earth/regions/app＝本番は共有エンジンの入口 regions/app.js）＝choju と同型。
// 違うのは base・既定の視点・案内板（twin.ts）だけ。データは焼かない（建物＝PLATEAU の配信・写真とハザード＝地理院タイル・避難場所＝bucket bousai/hinan）＝ortho-data の置き場は要らない。
// public＝yokohama 自前の棚（favicon だけ）。jp の台帳は共有エンジンの assets/（dev は packages/jp/assets を直）。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/yokohama");

export default defineConfig({
	base: "/yokohama/",
	server: { port: 5201, fs: { allow: [ROOT] } },   // root の外（packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss],
});
