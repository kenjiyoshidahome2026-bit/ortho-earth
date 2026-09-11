#!/usr/bin/env node
// t-gdb: Esri File Geodatabase（.gdb）→ GeoPBF と、投影（convert/proj.js）の検定。資料は GDAL の testopenfilegdb.gdb.zip（MIT・tests/fixtures/gdb/NOTICE.md）。
globalThis.ImageData ??= class ImageData { };
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";
import { decodeZIP } from "../src/modules/decodeZIP.js";
import { openFileGDB, fromFileGDB, gdbSourceFromFiles, gdbSourceFromMap, parseTablx } from "../src/convert/filegdb.js";
import { crsFromWKT, tmInverse, tmForward, parseWKTTree } from "../src/convert/proj.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const zipPath = new URL("./fixtures/gdb/testopenfilegdb.gdb.zip", import.meta.url);
const entries = await decodeZIP(new Blob([readFileSync(zipPath)]));
const src = gdbSourceFromFiles(entries);

// ── 一覧 ──────────────────────────────────────────────────────────────────────
const gdb = await openFileGDB(src);
ok(gdb.tables.length === 37 && gdb.layers.length === 33 && !gdb.tables.some(t => /^GDB_/.test(t.name)), `openFileGDB: 表 ${gdb.tables.length}・フィーチャクラス ${gdb.layers.length}・系統表は除く`);
const pt = gdb.tables.find(t => t.name === "point");
ok(pt.geometryType === "point" && pt.rows === 5 && pt.crs.kind === "lonlat" && pt.crs.label === "GCS_WGS_1984" && pt.fields.map(f => f.name).join() === "SHAPE,OBJECTID,id,str,smallint,int,float,real,adate,guid,xml,binary,nullint,binary2", "point: 幾何型・行数・CRS・列");
ok(gdb.tables.find(t => t.name === "big_layer").geometryType === null && gdb.tables.find(t => t.name === "polygon25D").hasZ && gdb.tables.find(t => t.name === "multipatch").geometryType === "multipatch", "big_layer は表・25D は Z・multipatch");

// ── 属性と幾何 ────────────────────────────────────────────────────────────────
{
	const { pbf, stats: s } = await fromFileGDB(src, { layer: "point" });
	const f = pbf.geojson.features, p = f[0].properties;
	ok(s.features === 5 && f[0].geometry.coordinates.join() === "1,2" && s.vertices === 5, "point: 5 点 (1 2)");
	ok(p.OBJECTID === 1 && p.id === 1 && p.str === "foo_é" && p.smallint === -13 && p.int === 123 && p.float === 1.5 && p.real === 4.56 && p.xml === "<foo></foo>", "属性: objectid/int16/int32/float32/float64/string(UTF-8)/xml");
	ok(p.adate instanceof Date && p.adate.toISOString() === "2013-12-26T12:34:56.000Z", "datetime: OLE 日数 → Date");
	ok(p.guid === "{12345678-9ABC-DEF0-1234-567890ABCDEF}" && !("nullint" in p) && !("binary" in p) && s.skipped.map(k => k.name).join() === "binary,binary2", "GUID の並び替え・NULL は無し・binary 列は読まない");
	ok(f[4].properties.OBJECTID === 5, "OBJECTID は行番号");
}
{
	const { pbf } = await fromFileGDB(src, { layer: "polygon" });
	ok(JSON.stringify(pbf.geojson.features[0].geometry) === JSON.stringify({ type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }), "polygon: 外環（時計回り→反時計回りへ）");
	const m = (await fromFileGDB(src, { layer: "multipolygon" })).pbf.geojson.features[0].geometry;
	ok(m.type === "MultiPolygon" && m.coordinates.length === 2 && m.coordinates[0].length === 2 && m.coordinates[0][1][0].join() === "0.25,0.25" && m.coordinates[1][0][2].join() === "3,1", "multipolygon: 穴は外環へ入り、離れた環は別ポリゴン");
	const ml = (await fromFileGDB(src, { layer: "multilinestring_multipart" })).pbf.geojson.features[0].geometry;
	ok(ml.type === "MultiLineString" && JSON.stringify(ml.coordinates) === "[[[1,2],[3,4]],[[5,6],[7,8]]]", "multilinestring: 複数パート");
	const l = (await fromFileGDB(src, { layer: "linestring" })).pbf.geojson.features[0].geometry;
	ok(l.type === "LineString" && l.coordinates.length >= 2, "linestring: 単一パートは LineString");
	const mp = (await fromFileGDB(src, { layer: "multipoint" })).pbf.geojson.features[0].geometry;
	ok(mp.type === "MultiPoint" && mp.coordinates.length >= 2, "multipoint");
}
{
	const zm = await fromFileGDB(src, { layer: "pointzm" });
	ok(zm.stats.features === 1 && zm.pbf.geojson.features[0].geometry.coordinates.join() === "1,2" && zm.stats.z && zm.stats.m, "pointzm: Z/M を落として 2D");
	const pzm = await fromFileGDB(src, { layer: "multipolygonzm" });
	ok(pzm.stats.features === 1 && pzm.pbf.geojson.features[0].geometry.type === "Polygon" && pzm.pbf.geojson.features[0].geometry.coordinates[0].length === 5, "polygonZM（古典型コード 15）: Z/M 区間を無視して環を読む");
	const z25 = await fromFileGDB(src, { layer: "polygon25D" });
	ok(z25.stats.features === 5 && z25.pbf.geojson.features[0].geometry.type === "Polygon", "polygon25D（Z）");
	const mpatch = await fromFileGDB(src, { layer: "multipatch" });
	ok(mpatch.stats.features === 0 && mpatch.stats.droppedGeometries === 5 && mpatch.stats.multipatch === 5, "multipatch は落として数える");
	const empty = await fromFileGDB(src, { layer: "empty_polygon" });
	ok(empty.stats.features === 0 && empty.stats.droppedGeometries === 5, "空の面（この資料では NULL として格納）は落として数える");
	const emptyMp = await fromFileGDB(src, { layer: "empty_multipoint" });
	ok(emptyMp.stats.features === 0 && emptyMp.stats.droppedGeometries === 5, "空の多点も落として数える");
	const nul = await fromFileGDB(src, { layer: "null_polygon" });
	ok(nul.stats.features === 0 && nul.stats.droppedGeometries === 5, "NULL 幾何は落として数える");
	const hole = await fromFileGDB(src, { layer: "hole" });
	ok(hole.stats.crsUnknown && hole.stats.rows === 12 && hole.stats.features === 0, "不明 SRS（GUID）＋空の層＝素通し・削除行/NULL は落ちる");
	const sev = await fromFileGDB(src, { layer: "several_polygons" });
	ok(sev.stats.features === 9 && sev.pbf.geojson.features.every(f => /Polygon/.test(f.geometry.type)), "several_polygons: 不明 SRS でも範囲が経緯度なら読む");
	const d = await fromFileGDB(src);
	ok(d.stats.layer === "point" && d.stats.layers.length === 33 && d.stats.tables.includes("big_layer"), "layer 省略＝最初のフィーチャクラス・表の一覧");
	let threw = ""; try { await fromFileGDB(src, { layer: "big_layer" }); } catch (e) { threw = e.message; } ok(/幾何の無い表/.test(threw), "幾何の無い表は拒否");
	threw = ""; try { await fromFileGDB(src, { layer: "nope" }); } catch (e) { threw = e.message; } ok(/層 "nope" が無い/.test(threw), "無い層は拒否");
	threw = ""; try { await openFileGDB(gdbSourceFromMap({ "x.txt": new Uint8Array(4) })); } catch (e) { threw = e.message; } ok(/File Geodatabase でない/.test(threw), "カタログが無ければ拒否");
	const n = await fromFileGDB(src, { layer: "Point", name: "p", precision: 7, exclude: ["xml", "guid"] });
	ok(n.stats.layer === "point" && n.pbf.name() === "p" && n.pbf.precision() === 7 && !n.stats.columns.includes("xml"), "層名は大小無視・name/precision/exclude");
	// Map ソース（Node 用）でも同じ
	const map = new Map(); for (const e of entries) map.set(e.name, new Uint8Array(await e.arrayBuffer()));
	const viaMap = await fromFileGDB(gdbSourceFromMap(map), { layer: "polygon" });
	ok(viaMap.stats.features === 5, "gdbSourceFromMap（バイト列の辞書）");
}
// ── .gdbtablx のビットマップ（欠落ブロック）────────────────────────────────────
{
	// 3 ブロック中 0 と 2 だけ存在・幅 4 のオフセット
	const size = 4, nBlocks = 2, nRows = 3 * 1024;
	const u8 = new Uint8Array(16 + nBlocks * 1024 * size + 16 + 4); const dv = new DataView(u8.buffer);
	dv.setInt32(0, 3, true); dv.setInt32(4, nBlocks, true); dv.setInt32(8, nRows, true); dv.setInt32(12, size, true);
	dv.setUint32(16 + 0 * size, 100, true); dv.setUint32(16 + 1024 * size + 5 * size, 200, true);   // ブロック0の行1・ブロック2の行6（配列上は2番目のブロック）
	const tr = 16 + nBlocks * 1024 * size; dv.setInt32(tr, 1, true); u8[tr + 16] = 0b101;
	const tx = parseTablx(u8);
	ok(tx.offsetOf(1) === 100 && tx.offsetOf(1025) === 0 && tx.offsetOf(2048 + 6) === 200 && tx.offsetOf(2) === 0, "parseTablx: 1024 ブロックのビットマップで欠落ブロックを飛ばす");
}
// ── 投影 ──────────────────────────────────────────────────────────────────────
{
	const IX = { a: 6378137, f: 1 / 298.257222101, k0: 0.9999, lat0: 36, lon0: 139 + 50 / 60, fe: 0, fn: 0 };
	const fwd = tmForward(IX), inv = tmInverse(IX);
	// 子午線弧長を数値積分（級数と独立）: 中央子午線上の点は x=0・y=k0·(S(φ)−S(φ0))
	const e2 = 2 * IX.f - IX.f * IX.f, M = phi => IX.a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi) ** 2, 1.5);
	const arc = (p0, p1, n = 2000) => { const h = (p1 - p0) / n; let s = M(p0) + M(p1); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * M(p0 + i * h); return s * h / 3; };
	const [x, y] = fwd([IX.lon0, 36.1]);
	ok(near(x, 0, 1e-6) && near(y, IX.k0 * arc(36 / 180 * Math.PI, 36.1 / 180 * Math.PI), 1e-3), `TM 順変換: 中央子午線上 y=${y.toFixed(4)} が数値積分の弧長と 1 mm 以内`);
	for (const [lon, lat] of [[140 + 5 / 60, 36.1], [138.5, 34.2], [141.9, 37.9]]) { const [X, Y] = fwd([lon, lat]); const [lo, la] = inv(X, Y); ok(near(lo, lon, 1e-10) && near(la, lat, 1e-10), `TM 往復 (${lon.toFixed(4)}, ${lat}) → (${X.toFixed(3)}, ${Y.toFixed(3)}) → 元へ 1e-10°`); }
	const [X2, Y2] = fwd([140 + 5 / 60, 36.1]);
	ok(near(Y2, 11123.8185, 0.01) && near(X2, 22510.2007, 0.01), "平面直角座標系 IX: (36°06′, 140°05′) → x=11123.8185 y=22510.2007（順変換の自己整合値）");
	const esri = crsFromWKT(`PROJCS["JGD_2011_Japan_Zone_9",GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",139.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",36.0],UNIT["Meter",1.0]]`);
	const back = esri.toLonLat([X2, Y2]);
	ok(esri.kind === "projected" && esri.label === "JGD_2011_Japan_Zone_9" && near(back[0], 140 + 5 / 60, 1e-9) && near(back[1], 36.1, 1e-9), "Esri WKT の平面直角座標系 IX を認識して逆変換");
	const utm = crsFromWKT(`PROJCS["WGS 84 / UTM zone 54N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",141],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32654"]]`);
	const u0 = utm.toLonLat([500000, 0]), ufwd = tmForward({ a: 6378137, f: 1 / 298.257223563, k0: 0.9996, lat0: 0, lon0: 141, fe: 500000, fn: 0 })([139.767125, 35.681236]), u1 = utm.toLonLat(ufwd);
	ok(utm.kind === "projected" && utm.label === "EPSG:32654" && near(u0[0], 141, 1e-12) && near(u0[1], 0, 1e-12) && near(u1[0], 139.767125, 1e-9) && near(u1[1], 35.681236, 1e-9), "OGC WKT の UTM 54N（AUTHORITY 付き）を認識・往復");
	const ft = crsFromWKT(`PROJCS["X",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1640416.666666667],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",-75],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",40],UNIT["Foot_US",0.3048006096012192]]`);
	ok(ft.kind === "projected" && near(ft.toLonLat([1640416.666666667, 0])[0], -75, 1e-9) && near(ft.toLonLat([1640416.666666667, 0])[1], 40, 1e-9), "単位がフィートでも原点が戻る");
	ok(crsFromWKT(`GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`).kind === "lonlat" && crsFromWKT(`GEOGCS["GCS_JGD_2000",DATUM["D_JGD_2000",SPHEROID["GRS_1980",6378137,298.257222101]]]`).kind === "lonlat", "GEOGCS WGS84 / JGD2000 は経緯度");
	ok(crsFromWKT(`GEOGCS["GCS_Tokyo",DATUM["D_Tokyo",SPHEROID["Bessel_1841",6377397.155,299.1528128]]]`).kind === "other" && crsFromWKT(`PROJCS["Tokyo_Japan_Zone_9",GEOGCS["GCS_Tokyo",DATUM["D_Tokyo",SPHEROID["Bessel_1841",6377397.155,299.1528128]]],PROJECTION["Transverse_Mercator"],PARAMETER["Central_Meridian",139.8333]]`).kind === "other", "旧測地系（Tokyo）は経緯度でも平面直角でも拒否");
	const wm = crsFromWKT(`PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`);
	ok(wm.kind === "projected" && near(wm.toLonLat([15557880, 4257870])[0], 139.7593, 1e-3) && near(wm.toLonLat([0, 0])[1], 0, 1e-12), "Web メルカトル（Esri 名）");
	ok(crsFromWKT("").kind === "other" && crsFromWKT("{B286C06B-0879-11D2-AACA-00C04FA33C20}").kind === "other" && crsFromWKT(`PROJCS["LCC",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]],PROJECTION["Lambert_Conformal_Conic"]]`).kind === "other", "空・GUID・未対応投影は other");
	const tree = parseWKTTree(`A["x",B[1,2.5,"y"],C]`);
	ok(tree.name === "A" && tree.args[0] === "x" && tree.args[1].name === "B" && tree.args[1].args[1] === 2.5 && tree.args[2].name === "C", "parseWKTTree");
}
// ── CLI ───────────────────────────────────────────────────────────────────────
{
	const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
	const dir = mkdtempSync(join(tmpdir(), "geopbf-gdb-"));
	const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	const list = run("gdb2pbf", zipPath.pathname);
	ok(/フィーチャクラス 33・表 4/.test(list) && /multipolygon  polygon  GCS_WGS_1984  5 行/.test(list) && /big_layer  \(table\)/.test(list), "CLI gdb2pbf <zip> ＝一覧");
	const out = join(dir, "mp.geopbf");
	const log = run("gdb2pbf", zipPath.pathname, out, "--layer", "multipolygon");
	ok(/features 5/.test(log) && /CRS GCS_WGS_1984/.test(log), "CLI gdb2pbf zip → GeoPBF");
	ok((await new GeoPBF().set(new Uint8Array(gunzipSync(readFileSync(out))))).geojson.features[0].geometry.type === "MultiPolygon", "CLI 出力を読み戻す");
	// ディレクトリ形（zip を展開して .gdb ディレクトリに）
	const gdbDir = join(dir, "x.gdb"); mkdirSync(gdbDir);
	for (const e of entries) writeFileSync(join(gdbDir, e.name.split("/").pop()), Buffer.from(await e.arrayBuffer()));
	const log2 = run("gdb2pbf", gdbDir, join(dir, "pt.geopbf"), "--layer", "point", "--no-gzip");
	ok(/features 5/.test(log2) && (await new GeoPBF().set(new Uint8Array(readFileSync(join(dir, "pt.geopbf"))))).geojson.features.length === 5, "CLI gdb2pbf .gdb ディレクトリ（range 読み）");
}

console.log(fails ? `\n✗ ${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
