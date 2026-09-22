import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
const __dirname = import.meta.dirname;
// www のデモ一覧は各デモをナビの下の iframe で開く（2026-09-22）＝www は COEP credentialless の頁＝中に入る頁も COEP が要る
// （無いと iframe の中で拒まれる）。Workers の静的アセットは配信ディレクトリ直下の _headers を読む＝ビルドの最後に dist/site/_headers を書く。
// credentialless＝越境の no-cors 取得は資格情報なしで通る（japan・equal と同じ・SAB は使わない）。
const coepHeaders = () => ({
	name: "coep-headers",
	closeBundle() { fs.writeFileSync(path.resolve(__dirname, "dist/site/_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n"); },
});

// base './'＝どのパス（/solar/ でもプレビューでも）にマウントしても動く相対参照。
// 出力は dist/site/solar/＝Workers assets は「リクエストのパス名＝ディレクトリ内相対パス」で引く
// （wrangler.toml の directory = dist/site・route = /solar*。ortho-japan と同じ型）
export default defineConfig({
	base: "./",
	plugins: [coepHeaders()],
	server: { port: 5199 },   // ortho-japan の太陽系ガジェット（gadgets/solar.js）が開発時に叩く固定ポート＝素の 5173 だと japan と取り合う

	// target es2022＝main.js 冒頭の top-level await（訳を待ってから UI を組む）を素通しさせる。
	// 既定の "modules" は Safari 14 を含む＝TLA でビルドが落ちる（WebGL2 必須のアプリ＝素性の古い端末は元から対象外）
	build: { outDir: "dist/site/solar", emptyOutDir: true, target: "es2022" },
	worker: { format: "es" },   // geopbf は module worker 連鎖＝既定 iife だとビルドが落ちる（ortho-japan と同じ轍）
});
