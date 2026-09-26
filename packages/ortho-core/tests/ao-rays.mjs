#!/usr/bin/env node
// AO の位置の復元（#46 段 3・2026-09-26 の根治）の検証ハーネス。外部データ不要＝決定的。GPU の f32 を Math.fround で写す。
//   1. aoRays（f64 の視線基底）＝画面の点を P＝w·(F＋x·X＋y·Y) で戻すと、f32 でも目からの相対位置が相対 1e-6 以内（球・楕円体・チルト/回転込み）
//   2. 旧式＝invMvp（f32）を列順に積和して近平面と遠平面から視線を作ると、近景のチルトで 1 画素以上ずれる（縦縞の正体・再発させない理由の記録）
//   3. 対数深度の逆：expm1 の級数は exp2(x)−1（f32）より桁が残る＝近景の w が 0.76m 刻みにならない
// 使い方: node packages/ortho-core/tests/ao-rays.mjs
import { cameraState, lonlatTo3D, setEllipsoid } from '../src/camera.js';
import { aoRays } from '../src/gpu/ao.js';

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const f = Math.fround, D2R = Math.PI / 180;
const CASES = [[16.5, 60, 30, 139.7671, 35.6812], [19, 75, 100, 139.7655, 35.6812], [12, 70, 0, 138.73, 35.36], [8, 40, 200, -70, -33], [3, 0, 0, 139, 36]];
// 決定的な擬似乱数（検定の再現性）
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

console.log('― aoRays（f64 の基底）＝f32 でも位置が戻る ―');
for (const ell of [false, true]) {
	setEllipsoid(ell);
	for (const [z, pitch, brg, lon, lat] of CASES) {
		const st = cameraState({ center: [lon, lat], zoom: z, pitch: pitch * D2R, bearing: brg * D2R, dpr: 1 }, 1280, 800);
		const r = aoRays(st.mvp, st.invMvp), R = { F: r.F.map(f), X: r.X.map(f), Y: r.Y.map(f) };
		let worst = 0, n = 0;
		const span = 0.02 / 2 ** Math.max(0, z - 12);
		for (let k = 0; k < 400; k++) {
			const p = lonlatTo3D(lon + (rnd() - 0.5) * span, lat + (rnd() - 0.5) * span);
			const m = st.mvp, c = [0, 1, 2, 3].map(i => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
			if (c[3] <= 0 || Math.abs(c[0] / c[3]) > 1 || Math.abs(c[1] / c[3]) > 1) continue;
			const nx = f(c[0] / c[3]), ny = f(c[1] / c[3]), w = f(c[3]);
			const P = [0, 1, 2].map(i => f(f(f(R.F[i] + f(nx * R.X[i])) + f(ny * R.Y[i])) * w));
			const T = [0, 1, 2].map(i => p[i] - st.eye[i]);
			worst = Math.max(worst, Math.hypot(P[0] - T[0], P[1] - T[1], P[2] - T[2]) / Math.hypot(...T)); n++;
		}
		ok(n > 50 && worst < 1e-6, `${ell ? "楕円体" : "球"} z${z} チルト${pitch}°：相対誤差 ${worst.toExponential(1)}（${n} 点）`);
	}
}
setEllipsoid(false);

console.log('― 旧式（invMvp を f32 で積和）は近景のチルトで画素単位にずれる＝戻さない理由 ―');
{
	const st = cameraState({ center: [139.7671, 35.6812], zoom: 16.5, pitch: 60 * D2R, bearing: 30 * D2R, dpr: 1 }, 1280, 800);
	const M = Float32Array.from(st.invMvp);
	const mul32 = (x, y, z, w) => [0, 1, 2, 3].map(r => { let s = f(M[r] * x); s = f(s + f(M[4 + r] * y)); s = f(s + f(M[8 + r] * z)); return f(s + f(M[12 + r] * w)); });
	const mul64 = (x, y, z, w) => [0, 1, 2, 3].map(r => st.invMvp[r] * x + st.invMvp[4 + r] * y + st.invMvp[8 + r] * z + st.invMvp[12 + r] * w);
	const dir = (mul, x, y) => { const a = mul(x, y, 0, 1), b = mul(x, y, 1, 1), d = [0, 1, 2].map(i => b[i] / b[3] - a[i] / a[3]), l = Math.hypot(...d); return d.map(v => v / l); };
	const pxRad = 2 * Math.tan(25 * D2R) / 800;
	let worst = 0;
	for (let px = 600; px < 660; px++) { const x = (px + 0.5) / 640 - 1, y = 1 - 500.5 / 400, a = dir(mul64, x, y), b = dir(mul32, x, y); worst = Math.max(worst, Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) / pxRad); }
	ok(worst > 1, `invMvp（要素 ${Math.max(...st.invMvp.map(Math.abs)).toExponential(1)}）の f32 視線は最大 ${worst.toFixed(1)} 画素ずれる（>1）`);
}

console.log('― 対数深度の逆（w＝expm1(z·2ln2/logCoef)）＝近景で桁が残る ―');
{
	const expm1s = x => x < 0.1 ? f(x * f(1 + f(x * f(0.5 + f(x * f(0.16666667 + f(x * f(0.041666668 + f(x * f(0.008333334 + f(x * 0.0013888889))))))))))) : f(f(Math.exp(x)) - 1);
	let worstNew = 0, worstOld = 0;
	for (const wM of [30, 80, 300, 1500, 8000]) {
		const w = wM / 6371000, far = 0.02, logCoef = 2 / Math.log2(far + 1);
		const z = f(0.5 * logCoef * Math.log2(1 + w));   // 深度テクスチャの値（f32）
		const x = f(z * f(2 * Math.LN2 / logCoef));
		worstNew = Math.max(worstNew, Math.abs(expm1s(x) - w) / w);
		worstOld = Math.max(worstOld, Math.abs(f(f(2 ** f(2 * z / logCoef)) - 1) - w) / w);
	}
	ok(worstNew < 1e-5, `expm1 の級数：相対誤差 ${worstNew.toExponential(1)}（30m〜8km）`);
	ok(worstOld > 1e-3, `旧 exp2(x)−1：相対誤差 ${worstOld.toExponential(1)}（30m で数 cm〜m の段＝まだらの正体）`);
}

console.log(fails ? `\n✗ ${fails} 件失敗` : '\nPASS');
process.exit(fails ? 1 : 0);
