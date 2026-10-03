// アプリの vite.config が揃って持つ決まり事（2026-10-03・アプリ横断の最適化で 1 本に）。ここは「同じ理由で同じ値を持つ物」だけ＝
// 各アプリの base・outDir・proxy は各アプリに残す。lib×ES の資産まわりは vite-lib-plugins.mjs、共有エンジンは shared-engine.mjs。
import { resolve } from "node:path";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";

// COOP/COEP を middleware で「全リクエスト」に刻む（dev と preview の両方）。server.headers だと worker のサブ import の転送レスポンスに
// 届かず worker 全滅→黒画面＝middleware が標準解（japan 2026-09）。crossOriginIsolated＝gint の SharedArrayBuffer（ゼロコピー）の点火条件で、
// 無くても動く（SAB 不在なら ArrayBuffer のコピー 1 回に落ちる）。COEP=credentialless＝SAB を有効化しつつ越境（GSI/bucket）は CORS で通す。
// 本番は各 deploy-worker.js／_headers が同じ 2 ヘッダを刻む＝dev/prod で同一条件。
//   coep  … "credentialless"（既定）。uploader だけ従来どおり "require-corp"
//   corp  … true＝Cross-Origin-Resource-Policy: cross-origin も刻む（equal＝別オリジンの japan の iframe に載る＝navigation 応答にも CORP が見られる）
//   nocoi … true＝刻まない。既定は環境変数 NOCOI=1（japan・globe の verify:nocoi＝「COI 無しでも全機能が動く」の実測）
export const crossOriginIsolation = ({ coep = "credentialless", corp = false, nocoi = process.env.NOCOI === "1" } = {}) => {
	const use = server => {   // 戻り値なし（configureServer の戻り値は post-hook 関数と解釈される＝connect app を返すと起動時に落ちる）
		server.middlewares.use((_req, res, next) => {
			res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
			res.setHeader("Cross-Origin-Embedder-Policy", coep);
			if (corp) res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
			next();
		});
	};
	return { name: "cross-origin-isolation", configureServer: nocoi ? undefined : use, configurePreviewServer: nocoi ? undefined : use };
};

// Workers の静的アセット配信は配信ディレクトリ直下の _headers を読む＝ビルドの最後に書く（solar・world＝www のデモ一覧の iframe に載る頁は
// www と同じ COEP credentialless が要る。無いと iframe の中で拒まれる・2026-09-22）。dir＝_headers を置く配信ディレクトリ（絶対パス）
export const coepHeadersFile = dir => ({
	name: "coep-headers",
	apply: "build",
	closeBundle() { mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, "_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n"); },
});

// rolldown（vite 8）のチャンク最適化を切る（2026-09-25・globe を束ねる vite 8 アプリの決まり）。既定 on だと実行時ヘルパ __exportAll の
// 共通チャンクが動的エントリ mesh-loaders に合流し、renderworker・gint・topology 等がヘルパ欲しさに mesh-loaders＋basis-loader（計 220KB）を
// 静的 import する＝3D を使う前から worker ごとに読み込み・副作用（globalThis.probe）も走る（起動 4 秒の JS 1.5→2.1MB を実測）。
// worker は別ビルド＝build.rolldownOptions と worker.rolldownOptions の両方に要る。experimental の口＝rolldown を上げたら
// 「mesh-loaders を静的 import するチャンクが無い」ことを確かめ直す。
export const noChunkOptimization = { experimental: { chunkOptimization: false } };

// cssTarget＝vite 8 の既定（baseline-widely-available）の実体。build.target を esnext にすると cssTarget も esnext になり、lightningcss が
// -webkit-backdrop-filter を「不要な接頭辞」として消す＝iOS 17 以前の Safari でガラスのぼかしが消える（8.1 で 24 規則を実測・2026-09-25）
export const CSS_TARGET = ["chrome111", "edge111", "firefox114", "safari16.4", "ios16.4"];

// 本番 CSS を render-blocking から外す＝起動画面（#boot・head 内インライン CSS で自足）を HTML 到着直後に描かせる（FCP を CSS 往復の後ろから前へ）。
// アプリ UI は JS 実行（~2s）後に生成＝その時には CSS は届いており FOUC は起きない。media=print で一旦非適用→onload で all に戻す定石。
// JS 無効環境向けに noscript の実体 link も残す。
export const asyncMainCss = {
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

// publicDir（japan の public を共有する頁も）から実行時に読まない物を出力から外す（2026-09-30・−4.6MB）。
// dir＝出力ディレクトリ（絶対パス）・files＝外すエントリ名（plateau-names.json＝台帳づくりの中間・showcase＝www のデモが /japan/showcase を指す）
export const dropUnusedPublic = (dir, files) => ({
	name: "drop-unused-public",
	apply: "build",
	closeBundle() { for (const f of files) rmSync(resolve(dir, f), { recursive: true, force: true }); },
});

// 部品（geopbf・ortho-core・altpbf・geoedit）の worker はアプリの入口（globe の worker.js）で走らせる＝各部品の builtinWorkers.js（new Worker の
// 唯一の直書き）を「作らない版」に差し替える（2026-09-22・標準の作法）。#tile-formats＝MLT（#88）・#pointcloud-formats＝COPC の LAZ（#178）＝
// どちらも最初のタイル／節で動的 import（起動の束には入らない）。root＝リポジトリの根（packages/ の親・絶対パス）
export const engineAliases = root => [
	{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(root, "packages/geopbf/src/modules/builtinWorkers.none.js") },
	{ find: "#tile-formats", replacement: resolve(root, "packages/tile-formats/src/register.js") },
	{ find: "#pointcloud-formats", replacement: resolve(root, "packages/tile-formats/src/pointcloud.js") },
];
