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
// 借り物（2026-09-25）：小地域 CSV（各 9MB）は gishub-jp の public/census が正本＝同一ファイルを二重に抱えない。
// 配信上の道（/japan/census2020/census/<name>）は従来どおり＝dev は正本から直配信・build は outDir へ写す
const SHARED = { dir: resolve(import.meta.dirname, "../gishub-jp/public/census"), at: "/census/", files: ["2015-small.csv", "2020-small.csv"] };
const sharedFile = rel => rel.startsWith(SHARED.at) && SHARED.files.includes(rel.slice(SHARED.at.length)) ? join(SHARED.dir, rel.slice(SHARED.at.length)) : null;
const MIME = { ".csv": "text/csv; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const extraPublic = {
	name: "extra-public",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			const p = decodeURIComponent((req.url || "").split("?")[0]);
			if (!p.startsWith("/japan/census2020/")) return next();
			const rel = p.slice("/japan/census2020".length);
			const own = normalize(join(extraDir, rel)), file = own.startsWith(extraDir) && existsSync(own) && statSync(own).isFile() ? own : sharedFile(rel);
			if (!file || !existsSync(file)) return next();
			res.setHeader("Content-Type", MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream");
			createReadStream(file).pipe(res);
		});
	},
	closeBundle() {
		const out = resolve(import.meta.dirname, "dist/site/japan/census2020");
		if (!existsSync(out)) return;
		cpSync(extraDir, out, { recursive: true });
		for (const f of SHARED.files) cpSync(join(SHARED.dir, f), join(out, SHARED.at, f));
	},
};

export default defineConfig({
	base: "/japan/census2020/",
	publicDir: resolve(import.meta.dirname, "../ortho-japan/public"),
	resolve: { alias: [{ find: "#extra-roles", replacement: resolve(import.meta.dirname, "../../packages/jp/src/worker-roles.js") }] },   // e-Stat の worker 役＝globe の入口の既定 {} を日本の役表へ（S4 2026-09-23）
	server: { port: 5189, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },   // root の外（../ortho-japan・../gishub-jp/jp・packages）を dev で読ませる
	// エンジンは同梱（main.js 冒頭＝A 裁定 2026-09-23）＝external 無し。worker/wasm は ortho-japan の build と同じ既定で束なる
	// experimental.chunkOptimization:false＝rolldown（vite 8）の決まり（2026-09-25・japan と同じ）。既定 on だと worker が実行時ヘルパ欲しさに
	// mesh-loaders＋basis-loader（計 220KB）を静的 import する。worker は別ビルド＝両方に要る。rolldown を上げたら確かめ直す。
	build: { outDir: "dist/site/japan/census2020", emptyOutDir: true, rolldownOptions: { experimental: { chunkOptimization: false } } },
	worker: { format: "es", rolldownOptions: { experimental: { chunkOptimization: false } } },
	plugins: [crossOriginIsolation, asyncMainCss, extraPublic],
});
