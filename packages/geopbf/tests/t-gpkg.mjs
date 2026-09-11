#!/usr/bin/env node
// t-gpkg: GeoPackage → GeoPBF（自前 SQLite リーダ・決定的・外部ツール不要）。
//   固定資料は tests/fixtures/gpkg/make.py（python3 標準 sqlite3）で生成したもの。
//   ・SQLite リーダ: 多段 B-tree（page 1024・1200 行）・overflow ページ・rowid 別名・全 serial type・UTF-16le・CREATE TABLE の列解釈
//   ・GPKG: 層一覧・全ジオメトリ種・BE envelope/BE WKB・Z 落とし・空/NULL 落とし・EPSG:3857→経緯度・型変換（bool/date/巨大整数/BLOB 列除外）
//   ・CLI（gpkg2pbf 一覧と変換）
globalThis.ImageData ??= class ImageData { };
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";
import { openSqlite, parseCreate, varint } from "../src/convert/sqlite.js";
import { fromGeoPackage, readGeoPackage, classifyCrs, openGpkgTiles, mimeOf } from "../src/convert/gpkg.js";
import { existsSync } from "node:fs";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fx = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/gpkg/${n}`, import.meta.url)));
const mixed = fx("mixed.gpkg"), utf16 = fx("utf16.gpkg");

// ── SQLite リーダ ─────────────────────────────────────────────────────────────
{
	const db = openSqlite(mixed);
	ok(db.pageSize === 1024 && db.encoding === "utf-8", `header: page ${db.pageSize} ${db.encoding}`);
	const t = db.tables.get("places");
	ok(t.columns.map(c => c.name).join() === "fid,geom,name,pop,ratio,flag,d,dt,big,note,photo,nothing" && t.rowidAlias === 0 && t.columns[9].type === "TEXT(8000)", "CREATE TABLE の列名・型・rowid 別名");
	ok(db.count("places") === 1200, "count: 葉のセル数 1200（root は内部ページ＝多段）");
	const rows = [...db.rows("places")];
	ok(rows.length === 1200 && rows[0].fid === 1 && rows[1199].fid === 1200, "rows: 1200 行を rowid 順に");
	const r0 = rows[0];
	ok(r0.name === "東京駅" && r0.pop === 1000000 && r0.ratio === 0.5 && r0.flag === 1 && r0.d === "2026-09-12" && r0.big === 2 ** 40 + 7, "serial types: text/int/real/int 0-1/int48");
	ok(r0.note.length === 5000 && /^n+$/.test(r0.note), "overflow ページを継いだ 5000 文字の TEXT");
	ok(r0.photo instanceof Uint8Array && r0.photo.length === 264 && r0.photo[1] === 0x50 && r0.nothing === null, "BLOB と NULL");
	ok(rows[1].pop === -42 && rows[1].ratio === -1.25 && rows[1].big === -(2 ** 40) && rows[1].note === "", "負の整数・負の real・空文字");
	ok(rows[3].pop === 127 && rows[3].big === 2 ** 31 && rows[4].pop === 32767 && rows[4].ratio === 1e300 && rows[4].big === 2 ** 47, "int8/16/32 境目と 1e300");
	ok(rows[4].name === `quote "and" 'apos'`, "引用符を含む文字列");
	ok(rows[1199].big === 1199 * 2 ** 33, "48 bit 整数の最後の行");
	ok([...db.rows("gpkg_contents")].map(r => r.table_name).join() === "places,shapes,merc,attrs_only", "gpkg_contents の行");
	ok(db.views.has("v_places") && db.tables.has("rtree_places_geom_node"), "view と rtree の影表を認識（読み飛ばせる）");
	let threw = ""; try { db.rows("rtree_places_geom").next(); } catch (e) { threw = e.message; } ok(/仮想表/.test(threw), "仮想表は明示して拒否");
	threw = ""; try { db.table("nope"); } catch (e) { threw = e.message; } ok(/表 "nope" が無い/.test(threw), "無い表は候補付きで拒否");
	threw = ""; try { openSqlite(new Uint8Array(200)); } catch (e) { threw = e.message; } ok(/SQLite3 ファイルでない/.test(threw), "署名違いは拒否");
}
{
	const db = openSqlite(utf16);
	const rows = [...db.rows("pts")];
	ok(db.encoding === "utf-16le" && rows.map(r => `${r.id}:${r["名前"]}`).join() === "7:東京,9:大阪 🗼", "UTF-16le の文字列と明示 id の rowid 別名");
}
{
	const c = parseCreate(`CREATE TABLE "t" ("fid" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, [geom] POINT, \`n\` DECIMAL(10,2) DEFAULT 1.5, s TEXT COLLATE NOCASE, CONSTRAINT pk PRIMARY KEY (fid), UNIQUE("s")) WITHOUT ROWID`);
	ok(c.columns.map(k => `${k.name}:${k.type}`).join() === "fid:INTEGER,geom:POINT,n:DECIMAL(10,2),s:TEXT" && c.rowidAlias === 0 && c.withoutRowid, "parseCreate: 引用の三種・括弧付き型・表制約の読み飛ばし・WITHOUT ROWID");
	const c2 = parseCreate(`CREATE TABLE x (id INT PRIMARY KEY, v)`);
	ok(c2.rowidAlias === -1 && c2.columns[1].type === "", "parseCreate: INT PRIMARY KEY は別名でない・型なし列");
	const o = { v: 0, p: 0 };
	varint(new Uint8Array([0x7f]), 0, o); ok(o.v === 127 && o.p === 1, "varint 1 byte");
	varint(new Uint8Array([0x81, 0x00]), 0, o); ok(o.v === 128 && o.p === 2, "varint 2 bytes");
	varint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, o); ok(o.v === -1 && o.p === 9, "varint 9 bytes = -1（二の補数）");
	varint(new Uint8Array([0xc0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]), 0, o); ok(o.v === -(2n ** 63n) && o.p === 9, "varint 9 bytes の bit63 は BigInt（-2^63）");
	varint(new Uint8Array([0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]), 0, o); ok(o.v === 2 ** 49 && o.p === 8, "varint 8 bytes = 2^49");
}

// ── GeoPackage ────────────────────────────────────────────────────────────────
{
	const g = readGeoPackage(mixed);
	ok(g.layers.map(l => `${l.table}:${l.geometryType}:${l.crs.label}:${l.count}`).join() === "places:POINT:EPSG:4326:1200,shapes:GEOMETRY:EPSG:4326:10,merc:POINT:EPSG:3857:2", "層一覧（表・幾何型・CRS・件数）");
	ok(g.others.length === 1 && g.others[0].dataType === "attributes" && g.layers[0].identifier === "Places" && g.layers[0].description === "1200 points", "非地物表と identifier/description");
	ok(classifyCrs({ id: 0, org: "NONE", code: 0 }).kind === "lonlat" && classifyCrs({ id: 6668, org: "EPSG", code: 6668, definition: 'GEOGCS["JGD2011"]' }).kind === "other" && classifyCrs({ id: 900913, org: "EPSG", code: 900913 }).kind === "mercator", "classifyCrs");
}
const places = await fromGeoPackage(mixed, { layer: "places" });
{
	const s = places.stats, gj = places.pbf.geojson;
	ok(s.features === 1200 && s.vertices === 1200 && gj.features.length === 1200, "places: 1200 点");
	ok(s.columns.join() === "fid,name,pop,ratio,flag,d,dt,big,note,nothing" && s.skipped.map(k => k.name).join() === "photo", "列: BLOB 列だけ除外");
	const p0 = gj.features[0].properties;
	ok(gj.features[0].geometry.coordinates.join() === "139.767125,35.681236" && p0.fid === 1 && p0.name === "東京駅" && p0.pop === 1000000, "先頭の点と属性");
	ok(p0.flag === true && gj.features[1].properties.flag === false && gj.features[2].properties.flag === undefined, "BOOLEAN → bool（NULL は無し）");
	ok(p0.d instanceof Date && p0.d.toISOString().startsWith("2026-09-12") && p0.dt instanceof Date && p0.dt.toISOString() === "2026-09-12T01:02:03.000Z", "DATE/DATETIME → Date");
	ok(p0.big === 2 ** 40 + 7 && s.bigints === 1 && gj.features[4].properties.ratio === "1e+300", "48 bit 整数はそのまま・整数値の巨大 REAL は文字列");
	ok(p0.note.length === 5000 && gj.features[1].properties.note === "", "overflow の長文と空文字が属性に");
	ok(gj.features[3].geometry.coordinates.join() === "-179.999999,-89.999999" && gj.features[4].geometry.coordinates.join() === "179.999999,89.999999", "端の座標（precision 6）");
	const f1199 = gj.features[1199]; ok(f1199.properties.name === "p1199" && near(f1199.geometry.coordinates[0], -180 + (1199 * 37 % 3600) / 10), "最後の点（内部ページ経由）");
	ok(s.crs === "EPSG:4326" && !s.reprojected && s.droppedGeometries === 0, "stats: CRS・落とした幾何なし");
}
{
	const { pbf, stats: s } = await fromGeoPackage(mixed, { layer: "shapes" });
	const gj = pbf.geojson, by = Object.fromEntries(gj.features.map(f => [f.properties.kind, f.geometry]));
	ok(s.features === 8 && s.droppedGeometries === 2 && s.emptyGeometries === 1 && gj.features.length === 8, "shapes: NULL と空フラグを落として 8 件");
	ok(by["polygon+hole"].type === "Polygon" && by["polygon+hole"].coordinates.length === 2 && by["polygon+hole"].coordinates[1].length === 5, "穴あきポリゴン");
	ok(by["multipolygon(BE envelope)"].type === "MultiPolygon" && by["multipolygon(BE envelope)"].coordinates.length === 2, "BE envelope を読み飛ばして MultiPolygon");
	ok(by["line(no envelope)"].coordinates.length === 3 && by["line(no envelope)"].coordinates[1].join() === "139.65,35.3", "envelope 無しの LineString");
	ok(by["multiline"].type === "MultiLineString" && by["multipoint"].type === "MultiPoint" && by["collection"].type === "GeometryCollection" && by["collection"].geometries.length === 2, "MultiLineString / MultiPoint / GeometryCollection");
	ok(by["pointZ"].type === "Point" && by["pointZ"].coordinates.join() === "140.1,36.1", "PointZ は Z を落として 2D");
	ok(by["polygon(BE wkb)"].coordinates[0].length === 5 && by["polygon(BE wkb)"].coordinates[0][2].join() === "11,11", "big-endian WKB");
	ok(!("null geometry" in by) && !("empty flag" in by), "落とした 2 件は出てこない");
}
{
	const { pbf, stats: s } = await fromGeoPackage(mixed, { layer: "merc" });
	const c = pbf.geojson.features[0].geometry.coordinates, c1 = pbf.geojson.features[1].geometry.coordinates;
	ok(s.reprojected && s.crs === "EPSG:3857" && near(c[0], 139.767125) && near(c[1], 35.681236) && c1.join() === "0,0", "EPSG:3857 → 経緯度");
}
{
	const { pbf, stats: s } = await fromGeoPackage(utf16);
	ok(s.layer === "pts" && pbf.geojson.features.map(f => `${f.properties.id}:${f.properties["名前"]}`).join() === "7:東京,9:大阪 🗼", "UTF-16le の GeoPackage");
}
{
	const d = await fromGeoPackage(mixed);
	ok(d.stats.layer === "places" && d.stats.layers.join() === "places,shapes,merc", "layer 省略＝最初の地物層・stats.layers に全部");
	const n = await fromGeoPackage(mixed, { layer: "Places", name: "x", precision: 7, exclude: ["note", "nothing"] });
	ok(n.stats.layer === "places" && n.pbf.name() === "x" && n.pbf.precision() === 7 && !n.stats.columns.includes("note"), "identifier で層指定・name/precision/exclude");
	let threw = ""; try { await fromGeoPackage(mixed, { layer: "nope" }); } catch (e) { threw = e.message; } ok(/層 "nope" が無い（層: places, shapes, merc）/.test(threw), "無い層は候補付きで拒否");
	threw = ""; try { await fromGeoPackage(new Uint8Array(4096)); } catch (e) { threw = e.message; } ok(/SQLite3 ファイルでない/.test(threw), "GeoPackage でないものは拒否");
	// 往復: GeoPBF のバイト列を読み直しても同じ
	const back = await new GeoPBF().set(places.pbf.arrayBuffer);
	ok(back.geojson.features.length === 1200 && back.geojson.features[0].properties.name === "東京駅", "GeoPBF バイト列の読み直し");
}

// ── ラスタ（タイル表） ─────────────────────────────────────────────────────────
{
	const tiny = fx("tiny.gpkg");
	const db = openSqlite(tiny);
	ok(db.get("tiny", 3).tile_row === 0 && db.get("tiny", 3).tile_column === 1 && db.get("tiny", 99) === null && db.get("tiny", 0) === null, "sqlite.get: rowid 直引き（有り・無し）");
	const proj = [...db.rowsProjected("tiny", 4)];
	ok(proj.length === 7 && proj[0].values.length === 4 && proj[6].rowid === 7, "sqlite.rowsProjected: 先頭 4 列で打ち切り（BLOB を触らない）");
	const g = readGeoPackage(tiny);
	ok(g.tiles.map(t => `${t.table}:${t.crs.label}:z${t.zooms.join("-")}:${t.count}`).join() === "tiny:EPSG:3857:z0-1-2:7,geo:EPSG:4326:z0:2" && g.layers.length === 0, "readGeoPackage: タイル表の一覧（CRS・ズーム・枚数）");
	const t = openGpkgTiles(tiny, "tiny");
	ok(t.xyz && t.zooms.join() === "0,1,2" && t.count === 7 && t.matrices.get(2).width === 4 && t.matrixSet.maxX > 20037508, "openGpkgTiles: 3857 全世界格子＝XYZ 同型");
	const b = t.get(1, 1, 0);
	ok(b instanceof Uint8Array && mimeOf(b) === "image/png" && b.length === 564 && t.has(2, 3, 1) && !t.has(2, 0, 0) && t.get(2, 0, 0) === null, "get/has: PNG のバイト列・歯抜けは null");
	ok(t.get(0, 0, 0)[0] === 0x89 && t.get(2, 1, 2).length > 0 && t.bboxLonLat.map(v => Math.round(v)).join() === "-180,-85,180,85", "get: 各ズーム・bbox は経緯度へ");
	const geo = openGpkgTiles(tiny, "geo");
	ok(!geo.xyz && geo.matrices.get(0).width === 2 && geo.crs.kind === "lonlat" && geo.bboxLonLat.join() === "-180,-90,180,90", "4326 世界格子（2×1）は xyz でない");
	const d = openGpkgTiles(tiny); ok(d.table === "tiny", "table 省略＝最初のタイル表");
	let threw = ""; try { openGpkgTiles(tiny, "nope"); } catch (e) { threw = e.message; } ok(/タイル表 "nope" が無い（タイル表: tiny, geo）/.test(threw), "無いタイル表は候補付きで拒否");
	threw = ""; try { openGpkgTiles(mixed); } catch (e) { threw = e.message; } ok(/タイル表（data_type='tiles'）が無い/.test(threw), "タイル表の無い gpkg は拒否");
	ok(mimeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === "image/jpeg" && mimeOf(new TextEncoder().encode("RIFF....WEBPVP8 ")) === "image/webp", "mimeOf: JPEG / WebP");
	// 地理院タイルの実物（tests/fixtures/gpkg/make-raster.py で生成・git 非追跡・あれば検定）
	const gsiPath = new URL("./fixtures/gpkg/gsi-tokyo.gpkg", import.meta.url);
	if (!existsSync(gsiPath)) console.log("– skip: 地理院タイル gpkg（make-raster.py 未実行）");
	else {
		const gsi = new Uint8Array(readFileSync(gsiPath));
		const r = readGeoPackage(gsi);
		ok(r.tiles.map(t => t.table).join() === "std,photo" && r.tiles[0].zooms.join() === "10,11,12,13,14" && r.tiles[1].zooms.join() === "12,13,14", "GSI: std/photo の 2 表とズーム域");
		const std = openGpkgTiles(gsi, "std"), photo = openGpkgTiles(gsi, "photo");
		ok(std.xyz && std.count === 20 && photo.xyz && photo.count === 17 && std.bboxLonLat.map(v => v.toFixed(2)).join() === "139.74,35.66,139.79,35.70", "GSI: XYZ 同型・枚数・bbox");
		// z14 の範囲は bbox から XYZ 式で導く（make-raster.py の tile_xy と同じ）＝14551–14553 × 6450–6452 の 3×3
		const txy = (lon, lat, z) => { const n = 2 ** z, r = lat * Math.PI / 180; return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)]; };
		const [x0, y0] = txy(139.74, 35.70, 14), [x1, y1] = txy(139.79, 35.66, 14);
		const z14 = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (std.has(14, x, y)) z14.push([x, y]);
		ok(x0 === 14551 && y0 === 6450 && z14.length === 9 && mimeOf(std.get(14, ...z14[0])) === "image/png" && std.get(14, ...z14[0]).length > 10000, "GSI: bbox から導いた z14 の 3×3 が全部あり PNG");
		ok(mimeOf(photo.get(12, 3638, 1612)) === "image/jpeg" && std.get(10, 909, 403)?.length > 0, "GSI: 写真は JPEG・z10 の 1 枚");
	}
}

// ── CLI ───────────────────────────────────────────────────────────────────────
{
	const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
	const dir = mkdtempSync(join(tmpdir(), "geopbf-gpkg-"));
	const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	const src = new URL("./fixtures/gpkg/mixed.gpkg", import.meta.url).pathname;
	const list = run("gpkg2pbf", src);
	ok(/地物層 3/.test(list) && /places \(Places\)  POINT  EPSG:4326  1,200 件/.test(list) && /attrs_only  \(attributes\)/.test(list), "CLI gpkg2pbf <in> ＝層の一覧");
	const out = join(dir, "shapes.geopbf");
	const log = run("gpkg2pbf", src, out, "--layer", "shapes");
	ok(/features 8/.test(log) && /落とした地物 2/.test(log), "CLI gpkg2pbf 変換のログ");
	const raw = readFileSync(out);
	const pbf = await new GeoPBF().set(new Uint8Array(gunzipSync(raw)));
	ok(raw[0] === 0x1f && pbf.geojson.features.length === 8 && pbf.name() === "shapes", "CLI 出力＝gzip GeoPBF・8 件・name=表名");
	const info = run("info", out);
	ok(/features\s+8/.test(info), "CLI info が読める");
}

console.log(fails ? `\n✗ ${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
