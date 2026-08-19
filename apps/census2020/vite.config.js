import { defineConfig } from "vite";
import { resolve, join, normalize } from "node:path";
import { existsSync, statSync, createReadStream, cpSync } from "node:fs";

// census2020＝国勢調査2020の独立した入口（/japan/census2020/）。中身は ortho-japan と同じエンジン
// （../ortho-japan/app.js を直接 import）で、違うのは base(/japan/census2020/)・6:4分割レイアウト・右パネルの
// censusドリル・コロプレス/筆/防災の各モジュールだけ＝エンジンは二重化しない（ortho-nl と同型）。
// publicDir は japan のものを共有（plateau-sets.json 等）。census 固有の重量データ（小地域CSV等）は
// japan の public に混ぜず public-extra/ から extraPublic プラグインで合流させる。
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
// 第二の public（public-extra/）：vite の publicDir は一つだけ＝共有棚（../ortho-japan/public）に census の
// 重量データ（9MB CSV 等）を混ぜないための合流口。dev は base 下で直配信、build は outDir へ丸コピー。
const extraDir = resolve(import.meta.dirname, "public-extra");
const MIME = { ".csv": "text/csv; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const extraPublic = {
	name: "extra-public",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			const p = decodeURIComponent((req.url || "").split("?")[0]);
			if (!p.startsWith("/japan/census2020/")) return next();
			const file = normalize(join(extraDir, p.slice("/japan/census2020".length)));
			if (!file.startsWith(extraDir) || !existsSync(file) || !statSync(file).isFile()) return next();
			res.setHeader("Content-Type", MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream");
			createReadStream(file).pipe(res);
		});
	},
	closeBundle() {
		const out = resolve(import.meta.dirname, "dist/site/japan/census2020");
		if (existsSync(out)) cpSync(extraDir, out, { recursive: true });
	},
};

export default defineConfig({
	base: "/japan/census2020/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	server: { port: 5189, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（../ortho-japan・../gishub-jp/jp・packages）を dev で読ませる
	// external＝SDK二重構成（main.js冒頭）の本番側import＝バンドルせず実行時URLのまま（実体は ortho-japan Worker が /japan/lib/ で配る）
	build: { outDir: "dist/site/japan/census2020", emptyOutDir: true, rollupOptions: { external: ["/japan/lib/ortho-japan.js"] } },
	worker: { format: "es" },
	plugins: [crossOriginIsolation, asyncMainCss, extraPublic],
});
