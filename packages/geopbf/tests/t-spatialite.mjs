#!/usr/bin/env node
// t-spatialite: SpatiaLite（自前 SQLite リーダ＋幾何 BLOB 復号）→ GeoPBF。固定資料は tests/fixtures/spatialite/make.py（mod_spatialite）。
// 古典 BLOB・圧縮（XYZ/XYZM・float 差分）・TinyPoint・Multi/Collection（ENTITY 印）・NULL・3857/平面直角の逆変換・型付き属性・BLOB 列の除外・層一覧・エラー文言。
globalThis.ImageData ??= class ImageData { };
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { GeoPBF } from "../src/pbf.js";
import { readSpatiaLite, fromSpatiaLite, parseSpatiaLiteBlob } from "../src/convert/spatialite.js";
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
const fx = new Uint8Array(readFileSync(new URL("./fixtures/spatialite/mixed.sqlite", import.meta.url)));
const gpkg = new Uint8Array(readFileSync(new URL("./fixtures/gpkg/mixed.gpkg", import.meta.url)));

// ── 一覧 ──
const g = readSpatiaLite(fx);
ok(g.layers.map(l => l.table).sort().join() === "jpr,lines,merc,multi,places,polys,tiny,tinyz", `層 8: ${g.layers.map(l => l.table).join(",")}`);
const L = n => g.layers.find(l => l.table === n);
ok(L("places").geometryType === "POINT" && L("lines").z && !L("lines").m && L("polys").z && L("polys").m && L("multi").geometryType === "GEOMETRY", "geometry_columns v4 の型/次元（POINT・XYZ・XYZM・GEOMETRY）");
ok(L("places").crs.kind === "lonlat" && L("merc").crs.kind === "mercator" && L("jpr").crs.label.includes("6677") && L("jpr").crs.kind !== "other", `CRS: 4326 lonlat・3857 mercator・6677 ${L("jpr").crs.label}`);
ok(L("places").columns.map(c => c.name).join() === "id,name,pop,ratio,flag,d,dt,note,photo,nil,geom" && L("places").count === 300, "列と行数");

// ── places（点・型付き属性）──
{
	const { pbf, stats } = await fromSpatiaLite(fx, { layer: "places" });
	const f = pbf.geojson.features, p0 = f[0].properties, p3 = f[3].properties;
	ok(stats.features === 300 && pbf.length === 300, `places: 300 地物`);
	ok(nearPt(f[0].geometry.coordinates, [139, 35]) && nearPt(f[299].geometry.coordinates, [139.299, 35.1495]), "座標（先頭と末尾）");
	ok(p0.name === "駅0" && p0.pop === 0 && p3.pop === 3000 && near(p3.ratio, 3 / 7) && p3.flag === true && p0.flag === false, "属性: text/int/real/boolean（0 は落とさない）");
	ok(p3.d instanceof Date && p3.d.toISOString().startsWith("2026-09-16") && p3.dt instanceof Date, "DATE/DATETIME → Date");
	ok(f[299].properties.note.length === 5000 && f[6].properties.note.length === 6, "overflow ページを継いだ長文（1 行だけ 5000 字）");
	ok(!("photo" in p3) && stats.skipped.map(k => k.name).join() === "photo" && !("nil" in p3) && pbf.keys.includes("nil") && !pbf.keys.includes("geom"), "BLOB 列は読まない・NULL 列は属性に無いが keys には載る・幾何列は keys に無い");
}
// ── lines（XYZ・圧縮/非圧縮）──
{
	const { pbf, stats } = await fromSpatiaLite(fx, { layer: "lines", precision: 7 });
	const f = pbf.geojson.features;
	ok(stats.features === 3 && stats.z && f[0].geometry.type === "LineString", "lines: 3 本・Z");
	ok(JSON.stringify(f[0].geometry.coordinates) === JSON.stringify([[139, 35], [139.5, 35.5], [140, 36]]), "圧縮 XYZ（float 差分 0.5 は厳密）");
	const plain = f[1].geometry.coordinates, comp = f[2].geometry.coordinates;
	ok(plain.length === 4 && comp.length === 4 && plain.every((p, i) => nearPt(p, comp[i], 2e-6)) && nearPt(plain[1], [139.223456, 35.754321], 1e-7), "非圧縮と圧縮（float 差分）が 2e-6 以内で一致・非圧縮は厳密");
}
// ── polys（XYZM・穴）──
{
	const { pbf, stats } = await fromSpatiaLite(fx, { layer: "polys" });
	const f = pbf.geojson.features;
	ok(stats.features === 2 && stats.z && stats.m && f[0].geometry.type === "Polygon" && f[0].geometry.coordinates.length === 2, "polys: XYZM・穴付き");
	ok(nearPt(f[0].geometry.coordinates[1][1], [139.4, 35.2]) && f[0].geometry.coordinates[0].length === 5, "穴の頂点と外環の閉合");
	ok(f[1].geometry.coordinates[0].length === 5 && nearPt(f[1].geometry.coordinates[0][2], [1, 1]), "圧縮 XYZM の環");
}
// ── multi（GEOMETRY 列に混在）──
{
	const { pbf, stats } = await fromSpatiaLite(fx, { layer: "multi" });
	const f = pbf.geojson.features, ty = f.map(x => x.geometry.type).join();
	ok(stats.features === 4 && stats.droppedGeometries === 1 && ty === "MultiPoint,MultiLineString,MultiPolygon,GeometryCollection", `multi: ${ty}・NULL 1 行を落とした`);
	ok(JSON.stringify(f[0].geometry.coordinates) === "[[1,2],[3,4]]" && f[1].geometry.coordinates.length === 2 && nearPt(f[1].geometry.coordinates[0][1], [1.5, 2.5]) && f[2].geometry.coordinates[1].length === 2 && f[3].geometry.geometries.length === 2, "要素（ENTITY 印）・圧縮 MultiLineString・穴付き MultiPolygon・Collection");
}
// ── 投影の逆変換 ──
{
	const m = await fromSpatiaLite(fx, { layer: "merc" }), j = await fromSpatiaLite(fx, { layer: "jpr" });
	ok(nearPt(m.pbf.geojson.features[0].geometry.coordinates, [139.7, 35.7], 1e-6) && m.stats.reprojected, `3857 → 経緯度 ${m.pbf.geojson.features[0].geometry.coordinates}`);
	ok(nearPt(j.pbf.geojson.features[0].geometry.coordinates, [139.7, 35.7], 2e-6) && j.stats.reprojected, `6677（平面直角 IX）→ 経緯度 ${j.pbf.geojson.features[0].geometry.coordinates}`);
}
// ── TinyPoint ──
{
	const t = await fromSpatiaLite(fx, { layer: "tiny" }), tz = await fromSpatiaLite(fx, { layer: "tinyz" });
	ok(nearPt(t.pbf.geojson.features[0].geometry.coordinates, [139.5, 35.5]) && nearPt(tz.pbf.geojson.features[0].geometry.coordinates, [139.5, 35.5]), "TinyPoint XY / XYZ");
}
// ── BLOB 単体 ──
{
	const ctx = { vertices: 0 };
	const hex = "0001e6100000000000000000f03f0000000000000040000000000000084000000000000010407c07000000020000006901000000000000000000f03f0000000000000040690200000002000000000000000000f03f000000000000004000000000000008400000000000001040fe";
	const gc = parseSpatiaLiteBlob(Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16))), ctx);
	ok(gc.type === "GeometryCollection" && gc.geometries[1].coordinates[1].join() === "3,4" && ctx.vertices === 3, "parseSpatiaLiteBlob: 実物の GEOMETRYCOLLECTION");
}
// ── 既定層・エラー ──
{
	const d = await fromSpatiaLite(fx);
	ok(d.stats.layer === "places" && d.stats.layers.length === 8, "layer 省略＝最初の層");
	let threw = ""; try { await fromSpatiaLite(fx, { layer: "nope" }); } catch (e) { threw = e.message; } ok(/層 "nope" が無い（層: /.test(threw), "無い層は候補付きで拒否");
	threw = ""; try { readSpatiaLite(gpkg); } catch (e) { threw = e.message; } ok(/SpatiaLite でない/.test(threw), "GeoPackage / 素の SQLite は SpatiaLite でないと言う");
	const n = await fromSpatiaLite(fx, { layer: "Places", name: "x", precision: 7, exclude: ["note", "photo"] });
	ok(n.pbf.name() === "x" && n.pbf.precision() === 7 && !n.pbf.keys.includes("note"), "層名は大文字小文字を無視・name/precision/exclude");
}
// ── worker 脚本 ──
{
	globalThis.onmessage = null;
	const got = new Promise(resolve => { globalThis.postMessage = (m) => resolve(m); });
	await import("../src/decoder/spatialite.js?v=" + Date.now());
	globalThis.onmessage({ data: { file: new File([fx], "mixed.sqlite"), name: "mixed", precision: 6, layer: "multi" } });
	const r = await Promise.race([got, new Promise(res => setTimeout(() => res("TIMEOUT"), 8000))]);
	ok(r && r !== "TIMEOUT" && r.type === "spatialitedec" && r.data instanceof ArrayBuffer && /層 multi/.test(r.warning) && /幾何なし 1/.test(r.warning), `decoder worker: ${r?.warning}`);
	if (r?.data) { const p = await new GeoPBF().set(r.data); ok(p.length === 4, `worker 経由 4 地物（${p.length}）`); }
}
// ── CLI ──
{
	const out = execFileSync("node", [new URL("../bin/geopbf.mjs", import.meta.url).pathname, "spatialite2pbf", new URL("./fixtures/spatialite/mixed.sqlite", import.meta.url).pathname], { encoding: "utf8" });
	ok(/地物層 8/.test(out) && /places/.test(out) && /jpr/.test(out), "CLI spatialite2pbf の一覧");
}
console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
