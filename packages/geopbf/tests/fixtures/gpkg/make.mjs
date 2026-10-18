#!/usr/bin/env node
// tests/fixtures/gpkg/make.mjs ── t-gpkg.mjs が読む GeoPackage 固定資料を組む（Node 標準の node:sqlite だけ・GDAL 不要・2026-10-18 に make.py から移植）。
// 生成物は決定的（時刻は固定文字列）。再生成: node tests/fixtures/gpkg/make.mjs
//   mixed.gpkg  page_size 1024・places 1200 点（多段 B-tree・overflow ページ・rowid 別名 fid・型付き属性・BLOB 列）
//               shapes（全ジオメトリ種・穴・Z・null・empty フラグ・BE envelope）・merc（EPSG:3857）・attrs_only（非地物表）
//               ＋ view・rtree 索引（GDAL が書くのと同じ影表）・gpkg_extensions
//   utf16.gpkg  PRAGMA encoding=UTF-16le・INTEGER PRIMARY KEY を明示 id で
//   tiny.mbtiles / view.mbtiles  MBTiles（tiles 実表 PNG・TMS 行／map+images+tiles ビュー・gzip 疑似 MVT）
//   tiny.gpkg   ラスタ（タイル表）＝3857 全世界格子の単色 PNG 7 枚（歯抜け）＋ 4326 世界格子 2 枚。地理院タイルの実物は make-raster.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = 6378137.0, rad = d => d * Math.PI / 180;
const round6 = v => Number(v.toFixed(6));
const open = name => { const p = path.join(HERE, name); fs.rmSync(p, { force: true }); return [p, new DatabaseSync(p)]; };
const done = (p, db) => { db.close(); console.log(p, fs.statSync(p).size, "bytes"); };
// executemany 相当（1 本の transaction＝python の sqlite3 と同じく commit まで束ねる）
// gzip の頭は python の gzip.compress（level 9）と同じ XFL=2・OS=255 に揃える
const gz = s => { const b = zlib.gzipSync(s, { level: 9 }); b[8] = 2; b[9] = 255; return b; };
const many = (db, sql, rows) => { const st = db.prepare(sql); for (const r of rows) st.run(...r); };

// ---- WKB（LE） -------------------------------------------------------------
const T = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };
const u32 = (v, be) => { const b = Buffer.alloc(4); be ? b.writeUInt32BE(v) : b.writeUInt32LE(v); return b; };
const i32 = (v, be) => { const b = Buffer.alloc(4); be ? b.writeInt32BE(v) : b.writeInt32LE(v); return b; };
const f64s = (vs, be) => { const b = Buffer.alloc(8 * vs.length); vs.forEach((v, i) => be ? b.writeDoubleBE(v, 8 * i) : b.writeDoubleLE(v, 8 * i)); return b; };
function wkb(g, z = false, be = false) {
	const pt = c => f64s(z ? c.slice(0, 3) : c.slice(0, 2), be);
	const ring = r => Buffer.concat([u32(r.length, be), ...r.map(pt)]);
	const head = Buffer.concat([Buffer.from([be ? 0 : 1]), u32(T[g.type] + (z ? 1000 : 0), be)]);
	if (g.type === "Point") return Buffer.concat([head, pt(g.coordinates)]);
	if (g.type === "LineString") return Buffer.concat([head, ring(g.coordinates)]);
	if (g.type === "Polygon") return Buffer.concat([head, u32(g.coordinates.length, be), ...g.coordinates.map(ring)]);
	if (g.type === "GeometryCollection") return Buffer.concat([head, u32(g.geometries.length, be), ...g.geometries.map(x => wkb(x, z, be))]);
	const inner = { MultiPoint: "Point", MultiLineString: "LineString", MultiPolygon: "Polygon" }[g.type];
	return Buffer.concat([head, u32(g.coordinates.length, be), ...g.coordinates.map(c => wkb({ type: inner, coordinates: c }, z, be))]);
}
function* coords(g) {
	if (g.type === "GeometryCollection") { for (const x of g.geometries) yield* coords(x); return; }
	function* walk(c) { if (typeof c[0] === "number") yield c; else for (const x of c) yield* walk(x); }
	yield* walk(g.coordinates);
}

// GeoPackage 幾何 BLOB: "GP" ver flags srs_id [envelope] wkb
function gpb(g, { srs = 4326, env = true, beEnv = false, z = false, empty = false, wkbBe = false } = {}) {
	const flags = (beEnv ? 0 : 1) | ((env ? 1 : 0) << 1) | ((empty ? 1 : 0) << 4);
	const parts = [Buffer.from([0x47, 0x50, 0, flags]), i32(srs, beEnv)];
	if (env) {
		const cs = [...coords(g)], xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
		parts.push(f64s([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], beEnv));
	}
	parts.push(wkb(g, z, wkbBe));
	return Buffer.concat(parts);
}

// ---- GeoPackage の骨格 -----------------------------------------------------
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
function skeleton(db, { pageSize, encoding } = {}) {
	if (encoding) db.exec(`PRAGMA encoding='${encoding}'`);
	if (pageSize) db.exec(`PRAGMA page_size=${pageSize}`);
	db.exec("PRAGMA application_id=1196444487");   // 'GPKG'
	db.exec("PRAGMA user_version=10300");
	db.exec(`
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));
	`);
	many(db, "INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)", [
		["Undefined cartesian SRS", -1, "NONE", -1, "undefined", "undefined cartesian coordinate reference system"],
		["Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined geographic coordinate reference system"],
		["WGS 84 geodetic", 4326, "EPSG", 4326, WGS84, "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid"],
		["WGS 84 / Pseudo-Mercator", 3857, "EPSG", 3857, 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84"]]', null],
	]);
}

function addLayer(db, table, gtype, srs, features, cols, { ident, desc = "", z = 0, rtree = false, pk = "fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL" } = {}) {
	// features: [[geomBlob|null, {col: val}]]
	db.exec(`CREATE TABLE "${table}" (${pk}, "geom" ${gtype}, ${cols.join(", ")})`);
	const names = cols.map(x => x.split(" ")[0].replace(/"/g, ""));
	many(db, `INSERT INTO "${table}" ("geom", ${names.map(n => `"${n}"`).join(", ")}) VALUES (${Array(names.length + 1).fill("?").join(",")})`,
		features.map(([blob, props]) => [blob, ...names.map(n => props[n] ?? null)]));
	db.prepare("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,last_change,min_x,min_y,max_x,max_y,srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
		.run(table, "features", ident || table, desc, "2026-09-12T00:00:00.000Z", null, null, null, null, srs);
	db.prepare("INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)").run(table, "geom", gtype, srs, z, 0);
	if (rtree) {
		db.exec(`
        CREATE VIRTUAL TABLE "rtree_${table}_geom" USING rtree(id, minx, maxx, miny, maxy);
        CREATE TRIGGER "rtree_${table}_geom_insert" AFTER INSERT ON "${table}" WHEN (new."geom" NOT NULL AND NOT ST_IsEmpty(NEW."geom"))
          BEGIN INSERT OR REPLACE INTO "rtree_${table}_geom" VALUES (NEW.fid, ST_MinX(NEW."geom"), ST_MaxX(NEW."geom"), ST_MinY(NEW."geom"), ST_MaxY(NEW."geom")); END;
		`);
		many(db, `INSERT INTO "rtree_${table}_geom" VALUES (?,?,?,?,?)`, Array.from({ length: 5 }, (_, i) => [i + 1, 0, 1, 0, 1]));
		db.exec("CREATE TABLE IF NOT EXISTS gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL)");
		db.prepare("INSERT INTO gpkg_extensions VALUES (?,?,?,?,?)").run(table, "geom", "gpkg_rtree_index", "http://www.geopackage.org/spec120/#extension_rtree", "write-only");
	}
}

function mixed() {
	const [p, db] = open("mixed.gpkg");
	skeleton(db, { pageSize: 1024 });
	db.exec("BEGIN");
	// places: 1200 点＝多段 B-tree。先頭 5 行は検定用の固定値、以降は決定的な生成
	const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
	const fixed = [
		[{ name: "東京駅", pop: 1_000_000, ratio: 0.5, flag: 1, d: "2026-09-12", dt: "2026-09-12T01:02:03Z", big: 2 ** 40 + 7, note: "n".repeat(5000), photo: png }, [139.767125, 35.681236]],
		[{ name: "Ōsaka", pop: -42, ratio: -1.25, flag: 0, big: -(2 ** 40), note: "" }, [135.5, 34.7]],
		[{ name: "zero", pop: 0, ratio: 0.0, d: "1970-01-02", dt: "1970-01-01T00:00:00Z", big: 0 }, [0, 0]],
		[{ name: "int8/16/24/32/48 境目", pop: 127, ratio: 1.0, flag: 1, big: 2 ** 31, note: "a" }, [-179.999999, -89.999999]],
		[{ name: "quote \"and\" 'apos'", pop: 32767, ratio: 1e300, flag: 0, big: 2 ** 47 }, [179.999999, 89.999999]],
	];
	const feats = fixed.map(([props, xy]) => [gpb({ type: "Point", coordinates: xy }), props]);
	for (let i = 5; i < 1200; i++) {
		const x = round6(-180 + (i * 37 % 3600) / 10), y = round6(-85 + (i * 53 % 1700) / 10);
		feats.push([gpb({ type: "Point", coordinates: [x, y] }, { env: i % 2 === 0 }),
			{ name: `p${i}`, pop: i * 1000, ratio: i / 7, flag: i % 2, big: i * 2 ** 33 }]);
	}
	addLayer(db, "places", "POINT", 4326, feats,
		['"name" TEXT', '"pop" INTEGER', '"ratio" REAL', '"flag" BOOLEAN', '"d" DATE', '"dt" DATETIME', '"big" INTEGER', '"note" TEXT(8000)', '"photo" BLOB', '"nothing" TEXT'],
		{ ident: "Places", desc: "1200 points", rtree: true });
	db.exec("CREATE VIEW v_places AS SELECT fid, name FROM places");
	// shapes: 全種
	const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
	const emptyBlob = Buffer.concat([Buffer.from([0x47, 0x50, 0, 0x11]), i32(4326), Buffer.from([1, 1, 0, 0, 0]), f64s([NaN, NaN])]);
	const shp = [
		[gpb({ type: "Polygon", coordinates: [sq(139.5, 35.5, 139.8, 35.8), sq(139.6, 35.6, 139.7, 35.7)] }), { kind: "polygon+hole" }],
		[gpb({ type: "MultiPolygon", coordinates: [[sq(15, 15, 16, 16)], [sq(20, 20, 21, 21)]] }, { beEnv: true }), { kind: "multipolygon(BE envelope)" }],
		[gpb({ type: "LineString", coordinates: [[139.5, 35.5], [139.65, 35.3], [139.8, 35.5]] }, { env: false }), { kind: "line(no envelope)" }],
		[gpb({ type: "MultiLineString", coordinates: [[[0.5, 0.5], [1, 1]], [[2, 2], [3, 4]]] }), { kind: "multiline" }],
		[gpb({ type: "MultiPoint", coordinates: [[1, 1], [2, 2]] }), { kind: "multipoint" }],
		[gpb({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [5, 5] }, { type: "LineString", coordinates: [[5, 5], [6, 6]] }] }), { kind: "collection" }],
		[gpb({ type: "Point", coordinates: [140.1, 36.1, 123.4] }, { z: true }), { kind: "pointZ" }],
		[gpb({ type: "Polygon", coordinates: [sq(10, 10, 11, 11)] }, { wkbBe: true }), { kind: "polygon(BE wkb)" }],
		[null, { kind: "null geometry" }],
		[emptyBlob, { kind: "empty flag" }],
	];
	addLayer(db, "shapes", "GEOMETRY", 4326, shp, ['"kind" TEXT'], { desc: "all geometry kinds" });
	// merc: EPSG:3857 の点（東京駅・null island）
	const merc = (lon, lat) => [R * rad(lon), R * Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2))];
	addLayer(db, "merc", "POINT", 3857, [
		[gpb({ type: "Point", coordinates: merc(139.767125, 35.681236) }, { srs: 3857 }), { name: "tokyo" }],
		[gpb({ type: "Point", coordinates: [0, 0] }, { srs: 3857 }), { name: "null island" }],
	], ['"name" TEXT']);
	// 非地物表
	db.exec("CREATE TABLE attrs_only (id INTEGER PRIMARY KEY, v TEXT)");
	db.exec("INSERT INTO attrs_only VALUES (1,'x')");
	db.exec("INSERT INTO gpkg_contents (table_name,data_type,identifier,last_change) VALUES ('attrs_only','attributes','attrs_only','2026-09-12T00:00:00.000Z')");
	db.exec("COMMIT"); db.exec("VACUUM");
	done(p, db);
}

function utf16() {
	const [p, db] = open("utf16.gpkg");
	skeleton(db, { encoding: "UTF-16le" });
	db.exec('CREATE TABLE pts ("id" INTEGER PRIMARY KEY, geom POINT, "名前" TEXT, n INTEGER)');
	const ins = db.prepare("INSERT INTO pts VALUES (?, ?, ?, ?)");
	ins.run(7, gpb({ type: "Point", coordinates: [139.767125, 35.681236] }), "東京", 1);
	ins.run(9, gpb({ type: "Point", coordinates: [135.5, 34.7] }), "大阪 🗼", 2);
	db.exec("INSERT INTO gpkg_contents (table_name,data_type,identifier,last_change,srs_id) VALUES ('pts','features','pts','2026-09-12T00:00:00.000Z',4326)");
	db.exec("INSERT INTO gpkg_geometry_columns VALUES ('pts','geom','POINT',4326,0,0)");
	done(p, db);
}

function pngSolid(w, h, rgb) {
	const chunk = (t, d) => { const td = Buffer.concat([Buffer.from(t, "latin1"), d]); return Buffer.concat([u32(d.length, true), td, u32(zlib.crc32(td), true)]); };
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())]);
	const ihdr = Buffer.concat([u32(w, true), u32(h, true), Buffer.from([8, 2, 0, 0, 0])]);
	return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function raster() {
	// tiny.gpkg: 3857 全世界格子（XYZ 同型）の "tiny"（z0:1・z1:4・z2:2 枚＝歯抜け）と、4326 世界格子（2×1）の "geo"＝xyz でない例
	const [p, db] = open("tiny.gpkg");
	skeleton(db, { pageSize: 1024 });
	db.exec(`
    CREATE TABLE gpkg_tile_matrix_set (table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL, min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL, max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL);
    CREATE TABLE gpkg_tile_matrix (table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL,
      tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL, CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level));
	`);
	const W = 20037508.342789244;
	const tileTable = (name, srs, ext, mats, tiles, ident) => {
		db.exec(`CREATE TABLE "${name}" (id INTEGER PRIMARY KEY AUTOINCREMENT, zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL, tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row))`);
		db.prepare("INSERT INTO gpkg_tile_matrix_set VALUES (?,?,?,?,?,?)").run(name, srs, ...ext);
		many(db, "INSERT INTO gpkg_tile_matrix VALUES (?,?,?,?,?,?,?,?)", mats.map(([z, w, h]) => [name, z, w, h, 256, 256, (ext[2] - ext[0]) / (256 * w), (ext[3] - ext[1]) / (256 * h)]));
		many(db, `INSERT INTO "${name}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)`, tiles.map(([z, x, y, rgb]) => [z, x, y, pngSolid(256, 256, rgb)]));
		db.prepare("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,last_change,min_x,min_y,max_x,max_y,srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)").run(name, "tiles", ident, "synthetic", "2026-09-12T00:00:00.000Z", ...ext, srs);
	};
	tileTable("tiny", 3857, [-W, -W, W, W], [[0, 1, 1], [1, 2, 2], [2, 4, 4]],
		[[0, 0, 0, [255, 0, 0]], [1, 0, 0, [0, 255, 0]], [1, 1, 0, [0, 0, 255]], [1, 0, 1, [255, 255, 0]], [1, 1, 1, [0, 255, 255]], [2, 3, 1, [255, 0, 255]], [2, 1, 2, [10, 20, 30]]], "Tiny");
	tileTable("geo", 4326, [-180, -90, 180, 90], [[0, 2, 1]], [[0, 0, 0, [1, 2, 3]], [0, 1, 0, [4, 5, 6]]], "Geo");
	db.exec("VACUUM");
	done(p, db);
}

function mbtiles() {
	// tiny.mbtiles: tiles 実表・PNG・TMS 行（z1 の XYZ (1,0) は tile_row=1）
	let [p, db] = open("tiny.mbtiles");
	db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
	`);
	many(db, "INSERT INTO metadata VALUES (?,?)", [["name", "tiny"], ["format", "png"], ["bounds", "-180,-85.0511,180,85.0511"], ["minzoom", "0"], ["maxzoom", "1"], ["type", "overlay"], ["version", "1"]]);
	many(db, "INSERT INTO tiles VALUES (?,?,?,?)", [[0, 0, 0, [255, 0, 0]], [1, 0, 0, [0, 255, 0]], [1, 1, 0, [0, 0, 255]], [1, 1, 1, [9, 9, 9]]]
		.map(([z, x, y, rgb]) => [z, x, 2 ** z - 1 - y, pngSolid(256, 256, rgb)]));
	done(p, db);
	// view.mbtiles: map + images + tiles ビュー・gzip 包みの疑似 MVT（中身は検定用のダミー）・重複タイルは同じ tile_id を共有
	[p, db] = open("view.mbtiles");
	db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);
    CREATE TABLE images (tile_data BLOB, tile_id TEXT);
    CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column, map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id;
	`);
	many(db, "INSERT INTO metadata VALUES (?,?)", [["name", "view"], ["format", "pbf"], ["bounds", "139.0,35.0,140.0,36.0"], ["json", '{"vector_layers":[{"id":"roads"}]}']]);
	many(db, "INSERT INTO images VALUES (?,?)", [[gz("MVT-A"), "a"], [gz("MVT-B"), "b"]]);
	many(db, "INSERT INTO map VALUES (?,?,?,?)", [[2, 3, 2 ** 2 - 1 - 1, "a"], [2, 3, 2 ** 2 - 1 - 2, "a"], [3, 7, 2 ** 3 - 1 - 3, "b"], [3, 0, 0, "missing"]]);
	done(p, db);
}

mixed(); utf16(); raster(); mbtiles();
