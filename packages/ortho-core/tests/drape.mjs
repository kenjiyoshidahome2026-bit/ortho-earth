#!/usr/bin/env node
// 3D Tiles に重ねる絵（drape.ts＝set "meshDrape"・Cesium3DTileset.imageryLayers）の平面写像。外部データ不要＝決定的。
//   1. 窓の四隅と中心が uv の (0,0)・(1,1)・(0.5,0.5) 前後（Mercator の行・北が上）
//   2. 束の原点に合わせた 12 値（drapeUniforms）で引いても同じ uv（原点の差は double で）
//   3. 測地法線の向きに持ち上げた点（屋上）は真下と同じ uv（真上から投げる）
//   4. 球・楕円体の両方
// 使い方: node packages/ortho-core/tests/drape.mjs
import { drapeMap, drapeUniforms } from '../src/drape.ts';
import { lonlatTo3D, ellNormal3D, setEllipsoid } from '../src/camera.ts';

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const W = { west: -75.1855, south: 39.962, east: -75.1756, north: 39.9682 };
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
for (const ell of [false, true]) {
	setEllipsoid(ell);
	console.log(`― ${ell ? '楕円体' : '球'} ―`);
	const m = drapeMap(W);
	ok(!!m, 'drapeMap が作れる');
	const O = lonlatTo3D(-75.18, 39.965), u = new Float32Array(12);
	drapeUniforms(u, 0, m, O);
	const uvAt = (lon, lat, h = 0) => {
		const P = lonlatTo3D(lon, lat), n = ellNormal3D(lon, lat), k = h / 6378137;
		const p = [P[0] + n[0] * k - O[0], P[1] + n[1] * k - O[1], P[2] + n[2] * k - O[2]];
		return [u[0] * p[0] + u[1] * p[1] + u[2] * p[2] + u[3], u[4] * p[0] + u[5] * p[1] + u[6] * p[2] + u[7]];
	};
	const near = (a, b, tol = 2e-3) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
	ok(near(uvAt(W.west, W.north), [0, 0]), `北西の隅＝(0,0)：${uvAt(W.west, W.north).map(v => v.toFixed(4))}`);
	ok(near(uvAt(W.east, W.south), [1, 1]), `南東の隅＝(1,1)：${uvAt(W.east, W.south).map(v => v.toFixed(4))}`);
	const lat = 39.9651, vWant = (mercY(W.north) - mercY(lat)) / (mercY(W.north) - mercY(W.south));
	ok(near(uvAt(-75.18, lat), [(-75.18 - W.west) / (W.east - W.west), vWant]), `内側の点＝経度の比・Mercator の行`);
	ok(near(uvAt(-75.18, lat, 150), uvAt(-75.18, lat), 1e-4), `150 m 上の点は真下と同じ uv`);
	ok(u[8] === 1, 'dr2.x／u_drOn＝1');
	const off = new Float32Array(12).fill(7); drapeUniforms(off, 0, null, O);
	ok(off.every(v => v === 0), '絵なし＝12 値とも 0');
	ok(drapeMap({ west: 1, south: 2, east: 1, north: 3 }) === null, '幅 0 の窓＝null');
}
setEllipsoid(false);
if (fails) { console.error(`✗ ${fails} 件`); process.exit(1); }
console.log('✓ drape');
