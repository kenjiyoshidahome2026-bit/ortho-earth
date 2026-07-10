import { defineConfig } from "vite";

// worker は全て new Worker(..., { type: "module" }) で生成している＝ES module worker。
// vite 既定の worker.format="iife" は code-splitting（worker 内で worker を割る/動的 import）を弾くため、
// gint worker が geopbf の worker 連鎖に触れた瞬間ビルドが落ちる。生成形式に合わせ "es" にして解く。
// gint の SharedArrayBuffer には crossOriginIsolated（COOP/COEP）が必須。
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
const crossOriginIsolation = {
	name: "cross-origin-isolation",
	configureServer: coiHeaders,
	configurePreviewServer: coiHeaders,   // vite preview（ビルド後のローカル確認）にも同条件を刻む
};

export default defineConfig({
	// 配信先＝ www.ortho-earth.com/japan/ （サブパス。将来 /globe/ が並ぶ）。ルート相対の import/asset は base が面倒を見る。
	// 実行時 fetch は main.js 側で import.meta.env.BASE_URL を前置（vite は文字列リテラルの fetch を書き換えない）。
	base: "/japan/",
	// Workers assets は「リクエストのパス名＝assets ディレクトリ内の相対パス」で引くため、
	// dist/site/ をルートに japan/ サブフォルダへ出力（wrangler.toml の directory = dist/site）。
	build: { outDir: "dist/site/japan", emptyOutDir: true },
	worker: { format: "es" },
	plugins: [crossOriginIsolation],
});
