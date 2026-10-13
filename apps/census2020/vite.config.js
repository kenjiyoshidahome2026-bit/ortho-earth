import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, dropUnusedPublic } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// census2020＝国勢調査2020の独立した入口（/japan/census2020/）。中身は ortho-japan と同じエンジン
// （../ortho-japan/app.js を直接 import）で、違うのは base(/japan/census2020/)・6:4分割レイアウト・右パネルの
// censusドリル・コロプレス/筆/防災の各モジュールだけ＝エンジンは二重化しない（ortho-nl と同型）。
// publicDir は japan のものを共有（plateau-sets.json 等）。census の重量データ（小地域CSV等）は R2＝gishub-jp/shared-data が正本（2026-09-30・dev も本番も同じ URL を読む）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer＝ゼロコピーの点火条件。無くてもコピー経路で動く）。worker は ES module 形式。
// 第二の public（public-extra/）：vite の publicDir は一つだけ＝共有棚（../ortho-japan/public）に census の
// 重量データ（9MB CSV 等）を混ぜないための合流口。dev は base 下で直配信、build は outDir へ丸コピー。
// japan の public を共有すると、実行時に読まない物まで出力に入る＝外す（dropUnusedPublic・2026-09-30・−4.6MB）。
const OUT = resolve(import.meta.dirname, "dist/site/japan/census2020");

export default defineConfig({
	base: "/japan/census2020/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	server: { port: 5189, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（../ortho-japan・../gishub-jp/jp・packages）を dev で読ませる
	// build はエンジン（globe・i18n・core・geopbf）を共有エンジンの版つき URL から読む（2026-09-30・LAYERS.md 掟 3）。束に残るのは jp パック・census の殻・e-Stat の worker。dev はソース直のまま
	build: { outDir: OUT, emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, dropUnusedPublic(OUT, ["plateau-names.json", "showcase"])],
});
