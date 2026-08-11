#!/usr/bin/env node
// 楕円体カメラ（段階B・?ell=1）の検証ハーネス。外部データ不要＝決定的。
//   1. β⇄φ 往復（極・赤道・一般）
//   2. project→unproject 往復（球・楕円体の両モード・チルト/回転込み）
//   3. 球モード回帰＝setEllipsoid(false) で従来値とビット同値（mvp/eye/往復）
//   4. 楕円体の幾何的正しさ：南北1°の画面距離が東西1°·cosφ と M/N 比で食い違う（球では一致）こと
//   5. dβ 閉形式（シェーダ式のJS写経）と厳密 βOf の一致（全域）
// 使い方: node packages/ortho-core/tests/ellipsoid.mjs
import { cameraState, project, unproject, lonlatTo3D, setEllipsoid, betaOf, geodeticOf, ellNormal3D }
	from '../src/camera.js';
import { meridionalRadius, primeVerticalRadius } from '../src/geodesic.js';

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const near = (v, r, tol) => Math.abs(v - r) <= tol;
const CAM = (lat = 35.68, zoom = 10, pitch = 0, bearing = 0) =>
	({ center: [139.767, lat], zoom, pitch, bearing, dpr: 1 });

console.log('― β⇄φ 往復 ―');
setEllipsoid(true);
ok([0, 35.68, -89.999, 90, -90, 45].every(p => near(geodeticOf(betaOf(p)), p, 1e-12)), 'geodeticOf(betaOf(φ))=φ（極含む）');
ok(betaOf(35) < 35 && betaOf(-35) > -35, 'β は赤道側へ寄る（|β|<|φ|）');
ok(near(betaOf(35), 35 - (1 / 595.51446) * Math.sin(70 * Math.PI / 180) * 180 / Math.PI, 2e-4), 'β−φ ≈ −ν·sin2φ（ν=f/(2−f)）');

console.log('― project→unproject 往復 ―');
for (const ell of [false, true]) {
	setEllipsoid(ell);
	let worst = 0;
	for (const [lat, zoom, pitch, bearing] of [[35.68, 10, 0, 0], [35.68, 16, 55 * Math.PI / 180, 0.7], [-38, 6, 0.4, 2], [68, 4, 0, 0]]) {
		const st = cameraState(CAM(lat, zoom, pitch, bearing), 900, 650);
		for (const [dx, dy] of [[0, 0], [0.2, 0.1], [-0.3, 0.25]]) {
			const ll = unproject(st, 450 + dx * 400, 325 + dy * 300);
			if (!ll) continue;
			const [sx, sy] = project(st, ll[0], ll[1]);
			worst = Math.max(worst, Math.hypot(sx - (450 + dx * 400), sy - (325 + dy * 300)));
		}
	}
	ok(worst < 1e-6, `${ell ? '楕円体' : '球'}モード往復誤差 = ${worst.toExponential(1)} px`);
}

console.log('― 球モード回帰（ビット同値） ―');
setEllipsoid(false);
const stA = cameraState(CAM(35.68, 12, 0.5, 1.2), 800, 600);
const refU = lonlatTo3D(139.767, 35.68);
// 従来式の直写経（楕円体改修前の lonlatTo3D/cameraState と同じ演算列）と突合
const D2R = Math.PI / 180;
const oldU = (lon, lat) => { const a = lon * D2R, b = lat * D2R, cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
ok(refU.every((v, i) => v === oldU(139.767, 35.68)[i]), 'lonlatTo3D＝旧式とビット同値');
ok(near(geodeticOf(12.34), 12.34, 0) && near(betaOf(-56.7), -56.7, 0), 'β変換＝球では厳密恒等');
const p1 = project(stA, 139.8, 35.7), u1 = unproject(stA, p1[0], p1[1]);
ok(near(u1[0], 139.8, 1e-9) && near(u1[1], 35.7, 1e-9), '球の project/unproject 健在');

console.log('― 楕円体の幾何（画面上の度の長さ＝M/N 比） ―');
setEllipsoid(true);
{
	// 真俯瞰・画面中心近傍：南北 dφ の画面距離／東西 dλ の画面距離 は (M·dφ)/(N·cosφ·dλ) になるはず
	const lat = 35.68, st = cameraState(CAM(lat, 9), 1000, 1000);
	const c = project(st, 139.767, lat), n = project(st, 139.767, lat + 0.2), e = project(st, 140.0, lat);
	const pxNS = Math.hypot(n[0] - c[0], n[1] - c[1]) / 0.2;                      // px/度（南北）
	const pxEW = Math.hypot(e[0] - c[0], e[1] - c[1]) / (140.0 - 139.767);        // px/度（東西）
	const wantRatio = meridionalRadius(lat) / (primeVerticalRadius(lat) * Math.cos(lat * D2R));
	const gotRatio = pxNS / pxEW;
	ok(near(gotRatio, wantRatio, wantRatio * 2e-3), `南北/東西の画面比 = ${gotRatio.toFixed(5)}（楕円体論値 ${wantRatio.toFixed(5)}）`);
	setEllipsoid(false);
	const st2 = cameraState(CAM(lat, 9), 1000, 1000);
	const c2 = project(st2, 139.767, lat), n2 = project(st2, 139.767, lat + 0.2), e2 = project(st2, 140.0, lat);
	const sphRatio = (Math.hypot(n2[0] - c2[0], n2[1] - c2[1]) / 0.2) / (Math.hypot(e2[0] - c2[0], e2[1] - c2[1]) / 0.233);
	ok(near(sphRatio, 1 / Math.cos(lat * D2R), 1 / Math.cos(lat * D2R) * 2e-3), `球は 1/cosφ = ${sphRatio.toFixed(5)}（対照）`);
}

console.log('― dβ 閉形式（シェーダ式の写経）＝厳密βと一致 ―');
setEllipsoid(true);
{
	// β = φ − ν·sin2φ + (ν²/2)·sin4φ の差分・積形式（シェーダ dBeta と同式）
	const f = 1 / 298.257223563, NU = f / (2 - f), NU2 = NU * NU / 2;
	const dBeta = (dp, p0) => {
		const c2 = Math.cos(2 * p0), s2 = Math.sin(2 * p0), c4 = Math.cos(4 * p0), s4 = Math.sin(4 * p0);
		const sd = Math.sin(dp), cd = Math.cos(dp), s2d = Math.sin(2 * dp), c2d = Math.cos(2 * dp);
		return dp - 2 * NU * (c2 * cd - s2 * sd) * sd + 2 * NU2 * (c4 * c2d - s4 * s2d) * s2d;
	};
	let worst = 0;
	for (const p0 of [0, 20, 35.68, 55, 75, -40]) for (const dp of [-40, -10, -1, -0.01, 0, 0.01, 1, 10, 40, 80]) {
		const phi = p0 + dp; if (Math.abs(phi) > 89.9) continue;
		const exact = (betaOf(phi) - betaOf(p0)) * D2R;
		const got = dBeta(dp * D2R, p0 * D2R);
		worst = Math.max(worst, Math.abs(got - exact) * 6378137);   // rad→m（世界単位=a）
	}
	ok(worst < 0.03, `全域最大誤差 = ${(worst * 100).toFixed(2)} cm（< 3cm）`);
}

console.log('― 測地法線 ―');
setEllipsoid(true);
{
	// S·m が単位測地法線 n_geo に一致（|S·m|=1・β球面と接平面が直交するのは球のみ＝mは動径からずれる）
	const m = ellNormal3D(139, 35), r = 1 - 1 / 298.257223563;
	const w = [m[0], r * m[1], m[2]];
	ok(near(Math.hypot(...w), 1, 1e-12), '|S·m| = 1（worldで単位法線）');
	const u = lonlatTo3D(139, 35);
	ok(Math.abs(1 - (m[0] * u[0] + m[1] * u[1] + m[2] * u[2]) / Math.hypot(...m)) > 1e-7, 'm は β動径と別方向（楕円体で有意）');
}
setEllipsoid(false);   // 後続テストへの汚染防止

console.log(fails ? `\n${fails} 件失敗` : '\n全件通過');
process.exit(fails ? 1 : 0);
