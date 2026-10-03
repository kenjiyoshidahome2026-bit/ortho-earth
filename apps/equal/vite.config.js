import { defineConfig } from "vite";
import { crossOriginIsolation, noChunkOptimization } from "../../packages/globe/scripts/lib/vite-app.mjs";   // アプリ共通の決まり（2026-10-03）

// COOP/COEP（japan と同じ 2 ヘッダ・2026-09-20）：japan は COEP=credentialless で配信しており、その iframe に載る文書も
// 同じ COEP を持たないとブラウザが読み込みを止める（ERR_BLOCKED_BY_RESPONSE＝dev の別ポートで実測）。equal 自身は SAB を
// 使わないが、japan の上に重なる（同一 URL の受け渡し）ためにヘッダを揃える。dev＝この middleware・本番＝_headers（deploy で dist/site へ）。
// corp＝別オリジン（dev の japan 5175）の iframe に載るため Cross-Origin-Resource-Policy: cross-origin も刻む（navigation 応答にも CORP が見られる）。
// noChunkOptimization＝equal は今は 3D を含まず無症状だが、入った時に踏まないよう先に（2026-09-25・vite-app.mjs に理由）。

// base './'＝どのパスにマウントしても動く相対参照（solar と同じ型）。
export default defineConfig({
	plugins: [crossOriginIsolation({ corp: true })],
	base: "./",
	build: { outDir: "dist/site/equal", emptyOutDir: true, target: "es2022", rolldownOptions: noChunkOptimization },   // target＝トップレベル await を許す（起動時に UI の訳を揃える）
	worker: { format: "es", rolldownOptions: noChunkOptimization },   // geopbf は module worker 連鎖＝既定 iife だとビルドが落ちる（ortho-japan と同じ轍）
	server: { port: 5198 },
});
