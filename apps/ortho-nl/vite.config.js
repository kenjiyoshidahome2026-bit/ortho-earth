import { defineConfig } from "vite";
import { resolve } from "node:path";

// ortho-nl＝オランダ（3DBAG）の独立した入口。中身は ortho-japan と同じエンジン（../ortho-japan/app.js を直接 import）で、
// 違うのは base(/nl/)・既定の視点・題字・出典・載せるガジェットだけ＝コードは二重化しない。
// publicDir も japan のものを共有（plateau-sets.json 等の実行時 fetch は import.meta.env.BASE_URL 前置＝/nl/ から引ける）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer＝ゼロコピーの点火条件。無くてもコピー経路で動く）。worker は ES module 形式。
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
	configurePreviewServer: coiHeaders,
};
// 本番CSSを render-blocking から外す（japan と同じ定石＝起動画面を先に描く）
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

// rolldown（vite 8）のチャンク最適化を切る（2026-09-25・world と同じ）。既定 on だと実行時ヘルパ __exportAll の共通チャンクが
// 動的エントリ mesh-loaders に合流し、renderworker・gint・topology 等がヘルパ欲しさに mesh-loaders＋basis-loader（計 220KB）を
// 静的 import する＝3D を使う前から worker ごとに読み込み・副作用（globalThis.probe）も走る（起動 4 秒の JS 1.5→2.1MB を実測）。
// worker は別ビルド＝build と worker の両方に要る。experimental の口＝rolldown を上げたら静的 import が無いことを確かめ直す。
const noChunkOptimization = { experimental: { chunkOptimization: false } };

export default defineConfig({
	base: "/nl/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	server: { port: 5188, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（../ortho-japan・packages）を dev で読ませる
	build: { outDir: "dist/site/nl", emptyOutDir: true, rolldownOptions: noChunkOptimization },
	worker: { format: "es", rolldownOptions: noChunkOptimization },
	plugins: [crossOriginIsolation, asyncMainCss],
});
