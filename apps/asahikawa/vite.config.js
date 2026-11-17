import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { offlineManifest } from "../../packages/citytwin/scripts/vite-offline.mjs";   // 通信なしの束の目録（市のデジタルツイン共通）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, orthoData, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// asahikawa＝旭川市デジタルツインの独立した入口（/asahikawa/・2026-11-17）。横浜市デジタルツインと同じ芯（@ortho-earth/citytwin＝本番は共有エンジンの入口 citytwin/index.js）に旭川の設定（data.ts の CITY）を渡す。
// エンジン＝@ortho-earth/regions/app（共有エンジンの regions/app.js）。建物＝地理院の基図の建物（旭川に PLATEAU は無い）・ハザード＝地理院タイル・避難場所＝bucket bousai/hinan/01。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝ortho-data/japan/asahikawa/（scripts/bake-asahikawa.mjs＝共通の packages/citytwin/scripts/bake-city.mjs が組む・dev は手元の正本・DATA.md）。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/asahikawa");
const DATA = resolve(ROOT, "ortho-data/japan/asahikawa");   // 台帳の正本（GitHub Pages の ortho-data と同じ物）

// 通信なしで使う束の目録（offline.json）＝市のデジタルツイン共通の部品（packages/citytwin/scripts/vite-offline.mjs）

export default defineConfig(({ command }) => ({
	base: "/asahikawa/",
	define: { __DATA_JAPAN__: orthoData(command, "/asahikawa/", ROOT, "japan") },
	server: { port: 5206, fs: { allow: [ROOT] } },   // root の外（packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, bootScreen, offlineManifest({ id: "asahikawa", out: OUT, data: DATA })],
}));
