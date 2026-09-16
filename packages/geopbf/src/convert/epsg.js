// convert/epsg.js ── EPSG 番号 → WKT（proj.js の crsFromWKT が読める最小形）。DXF のように座標系を持たない入力へ「EPSG 番号で指定」するための表。
// 収録: 経緯度（4326 WGS84・4612 JGD2000・6668 JGD2011・4301 Tokyo）・3857・平面直角座標系 I〜XIX（JGD2011 6669–6687・JGD2000 2443–2461・
// Tokyo 30161–30179）・UTM（WGS84 32601–32660 N / 32701–32760 S・JGD2011 6688–6691 = 51–54 帯・JGD2000 3097–3101 = 51–55 帯）。
// それ以外は null＝呼び手が WKT 文字列を渡す。
const JPR = [   // [lat0, lon0]（度）＝測量法 平面直角座標系 I〜XIX の原点
	[33, 129.5], [33, 131], [36, 132 + 10 / 60], [33, 133.5], [36, 134 + 20 / 60], [36, 136], [36, 137 + 10 / 60], [36, 138.5], [36, 139 + 50 / 60],
	[40, 140 + 50 / 60], [44, 140.25], [44, 142.25], [44, 144.25], [26, 142], [26, 127.5], [26, 124], [26, 131], [20, 136], [26, 154],
];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX"];
const GEOG = {
	WGS84: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]',
	JGD2011: 'GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","6668"]]',
	JGD2000: 'GEOGCS["JGD2000",DATUM["Japanese_Geodetic_Datum_2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4612"]]',
	TOKYO: 'GEOGCS["Tokyo",DATUM["Tokyo",SPHEROID["Bessel 1841",6377397.155,299.1528128]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4301"]]',
};
const tm = (name, geog, lat0, lon0, k0, fe, fn, code) =>
	`PROJCS["${name}",${geog},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",${lat0}],PARAMETER["central_meridian",${lon0}],PARAMETER["scale_factor",${k0}],PARAMETER["false_easting",${fe}],PARAMETER["false_northing",${fn}],UNIT["metre",1],AUTHORITY["EPSG","${code}"]]`;

/** EPSG 番号 → WKT。未収録は null */
export function epsgToWKT(code) {
	code = Number(code);
	if (code === 4326) return GEOG.WGS84;
	if (code === 6668) return GEOG.JGD2011;
	if (code === 4612) return GEOG.JGD2000;
	if (code === 4301) return GEOG.TOKYO;
	if (code === 3857 || code === 3785 || code === 900913) return `PROJCS["WGS 84 / Pseudo-Mercator",${GEOG.WGS84},PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]`;
	const jpr = (base, geog, datum) => { const z = code - base; if (z < 0 || z >= 19) return null; const [lat0, lon0] = JPR[z]; return tm(`${datum} / Japan Plane Rectangular CS ${ROMAN[z]}`, geog, lat0, lon0, 0.9999, 0, 0, code); };
	if (code >= 6669 && code <= 6687) return jpr(6669, GEOG.JGD2011, "JGD2011");
	if (code >= 2443 && code <= 2461) return jpr(2443, GEOG.JGD2000, "JGD2000");
	if (code >= 30161 && code <= 30179) return jpr(30161, GEOG.TOKYO, "Tokyo");
	const utm = (zone, south, geog, datum) => tm(`${datum} / UTM zone ${zone}${south ? "S" : "N"}`, geog, 0, zone * 6 - 183, 0.9996, 500000, south ? 10000000 : 0, code);
	if (code >= 32601 && code <= 32660) return utm(code - 32600, false, GEOG.WGS84, "WGS 84");
	if (code >= 32701 && code <= 32760) return utm(code - 32700, true, GEOG.WGS84, "WGS 84");
	if (code >= 6688 && code <= 6691) return utm(code - 6688 + 51, false, GEOG.JGD2011, "JGD2011");
	if (code >= 3097 && code <= 3101) return utm(code - 3097 + 51, false, GEOG.JGD2000, "JGD2000");
	return null;
}
