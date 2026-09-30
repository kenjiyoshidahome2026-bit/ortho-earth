import { defineConfig } from "vite";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

// census2020＝国勢調査2020の独立した入口（/japan/census2020/）。中身は ortho-japan と同じエンジン
// （../ortho-japan/app.js を直接 import）で、違うのは base(/japan/census2020/)・6:4分割レイアウト・右パネルの
// censusドリル・コロプレス/筆/防災の各モジュールだけ＝エンジンは二重化しない（ortho-nl と同型）。
// publicDir は japan のものを共有（plateau-sets.json 等）。census の重量データ（小地域CSV等）は R2＝gishub-jp/shared-data が正本（2026-09-30・dev も本番も同じ URL を読む）。
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
// japan の public を共有すると、実行時に読まない物まで出力に入る＝外す（2026-09-30・−4.6MB）。plateau-names.json＝台帳づくりの中間（japan も deploy で消す）・showcase＝www のデモが /japan/showcase を指す
const dropUnusedPublic = {
	name: "drop-unused-public",
	apply: "build",
	closeBundle() { for (const f of ["plateau-names.json", "showcase"]) rmSync(resolve(import.meta.dirname, "dist/site/japan/census2020", f), { recursive: true, force: true }); },
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
	plugins: [crossOriginIsolation, asyncMainCss, dropUnusedPublic],
});
