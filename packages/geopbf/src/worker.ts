// geopbf/src/worker.ts ── 変換 worker の唯一の入口（処方②・ortho-earth#12・2026-09-14）。
//
// 従来は形式ごとに worker ファイル（decoder/fgb.js …）を new Worker していた。バンドラ（vite）は worker ごとに独立した
// rollup ビルドを回すため、核（pbf-base.js / modules/pbf.ts / antimeridian* / cleanCoords …）が decoder 13＋encoder 11 の
// 全部に同梱され、配布物で 25〜29 コピー＝約 1.4 MB が複製で失われていた（ortho-japan dist/lib の計量）。
// 入口をこの 1 本にし、形式モジュールを動的 import にすると worker ビルドは 1 つ＝核は共有チャンク 1 つになる。
//
// 形式の指名は Worker の name：`new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "decoder:fgb" })`。
// URL に ?query を足す方式は vite の静的検出（new Worker(new URL('…', import.meta.url), {静的 options})）を壊すので使わない。
// decoder/*.ts・encoder/*.ts は従来どおり「自分で onmessage を張る worker 脚本」のまま無改修。ここは指名された脚本を
// 読み込み、読み込み中に届いたメッセージを手渡すだけ。1 インスタンス＝1 仕事（呼び手が terminate する運用も従来どおり）。
// 便の形（main ⇄ 各脚本）は worker-msg.ts（型だけ）。cog/・convert/ も .ts（batch F）＝指定子はすべて .ts。
const MODULES: Record<string, () => Promise<unknown>> = {
	"geopbf:cog":      () => import("./cog/worker.ts"),            // COG の復号（cog/pool）＝ホストの入口から来る時の名前（2026-09-22）
	"geopbf:tile":     () => import("./convert/tile-worker.ts"),   // PMTiles のタイル書き出し（convert/pool）＝同上
	"decoder:fgb":     () => import("./decoder/fgb.ts"),
	"decoder:gint":    () => import("./decoder/gint.ts"),
	"decoder:gml":     () => import("./decoder/gml.ts"),
	"decoder:gpkg":    () => import("./decoder/gpkg.ts"),
	"decoder:gdb":     () => import("./decoder/gdb.ts"),
	"decoder:parquet": () => import("./decoder/parquet.ts"),
	"decoder:csv":     () => import("./decoder/csv.ts"),
	"decoder:czml":    () => import("./decoder/czml.ts"),
	"decoder:dxf":     () => import("./decoder/dxf.ts"),
	"decoder:gpx":     () => import("./decoder/gpx.ts"),
	"decoder:json":    () => import("./decoder/json.ts"),
	"decoder:ndjson":  () => import("./decoder/ndjson.ts"),
	"decoder:kmz":     () => import("./decoder/kmz.ts"),
	"decoder:moj":     () => import("./decoder/moj.ts"),
	"decoder:pbf":     () => import("./decoder/pbf.ts"),
	"decoder:shape":   () => import("./decoder/shape.ts"),
	"decoder:spatialite": () => import("./decoder/spatialite.ts"),
	"encoder:czml":     () => import("./encoder/czml.ts"),
	"encoder:fgb":      () => import("./encoder/fgb.ts"),
	"encoder:geojson":  () => import("./encoder/geojson.ts"),
	"encoder:geopbf":   () => import("./encoder/geopbf.ts"),
	"encoder:gint":     () => import("./encoder/gint.ts"),
	"encoder:gml":      () => import("./encoder/gml.ts"),
	"encoder:gpx":      () => import("./encoder/gpx.ts"),
	"encoder:kmz":      () => import("./encoder/kmz.ts"),
	"encoder:preview":  () => import("./encoder/preview.ts"),
	"encoder:profile":  () => import("./encoder/profile.ts"),
	"encoder:shape":    () => import("./encoder/shape.ts"),
	"encoder:topojson": () => import("./encoder/topojson.ts"),
};

// 脚本の読み込みが終わるまでに届いたメッセージは溜めておき、読み込み後に脚本の onmessage へ渡す。
const pending: MessageEvent[] = [];
const enqueue = (e: MessageEvent): number => pending.push(e);
self.onmessage = enqueue;

(async () => {
	const load = MODULES[self.name];
	try {
		if (!load) throw new Error(`unknown worker name "${self.name}" (expected decoder:<format> / encoder:<format>)`);
		await load();                                   // 脚本が自分の onmessage を張る
		if (self.onmessage === enqueue) throw new Error(`${self.name}: the script did not install onmessage`);
	} catch (err) {
		console.error("[geopbf worker]", err);
		self.onmessage = () => postMessage(null);       // 呼び手は null を「失敗」として扱う（従来の worker.onerror と同じ着地）
	}
	const handler = self.onmessage!;   // 脚本が張ったか、上の失敗時の物＝必ずある
	for (const e of pending.splice(0)) handler.call(self as unknown as DedicatedWorkerGlobalScope, e);
})();
