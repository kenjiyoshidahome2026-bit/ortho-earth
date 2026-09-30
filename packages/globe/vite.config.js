// 地球儀ホストの検定台（packages/globe/tests/*.html を dev サーバで配るだけ）。
// なぜ器が要るか：検定頁は「実ブラウザで起動して title に PASS/FAIL を書く」形＝配る器が要る。
// 9/24 までこの器は apps/ortho-japan（日本の殻）しか持っておらず、globe の門は japan に間借りしていた。
// ここが持つのは**頁を配るのに必要な条件だけ**で、japan の vite と同じにする必要があるのは次の3つ：
//   ① COOP/COEP を middleware で全リクエストに刻む（server.headers だと worker のサブ import に届かず
//      worker 全滅＝黒画面。crossOriginIsolated＝SAB のゼロコピーが点く条件・NOCOI=1 で外して A/B）
//   ② worker.format="es"（全 worker が type:"module"＝既定の iife だと worker 内 worker/動的 import で落ちる）
//   ③ builtinWorkers を「作らない版」へ（部品の worker は作らない＝ホストの入口 worker.js 一本で回す作法）
// #extra-roles（地域の worker 役）は**差し替えない**＝globe 既定の {} のまま＝地域を知らない器であることの実地確認。
// #tile-formats（タイル形式のプラグイン）は MLT を載せる（#88）＝形式は地域ではない。t-mlcompat?g=mlt が「MVT と MLT で同じ絵」を見る器
import { defineConfig } from "vite";
import { resolve } from "node:path";

const coiHeaders = server => {
	server.middlewares.use((_req, res, next) => {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
		next();
	});
};
const NOCOI = process.env.NOCOI === "1";
const crossOriginIsolation = { name: "cross-origin-isolation", configureServer: NOCOI ? undefined : coiHeaders, configurePreviewServer: NOCOI ? undefined : coiHeaders };

export default defineConfig({
	resolve: { alias: [{ find: /^\.\.?\/(modules\/)?builtinWorkers\.js$/, replacement: resolve(import.meta.dirname, "../geopbf/src/modules/builtinWorkers.none.js") },
		{ find: "#tile-formats", replacement: resolve(import.meta.dirname, "../tile-formats/src/register.js") },
		{ find: "#pointcloud-formats", replacement: resolve(import.meta.dirname, "../tile-formats/src/pointcloud.js") }] },   // 点群の解読器（#178・COPC の LAZ＝laz-perf）＝最初の節で動的 import（起動の束には入らない）
	worker: { format: "es" },
	plugins: [crossOriginIsolation],
});
