import { defineConfig } from "vite";
import { resolve } from "node:path";

// ortho-globe＝地球儀（@ortho-earth/globe）の家＝地域の申告を持たない頁だけを置く（LAYERS.md「globe の家」2026-09-24）。
//   /globe/        … Globe ⇄ Equal Earth の往復（index.html）
//   /globe/quakes  … 世界の地震（データ＝apps/quakes-mirror の /quakes/*）
//   /globe/sats    … 人工衛星（データ＝apps/sats-mirror の /sats/active.csv）
// エンジンは各頁の束に焼く（A 裁定 2026-09-23＝実行時に /japan/lib を食わない）。japan の殻（app.js）も jp パックも通らない。
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

export default defineConfig({
	base: "/globe/",
	server: { port: 5186 },
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引く＝dist/site/ をルートに globe/ へ出す（wrangler.toml の directory＝dist/site）
	build: { outDir: "dist/site/globe", emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html"), quakes: resolve(import.meta.dirname, "quakes.html"), sats: resolve(import.meta.dirname, "sats.html") },
		// rolldown（vite 8）のチャンク最適化を切る（2026-09-25・japan と同じ）＝worker が実行時ヘルパ欲しさに mesh-loaders を静的 import する罠。worker にも同じ物
		experimental: { chunkOptimization: false },
	} },
	// 部品（geopbf・ortho-core・altpbf）の worker はアプリの入口（globe の worker.js）で走らせる＝各部品の builtinWorkers.js を「作らない版」へ（japan と同じ作法）。
	// #extra-roles は差し替えない＝globe 既定の {}（地域の worker 役なし）
	resolve: { alias: [{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(import.meta.dirname, "../../packages/geopbf/src/modules/builtinWorkers.none.js") }] },
	worker: { format: "es", rolldownOptions: { experimental: { chunkOptimization: false } } },
	plugins: [crossOriginIsolation],
});
