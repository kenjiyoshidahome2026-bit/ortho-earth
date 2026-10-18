// 地球儀ホストの検定台（packages/globe/tests/*.html を dev サーバで配るだけ）。
// なぜ器が要るか：検定頁は「実ブラウザで起動して title に PASS/FAIL を書く」形＝配る器が要る。
// 9/24 までこの器は apps/ortho-japan（日本の殻）しか持っておらず、globe の門は japan に間借りしていた。
// ここが持つのは**頁を配るのに必要な条件だけ**で、japan の vite と同じにする必要があるのは次の3つ（どれも scripts/lib/vite-app.mjs の共通部品）：
//   ① COOP/COEP を middleware で全リクエストに刻む（server.headers だと worker のサブ import に届かず
//      worker 全滅＝黒画面。crossOriginIsolated＝SAB のゼロコピーが点く条件・NOCOI=1 で外して A/B）
//   ② worker.format="es"（全 worker が type:"module"＝既定の iife だと worker 内 worker/動的 import で落ちる）
//   ③ builtinWorkers を「作らない版」へ（部品の worker は作らない＝ホストの入口 worker.js 一本で回す作法）
// #tile-formats（タイル形式のプラグイン）は MLT を載せる（#88）＝形式は地域ではない。t-mlcompat?g=mlt が「MVT と MLT で同じ絵」を見る器
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { crossOriginIsolation, engineAliases } from "./scripts/lib/vite-app.mjs";

// "@ortho-earth/core/src/…"＝core の中身を白箱で見る検定頁（t-wgsl・t-gint*・t-elevcell）だけの口＝**この器の中でだけ**解ける。
// core の package.json の exports には無い（2.0 で "./internal/*" を閉じた・段 5-7）＝利用者からは見えない。node の検定は相対パス（../../ortho-core/src/…）で読む。
const CORE_SRC = { find: /^@ortho-earth\/core\/src\//, replacement: resolve(import.meta.dirname, "..", "ortho-core", "src") + "/" };

// node_modules/three を /__three/… に素のまま（vite の変換を通さず）配る＝CDN の three と同じ（bare の "three" を書き換えない）
const THREE_DIR = resolve(import.meta.dirname, "..", "..", "node_modules", "three");
function rawThree() {
	return { name: "raw-three", configureServer(server) {
		server.middlewares.use("/__three/", async (req, res, next) => {
			const rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, ""), file = resolve(THREE_DIR, rel);
			if (!file.startsWith(THREE_DIR + "/") || !/\.(js|json|wasm|glb|bin)$/.test(file)) return next();
			try { const body = await readFile(file); res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream"); res.end(body); }
			catch { next(); }
		});
	} };
}

export default defineConfig({
	resolve: { alias: [...engineAliases(resolve(import.meta.dirname, "..", "..")), CORE_SRC] },
	// three.js（検定 t-three だけの devDependency・利用者は CDN の URL を渡す）：bare の "three" を頁で import すると dep の事前束ね（?url が default を失う）に
	// 入り、/@fs/ で配ると addons の `from "three"` を vite が束ねた別の three に書き換える（THREE の実体が二つになる）。そこで node_modules/three を
	// /__three/ に**素のまま**配る（rawThree）＝CDN と同じ形。頁は __OE_THREE_URL__ を worker（map.addThree の opts.three）へそのまま渡す
	define: { __OE_THREE_URL__: JSON.stringify("/__three/build/three.module.js") },
	optimizeDeps: { include: ["@deck.gl/core", "@deck.gl/layers", "@deck.gl/mapbox"] },   // deck.gl（検定 t-deckgl だけの devDependency）＝起動時に束ねておく（頁の途中の再読込を避ける）
	worker: { format: "es" },
	plugins: [crossOriginIsolation(), rawThree()],
});
