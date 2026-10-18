#!/usr/bin/env node
// tests/fixtures/gpkg/make-raster.mjs ── 地理院タイルからラスタ GeoPackage を組む（Node 標準の node:sqlite と fetch だけ・GDAL 不要・2026-10-18 に make-raster.py から移植）。
// 出力: gsi-tokyo.gpkg  東京駅周辺・EPSG:3857・全世界格子（tile_row = XYZ の y）・2 表
//   std    標準地図 PNG  z10–14   https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png
//   photo  全国最新写真（シームレス）JPEG z12–14   .../xyz/seamlessphoto/{z}/{x}/{y}.jpg
// 出典: 国土地理院 地理院タイル（https://maps.gsi.go.jp/development/ichiran.html）。gpkg_contents.description に明記。
// 再生成: node tests/fixtures/gpkg/make-raster.mjs  （取得は数十枚・0.1 秒間隔）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "gsi-tokyo.gpkg");
const BBOX = [139.74, 35.66, 139.79, 35.70];          // lon0 lat0 lon1 lat1（東京駅〜皇居〜日本橋）
const ORIGIN = 20037508.342789244;                    // 3857 の世界半幅
const UA = "ortho-earth geopbf fixture builder (https://www.ortho-earth.com/)";
const rad = d => d * Math.PI / 180;

const tileXY = (lon, lat, z) => {
	const n = 2 ** z;
	return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * n)];
};
const merc = (lon, lat) => { const R = 6378137.0; return [R * rad(lon), R * Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2))]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

process.on("exit", c => { if (c) fs.rmSync(TMP, { force: true }); });

async function fetchTile(url) {
	const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
	if (!r.ok) throw new Error(`${r.status} ${url}`);
	return new Uint8Array(await r.arrayBuffer());
}

async function addTiles(db, table, urlFmt, zooms, ident, desc) {
	db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row))`);
	db.prepare("INSERT INTO gpkg_tile_matrix_set VALUES (?,?,?,?,?,?)").run(table, 3857, -ORIGIN, -ORIGIN, ORIGIN, ORIGIN);
	const ins = db.prepare(`INSERT INTO "${table}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)`);
	let nTotal = 0;
	for (const z of zooms) {
		const [x0, y0] = tileXY(BBOX[0], BBOX[3], z), [x1, y1] = tileXY(BBOX[2], BBOX[1], z);
		const px = 2 * ORIGIN / (256 * 2 ** z);
		db.prepare("INSERT INTO gpkg_tile_matrix VALUES (?,?,?,?,?,?,?,?)").run(table, z, 2 ** z, 2 ** z, 256, 256, px, px);
		for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
			ins.run(z, x, y, await fetchTile(urlFmt.replace("{z}", z).replace("{x}", x).replace("{y}", y)));
			nTotal++; await sleep(100);
		}
		console.log(`  ${table} z${z}: ${(x1 - x0 + 1) * (y1 - y0 + 1)} tiles`);
	}
	const [mx0, my0] = merc(BBOX[0], BBOX[1]), [mx1, my1] = merc(BBOX[2], BBOX[3]);
	db.prepare("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,last_change,min_x,min_y,max_x,max_y,srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
		.run(table, "tiles", ident, desc, "2026-09-12T00:00:00.000Z", mx0, my0, mx1, my1, 3857);
	return nTotal;
}

const TMP = OUT + ".tmp";   // 取得に失敗したら半端な gpkg を残さない（t-gpkg は無ければ飛ばす）
fs.rmSync(TMP, { force: true });
const db = new DatabaseSync(TMP);
db.exec("PRAGMA application_id=1196444487"); db.exec("PRAGMA user_version=10300");
db.exec(`
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
    CREATE TABLE gpkg_tile_matrix_set (table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL, min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL,
      max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL);
    CREATE TABLE gpkg_tile_matrix (table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL,
      tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL,
      CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level));
`);
const srs = db.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)");
for (const r of [
	["Undefined cartesian SRS", -1, "NONE", -1, "undefined", null],
	["Undefined geographic SRS", 0, "NONE", 0, "undefined", null],
	["WGS 84 geodetic", 4326, "EPSG", 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]', null],
	["WGS 84 / Pseudo-Mercator", 3857, "EPSG", 3857, 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]', null],
]) srs.run(...r);
db.exec("BEGIN");
let n = await addTiles(db, "std", "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", [10, 11, 12, 13, 14], "GSI std", "地理院タイル 標準地図（出典: 国土地理院）");
n += await addTiles(db, "photo", "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", [12, 13, 14], "GSI seamlessphoto", "地理院タイル 全国最新写真（シームレス）（出典: 国土地理院）");
db.exec("COMMIT"); db.exec("VACUUM"); db.close();
fs.renameSync(TMP, OUT);
console.log(OUT, fs.statSync(OUT).size, "bytes,", n, "tiles");
