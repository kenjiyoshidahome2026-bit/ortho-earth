import { defineConfig } from "vite";
import { resolve } from "node:path";

// ortho-nl＝オランダ（3DBAG）の独立した入口。中身は ortho-japan と同じエンジン（../ortho-japan/app.js を直接 import）で、
// 違うのは base(/nl/)・既定の視点・題字・出典・載せるガジェットだけ＝コードは二重化しない。
// publicDir も japan のものを共有（plateau-sets.json 等の実行時 fetch は import.meta.env.BASE_URL 前置＝/nl/ から引ける）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer に必須）。worker は ES module 形式。
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

export default defineConfig({
	base: "/nl/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	server: { port: 5188, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（../ortho-japan・packages）を dev で読ませる
	build: { outDir: "dist/site/nl", emptyOutDir: true },
	worker: { format: "es" },
	plugins: [crossOriginIsolation, asyncMainCss],
});
