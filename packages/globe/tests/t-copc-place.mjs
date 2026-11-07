// COPC の節の置き方（src/copc-place.js・点群計画 段 2-1）の検定。node tests/t-copc-place.mjs
//  ① 熱海の大きさ（平面直角 VIII 系・根 400 m〜葉 25 m）＝二次式で置いた点が 1 点ずつ置いた点と 1 cm 以内・近似が使われる
//  ② 広い節（20 km）＝ずれが 1 cm を超える＝1 点ずつに戻る（結果は従来と同じ）
//  ③ 速さ＝近似は 1 点ずつより速い（数字は出すだけ）
import assert from "node:assert/strict";
import { crsFromWKT } from "geopbf/proj";
import { placeNode, dumpEnu, dumpStride, R_SPHERE } from "../src/copc-place.ts";
import { geoWorld, earthW } from "../src/meshdecode.ts";

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
t("④ 丸ごと＝錨からの東北上 m（dumpEnu・map.readPointCloud）＝経緯度から直に置いた物と 1 mm 以内・間引き", () => {
	const c = cloud(200, 5000), a = ll([C[0], C[1]]), anchor = [a[0], a[1], 150];
	const out = { pts: new Float32Array(c.n * 3), elev: new Float32Array(c.n), at: 0, bb: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
	dumpEnu(c.r, c.n, { ll, vUnit: 1, dz: -40, anchor }, out);
	assert.equal(out.at, c.n);
	const ce = Math.cos(anchor[1] * D2R) * D2R * R_SPHERE, cn = D2R * R_SPHERE;
	for (let i = 0; i < c.n; i += 97) {
		const g = ll([c.r.x[i], c.r.y[i]]), e = (g[0] - anchor[0]) * ce, nn = (g[1] - anchor[1]) * cn, u = c.r.z[i] - 40 - 150 - (e * e + nn * nn) / (2 * R_SPHERE);
		assert.ok(Math.abs(out.pts[i * 3] - e) < 1e-3 && Math.abs(out.pts[i * 3 + 1] - nn) < 1e-3 && Math.abs(out.pts[i * 3 + 2] - u) < 1e-3, `point ${i}`);
		assert.ok(Math.abs(out.elev[i] - (c.r.z[i] - 40)) < 1e-3);   // Float32
	}
	assert.ok(out.bb[0] < -150 && out.bb[3] > 150 && out.bb[1] < -150 && out.bb[4] > 150, JSON.stringify(out.bb));   // 400 m 角
	// 2 回に分けて詰めても同じ（at が進む）
	const half = { pts: new Float32Array(c.n * 3), elev: new Float32Array(c.n), at: 0, bb: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
	const sub = k0 => ({ x: c.r.x.subarray(k0), y: c.r.y.subarray(k0), z: c.r.z.subarray(k0) });
	dumpEnu(c.r, 2000, { ll, vUnit: 1, dz: -40, anchor }, half); dumpEnu(sub(2000), c.n - 2000, { ll, vUnit: 1, dz: -40, anchor }, half);
	assert.deepEqual([...half.pts.subarray(6000, 6009)], [...out.pts.subarray(6000, 6009)]); assert.deepEqual(half.bb, out.bb);
	assert.equal(dumpStride(100, 0), 1); assert.equal(dumpStride(100, 100), 1); assert.equal(dumpStride(1000, 300), 4); assert.equal(dumpStride(9_500_000, 4e6), 3);
});
console.log(`\n全 ${k} 件通過`);
