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
import { bakeMeshGrid } from "../src/convert/datum.js";

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
	const binPath = join(dir, "tky.bin"); writeFileSync(binPath, bakeMeshGrid(readFileSync(new URL("./fixtures/datum/tky2jgd-tokyo.par", import.meta.url), "utf8")).bytes);
	const log2 = run("gdb2pbf", gdbDir, join(dir, "pt.geopbf"), "--layer", "point", "--no-gzip", "--tky2jgd", binPath);
	ok(/features 5/.test(log2) && (await new GeoPBF().set(new Uint8Array(readFileSync(join(dir, "pt.geopbf"))))).geojson.features.length === 5, "CLI gdb2pbf .gdb ディレクトリ（range 読み）");
}

console.log(fails ? `\n✗ ${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
