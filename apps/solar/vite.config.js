import { defineConfig } from "vite";
import { resolve } from "node:path";
import { coepHeadersFile } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）
// 本番の COOP/COEP＝coepHeadersFile が dist/site/_headers を書く（www のデモ一覧の iframe に載る頁＝www と同じ COEP credentialless が要る・2026-09-22・理由は vite-app.mjs）。

// base './'＝どのパス（/solar/ でもプレビューでも）にマウントしても動く相対参照。
// 出力は dist/site/solar/＝Workers assets は「リクエストのパス名＝ディレクトリ内相対パス」で引く
// （wrangler.toml の directory = dist/site・route = /solar*。ortho-japan と同じ型）
export default defineConfig({
	base: "./",
	plugins: [coepHeadersFile(resolve(import.meta.dirname, "dist/site"))],
	server: { port: 5199 },   // ortho-japan の太陽系ガジェット（gadgets/solar.js）が開発時に叩く固定ポート＝素の 5173 だと japan と取り合う

	// target es2022＝main.js 冒頭の top-level await（訳を待ってから UI を組む）を素通しさせる。
	// 既定の "modules" は Safari 14 を含む＝TLA でビルドが落ちる（WebGL2 必須のアプリ＝素性の古い端末は元から対象外）
	build: { outDir: "dist/site/solar", emptyOutDir: true, target: "es2022" },
	worker: { format: "es" },   // geopbf は module worker 連鎖＝既定 iife だとビルドが落ちる（ortho-japan と同じ轍）
});
