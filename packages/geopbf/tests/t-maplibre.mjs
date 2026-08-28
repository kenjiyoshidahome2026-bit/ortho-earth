// t-maplibre: MapLibre addProtocol("geopbf") ハンドラの検定（Node 20+）。
// node:http でリポジトリ内の実データ amedas.geopbf をメモリ配信（＋その場gzip版）し、
// ハンドラ経由の GeoJSON 返却・gzip透過・properties の JSON-safe 性・値型写像・メタデータを検証する。
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { GeoPBF } from "../src/pbf-base.js";
import { geopbfProtocol, makeGeopbfProtocol, loadGeopbf, sanitizeProperties } from "../src/maplibre.js";

// Node に ImageData が無い（pbf-base のエンコード経路が参照する）ためスタブ。IMAGE 型の写像検証も兼ねる。
globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- 配信データの用意 -------------------------------------------------------
const amedasPath = new URL("../../../apps/gishub-jp/public/jma/amedas.geopbf", import.meta.url);
const amedas = await readFile(amedasPath);
const amedasGz = new Uint8Array(await new Response(
	new Blob([amedas]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// 全値型（IMAGE は Node に ImageData が無いので除外）＋ドットキー1段ネストを含む合成データ
const synthGeojson = {
	type: "FeatureCollection",
	features: [{
		type: "Feature",
		geometry: { type: "Point", coordinates: [139.75, 35.68] },
		properties: {
			str: "text", int: 42, float: 1.5, bool: true,
			color: "rgb(10,20,30)",
			date: new Date(1700000000000),
			func: function hello(a) { return a + 1; },
			json: { deep: { list: [1, 2, 3] } },
			bbox: [1.5, 2.5, 3.5, 4.5],
			blob: new Blob(["binary"], { type: "text/plain" }),
			img: new ImageData(new Uint8ClampedArray(4), 1, 1),
			nest: { label: "n", when: new Date(1700000000000) },
		},
	}],
};
const synthPbf = await new GeoPBF({
	name: "synth", description: "synthetic test", license: "CC0",
	attribution: "test-attribution", minZoom: 5, maxZoom: 12,
}).set(synthGeojson);
const synth = new Uint8Array(synthPbf.arrayBuffer);

const server = createServer((req, res) => {
	const body = { "/amedas.geopbf": amedas, "/amedas.geopbf.gz": amedasGz, "/synth.geopbf": synth }[req.url];
	if (!body) { res.writeHead(404); return res.end(); }
	res.writeHead(200, { "content-type": "application/octet-stream" });
	res.end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- (a) ハンドラが FeatureCollection を返す --------------------------------
const ra = await geopbfProtocol({ url: `geopbf://${base}/amedas.geopbf`, type: "json" }, new AbortController());
ok(ra && ra.data && ra.data.type === "FeatureCollection", "(a) {data}=FeatureCollection");
ok(ra.data.features.length > 0, `(a) features.length=${ra.data.features.length} > 0`);

// ---- (b) gzip 透過 ----------------------------------------------------------
const rb = await geopbfProtocol({ url: `geopbf://${base}/amedas.geopbf.gz`, type: "json" }, new AbortController());
ok(rb.data.features.length === ra.data.features.length, "(b) gzip版でも同一 feature 数");

// ---- (c) 全 properties が JSON roundtrip で不変（サニタイズ漏れ検出） ------
const props = ra.data.features.map(f => f.properties);
ok(isDeepStrictEqual(JSON.parse(JSON.stringify(props)), props), "(c) 実データ properties が JSON-safe");

// ---- (d) 値型写像（合成データ） --------------------------------------------
const rd = await geopbfProtocol({ url: `geopbf://${base}/synth.geopbf`, type: "json" }, new AbortController());
const p = rd.data.features[0].properties;
ok(p.str === "text" && p.int === 42 && p.float === 1.5 && p.bool === true, "(d) primitive 素通し");
ok(p.color === "rgb(10,20,30)", `(d) COLOR→rgb文字列 (${p.color})`);
ok(p.date === new Date(1700000000000).toISOString(), `(d) DATE→ISO文字列 (${p.date})`);
ok(typeof p.func === "string" && p.func.includes("a + 1"), "(d) FUNC→関数ソース文字列（noeval）");
ok(isDeepStrictEqual(p.json, { deep: { list: [1, 2, 3] } }), "(d) JSON 素通し");
ok(isDeepStrictEqual(p.bbox, [1.5, 2.5, 3.5, 4.5]), "(d) BBOX→plain Array");
ok(!("blob" in p), "(d) BLOB キー削除");
ok(!("img" in p), "(d) IMAGE キー削除");
ok(p.nest && p.nest.label === "n" && p.nest.when === new Date(1700000000000).toISOString(), "(d) ドットキー1段ネスト内も写像");
ok(isDeepStrictEqual(JSON.parse(JSON.stringify(p)), p), "(d) 合成 properties が JSON-safe");

// sanitize:false なら素通し（Date のまま）
const rawProto = makeGeopbfProtocol({ sanitize: false });
const rr = await rawProto({ url: `geopbf://${base}/synth.geopbf`, type: "json" }, new AbortController());
ok(rr.data.features[0].properties.date instanceof Date, "(d) sanitize:false は素通し");

// sanitizeProperties 単体（ImageData 相当の drop は関数値の保険 drop で代用確認）
const sp = sanitizeProperties({ fn: () => 1, keep: "x" });
ok(!("fn" in sp) && sp.keep === "x", "(d) sanitizeProperties: 関数値は保険 drop");

// ---- (e) loadGeopbf のメタデータ -------------------------------------------
const le = await loadGeopbf(`geopbf://${base}/synth.geopbf`);
ok(le.geojson.features.length === 1, "(e) loadGeopbf が geojson を返す");
ok(le.name === "synth" && le.description === "synthetic test" && le.license === "CC0"
	&& le.attribution === "test-attribution" && le.minZoom === 5 && le.maxZoom === 12,
	`(e) メタ6項目 (name=${le.name}, attribution=${le.attribution}, zoom=${le.minZoom}-${le.maxZoom})`);

// onMeta コールバック経由でも同メタが来る
let gotMeta = null;
await makeGeopbfProtocol({ onMeta: (u, m) => gotMeta = m })({ url: `geopbf://${base}/synth.geopbf`, type: "json" }, new AbortController());
ok(gotMeta && gotMeta.attribution === "test-attribution", "(e) onMeta コールバック");

// ---- (f) URL の取り扱い -----------------------------------------------------
// MapLibre の new URL() 正規化で "geopbf://http://…" の ":" が落ちた形（http//…）の復元
const rf = await geopbfProtocol({ url: `geopbf://${base.replace("http://", "http//")}/amedas.geopbf`, type: "json" }, new AbortController());
ok(rf.data.features.length === ra.data.features.length, "(f) MapLibre正規化で潰れたURLの復元");

// 相対 URL は location の無い環境では reject
ok(await geopbfProtocol({ url: "geopbf://data/foo.geopbf", type: "json" }, new AbortController())
	.then(() => false, e => /relative URL/.test(e.message)), "(f) 相対URL＝Nodeでは reject");

server.close();
process.exit(fails ? 1 : 0);
