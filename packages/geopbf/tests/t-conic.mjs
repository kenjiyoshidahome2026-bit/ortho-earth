// 円錐図法（#178・convert/proj.js の LCC・Albers）＝EPSG Guidance Note 7-2 と Snyder の数値例・往復・WKT からの判定。
import { lccForward, lccInverse, albersForward, albersInverse, crsFromWKT } from "../src/convert/proj.js";
let fails = 0;
const ok = (name, cond, note = "") => { if (!cond) fails++; console.log(`${cond ? "ok" : "NG"} ${name}${note ? "  " + note : ""}`); };
const CLARKE = { a: 6378206.4, f: 1 / 294.9786982 };
const FT = 0.3048006096012192, dms = (d, m, s = 0) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);
// EPSG GN7-2 の例（Texas South Central NAD27・LCC 2SP・米国測量フィート）
const tx = { ...CLARKE, lat1: dms(28, 23), lat2: dms(30, 17), latF: dms(27, 50), lonF: -99, fe: 2000000 * FT, fn: 0 };
const [E, N] = lccForward(tx)(-96, 28.5);
ok("lcc2sp-epsg", Math.abs(E / FT - 2963503.91) < 0.05 && Math.abs(N / FT - 254759.80) < 0.05, `${(E / FT).toFixed(2)} ${(N / FT).toFixed(2)}`);
const b = lccInverse(tx)(E, N);
ok("lcc2sp-inverse", Math.abs(b[0] + 96) < 1e-9 && Math.abs(b[1] - 28.5) < 1e-9, b.join());
// Snyder の例（Clarke 1866）：LCC φ1 33 φ2 45 φ0 23 λ0 −96 → (35°N, 75°W)＝x 1,894,410.9 y 1,564,649.5
const sn = { ...CLARKE, lat1: 33, lat2: 45, latF: 23, lonF: -96 };
const [lx, ly] = lccForward(sn)(-75, 35);
ok("lcc-snyder", Math.abs(lx - 1894410.9) < 0.5 && Math.abs(ly - 1564649.5) < 0.5, `${lx.toFixed(1)} ${ly.toFixed(1)}`);
// Albers（Snyder・Clarke 1866）：φ1 29.5 φ2 45.5 φ0 23 λ0 −96 → (35°N, 75°W)＝x 1,885,472.7 y 1,535,925.0
const al = { ...CLARKE, lat1: 29.5, lat2: 45.5, latF: 23, lonF: -96 };
const [ax, ay] = albersForward(al)(-75, 35);
ok("albers-snyder", Math.abs(ax - 1885472.7) < 0.5 && Math.abs(ay - 1535925.0) < 0.5, `${ax.toFixed(1)} ${ay.toFixed(1)}`);
const ab = albersInverse(al)(ax, ay);
ok("albers-inverse", Math.abs(ab[0] + 75) < 1e-8 && Math.abs(ab[1] - 35) < 1e-7, ab.join());
// 1SP（EPSG GN7-2 の例：Jamaica 1969・Clarke 1866・φ0 18 λ0 −77 k0 1 FE 250000 FN 150000）：(17.932°N, 76.944°W)→ E 255966.58 N 142493.51
const jm = { ...CLARKE, lat1: 18, lat2: null, latF: 18, lonF: -77, k0: 1, fe: 250000, fn: 150000 };
const [jx, jy] = lccForward(jm)(dms(-76, 56, 37.26), dms(17, 55, 55.8));
ok("lcc1sp-epsg", Math.abs(jx - 255966.58) < 0.05 && Math.abs(jy - 142493.51) < 0.05, `${jx.toFixed(2)} ${jy.toFixed(2)}`);
const jb = lccInverse(jm)(jx, jy);
ok("lcc1sp-inverse", Math.abs(jb[0] - dms(-76, 56, 37.26)) < 1e-9 && Math.abs(jb[1] - dms(17, 55, 55.8)) < 1e-9);
// WKT（NAD83 の State Plane・フィート／CONUS Albers）＝crsFromWKT が projected と判定して逆変換を返す
const sp = 'PROJCS["NAD83 / Oregon GIC Lambert (ft)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",41.75],PARAMETER["central_meridian",-120.5],PARAMETER["standard_parallel_1",43],PARAMETER["standard_parallel_2",45.5],PARAMETER["false_easting",1312335.958],PARAMETER["false_northing",0],UNIT["foot",0.3048],AUTHORITY["EPSG","2992"]]';
const c = crsFromWKT(sp);
const fwd = lccForward({ a: 6378137, f: 1 / 298.257222101, lat1: 43, lat2: 45.5, latF: 41.75, lonF: -120.5, fe: 1312335.958 * 0.3048, fn: 0 });
const [ox, oy] = fwd(-123.07, 44.05);   // Autzen（Eugene・オレゴン）
const back = c.toLonLat?.([ox / 0.3048, oy / 0.3048]);
ok("wkt-lcc-feet", c.kind === "projected" && back && Math.abs(back[0] + 123.07) < 1e-8 && Math.abs(back[1] - 44.05) < 1e-8, `${c.kind} ${back}`);
const conus = 'PROJCS["NAD83 / Conus Albers",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Albers_Conic_Equal_Area"],PARAMETER["standard_parallel_1",29.5],PARAMETER["standard_parallel_2",45.5],PARAMETER["latitude_of_center",23],PARAMETER["longitude_of_center",-96],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","5070"]]';
const c2 = crsFromWKT(conus), af = albersForward({ a: 6378137, f: 1 / 298.257222101, lat1: 29.5, lat2: 45.5, latF: 23, lonF: -96 });
const back2 = c2.toLonLat?.(af(-77.03, 38.9));
ok("wkt-albers", c2.kind === "projected" && Math.abs(back2[0] + 77.03) < 1e-8 && Math.abs(back2[1] - 38.9) < 1e-7, `${c2.kind} ${back2}`);
// GDAL の WKT1 の EPSG:3857（Mercator_1SP＋WGS84 楕円体・名前と AUTHORITY と PROJ4 の拡張でだけ球と分かる）＝球の逆変換
const gdal3857 = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["X",EAST],AXIS["Y",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]';
const g = crsFromWKT(gdal3857).toLonLat([-8242596, 4966606]);
ok("gdal-3857", Math.abs(g[0] + 74.0445) < 1e-3 && Math.abs(g[1] - 40.68920) < 1e-4, g.join());
console.log(fails ? `\nFAIL ${fails}` : "\n全件通過");
process.exit(fails ? 1 : 0);
