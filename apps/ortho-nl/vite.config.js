import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// ortho-nl＝オランダ（3DBAG）の独立した入口。中身は ortho-japan と同じエンジン（@ortho-earth/regions/app＝本番は共有エンジンの入口 regions/app.js）で、
// 違うのは base(/nl/)・既定の視点・題字・出典・載せるガジェットだけ＝コードは二重化しない。
// build はエンジン（globe・i18n・core・geopbf）を共有エンジンの版つき URL から読む（2026-09-30・LAYERS.md 掟 3）＝束に残るのは地域の申告と殻だけ。
// public＝nl 自前の棚（sw.js＝packages/globe/scripts/lib/sw.js への symlink・アイコン・2026-10-15〜。旧＝japan の public を丸写し）。jp の台帳は共有エンジンの assets/（dev は packages/jp/assets を直）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer＝ゼロコピーの点火条件。無くてもコピー経路で動く）。worker は ES module 形式。
const OUT = resolve(import.meta.dirname, "dist/site/nl");

export default defineConfig({
	base: "/nl/",
	server: { port: 5188, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss],
});
