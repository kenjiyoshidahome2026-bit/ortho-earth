// t-leaflet: geopbf/leaflet プラグインの検定（Node 20+）。
// Leaflet 本体は DOM 前提なので、ここでは Class.extend / GeoJSON / Evented の契約を模した
// 最小フェイク L でプラグインの配線（登録・load/error イベント・attribution 自動配線・メタ）を検定する。
// 実 Leaflet との結合は tests/t-leaflet.html（自己判定式）が関門。
import { createServer } from "node:http";
import { GeoPBF } from "../src/pbf-base.js";
import { extendLeaflet, loadGeopbf } from "../src/leaflet.js";

// Node に ImageData が無い（pbf-base のエンコード経路が参照する）ためスタブ
globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- 最小フェイク L（Leaflet の Class.extend 契約: initialize がコンストラクタ） --------
class FakeGeoJSON {
	initialize(geojson, options) { this.options = { ...options }; this._features = []; if (geojson) this.addData(geojson); }
	addData(g) { this._features.push(...g.features); }
	on(type, fn) { ((this._ev ??= {})[type] ??= []).push(fn); return this; }
	fire(type, e) { (this._ev?.[type] || []).forEach(fn => fn(e)); return this; }
}
FakeGeoJSON.extend = function (props) {
	class Sub extends this { constructor(...a) { super(); this.initialize(...a); } }
	Object.assign(Sub.prototype, props);
	return Sub;
};
const L = { GeoJSON: FakeGeoJSON };

// ---- 配信データ -------------------------------------------------------------
const synthPbf = await new GeoPBF({ name: "synth", attribution: "test-attribution", minZoom: 5, maxZoom: 12 }).set({
	type: "FeatureCollection",
	features: [{ type: "Feature", geometry: { type: "Point", coordinates: [139.75, 35.68] }, properties: { n: 1 } }],
});
const synth = new Uint8Array(synthPbf.arrayBuffer);
const server = createServer((req, res) => {
	if (req.url !== "/synth.geopbf") { res.writeHead(404); return res.end(); }
	res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(synth);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- 登録と冪等性 -----------------------------------------------------------
extendLeaflet(L);
ok(typeof L.GeoPBF === "function" && typeof L.geoPBF === "function", "extendLeaflet が L.GeoPBF / L.geoPBF を登録");
const cls = L.GeoPBF; extendLeaflet(L);
ok(L.GeoPBF === cls, "二重登録は冪等");
ok(await Promise.resolve().then(() => extendLeaflet({})).then(() => false, e => /L\.GeoJSON\.extend/.test(e.message)),
	"L でないものは明示エラー");

// ---- load イベント・attribution 自動配線・メタ ------------------------------
const layer = L.geoPBF(`geopbf://${base}/synth.geopbf`);
const ev = await new Promise((res, rej) => layer.on("load", res).on("error", e => rej(e.error)));
ok(layer._features.length === 1 && ev.geojson.features.length === 1, "load イベントで addData 済み");
ok(layer.options.attribution === "test-attribution", "ヘッダ ATTRIBUTION を options.attribution へ自動配線");
const m = layer.getMeta();
ok(m.name === "synth" && m.minZoom === 5 && m.maxZoom === 12, `getMeta() (name=${m.name}, zoom=${m.minZoom}-${m.maxZoom})`);
ok((await layer.whenReady()) === layer, "whenReady() で読込完了を待てる");

// 明示指定の attribution は上書きしない
const layer2 = L.geoPBF(`geopbf://${base}/synth.geopbf`, { attribution: "mine" });
await layer2.whenReady();
ok(layer2.options.attribution === "mine", "明示 attribution が優先");

// ---- error イベント ---------------------------------------------------------
const bad = L.geoPBF(`geopbf://${base}/nothing.geopbf`);
const err = await new Promise(res => bad.on("error", e => res(e.error)));
ok(/404/.test(err.message), "404 は error イベント");

// ---- 再 export の疎通 -------------------------------------------------------
const direct = await loadGeopbf(`${base}/synth.geopbf`);
ok(direct.geojson.features.length === 1 && direct.attribution === "test-attribution", "loadGeopbf 再export（bare URL も可）");

server.close();
process.exit(fails ? 1 : 0);
