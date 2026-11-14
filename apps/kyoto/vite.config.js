import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { offlineManifest } from "../../packages/citytwin/scripts/vite-offline.mjs";   // 通信なしの束の目録（市のデジタルツイン共通）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, orthoData, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// kyoto＝京都市デジタルツインの独立した入口（/kyoto/・2026-11-14）。横浜市デジタルツインと同じ芯（@ortho-earth/citytwin＝本番は共有エンジンの入口 citytwin/index.js）に京都の設定（data.ts の CITY）を渡す。
// エンジン＝@ortho-earth/regions/app（共有エンジンの regions/app.js）。建物＝PLATEAU の配信・ハザード＝地理院タイル・避難場所＝bucket bousai/hinan/26。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝ortho-data/japan/kyoto/（scripts/bake-kyoto.mjs＝共通の packages/citytwin/scripts/bake-city.mjs が組む・dev は手元の正本・DATA.md）。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/kyoto");
const DATA = resolve(ROOT, "ortho-data/japan/kyoto");   // 台帳の正本（GitHub Pages の ortho-data と同じ物）

// 通信なしで使う束の目録（offline.json）＝市のデジタルツイン共通の部品（packages/citytwin/scripts/vite-offline.mjs）

export default defineConfig(({ command }) => ({
	base: "/kyoto/",
	define: { __DATA_JAPAN__: orthoData(command, "/kyoto/", ROOT, "japan") },
	server: { port: 5202, fs: { allow: [ROOT] } },   // root の外（packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, bootScreen, offlineManifest({ id: "kyoto", out: OUT, data: DATA })],
}));
