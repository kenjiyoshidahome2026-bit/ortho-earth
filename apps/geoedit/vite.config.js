import { defineConfig } from "vite";
import { resolve } from "node:path";

// geoedit＝GeoPBFトポロジカルエディタの独立した入口（/geoedit/）。中身は ortho-japan と同じエンジン
// （SDK二重構成＝dev はソース直 import・本番は /japan/lib/ の配布物）で、違うのは base と編集UIだけ
// ＝エンジンは二重化しない（census2020 と同型）。publicDir は japan のものを共有（favicon 等）。
// COOP/COEP は japan と同条件（gint の SharedArrayBuffer＝ゼロコピーの点火条件。無くてもコピー経路で動く）。
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
	base: "/geoedit/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	server: {
		port: 5190,
		fs: { allow: [resolve(import.meta.dirname, "..", "..")] },   // root の外（../ortho-japan・packages）を dev で読ませる
		// クラウド保存（apps/account の wrangler dev :8787）＝dev も同一オリジン化＝CORS 不要（本番は route が同居）
		proxy: { "/auth": "http://localhost:8787", "/me": "http://localhost:8787" },
	},
	// external＝SDK二重構成（main.js冒頭）の本番側import＝バンドルせず実行時URLのまま（実体は ortho-japan Worker が /japan/lib/ で配る）
	build: { outDir: "dist/site/geoedit", emptyOutDir: true, rollupOptions: { external: ["/japan/lib/ortho-japan.js"] } },
	worker: { format: "es" },
	plugins: [crossOriginIsolation, asyncMainCss],
});
