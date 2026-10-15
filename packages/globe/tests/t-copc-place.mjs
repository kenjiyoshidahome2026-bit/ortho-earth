// COPC の節の置き方（src/copc-place.js・点群計画 段 2-1）の検定。node tests/t-copc-place.mjs
//  ① 熱海の大きさ（平面直角 VIII 系・根 400 m〜葉 25 m）＝二次式で置いた点が 1 点ずつ置いた点と 1 cm 以内・近似が使われる
//  ② 広い節（20 km）＝ずれが 1 cm を超える＝1 点ずつに戻る（結果は従来と同じ）
//  ③ 速さ＝近似は 1 点ずつより速い（数字は出すだけ）
import assert from "node:assert/strict";
import { crsFromWKT } from "geopbf/proj";
import { placeNode } from "../src/copc-place.js";
import { geoWorld, earthW } from "../src/meshdecode.js";

const VIII = `PROJCS["JGD2011 / Japan Plane Rectangular CS VIII",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",138.5],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]`;
const crs = crsFromWKT(VIII), ll = crs.toLonLat, EW = earthW(), D2R = Math.PI / 180;
const C = [53000, -98850, 150];   // 熱海の図郭 08NF2392 の中ほど（m）
const cloud = (half, n = 20000) => {
	const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
	for (let i = 0; i < n; i++) { x[i] = C[0] + (Math.random() * 2 - 1) * half; y[i] = C[1] + (Math.random() * 2 - 1) * half; z[i] = C[2] + (Math.random() * 2 - 1) * half; }
	return { r: { x, y, z }, n, bounds: [C[0] - half, C[1] - half, C[2] - half, C[0] + half, C[1] + half, C[2] + half] };
};
const exactErr = ({ r, n }, out, dz) => {   // 置いた点と、1 点ずつの本物の差の最大（m）
	const w = [0, 0, 0]; let e = 0;
	for (let i = 0; i < n; i++) {
		const [lon, lat] = ll([r.x[i], r.y[i]]); geoWorld(lon * D2R, lat * D2R, (r.z[i] + dz) / EW, w);
		for (let j = 0; j < 3; j++) e = Math.max(e, Math.abs(out.origin[j] + out.pos[i * 3 + j] - w[j]));
	}
	return e * EW;
};
let k = 0;
const t = (name, fn) => { fn(); k++; console.log("  ✔", name); };

t("熱海の大きさ（400 m〜25 m）＝近似・1 点ずつと 1 cm 以内", () => {
	for (const half of [200, 100, 50, 12.5]) {
		const c = cloud(half), out = placeNode(c.r, c.n, { ll, vUnit: 1, dz: -40, EW, bounds: c.bounds });
		assert.ok(out.affine, `${half * 2} m の節が近似でない（ずれ ${out.errM}）`);
		const e = exactErr(c, out, -40);
		assert.ok(e < 0.01, `${half * 2} m の節のずれ ${e} m`);
		assert.ok(Math.abs(out.elev[0] - (c.r.z[0] - 40)) < 1e-3);
	}
});
t("広い節（20 km）＝1 点ずつに戻る", () => {
	const c = cloud(10000, 2000), out = placeNode(c.r, c.n, { ll, vUnit: 1, dz: 0, EW, bounds: c.bounds });
	assert.equal(out.affine, false);
	assert.ok(exactErr(c, out, 0) < 0.01);
});
t("速さ（20 万点）", () => {
	const c = cloud(100, 200000);
	let t0 = performance.now(); placeNode(c.r, c.n, { ll, vUnit: 1, dz: 0, EW, bounds: c.bounds }); const a = performance.now() - t0;
	t0 = performance.now(); placeNode(c.r, c.n, { ll, vUnit: 1, dz: 0, EW, bounds: c.bounds, tolM: -1 }); const b = performance.now() - t0;
	console.log(`     近似 ${a.toFixed(1)} ms・1 点ずつ ${b.toFixed(1)} ms（×${(b / a).toFixed(1)}）`);
	assert.ok(a < b);
});
console.log(`\n全 ${k} 件通過`);
