import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
const __dirname = import.meta.dirname;
// www のデモ一覧は各デモをナビの下の iframe で開く＝www は COEP credentialless の頁＝中に入る頁も COEP が要る（solar と同じ）。
// Workers の静的アセットは配信ディレクトリ直下の _headers を読む＝ビルドの最後に dist/site/_headers を書く。
const coepHeaders = () => ({
	name: "coep-headers",
	closeBundle() { fs.writeFileSync(path.resolve(__dirname, "dist/site/_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n"); },
});
// base './'＝どのパス（/himekuri/ でもプレビューでも）にマウントしても動く相対参照。出力は dist/site/himekuri/（wrangler.toml の directory = dist/site・route = /himekuri*＝solar と同じ型）
export default defineConfig({
	base: "./",
	plugins: [coepHeaders()],
	server: { port: 5197, fs: { allow: [path.resolve(__dirname, "../..")] } },
	build: { outDir: "dist/site/himekuri", emptyOutDir: true, target: "es2022" },
});
