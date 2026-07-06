import { defineConfig } from "vite";

// worker は全て new Worker(..., { type: "module" }) で生成している＝ES module worker。
// vite 既定の worker.format="iife" は code-splitting（worker 内で worker を割る/動的 import）を弾くため、
// gint worker が geopbf の worker 連鎖に触れた瞬間ビルドが落ちる。生成形式に合わせ "es" にして解く。
// gint の SharedArrayBuffer には crossOriginIsolated（COOP/COEP）が必須。
// server.headers だと worker のサブ import 転送レスポンスに届かず worker 全滅→黒画面。
// middleware で「全リクエスト」に刻めば worker の import graph 隅々まで COEP が乗る＝標準解。
// COEP=credentialless：SAB を有効化しつつ cross-origin(GSI/bucket)は CORS で通す（require-corp のように CORP 必須にしない）。
const crossOriginIsolation = {
	name: "cross-origin-isolation",
	configureServer(server) {
		server.middlewares.use((_req, res, next) => {
			res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
			res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
			next();
		});
	},
};

export default defineConfig({
	worker: { format: "es" },
	plugins: [crossOriginIsolation],
});

