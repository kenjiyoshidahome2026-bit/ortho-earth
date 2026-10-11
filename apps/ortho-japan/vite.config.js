import { defineConfig } from "vite";
import { resolve } from "node:path";
import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, asyncMainCss, dropUnusedPublic, engineAliases } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// worker は全て new Worker(..., { type: "module" }) で生成している＝ES module worker。
// vite 既定の worker.format="iife" は code-splitting（worker 内で worker を割る/動的 import）を弾くため、
// gint worker が geopbf の worker 連鎖に触れた瞬間ビルドが落ちる。生成形式に合わせ "es" にして解く。
// gint の SharedArrayBuffer（worker へのゼロコピー）は crossOriginIsolated（COOP/COEP）で点く＝crossOriginIsolation()（vite-app.mjs）が
// middleware で全リクエストに刻む。無くても動く＝SAB 不在なら通常 ArrayBuffer のコピー1回に落ちる。
// NOCOI=1 ＝COOP/COEP を刻まずに起動する（crossOriginIsolated が立たない＝SAB 不在の世界を再現）。
// 目的は SDK 化の前提確認：埋め込み先のページに COEP を要求できるとは限らない（COEP はホスト側の
// 他の埋め込みを軒並み壊す）ため、「COI 無しでも全機能が動く」ことを実測で押さえる。
// 根拠となる逃げ道は geopbf setGintBUF の SAB フォールバック（Safari は COEP:credentialless 非対応＝
// 元から COI 無しで動いている）。検証は scripts/verify-nocoi.mjs（`npm run verify:nocoi`）。
// 本番（Cloudflare Workers assets）では deploy-worker.js が同じ2ヘッダを全レスポンスに刻む＝dev/prod で同一条件。
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(import.meta.dirname, "dist/site/japan");

export default defineConfig({
	// 配信先＝ www.ortho-earth.com/japan/ （サブパス。地域なしの頁は /globe/＝apps/ortho-globe）。ルート相対の import/asset は base が面倒を見る。
	// 実行時 fetch は main.js 側で import.meta.env.BASE_URL を前置（vite は文字列リテラルの fetch を書き換えない）。
	base: "/japan/",
	// クラウド保存（apps/account の wrangler dev :8787）＝dev も同一オリジン化＝CORS 不要（本番は route が同居）。scene.html のクラウド保存が使う
	server: { proxy: { "/auth": "http://localhost:8787", "/me": "http://localhost:8787" } },
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引くため、
	// dist/site/ をルートに japan/ サブフォルダへ出力（wrangler.toml の directory = dist/site）。
	// マルチページ：scene.html＝scenes エディタ（/japan/scene.html・最初のアプリ）。tellus.html＝Tellus 衛星データ専用ビューア（/japan/tellus）。
	// 地域の申告を持たない頁（Globe ⇄ Equal Earth・世界の地震・人工衛星）は 2026-09-24 に globe の家へ移設＝apps/ortho-globe（/globe/…・旧 URL は deploy-worker.js が 301）。
	// models.html＝名所 3D 模型 showcase（/japan/models.html・台帳 public/models.json・GLB は bucket GIS/models/）。fireworks.html＝打ち上げ花火（シーンの深度 #47 の見本・/japan/fireworks）。parks.html＝国立公園 35 の showcase（/japan/parks・台帳 public/parks.json・外周 public/parks.geopbf）。
	// エンジン（globe・i18n・core・geopbf）は sharedEngine() が /globe/engine/<版>/ へ外に出す（2026-09-30・旧＝本番だけ /japan/lib/ の SDK を実行時に食う二重構成）。
	// SDK（dist/lib）は外へ配る物＝build:prod が従来どおり /japan/lib/ に置く。
	// noChunkOptimization＝rolldown（vite 8）の決まり（2026-09-25・vite-app.mjs に理由）。worker は別ビルド＝下の worker.rolldownOptions にも同じ物。
	build: { outDir: OUT, emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html"), scene: resolve(import.meta.dirname, "scene.html"), geoedit: resolve(import.meta.dirname, "geoedit.html"), tellus: resolve(import.meta.dirname, "tellus.html"), models: resolve(import.meta.dirname, "models.html"), fireworks: resolve(import.meta.dirname, "fireworks.html"), parks: resolve(import.meta.dirname, "parks.html") },
		...noChunkOptimization,
	} },
	// 部品（geopbf・ortho-core・altpbf・geoedit）の worker はアプリの入口（worker.js）で走らせる（app.js の hostWorker）＝部品自身の worker は組み立てない（engineAliases）
	resolve: { alias: engineAliases(ROOT) },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	// plateau-names.json（2.9MB）＝台帳づくりの中間（scripts/plateau-names-*.mjs が読む）で実行時は読まない＝出力から外す（deploy.mjs の rm と同じ・2026-09-30 に build 側へ）
	plugins: [crossOriginIsolation(), sharedEngine(), asyncMainCss, dropUnusedPublic(OUT, ["plateau-names.json"])],
});
