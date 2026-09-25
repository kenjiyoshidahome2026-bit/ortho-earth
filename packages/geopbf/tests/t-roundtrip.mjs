// t-roundtrip: gml / kml / fgb の書き出し→読み戻しで、形（Multi 系・GeometryCollection）と属性（日本語のキー・入れ子・日付）が残ること（B9・2026-09-25）。
// encoder/decoder の worker を Node で直に回す（onmessage/postMessage を差し替える）。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf.js";
import { fileURLToPath } from "node:url";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const S = fileURLToPath(new URL("../src", import.meta.url));
let seq = 0;
async function runWorker(path, data) {
	globalThis.onmessage = null;
	const got = new Promise(r => { globalThis.postMessage = m => r(m); });
	const log = console.log; console.log = () => {};
	try { await import(path + "?v=" + (++seq)); globalThis.onmessage({ data }); return await Promise.race([got, new Promise(r => setTimeout(() => r("TIMEOUT"), 8000))]); }
	finally { console.log = log; }
}
const P = { nest: { x: 1, y: "a" }, "名前": "東京", "住所": "千代田区", d: new Date("2024-03-15T00:00:00Z") };
const sq = (x, y) => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]];
const geoms = [
	{ type: "MultiPoint", coordinates: [[1, 1], [2, 2]] },
	{ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
	{ type: "MultiPolygon", coordinates: [[sq(0, 0)], [sq(5, 5)]] },
	{ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [9, 9] }, { type: "LineString", coordinates: [[8, 8], [9, 8]] }] },
	{ type: "Point", coordinates: [9, 9] },
];
const src = await new GeoPBF().set({ type: "FeatureCollection", features: geoms.map((g, i) => ({ type: "Feature", properties: { ...P, n: `f${i}` }, geometry: g })) });
const want = src.geojson.features;
const sameGeom = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const [enc, dec, opts, file] of [["gml", "gml", {}, "t.gml"], ["kmz", "kmz", { kmz: false }, "t.kml"], ["fgb", "fgb", {}, "t.fgb"]]) {
	const f = await runWorker(`${S}/encoder/${enc}.js`, { buf: src.arrayBuffer.slice(0), name: "t", opts });
	ok(f && f !== "TIMEOUT", `${enc}：書き出せた`);
	const back = await runWorker(`${S}/decoder/${dec}.js`, { file: new File([await f.arrayBuffer()], file), name: "t", precision: 6, encoding: "utf8" });
	ok(back && back !== "TIMEOUT" && back.data, `${enc}：読み戻せた`);
	const got = (await new GeoPBF().set(back.data)).geojson.features;
	ok(got.length === want.length, `${enc}：地物の数（${got.length}/${want.length}）`);
	const byN = new Map(got.map(g => [g.properties.n, g]));
	for (const w of want) {
		const g = byN.get(w.properties.n);
		ok(g && sameGeom(g.geometry, w.geometry), `${enc}：${w.geometry.type} の形が往復（${g ? g.geometry.type : "なし"}）`);
	}
	const p = byN.get("f0")?.properties ?? {};
	const nest = typeof p.nest === "string" ? JSON.parse(p.nest) : p.nest;
	ok(p["名前"] === "東京" && p["住所"] === "千代田区", `${enc}：日本語のキーが別々に残る（名前=${p["名前"]} 住所=${p["住所"]}）`);
	ok(nest?.x === 1 && nest?.y === "a", `${enc}：入れ子の属性が残る（${JSON.stringify(p.nest)}）`);
	ok(String(p.d instanceof Date ? p.d.toISOString() : p.d) === "2024-03-15T00:00:00.000Z", `${enc}：日付は ISO 8601（${p.d}）`);
}
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
