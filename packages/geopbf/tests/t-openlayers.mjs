// t-openlayers: geopbf/openlayers の makeGeopbfLoader 検定（Node 20+・実 ol 使用）。
// ol の VectorSource / format / proj は DOM 不要で Node でも動くため、実物との結合をここで検定できる
// （描画までの関門は tests/t-openlayers.html）。node:http でメモリ配信し、
// 投影変換（EPSG:3857）・attribution 自動配線・onMeta/エラー経路を確認する。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import VectorSource from "ol/source/Vector.js";
import GeoJSON from "ol/format/GeoJSON.js";
import { get as getProjection } from "ol/proj.js";
import { GeoPBF } from "../src/pbf-base.js";
import { makeGeopbfLoader } from "../src/openlayers.js";

// Node に ImageData が無い（pbf-base のエンコード経路が参照する）ためスタブ
globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- 配信データ -------------------------------------------------------------
const amedas = await readFile(new URL("../../../apps/gishub-jp/public/jma/amedas.geopbf", import.meta.url));
const synthPbf = await new GeoPBF({ name: "synth", attribution: "test-attribution" }).set({
	type: "FeatureCollection",
	features: [{ type: "Feature", geometry: { type: "Point", coordinates: [139.75, 35.68] }, properties: { n: 1 } }],
});
const synth = new Uint8Array(synthPbf.arrayBuffer);
const server = createServer((req, res) => {
	const body = { "/amedas.geopbf": amedas, "/synth.geopbf": synth }[req.url];
	if (!body) { res.writeHead(404); return res.end(); }
	res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const EXTENT = [-2e7, -2e7, 2e7, 2e7], EPSG3857 = getProjection("EPSG:3857");
const load = (url, options = {}) => new Promise((res, rej) => {
	const source = new VectorSource({
		loader: makeGeopbfLoader(url, new GeoJSON(), { ...options, onMeta: meta => res({ source, meta }), onError: rej }),
	});
	source.loadFeatures(EXTENT, 1, EPSG3857);
});

// ---- 引数検査 ---------------------------------------------------------------
ok(await Promise.resolve().then(() => makeGeopbfLoader("x", {})).then(() => false, e => /format instance/.test(e.message)),
	"format 無しは明示エラー");

// ---- 実データ（amedas）: 読込・投影変換・メタ -------------------------------
const a = await load(`geopbf://${base}/amedas.geopbf`);
const n = a.source.getFeatures().length;
ok(n === 1286, `amedas: features=${n}`);
const [x, y] = a.source.getFeatures()[0].getGeometry().getFirstCoordinate();
ok(Math.abs(x) > 1e6 && Math.abs(y) > 1e6, `featureProjection で EPSG:3857 に変換済み (${Math.round(x)}, ${Math.round(y)})`);
ok(a.meta.name === "amedas", `onMeta (name=${a.meta.name})`);

// ---- attribution 自動配線（合成データ） -------------------------------------
const s = await load(`geopbf://${base}/synth.geopbf`);
const attr = s.source.getAttributions()?.();
ok([attr].flat().includes("test-attribution"), `ヘッダ ATTRIBUTION を source へ自動配線 (${JSON.stringify(attr)})`);

// source 側の明示 attributions が優先（上書きしない）
const s2 = await new Promise((res, rej) => {
	const source = new VectorSource({ attributions: "mine" });
	source.setLoader(makeGeopbfLoader(`geopbf://${base}/synth.geopbf`, new GeoJSON(), { onMeta: () => res(source), onError: rej }));
	source.loadFeatures(EXTENT, 1, EPSG3857);
});
ok([s2.getAttributions()?.()].flat().includes("mine"), "明示 attributions が優先");

// ---- エラー経路 -------------------------------------------------------------
const err = await new Promise(res => {
	const source = new VectorSource({
		loader: makeGeopbfLoader(`geopbf://${base}/nothing.geopbf`, new GeoJSON(), { onError: res }),
	});
	source.loadFeatures(EXTENT, 1, EPSG3857);
});
ok(/404/.test(err.message), "404 は onError（removeLoadedExtent 経路）");

server.close();
process.exit(fails ? 1 : 0);
