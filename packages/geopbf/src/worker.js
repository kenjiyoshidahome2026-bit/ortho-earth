// geopbf/src/worker.js ── 変換 worker の唯一の入口（処方②・ortho-earth#12・2026-09-14）。
//
// 従来は形式ごとに worker ファイル（decoder/fgb.js …）を new Worker していた。バンドラ（vite）は worker ごとに独立した
// rollup ビルドを回すため、核（pbf-base.js / modules/pbf.js / antimeridian* / cleanCoords …）が decoder 13＋encoder 11 の
// 全部に同梱され、配布物で 25〜29 コピー＝約 1.4 MB が複製で失われていた（ortho-japan dist/lib の計量）。
// 入口をこの 1 本にし、形式モジュールを動的 import にすると worker ビルドは 1 つ＝核は共有チャンク 1 つになる。
//
// 形式の指名は Worker の name：`new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "decoder:fgb" })`。
// URL に ?query を足す方式は vite の静的検出（new Worker(new URL('…', import.meta.url), {静的 options})）を壊すので使わない。
// decoder/*.js・encoder/*.js は従来どおり「自分で onmessage を張る worker 脚本」のまま無改修。ここは指名された脚本を
// 読み込み、読み込み中に届いたメッセージを手渡すだけ。1 インスタンス＝1 仕事（呼び手が terminate する運用も従来どおり）。
const MODULES = {
	"decoder:fgb":     () => import("./decoder/fgb.js"),
	"decoder:gint":    () => import("./decoder/gint.js"),
	"decoder:gml":     () => import("./decoder/gml.js"),
	"decoder:gpkg":    () => import("./decoder/gpkg.js"),
	"decoder:gdb":     () => import("./decoder/gdb.js"),
	"decoder:parquet": () => import("./decoder/parquet.js"),
	"decoder:csv":     () => import("./decoder/csv.js"),
	"decoder:dxf":     () => import("./decoder/dxf.js"),
	"decoder:gpx":     () => import("./decoder/gpx.js"),
	"decoder:json":    () => import("./decoder/json.js"),
	"decoder:ndjson":  () => import("./decoder/ndjson.js"),
	"decoder:kmz":     () => import("./decoder/kmz.js"),
	"decoder:moj":     () => import("./decoder/moj.js"),
	"decoder:pbf":     () => import("./decoder/pbf.js"),
	"decoder:shape":   () => import("./decoder/shape.js"),
	"decoder:spatialite": () => import("./decoder/spatialite.js"),
	"encoder:fgb":      () => import("./encoder/fgb.js"),
	"encoder:geojson":  () => import("./encoder/geojson.js"),
	"encoder:geopbf":   () => import("./encoder/geopbf.js"),
	"encoder:gint":     () => import("./encoder/gint.js"),
	"encoder:gml":      () => import("./encoder/gml.js"),
	"encoder:gpx":      () => import("./encoder/gpx.js"),
	"encoder:kmz":      () => import("./encoder/kmz.js"),
	"encoder:preview":  () => import("./encoder/preview.js"),
	"encoder:profile":  () => import("./encoder/profile.js"),
	"encoder:shape":    () => import("./encoder/shape.js"),
	"encoder:topojson": () => import("./encoder/topojson.js"),
};

// 脚本の読み込みが終わるまでに届いたメッセージは溜めておき、読み込み後に脚本の onmessage へ渡す。
const pending = [];
const enqueue = e => pending.push(e);
self.onmessage = enqueue;

(async () => {
	const load = MODULES[self.name];
	try {
		if (!load) throw new Error(`unknown worker name "${self.name}"（decoder:<format> / encoder:<format>）`);
		await load();                                   // 脚本が自分の onmessage を張る
		if (self.onmessage === enqueue) throw new Error(`${self.name}: the script did not install onmessage`);
	} catch (err) {
		console.error("[geopbf worker]", err);
		self.onmessage = () => postMessage(null);       // 呼び手は null を「失敗」として扱う（従来の worker.onerror と同じ着地）
	}
	const handler = self.onmessage;
	for (const e of pending.splice(0)) handler.call(self, e);
})();
