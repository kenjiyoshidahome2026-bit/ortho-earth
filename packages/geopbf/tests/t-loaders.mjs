// t-loaders: geopbf/loaders の GeoPBFLoader 検定（Node 20+・実 @loaders.gl/core 使用）。
// parse(buffer) / load(url) の両経路・gzip 透過・sanitize オプション・geopbfMeta 添付を確認する。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { parse, load } from "@loaders.gl/core";
import { GeoPBF } from "../src/pbf-base.js";
import { GeoPBFLoader } from "../src/loaders.js";

// Node に ImageData が無い（pbf-base のエンコード経路が参照する）ためスタブ
globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- 配信データ -------------------------------------------------------------
const amedas = await readFile(new URL("../../../apps/gishub-jp/public/jma/amedas.geopbf", import.meta.url));
const synthPbf = await new GeoPBF({ name: "synth", attribution: "test-attribution", minZoom: 5 }).set({
	type: "FeatureCollection",
	features: [{ type: "Feature", geometry: { type: "Point", coordinates: [139.75, 35.68] },
		properties: { n: 1, date: new Date(1700000000000) } }],
});
const synth = new Uint8Array(synthPbf.arrayBuffer);
const synthGz = new Uint8Array(await new Response(
	new Blob([synth]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const server = createServer((req, res) => {
	const body = { "/amedas.geopbf": amedas }[req.url];
	if (!body) { res.writeHead(404); return res.end(); }
	res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- parse(buffer) 経路 -----------------------------------------------------
const fc = await parse(synth.slice().buffer, GeoPBFLoader);
ok(fc.type === "FeatureCollection" && fc.features.length === 1, "parse(buffer) → FeatureCollection");
ok(fc.features[0].properties.date === new Date(1700000000000).toISOString(), "既定でサニタイズ（Date→ISO）");
ok(fc.geopbfMeta?.name === "synth" && fc.geopbfMeta?.attribution === "test-attribution" && fc.geopbfMeta?.minZoom === 5,
	`geopbfMeta 添付 (name=${fc.geopbfMeta?.name})`);

// gzip バッファも透過
const gz = await parse(synthGz.slice().buffer, GeoPBFLoader);
ok(gz.features.length === 1, "gzip バッファも透過");

// sanitize:false はオプションで素通し
const raw = await parse(synth.slice().buffer, GeoPBFLoader, { geopbf: { sanitize: false } });
ok(raw.features[0].properties.date instanceof Date, "options.geopbf.sanitize=false で素通し");

// ---- load(url) 経路（実データ） ---------------------------------------------
const am = await load(`${base}/amedas.geopbf`, GeoPBFLoader);
ok(am.features.length === 1286 && am.geopbfMeta.name === "amedas", `load(url) 実データ (features=${am.features.length})`);

// ---- Loader 契約の体裁 ------------------------------------------------------
ok(GeoPBFLoader.id === "geopbf" && GeoPBFLoader.extensions.includes("geopbf") && GeoPBFLoader.worker === false,
	"Loader 契約フィールド");

server.close();
process.exit(fails ? 1 : 0);
