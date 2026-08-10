import { defineConfig } from "vite";

// base './'＝どのパス（/solar/ でもプレビューでも）にマウントしても動く相対参照。
// 出力は dist/site/solar/＝Workers assets は「リクエストのパス名＝ディレクトリ内相対パス」で引く
// （wrangler.toml の directory = dist/site・route = /solar*。ortho-japan と同じ型）
export default defineConfig({
	base: "./",
	server: { port: 5199 },   // ortho-japan の太陽系ガジェット（gadgets/solar.js）が開発時に叩く固定ポート＝素の 5173 だと japan と取り合う

	build: { outDir: "dist/site/solar", emptyOutDir: true },
	worker: { format: "es" },   // geopbf は module worker 連鎖＝既定 iife だとビルドが落ちる（ortho-japan と同じ轍）
});
