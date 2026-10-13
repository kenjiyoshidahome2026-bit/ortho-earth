import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, dropUnusedPublic } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// ortho-nl＝オランダ（3DBAG）の独立した入口。中身は ortho-japan と同じエンジン（../ortho-japan/app.js を直接 import）で、
// 違うのは base(/nl/)・既定の視点・題字・出典・載せるガジェットだけ＝コードは二重化しない。
// build はエンジン（globe・i18n・core・geopbf）を共有エンジンの版つき URL から読む（2026-09-30・LAYERS.md 掟 3）＝束に残るのは地域の申告と殻だけ。
// publicDir も japan のものを共有（plateau-sets.json 等の実行時 fetch は import.meta.env.BASE_URL 前置＝/nl/ から引ける）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer＝ゼロコピーの点火条件。無くてもコピー経路で動く）。worker は ES module 形式。
// japan の public を共有すると、実行時に読まない物まで出力に入る＝外す（dropUnusedPublic・2026-09-30・−4.6MB）。
const OUT = resolve(import.meta.dirname, "dist/site/nl");

export default defineConfig({
	base: "/nl/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	server: { port: 5188, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（../ortho-japan・packages）を dev で読ませる
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, dropUnusedPublic(OUT, ["plateau-names.json", "showcase"])],
});
