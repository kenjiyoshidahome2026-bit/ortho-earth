import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, engineAliases, bootScreen } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// geoedit-app＝/japan/geoedit（置き場の名前は部品 packages/geoedit＝npm "geoedit" とぶつからないよう -app）。2026-10-24 に ortho-japan の頁から 1 つのアプリへ（本人「全アプリが横並びで生成される方が綺麗」→「それでやりますか！」・apps/hex と同じ形）。
// 自前の Worker は持たない＝出力 dist/site/japan/ を japan-host の build（packages/globe/scripts/lib/gather-apps.mjs＝package.json の servedAt で拾う）が集めて /japan/ の Worker が配る（URL は変わらない）。
// エンジン・地域の殻（@ortho-earth/regions/app）は共有エンジン（/globe/engine/<版>/）を URL で読む＝build の時だけ（dev はソース直）。
// 日本の実行時アセット（plateau-sets.json 等）は殻の既定（packages/jp/assets＝本番はエンジンの assets/）＝この頁は持たない。
const ROOT = resolve(import.meta.dirname, "../..");

export default defineConfig(() => ({
	base: "/japan/",
	// クラウド保存（apps/account の wrangler dev :8787）＝dev も同一オリジン化＝CORS 不要（本番は route が同居）
	server: { port: 5228, fs: { allow: [ROOT] }, proxy: { "/auth": "http://localhost:8787", "/me": "http://localhost:8787" } },
	build: { outDir: resolve(import.meta.dirname, "dist/site/japan"), emptyOutDir: true, rollupOptions: { input: { geoedit: resolve(import.meta.dirname, "geoedit.html") }, ...noChunkOptimization } },
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, bootScreen],
}));
