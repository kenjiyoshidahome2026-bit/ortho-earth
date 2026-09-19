import { defineConfig } from "vite";

// COOP/COEP（japan と同じ 2 ヘッダ・2026-09-20）：japan は COEP=credentialless で配信しており、その iframe に載る文書も
// 同じ COEP を持たないとブラウザが読み込みを止める（ERR_BLOCKED_BY_RESPONSE＝dev の別ポートで実測）。equal 自身は SAB を
// 使わないが、japan の上に重なる（同一 URL の受け渡し）ためにヘッダを揃える。dev＝この middleware・本番＝_headers（deploy で dist/site へ）。
// japan と同じく server.headers でなく middleware＝worker のサブ import まで届く。
const coiHeaders = server => {   // 戻り値なし（configureServer の戻り値は post-hook 関数と解釈される＝connect app を返すと起動時に落ちる）
	server.middlewares.use((_req, res, next) => {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
		res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");   // 別オリジン（dev の japan 5175）の iframe に載るため＝navigation 応答にも CORP が見られる
		next();
	});
};
const crossOriginIsolation = { name: "cross-origin-isolation", configureServer: coiHeaders, configurePreviewServer: coiHeaders };

// base './'＝どのパスにマウントしても動く相対参照（solar と同じ型）。
export default defineConfig({
	plugins: [crossOriginIsolation],
	base: "./",
	build: { outDir: "dist/site/equal", emptyOutDir: true, target: "es2022" },   // target＝トップレベル await を許す（起動時に UI の訳を揃える）
	worker: { format: "es" },   // geopbf は module worker 連鎖＝既定 iife だとビルドが落ちる（ortho-japan と同じ轍）
	server: { port: 5198 },
});
