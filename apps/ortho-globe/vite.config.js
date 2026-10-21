import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";
import { crossOriginIsolation, noChunkOptimization, engineAliases, orthoData } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// ortho-globe＝地球儀（@ortho-earth/globe）の家＝地域の申告を持たない頁だけを置く（LAYERS.md「globe の家」2026-09-24）。
//   /globe/        … Globe ⇄ Equal Earth の往復（index.html）
//   /globe/sats    … 人工衛星（データ＝apps/sats-mirror の /sats/active.csv）
//   /globe/clouds  … いまの雲（試作・データ＝NASA GIBS の静止気象衛星の赤外を直読み）
//   /globe/physical … 世界の地形（山・川・湖…＝packages/world の TerrainDB と形状台帳 ne-physical.geopbf・本番は GitHub Pages の ortho-data/globe/）
//   /globe/clock    … 世界時計（issue #309・NE の時間帯の面＝S3 直読み＋admin0 の国 → IANA の名前 → ブラウザの Intl）
//   /globe/hex      … 世界の人口を H3 の六角形の柱で（issue #310・データ＝GitHub Pages の ortho-data/globe/h3/kontur-20231101/＝scripts/kontur-h3.mjs が焼く）
//   /globe/arcs     … いちばん近い道は弧になる（弧＝map.addData の arcs・首都＝world の台帳・路線＝OpenFlights をブラウザが直読み・issue #311）
//   /globe/splat    … Gaussian splat の見本（Niantic の .spz 2 シーン＝3D Tiles の KHR_gaussian_splatting と 1 本の .spz・データ＝GitHub Pages の ortho-data/globe/splat/＝scripts/splat-tiles.mjs が焼く・2026-10-21）
//   /globe/parks    … アメリカ合衆国の国立公園 63（/japan/parks と同型・台帳 parks-us.json・外周 parks-us.geopbf・他ユニット nps-units.geopbf＝本番は GitHub Pages の ortho-data/us/・正本はリポの根の ortho-data/us/）
// エンジンは共有エンジン（/globe/engine/<版>/・縮小計画 項目 9・本人裁定 2026-09-30）を URL で読む＝build の時だけ（dev はソース直）。
// 共有エンジンの置き場は独立のデプロイ単位 apps/engine（route /globe/engine/*・2026-10-15〜）＝この家の dist には入らない。japan の殻（app.js）も jp パックも通らない。
// COOP/COEP（credentialless）＝gint の SharedArrayBuffer（ゼロコピー）の点火条件＝crossOriginIsolation()（vite-app.mjs・japan と同じ標準解）。本番は deploy-worker.js が同じ 2 ヘッダを刻む。
const ROOT = resolve(import.meta.dirname, "../..");

// 世界の地震（/globe/quakes/）は 2026-10-15 に独立のアプリ apps/quakes（Worker ortho-quakes・route がより specific）へ移った

export default defineConfig(({ command }) => ({
	base: "/globe/",
	// 地形の頁（physical.ts）のデータ置き場：dev＝手元の packages/world/out/（npm run build / ne:physical の生成物を置く前に見る）・本番＝空＝GitHub Pages の ortho-data/globe/（physical.ts の DATA）
	// 国立公園の頁（parks.html）のデータ置き場：dev＝手元の正本 ortho-data/us/・本番＝GitHub Pages の ortho-data/us/（vite-app.mjs の orthoData）
	define: { __WORLD_OUT__: JSON.stringify(command === "serve" ? "/globe/@fs" + resolve(import.meta.dirname, "../../packages/world/out") + "/" : ""), __DATA_US__: orthoData(command, "/globe/", ROOT, "us") },
	server: { port: 5186 },
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引く＝dist/site/ をルートに globe/ へ出す（wrangler.toml の directory＝dist/site）
	build: { outDir: "dist/site/globe", emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html"), sats: resolve(import.meta.dirname, "sats.html"), clouds: resolve(import.meta.dirname, "clouds.html"), physical: resolve(import.meta.dirname, "physical.html"), parks: resolve(import.meta.dirname, "parks.html"), clock: resolve(import.meta.dirname, "clock.html"), hex: resolve(import.meta.dirname, "hex.html"), arcs: resolve(import.meta.dirname, "arcs.html"), splat: resolve(import.meta.dirname, "splat.html") },
		...noChunkOptimization,   // rolldown（vite 8）の決まり（2026-09-25・vite-app.mjs に理由）。worker にも同じ物
	} },
	// 部品（geopbf・ortho-core・altpbf）の worker はアプリの入口（globe の worker.js）で走らせる＝各部品の builtinWorkers.js を「作らない版」へ（japan と同じ作法＝engineAliases）
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine()],
}));
