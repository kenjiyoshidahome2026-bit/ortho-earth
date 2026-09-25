import { defineConfig } from "vite";
import { resolve } from "node:path";

// worker は全て new Worker(..., { type: "module" }) で生成している＝ES module worker。
// vite 既定の worker.format="iife" は code-splitting（worker 内で worker を割る/動的 import）を弾くため、
// gint worker が geopbf の worker 連鎖に触れた瞬間ビルドが落ちる。生成形式に合わせ "es" にして解く。
// gint の SharedArrayBuffer（worker へのゼロコピー）は crossOriginIsolated（COOP/COEP）で点く。
// 無くても動く＝SAB 不在なら通常 ArrayBuffer のコピー1回に落ちる（下の NOCOI と verify:nocoi を参照）。
// server.headers だと worker のサブ import 転送レスポンスに届かず worker 全滅→黒画面。
// middleware で「全リクエスト」に刻めば worker の import graph 隅々まで COEP が乗る＝標準解。
// COEP=credentialless：SAB を有効化しつつ cross-origin(GSI/bucket)は CORS で通す（require-corp のように CORP 必須にしない）。
// 本番（Cloudflare Workers assets）では deploy-worker.js が同じ2ヘッダを全レスポンスに刻む＝dev/prod で同一条件。
const coiHeaders = (server) => {
	server.middlewares.use((_req, res, next) => {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
		next();
	});
};
// NOCOI=1 ＝COOP/COEP を刻まずに起動する（crossOriginIsolated が立たない＝SAB 不在の世界を再現）。
// 目的は SDK 化の前提確認：埋め込み先のページに COEP を要求できるとは限らない（COEP はホスト側の
// 他の埋め込みを軒並み壊す）ため、「COI 無しでも全機能が動く」ことを実測で押さえる。
// 根拠となる逃げ道は geopbf setGintBUF の SAB フォールバック（Safari は COEP:credentialless 非対応＝
// 元から COI 無しで動いている）。検証は scripts/verify-nocoi.mjs（`npm run verify:nocoi`）。
const NOCOI = process.env.NOCOI === "1";
const crossOriginIsolation = {
	name: "cross-origin-isolation",
	configureServer: NOCOI ? undefined : coiHeaders,
	configurePreviewServer: NOCOI ? undefined : coiHeaders,   // vite preview（ビルド後のローカル確認）にも同条件を刻む
};

// 本番CSS（quiet-mono＋app＝37KB）を render-blocking から外す＝起動画面(#boot・head内インラインCSSで自足)を
// HTML到着直後に描かせる（FCPをCSS往復の後ろから前へ）。アプリUIはJS実行(~2s)後に生成＝その時にはCSSは届いており
// FOUCは起きない。media=print で一旦非適用→onload で all に戻す定石。JS無効環境向けに noscript の実体linkも残す。
const asyncMainCss = {
	name: "async-main-css",
	enforce: "post",
	transformIndexHtml(html) {
		return html.replace(
			/<link rel="stylesheet"([^>]*?)href="([^"]+)"([^>]*)>/g,
			(_m, pre, href, post) =>
				`<link rel="stylesheet"${pre}href="${href}"${post} media="print" onload="this.media='all'">` +
				`<noscript><link rel="stylesheet"${pre}href="${href}"${post}></noscript>`,
		);
	},
};

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
	// models.html＝名所 3D 模型 showcase（/japan/models.html・台帳 public/models.json・GLB は bucket GIS/models/）。
	// external＝SDK二重構成（site.js 冒頭）の本番側 import はバンドルせず実行時URLのまま残す（build:prod が dist/lib を複写する）。
	// experimental.chunkOptimization:false＝rolldown（vite 8）の決まり（2026-09-25・world／ortho-nl／gishub-jp と同じ）。既定 on だと実行時ヘルパ
	// __exportAll の共通チャンクが動的エントリ mesh-loaders に合流し、worker がヘルパ欲しさに mesh-loaders＋basis-loader（計 220KB）を
	// 静的 import する。worker は別ビルド＝下の worker.rolldownOptions にも同じ物。rolldown を上げたら静的 import が無いことを確かめ直す。
	build: { outDir: "dist/site/japan", emptyOutDir: true, rollupOptions: {
		input: { main: resolve(import.meta.dirname, "index.html"), scene: resolve(import.meta.dirname, "scene.html"), geoedit: resolve(import.meta.dirname, "geoedit.html"), tellus: resolve(import.meta.dirname, "tellus.html"), models: resolve(import.meta.dirname, "models.html") },
		external: ["/japan/lib/ortho-japan.js"],
		experimental: { chunkOptimization: false },
	} },
	// 部品（geopbf・ortho-core・altpbf・geoedit）の worker はアプリの入口（worker.js）で走らせる（app.js の hostWorker）＝部品自身の worker は組み立てない
	// ＝各部品の builtinWorkers.js（new Worker の唯一の直書き）を「作らない版」（geopbf/no-builtin-workers・中身は汎用）に差し替える（2026-09-22・標準の作法）
	resolve: { alias: [{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(import.meta.dirname, "../../packages/geopbf/src/modules/builtinWorkers.none.js") },
		{ find: "#extra-roles", replacement: resolve(import.meta.dirname, "../../packages/jp/src/worker-roles.js") }] },   // 地域の worker 役（e-Stat）＝globe の入口の既定 {} を日本の役表へ（S4 2026-09-23）
	worker: { format: "es", rolldownOptions: { experimental: { chunkOptimization: false } } },
	plugins: [crossOriginIsolation, asyncMainCss],
});
