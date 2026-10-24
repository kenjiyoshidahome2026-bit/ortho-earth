// アプリの vite.config が揃って持つ決まり事（2026-10-03・アプリ横断の最適化で 1 本に）。ここは「同じ理由で同じ値を持つ物」だけ＝
// 各アプリの base・outDir・proxy は各アプリに残す。lib×ES の資産まわりは vite-lib-plugins.mjs、共有エンジンは shared-engine.mjs。
import { resolve, dirname } from "node:path";
import { rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { BOOT_SLOT, BOOT_CSS, BOOT_HTML } from "../../src/boot/screen.ts";

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
	closeBundle() { mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, "_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"); },
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

// 起動画面（#boot）を配る（2026-10-23・本人「修正元は１か所で、それを配る形に」）。正本＝packages/globe/src/boot/screen.ts。
// HTML の <!-- ortho:boot --> を幕に差し替え、head に CSS を入れる（dev も build も）。印の無い頁は素通し。畳むのは各頁の dismissBoot（page.js）
export const bootScreen = {
	name: "boot-screen",
	transformIndexHtml(html) {
		if (!html.includes(BOOT_SLOT)) return html;
		return html.replace(BOOT_SLOT, BOOT_HTML).replace("</head>", `\t<style id="boot-css">${BOOT_CSS}</style>\n</head>`);
	},
};

// publicDir（japan の public を共有する頁も）から実行時に読まない物を出力から外す（2026-09-30・−4.6MB）。
// dir＝出力ディレクトリ（絶対パス）・files＝外すエントリ名（plateau-names.json＝台帳づくりの中間・showcase＝www のデモが /japan/showcase を指す）
export const dropUnusedPublic = (dir, files) => ({
	name: "drop-unused-public",
	apply: "build",
	closeBundle() { for (const f of files) rmSync(resolve(dir, f), { recursive: true, force: true }); },
});

// 頁のデータの置き場（DATA.md・2026-10-13）＝本番は GitHub Pages（リポ ortho-data の <範囲>/・置く＝npm run publish:pages -w world-data -- --scope=<範囲>）・
// dev は手元の正本（リポの根の ortho-data/<範囲>/）を /@fs で読む＝置く前に見られる。vite の define に渡す値（文字列リテラル）を返す＝頁は __DATA_JAPAN__ のように書くだけ。
// command＝vite の command（"serve"＝dev）・base＝アプリの base（"/japan/" など）・root＝リポジトリの根・scope＝"us" | "japan"
export const ORTHO_DATA = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/";
export const orthoData = (command, base, root, scope) => JSON.stringify(command === "serve" ? `${base}@fs${resolve(root, "ortho-data", scope)}/` : `${ORTHO_DATA}${scope}/`);

// 部品（geopbf・ortho-core・altpbf・geoedit）の worker はアプリの入口（globe の worker.js）で走らせる＝各部品の builtinWorkers.js（new Worker の
// 唯一の直書き）を「作らない版」に差し替える（2026-09-22・標準の作法）。#tile-formats＝MLT（#88）・#pointcloud-formats＝COPC の LAZ（#178）＝
// どちらも最初のタイル／節で動的 import（起動の束には入らない）。root＝リポジトリの根（packages/ の親・絶対パス）
export const engineAliases = root => [
	{ find: /^\.\.?\/(modules\/)?builtinWorkers\.(js|ts)$/, replacement: resolve(root, "packages/geopbf/src/modules/builtinWorkers.none.ts") },
	{ find: "#tile-formats", replacement: resolve(root, "packages/ortho-core/src/tileformats-mlt.ts") },
	{ find: "#pointcloud-formats", replacement: resolve(root, "packages/tile-formats/src/pointcloud.ts") },
];

// SDK の plugin（sdk/splat・scene・ktx2）が描き手（レンダーワーカーが URL で import() する同一フレームのモジュール）を
// `new URL("./splat-draw.js", import.meta.url)` で指す書き方を、アプリの束で「実体の JS チャンク」にする（2026-10-21・verify-prod の splat 頁）。
// 字面は .js のまま（npm の dist では実体・repo の中では .ts）＝vite の既定（vite:asset-import-meta-url）はこれを「資産」と見て生の .ts をそのまま
// assets/ に写す＝ worker の import() が .ts を読めず「Failed to fetch dynamically imported module …splat-draw-xxxx.ts」。ここで先回り（enforce: pre）
// して rollup の chunk として emit し、参照を import.meta.ROLLUP_FILE_URL_ に差し替える＝TS を通した ES モジュールが assets/ に出る。
// 描き手が兄弟（splat-gpu.js／splat-gl.js）を同じ書き方で指す分も、その chunk が transform を通る時に同じ手で拾う（連鎖）。
// 対象＝相対パス（./ ../）の .js で、実体（.js か .ts）が repo の中に在る物だけ。/* @vite-ignore */ の付いた物・テンプレート文字列は触らない。dev は vite の
// 解決（.js → .ts の読み替え）がそのまま効くので build 限定。
export const moduleUrlAsChunk = {
	name: "module-url-as-chunk",
	enforce: "pre",
	apply: "build",
	async transform(code, id) {
		if (!code.includes("import.meta.url") || !code.includes(".js\"") && !code.includes(".js'")) return;
		const re = /new\s+URL\s*\(\s*(["'])(\.{1,2}\/[^"'`\n]+\.js)\1\s*,\s*import\.meta\.url\s*\)/g;
		let out = code, hit = false;
		for (const m of code.matchAll(re)) {
			if (/\/\*\s*@vite-ignore\s*\*\/\s*$/.test(code.slice(0, m.index))) continue;
			const want = resolve(dirname(id.split("?")[0]), m[2]);
			const file = [want, want.replace(/\.js$/, ".ts")].find(f => existsSync(f));
			if (!file) continue;
			// preserveSignature＝strict：誰も静的 import しない入口＝既定のままだと rolldown が export を全部木から落として空のチャンクになる（実測 0 kB・2026-10-21）
			const ref = this.emitFile({ type: "chunk", id: file, name: file.split("/").pop().replace(/\.(js|ts)$/, ""), preserveSignature: "strict" });
			// 第 2 引数に import.meta.url：vite は ROLLUP_FILE_URL_ を base 付きの絶対パス（/globe/assets/…）に解くので、そのままでは new URL が Invalid URL になる
			out = out.replace(m[0], `new URL(import.meta.ROLLUP_FILE_URL_${ref}, import.meta.url)`); hit = true;
		}
		return hit ? { code: out, map: null } : undefined;
	},
};
