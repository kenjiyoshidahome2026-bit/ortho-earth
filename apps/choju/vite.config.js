import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, orthoData } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// choju＝鳥獣の捕獲記録の独立した入口（/choju/）。www のデモ一覧には載せない単独の頁（本人裁定 2026-10-14）。
// 中身は ortho-japan と同じエンジン（@ortho-earth/jp/app＝本番は共有エンジンの入口 jp/app.js）＝ortho-nl と同型。違うのは base・既定の視点・案内板（choju.js）だけ。
// public＝choju 自前の棚（favicon だけ・2026-10-15〜。旧＝japan の public を丸写し）。jp の台帳は共有エンジンの assets/（dev は packages/jp/assets を直）。
// データ＝GitHub Pages の ortho-data/japan/choju/（captures.csv・munis.csv）。dev は手元の正本 ortho-data/japan/choju/（vite-app.mjs の orthoData・DATA.md）。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/choju");

export default defineConfig(({ command }) => ({
	base: "/choju/",
	define: { __DATA_JAPAN__: orthoData(command, "/choju/", ROOT, "japan") },
	server: { port: 5199, fs: { allow: [ROOT] } },   // root の外（packages・ortho-data）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss],
}));
