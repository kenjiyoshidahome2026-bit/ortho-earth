// 点群の座標系の決め方（src/pointcloud-crs.js・点群計画 段 3-2）の検定。node tests/t-pointcloud-crs.mjs
import assert from "node:assert/strict";
import { resolveCrs } from "../src/pointcloud-crs.js";

let k = 0;
const t = (name, fn) => { fn(); k++; console.log("  ✔", name); };
const near = (a, b, e) => Math.abs(a - b) <= e;
const ATAMI = [53000, -98850];   // 熱海（平面直角 VIII 系・m）

t("opts.crs＝EPSG 番号・平面の系で鉛直が無い＝標高とみなす", () => {
	const r = resolveCrs({ crs: "EPSG:6676" }), [lon, lat] = r.ll(ATAMI);
	assert.equal(r.from, "opts"); assert.ok(r.orthometric); assert.ok(near(lon, 139.081, 0.01) && near(lat, 35.108, 0.01), `${lon},${lat}`);
});
t("opts.vertical で楕円体高にできる", () => assert.equal(resolveCrs({ crs: "EPSG:6676", vertical: "ellipsoidal" }).orthometric, false));
t("GeoTIFF キー（6676＋6695）＝標高", () => {
	const r = resolveCrs({ geoKeys: { horizontal: 6676, vertical: 6695 } });
	assert.equal(r.from, "geokeys"); assert.ok(r.orthometric); assert.equal(r.verticalName, "EPSG:6695");
});
t("ファイルの WKT が GeoTIFF キーより先・opts.crs はファイルより先", () => {
	const merc = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]';
	const a = resolveCrs({ wkt: merc, geoKeys: { horizontal: 6676, vertical: null } });
	assert.equal(a.from, "wkt"); assert.equal(a.orthometric, false);   // メルカトル・鉛直なし＝楕円体高（従来どおり）
	assert.equal(resolveCrs({ wkt: merc, crs: "EPSG:6676" }).from, "opts");
});
t("鉛直付きの WKT（COMPD_CS）＝標高・単位", () => {
	const w = 'COMPD_CS["x",PROJCS["JGD2011 / Japan Plane Rectangular CS VIII",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",138.5],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]],VERT_CS["JGD2011 (vertical) height",VERT_DATUM["Japanese Geodetic Datum 2011 (vertical)",2005],UNIT["metre",1]]]';
	const r = resolveCrs({ wkt: w });
	assert.ok(r.orthometric); assert.equal(r.verticalName, "JGD2011 (vertical) height"); assert.equal(r.vUnit, 1);
});
t("座標系が無い＝{ crs } を渡すよう言って止まる・表に無い番号も止まる", () => {
	assert.throws(() => resolveCrs({}), /crs: "EPSG:6676"/);
	assert.throws(() => resolveCrs({ crs: "EPSG:2154" }), /not in the built-in EPSG table/);
});
console.log(`\n全 ${k} 件通過`);
