import { defineConfig } from "vite";
import { resolve } from "node:path";
import { cpSync, rmSync } from "node:fs";
import { sharedEngine, engineVersion } from "../../packages/globe/scripts/lib/shared-engine.mjs";

// ortho-globe＝地球儀（@ortho-earth/globe）の家＝地域の申告を持たない頁だけを置く（LAYERS.md「globe の家」2026-09-24）。
//   /globe/        … Globe ⇄ Equal Earth の往復（index.html）
//   /globe/quakes  … 世界の地震（データ＝apps/quakes-mirror の /quakes/*）
//   /globe/sats    … 人工衛星（データ＝apps/sats-mirror の /sats/active.csv）
//   /globe/clouds  … いまの雲（試作・データ＝NASA GIBS の静止気象衛星の赤外を直読み）
//   /globe/physical … 世界の地形（山・川・湖…＝packages/world の TerrainDB と形状台帳 ne-physical.geopbf・本番は bucket GIS/world/）
// エンジンは共有エンジン（/globe/engine/<版>/・縮小計画 項目 9・本人裁定 2026-09-30）を URL で読む＝build の時だけ（dev はソース直）。
// 共有エンジンの置き場はこの家（/globe/*）＝build の最後に dist/engine/<版>/ を dist/site/globe/engine/<版>/ へ写す。japan の殻（app.js）も jp パックも通らない。
// COOP/COEP（credentialless）＝gint の SharedArrayBuffer（ゼロコピー）の点火条件。server.headers では worker のサブ import に
// 届かないので middleware で全リクエストに刻む（japan と同じ標準解）。本番は deploy-worker.js が同じ 2 ヘッダを刻む。
const coiHeaders = server => {
	server.middlewares.use((_req, res, next) => {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
		next();
	});
};
const crossOriginIsolation = { name: "cross-origin-isolation", configureServer: coiHeaders, configurePreviewServer: coiHeaders };
const placeEngine = { name: "place-engine", apply: "build", closeBundle() { const v = engineVersion(); cpSync(resolve(import.meta.dirname, "dist/engine", v), resolve(import.meta.dirname, "dist/site/globe/engine", v), { recursive: true }); cpSync(resolve(import.meta.dirname, "dist/engine/current.json"), resolve(import.meta.dirname, "dist/site/globe/engine/current.json")); } };   // current.json＝Worker が旧版の入口を今の版へ送る時に読む

// dev の地震データ（public/quakes/*.geopbf・gitignore・24MB）は出荷しない＝本番は /quakes/（quakes-mirror）から読む。置いたままだと dist に
// quakes/ ができ、頁 /globe/quakes と同名のフォルダが並ぶ（検札の配り方が 404 にしていた・本番へ 24MB が上がる・2026-10-01）
const dropDevData = { name: "drop-dev-data", apply: "build", closeBundle() { rmSync(resolve(import.meta.dirname, "dist/site/globe/quakes"), { recursive: true, force: true }); } };

export default defineConfig(({ command }) => ({
	base: "/globe/",
	// 地形の頁（physical.js）のデータ置き場：dev＝手元の packages/world/out/（npm run build / ne:physical の生成物を bucket に置く前に見る）・本番＝空＝bucket GIS/world/
	define: { __WORLD_OUT__: JSON.stringify(command === "serve" ? "/globe/@fs" + resolve(import.meta.dirname, "../../packages/world/out") + "/" : "") },
	server: { port: 5186 },
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引く＝dist/site/ をルートに globe/ へ出す（wrangler.toml の directory＝dist/site）
	build: { outDir: "dist/site/globe", emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html"), quakes: resolve(import.meta.dirname, "quakes.html"), sats: resolve(import.meta.dirname, "sats.html"), clouds: resolve(import.meta.dirname, "clouds.html"), physical: resolve(import.meta.dirname, "physical.html") },
		// rolldown（vite 8）のチャンク最適化を切る（2026-09-25・japan と同じ）＝worker が実行時ヘルパ欲しさに mesh-loaders を静的 import する罠。worker にも同じ物
		experimental: { chunkOptimization: false },
	} },
	// 部品（geopbf・ortho-core・altpbf）の worker はアプリの入口（globe の worker.js）で走らせる＝各部品の builtinWorkers.js を「作らない版」へ（japan と同じ作法）。
	// #tile-formats＝MLT（MapLibre Tile）のプラグインを載せる（#88・形式は地域ではない）
	resolve: { alias: [{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(import.meta.dirname, "../../packages/geopbf/src/modules/builtinWorkers.none.js") },
		{ find: "#tile-formats", replacement: resolve(import.meta.dirname, "../../packages/tile-formats/src/register.js") },
		{ find: "#pointcloud-formats", replacement: resolve(import.meta.dirname, "../../packages/tile-formats/src/pointcloud.js") }] },   // 点群の解読器（#178・COPC の LAZ＝laz-perf）＝最初の節で動的 import（起動の束には入らない）
	worker: { format: "es", rolldownOptions: { experimental: { chunkOptimization: false } } },
	plugins: [crossOriginIsolation, sharedEngine(), placeEngine, dropDevData],
}));
