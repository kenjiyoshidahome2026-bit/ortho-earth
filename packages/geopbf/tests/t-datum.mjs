#!/usr/bin/env node
// t-datum: 投影（convert/proj.js）と測地系（convert/datum.js）の検定。外部データ不要＝決定的。
//   ・WKT の木・平面直角座標系/UTM/Web メルカトルの逆変換（順変換との往復・子午線弧長を数値積分と照合）
//   ・日本測地系 → JGD2000（TKY2JGD 格子 / 内蔵 Helmert）
//   ・JGD2000 → JGD2011（PatchJGD 格子・対象域外は無変換）と、Tokyo → JGD2011 の連鎖
// 固定資料は tests/fixtures/datum/*.par（国土地理院の .par から数メッシュを抜粋したもの・fixtures/datum/NOTICE.md）。
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { crsFromWKT, tmInverse, tmForward, parseWKTTree } from "../src/convert/proj.js";
import { bakeMeshGrid, parseMeshGrid, loadMeshGrid, resolveDatum, datumStats, tokyoToJGD, jgd2000To2011, tokyoHelmert } from "../src/convert/datum.js";
import { classifyCrs } from "../src/convert/gpkg.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const par = (n) => readFileSync(new URL(`./fixtures/datum/${n}`, import.meta.url), "utf8");

const GEOG_TOKYO = `GEOGCS["GCS_Tokyo",DATUM["D_Tokyo",SPHEROID["Bessel_1841",6377397.155,299.1528128]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
const GEOG_JGD2000 = `GEOGCS["JGD2000",DATUM["Japanese_Geodetic_Datum_2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]`;
const GEOG_JGD2011 = `GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]`;

// ── 投影 ──────────────────────────────────────────────────────────────────────
{
	const IX = { a: 6378137, f: 1 / 298.257222101, k0: 0.9999, lat0: 36, lon0: 139 + 50 / 60, fe: 0, fn: 0 };
	const fwd = tmForward(IX), inv = tmInverse(IX);
	// 中央子午線上では x=0・y=k0·(S(φ)−S(φ0))。S は級数と独立に数値積分（Simpson）で出す
	const e2 = 2 * IX.f - IX.f * IX.f, M = phi => IX.a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi) ** 2, 1.5);
	const arc = (p0, p1, n = 2000) => { const h = (p1 - p0) / n; let s = M(p0) + M(p1); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * M(p0 + i * h); return s * h / 3; };
	const [x, y] = fwd([IX.lon0, 36.1]);
	ok(near(x, 0, 1e-6) && near(y, IX.k0 * arc(36 / 180 * Math.PI, 36.1 / 180 * Math.PI), 1e-3), `TM 順変換: 中央子午線上 y=${y.toFixed(4)} が数値積分の弧長と 1 mm 以内`);
	for (const [lon, lat] of [[140 + 5 / 60, 36.1], [138.5, 34.2], [141.9, 37.9]]) { const [X, Y] = fwd([lon, lat]); const [lo, la] = inv(X, Y); ok(near(lo, lon, 1e-10) && near(la, lat, 1e-10), `TM 往復 (${lon.toFixed(4)}, ${lat}) → (${X.toFixed(3)}, ${Y.toFixed(3)}) → 元へ 1e-10°`); }
	const esri = crsFromWKT(`PROJCS["JGD_2011_Japan_Zone_9",GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",139.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",36.0],UNIT["Meter",1.0]]`);
	const [X2, Y2] = fwd([140 + 5 / 60, 36.1]), back = esri.toLonLat([X2, Y2]);
	ok(esri.kind === "projected" && esri.label === "JGD_2011_Japan_Zone_9" && near(back[0], 140 + 5 / 60, 1e-9) && near(back[1], 36.1, 1e-9), "Esri WKT の平面直角座標系 IX（JGD2011）を認識して逆変換");
	const utm = crsFromWKT(`PROJCS["WGS 84 / UTM zone 54N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",141],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","32654"]]`);
	const u0 = utm.toLonLat([500000, 0]), ufwd = tmForward({ a: 6378137, f: 1 / 298.257223563, k0: 0.9996, lat0: 0, lon0: 141, fe: 500000, fn: 0 })([139.767125, 35.681236]), u1 = utm.toLonLat(ufwd);
	ok(utm.kind === "projected" && utm.label === "EPSG:32654" && near(u0[0], 141, 1e-12) && near(u0[1], 0, 1e-12) && near(u1[0], 139.767125, 1e-9) && near(u1[1], 35.681236, 1e-9), "OGC WKT の UTM 54N（AUTHORITY 付き）を認識・往復");
	const ft = crsFromWKT(`PROJCS["X",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1640416.666666667],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",-75],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",40],UNIT["Foot_US",0.3048006096012192]]`);
	ok(ft.kind === "projected" && near(ft.toLonLat([1640416.666666667, 0])[0], -75, 1e-9) && near(ft.toLonLat([1640416.666666667, 0])[1], 40, 1e-9), "単位がフィートでも原点が戻る");
	const wm = crsFromWKT(`PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`);
	ok(wm.kind === "projected" && near(wm.toLonLat([15557880, 4257870])[0], 139.7593, 1e-3) && near(wm.toLonLat([0, 0])[1], 0, 1e-12), "Web メルカトル（Esri 名）");
	ok(crsFromWKT(GEOG_JGD2011).kind === "lonlat" && crsFromWKT(`GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]]`).kind === "lonlat", "GEOGCS WGS84 / JGD2011 は経緯度");
	ok(crsFromWKT(`GEOGCS["GCS_Pulkovo_1942",DATUM["D_Pulkovo_1942",SPHEROID["Krasovsky_1940",6378245,298.3]]]`).kind === "other" && crsFromWKT("").kind === "other" && crsFromWKT("{B286C06B-0879-11D2-AACA-00C04FA33C20}").kind === "other" && crsFromWKT(`PROJCS["LCC",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]],PROJECTION["Lambert_Conformal_Conic"]]`).kind === "other", "未知の測地系・空・GUID・未対応投影は other");
	const tree = parseWKTTree(`A["x",B[1,2.5,"y"],C]`);
	ok(tree.name === "A" && tree.args[0] === "x" && tree.args[1].name === "B" && tree.args[1].args[1] === 2.5 && tree.args[2].name === "C", "parseWKTTree");
}

// ── 焼き（共通の器）──────────────────────────────────────────────────────────
const tkyBake = bakeMeshGrid(par("tky2jgd-tokyo.par")), patchBake = bakeMeshGrid(par("patchjgd-tohoku.par"));
{
	ok(tkyBake.meta.transform === "tky2jgd" && tkyBake.meta.version === "JGD2000-TokyoDatum Ver.2.1.2" && tkyBake.meta.cells === 400 && tkyBake.meta.blocks === 4, "bakeMeshGrid: TKY2JGD の抜粋（400 セル・4 ブロック）と種別の推定");
	ok(patchBake.meta.transform === "patchjgd" && /PatchJGD\s+Ver\.4\.0\.0/.test(patchBake.meta.version) && patchBake.meta.cells === 400, "bakeMeshGrid: PatchJGD は説明行が 16 行あっても データ行だけ拾う");
	ok(tkyBake.meta.resScale === 1e-5 && patchBake.meta.resScale === 1e-5, "滑らかな抜粋はどちらも最細の目盛り 1e-5″（0.3 mm）に収まる");
	// 目盛りはブロック内の跳びで決まる（全国版 TKY2JGD は島嶼で 4.4″ 跳ぶので 1e-3″ になる）
	const jump = bakeMeshGrid("JGD2000-TokyoDatum Ver.test\nMeshCode dB dL\n53394500   0.00000   0.00000\n53394501   6.60000   0.00000\n");
	ok(jump.meta.resScale === 1e-3 && jump.meta.cells === 2, `ブロック内で 6.6″ 跳ぶと目盛りは ${jump.meta.resScale}″ に落ちる（Int16 に収める）`);
	const jumped = parseMeshGrid(jump.bytes);
	ok(near(jumped.cell(4280, 11170)[0], 0, 1e-3) && near(jumped.cell(4280, 11171)[0], 6.6, 1e-3), "粗い目盛りでも元の値に 1e-3″ 以内で戻る");
	ok(tkyBake.maxResidualArcsec < 0.05 && patchBake.maxResidualArcsec < 0.02, `量子化の丸め: 最大残差 ${tkyBake.maxResidualArcsec}" / ${patchBake.maxResidualArcsec}"`);
	let threw = ""; try { bakeMeshGrid("説明だけで数値が無い\n"); } catch (e) { threw = e.message; } ok(/データ行が無い/.test(threw), "データ行の無い .par は拒否");
	threw = ""; try { parseMeshGrid(new Uint8Array(64)); } catch (e) { threw = e.message; } ok(/形式が違う/.test(threw), "形式違いは拒否");
}

// ── 日本測地系 → JGD2000 ──────────────────────────────────────────────────────
const tky = parseMeshGrid(tkyBake.bytes);
const TOKYO_PT = [139.7669, 35.6812];
{
	// 3 次メッシュ 53394550 の南西端では .par の値そのもの
	const lat = 53 / 1.5 + 4 * 5 / 60 + 5 * 30 / 3600, lon = 139 + 5 * 7.5 / 60;
	const [, dB, dL] = par("tky2jgd-tokyo.par").split("\n").find(l => l.startsWith("53394550")).trim().split(/\s+/);
	const r = tky.shift([lon + 1e-9, lat + 1e-9]);
	ok(near((r[1] - lat) * 3600, +dB, 6e-4) && near((r[0] - lon) * 3600, +dL, 6e-4), `格子: メッシュ南西端で .par の値（dB ${dB} dL ${dL}）に 1e-3″ 以内`);
	const g = tky.shift(TOKYO_PT), h = tokyoHelmert(TOKYO_PT);
	ok(g && near((g[0] - TOKYO_PT[0]) * 3600, -11.6, 0.2) && near((g[1] - TOKYO_PT[1]) * 3600, 11.6, 0.2), "格子: 東京で経度 −11.6″・緯度 +11.6″（≈ 西 290 m・北 360 m）");
	ok(near(g[0], h[0], 1 / 90000) && near(g[1], h[1], 1 / 111000), "内蔵 Helmert は東京で格子と 1 m 以内");
	ok(tky.shift([100, 10]) === null && tky.shift([141.35, 43.06]) === null, "格子外（抜粋に無い札幌・海外）は null");
	const before = tky.stats.miss;
	ok(tokyoToJGD([141.35, 43.06], tky)[0] > 141.34 && tky.stats.miss === before + 1 && tokyoToJGD(TOKYO_PT, tky)[0] === g[0], "tokyoToJGD: 格子外は Helmert に落ちて数える");
	const c0 = crsFromWKT(GEOG_TOKYO), c1 = crsFromWKT(GEOG_TOKYO, { datum: { tokyo: tky } });
	ok(c0.kind === "datum" && c0.approx && /Helmert/.test(c0.label) && near(c0.toLonLat(TOKYO_PT)[1], h[1], 1e-12), "GCS_Tokyo（格子なし）＝Helmert 近似で経緯度へ");
	ok(c1.kind === "datum" && !c1.approx && /TKY2JGD/.test(c1.label) && c1.toLonLat(TOKYO_PT)[1] === g[1], "GCS_Tokyo（格子あり）＝格子で経緯度へ");
	// 旧測地系の平面直角座標系 IX＝Bessel の TM を逆変換してから測地系変換
	const zone9Tokyo = `PROJCS["Tokyo_Japan_Zone_9",${GEOG_TOKYO},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",139.8333333333333],PARAMETER["Scale_Factor",0.9999],PARAMETER["Latitude_Of_Origin",36.0],UNIT["Meter",1.0]]`;
	const xy = tmForward({ a: 6377397.155, f: 1 / 299.1528128, k0: 0.9999, lat0: 36, lon0: 139 + 50 / 60, fe: 0, fn: 0 })(TOKYO_PT);
	const c2 = crsFromWKT(zone9Tokyo, { datum: { tokyo: tky } }), b2 = c2.toLonLat(xy);
	ok(c2.kind === "projected" && /TKY2JGD/.test(c2.label) && near(b2[0], g[0], 1e-9) && near(b2[1], g[1], 1e-9), "Tokyo_Japan_Zone_9: Bessel で逆変換してから格子で JGD へ");
}

// ── JGD2000 → JGD2011（PatchJGD）────────────────────────────────────────────
const patch = parseMeshGrid(patchBake.bytes);
const TOHOKU_PT = [141.30, 38.45], WEST_PT = [135.5, 34.7];
{
	// 3 次メッシュ 57415200 の南西端では .par の値そのもの（残差 1e-5″＝0.3 mm）
	const lat = 57 / 1.5 + 5 * 5 / 60, lon = 141 + 2 * 7.5 / 60;
	const [, dB, dL] = par("patchjgd-tohoku.par").split("\n").find(l => l.startsWith("57415200")).trim().split(/\s+/);
	const r = patch.shift([lon + 1e-9, lat + 1e-9]);
	ok(near((r[1] - lat) * 3600, +dB, 1e-5) && near((r[0] - lon) * 3600, +dL, 1e-5), `PatchJGD: メッシュ南西端で .par の値（dB ${dB} dL ${dL}）に 1e-5″ 以内`);
	const q = patch.shift(TOHOKU_PT);
	const dxm = (q[0] - TOHOKU_PT[0]) * 111320 * Math.cos(38.45 * Math.PI / 180), dym = (q[1] - TOHOKU_PT[1]) * 111132;
	ok(near(dxm, 4.4, 0.3) && near(dym, -1.6, 0.3), `PatchJGD: 気仙沼付近で東 ${dxm.toFixed(2)} m・南 ${(-dym).toFixed(2)} m（2011 年の地殻変動）`);
	ok(patch.shift(WEST_PT) === null && jgd2000To2011(WEST_PT, patch) === WEST_PT, "対象域の外（西日本）は格子が無く、無変換でそのまま返る");
	ok(jgd2000To2011(TOHOKU_PT, patch)[0] === q[0] && jgd2000To2011(TOHOKU_PT, null)[0] === TOHOKU_PT[0], "jgd2000To2011: 格子が無ければ無変換");
	// WKT: JGD2000 は格子がある時だけ変換になる
	const noPatch = crsFromWKT(GEOG_JGD2000), withPatch = crsFromWKT(GEOG_JGD2000, { datum: { patch } });
	ok(noPatch.kind === "lonlat" && !noPatch.toLonLat, "JGD2000（格子なし）＝そのまま経緯度（従来どおり）");
	ok(withPatch.kind === "datum" && !withPatch.approx && /PatchJGD/.test(withPatch.label) && withPatch.toLonLat(TOHOKU_PT)[0] === q[0], "JGD2000（格子あり）＝JGD2011 へ寄せる");
	ok(crsFromWKT(GEOG_JGD2011, { datum: { patch } }).kind === "lonlat", "JGD2011 は格子があっても素通し（二重に足さない）");
	// Tokyo → JGD2000 → JGD2011 の連鎖
	const chain = crsFromWKT(GEOG_TOKYO, { datum: { tokyo: tky, patch } });
	ok(chain.kind === "datum" && /Tokyo→JGD2011/.test(chain.label) && /TKY2JGD/.test(chain.label) && /PatchJGD/.test(chain.label), `連鎖のラベル: ${chain.label}`);
	const viaChain = chain.toLonLat(TOKYO_PT), viaSteps = jgd2000To2011(tokyoToJGD(TOKYO_PT, tky), patch);
	ok(viaChain[0] === viaSteps[0] && viaChain[1] === viaSteps[1], "連鎖＝Tokyo→JGD2000→JGD2011 を順に適用したものと同じ");
	// JGD2000 の平面直角座標系（EPSG:2451 相当）も後段で効く
	const zone9_2000 = `PROJCS["JGD2000 / Japan Plane Rectangular CS IX",${GEOG_JGD2000},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",139.833333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","2451"]]`;
	const c = crsFromWKT(zone9_2000, { datum: { patch } });
	const xy = tmForward({ a: 6378137, f: 1 / 298.257222101, k0: 0.9999, lat0: 36, lon0: 139 + 50 / 60, fe: 0, fn: 0 })(TOHOKU_PT);
	ok(c.kind === "projected" && c.label === "EPSG:2451 → JGD2000→JGD2011 (PatchJGD)" && near(c.toLonLat(xy)[0], q[0], 1e-9) && near(c.toLonLat(xy)[1], q[1], 1e-9), "EPSG:2451（JGD2000 平面直角 IX）→ 逆変換してから PatchJGD");
}

// ── 入口が受け取る形 ──────────────────────────────────────────────────────────
{
	const viaGz = await loadMeshGrid(new Uint8Array(gzipSync(tkyBake.bytes)));
	ok(viaGz.blocks === 4 && viaGz.transform === "tky2jgd" && viaGz.shift(TOKYO_PT)[0] === tky.shift(TOKYO_PT)[0], "loadMeshGrid: gzip のバイト列を署名で展開");
	const d = await resolveDatum({ tky2jgd: tkyBake.bytes, patchjgd: patchBake.bytes });
	ok(d.tokyo?.transform === "tky2jgd" && d.patch?.transform === "patchjgd", "resolveDatum: 2 本を種別つきで受け取る");
	ok(await resolveDatum({}) === null && (await resolveDatum({ patchjgd: patchBake.bytes })).tokyo === null, "resolveDatum: 何も渡さなければ null・片方だけも可");
	const swapped = await resolveDatum({ tky2jgd: patchBake.bytes });
	ok(swapped === null, "resolveDatum: 取り違え（tky2jgd に PatchJGD）は使わない");
	const broken = await resolveDatum({ tky2jgd: new Uint8Array(32) });
	ok(broken === null, "resolveDatum: 壊れた格子は警告して近似に落ちる");
	const passthrough = await resolveDatum({ tky2jgd: tky });
	ok(passthrough.tokyo === tky, "resolveDatum: 読み込み済みの格子はそのまま");
	d.tokyo.stats.hit = 3; d.tokyo.stats.miss = 1; d.patch.stats.hit = 5; d.patch.stats.miss = 2;
	ok(JSON.stringify(datumStats(d)) === JSON.stringify({ tky2jgd: { grid: 3, helmert: 1 }, patchjgd: { grid: 5, outside: 2 } }) && datumStats(null) === null, "datumStats: 何点を格子で引けたか");
}

// ── GeoPackage の definition 経由（同じ判定器）────────────────────────────────
{
	const c3 = classifyCrs({ id: 6677, org: "EPSG", code: 6677, definition: `PROJCS["JGD2011 / Japan Plane Rectangular CS IX",${GEOG_JGD2011},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",139.833333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]` });
	ok(c3.kind === "projected" && /EPSG:6677/.test(c3.label) && near(c3.toLonLat([0, 0])[0], 139 + 50 / 60, 1e-9) && near(c3.toLonLat([0, 0])[1], 36, 1e-9), "gpkg の definition（EPSG:6677 平面直角 IX）を逆変換");
	ok(classifyCrs({ id: 4301, org: "EPSG", code: 4301, definition: GEOG_TOKYO }).kind === "datum", "gpkg の EPSG:4301（Tokyo）＝測地系変換");
	ok(classifyCrs({ id: 4612, org: "EPSG", code: 4612, definition: GEOG_JGD2000 }).kind === "lonlat" && classifyCrs({ id: 4612, org: "EPSG", code: 4612, definition: GEOG_JGD2000 }, { patch }).kind === "datum", "gpkg の EPSG:4612（JGD2000）＝格子を渡した時だけ JGD2011 へ");
}

console.log(fails ? `\n✗ ${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
