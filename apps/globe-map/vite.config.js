import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";
import { crossOriginIsolation, noChunkOptimization, engineAliases, orthoData, moduleUrlAsChunk, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// globe-map＝/globe/ の表の頁（Globe ⇄ Equal Earth の往復・index.html）。2026-10-24 に ortho-globe（今の apps/globe-host）から 1 つのアプリへ（本人「名前も変える」）。
// 自前の Worker は持たない＝出力 dist/site/globe/ を apps/globe-host の build（packages/globe/scripts/lib/gather-apps.mjs＝package.json の servedAt で拾う）が集めて /globe/ の Worker（名前は ortho-globe のまま）が配る。
// エンジンは共有エンジン（/globe/engine/<版>/・縮小計画 項目 9・本人裁定 2026-09-30）を URL で読む＝build の時だけ（dev はソース直）。地域の申告は持たない。
// COOP/COEP（credentialless）＝gint の SharedArrayBuffer（ゼロコピー）の点火条件＝crossOriginIsolation()（vite-app.mjs・japan と同じ標準解）。本番は globe-host の deploy-worker.js が同じ 2 ヘッダを刻む。
const ROOT = resolve(import.meta.dirname, "../..");

export default defineConfig(({ command }) => ({
	base: "/globe/",
	server: { port: 5186, fs: { allow: [ROOT] } },
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引く＝dist/site/ をルートに globe/ へ出す（wrangler.toml の directory＝dist/site）
	build: { outDir: resolve(import.meta.dirname, "dist/site/globe"), emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html") },
		...noChunkOptimization,   // rolldown（vite 8）の決まり（2026-09-25・vite-app.mjs に理由）。worker にも同じ物
	} },
	// 部品（geopbf・ortho-core・altpbf）の worker はアプリの入口（globe の worker.js）で走らせる＝各部品の builtinWorkers.js を「作らない版」へ（japan と同じ作法＝engineAliases）
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), moduleUrlAsChunk, bootScreen],   // moduleUrlAsChunk＝plugin-splat の描き手（splat-draw／splat-gpu／splat-gl）を実体の JS チャンクに（2026-10-21）
}));
