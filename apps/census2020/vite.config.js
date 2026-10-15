import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// census2020＝国勢調査2020の独立した入口（/japan/census2020/）。中身は ortho-japan と同じエンジン
// （@ortho-earth/jp/app＝本番は共有エンジンの入口 jp/app.js）で、違うのは base(/japan/census2020/)・6:4分割レイアウト・右パネルの
// censusドリル・コロプレス/筆/防災の各モジュールだけ＝エンジンは二重化しない（ortho-nl と同型）。
// public＝census 自前の棚（sw.js＝packages/globe/scripts/lib/sw.js への symlink・アイコン・2026-10-15〜。旧＝japan の public を丸写し）。jp の台帳は共有エンジンの assets/（dev は packages/jp/assets を直）。census の重量データ（小地域CSV等）は R2＝packages/jp/shared-data が正本（2026-09-30・dev も本番も同じ URL を読む）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer＝ゼロコピーの点火条件。無くてもコピー経路で動く）。worker は ES module 形式。
const OUT = resolve(import.meta.dirname, "dist/site/japan/census2020");

export default defineConfig({
	base: "/japan/census2020/",
	server: { port: 5189, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（packages）を dev で読ませる
	// build はエンジン（globe・i18n・core・geopbf）を共有エンジンの版つき URL から読む（2026-09-30・LAYERS.md 掟 3）。束に残るのは jp パック・census の殻・e-Stat の worker。dev はソース直のまま
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss],
});
