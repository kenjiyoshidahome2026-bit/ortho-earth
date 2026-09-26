#!/usr/bin/env node
// 全画面レイキャスト（球の床・海面下・経緯線・等高線・夜面）の視線（#65・2026-09-27）の検定ハーネス。外部データ不要＝決定的。GPU の f32 を Math.fround で写す。
//   1. 旧式＝invMvp（f32）を GPU で積和して近平面・遠平面から視線を作り、t＝(−b−√h)/2a で球に当てる＝高ズームのチルトで床の当たりが
//      ズームの摂動（+0.0005＝画面では 0.03% の拡大）で 1 画素以上跳ぶ（鋸歯の正体・戻さない理由の記録）
//   2. 新式＝CPU f64 の基底（camera.js viewRays）＋c＝|E|²−1 を f64 で渡し、t＝2c/(−b＋√h)、交点は原点相対 δ＝EO＋t·d（f32 で mm 級）＝
//      同じ摂動で床の当たりは 0.05 画素未満。（目の絶対位置 E＋t·d で持つと |E|≈1 の f32 刻み 6e-8＝0.4 m でまだ 1〜3 画素跳ぶ＝δ で持つ理由）
//   3. deltaLL（δ → 経緯度の差の恒等式・f32）＝真の経緯度差と 1e-8°（1 mm）以内・絶対の経緯度（f32 で 1.4 m 刻み）を経ない
//   4. sphereRayUniforms の c と、視線 v の長さ（clip w＝1 の向き）＝f64 で自明に正しい
// 使い方: node packages/ortho-core/tests/globe-rays.mjs
import { cameraState, lonlatTo3D, betaToLonLat as lonlatOf3D, viewRays, sphereRayUniforms, anchorUV, setEllipsoid } from '../src/camera.js';

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const f = Math.fround, D2R = Math.PI / 180, W = 1280, H = 800;
const CASES = [[17.5, 70, 20, 139.7671, 35.6812], [19, 75, 100, 139.7655, 35.6812], [16, 60, 0, 138.73, 35.36]];

// f32 の内積・積和（GPU の作法）
const dot32 = (a, b) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
// 旧式：invMvp（f32）× ndc → A（近）・B（遠）→ d＝B−A → t＝(−b−√h)/2a → 床の点（f32）
function hitOld(st, x, y) {
	const M = Float32Array.from(st.invMvp);
	const mul = (x, y, z, w) => [0, 1, 2, 3].map(r => { let s = f(M[r] * x); s = f(s + f(M[4 + r] * y)); s = f(s + f(M[8 + r] * z)); return f(s + f(M[12 + r] * w)); });
	const np = mul(x, y, -1, 1), fp = mul(x, y, 1, 1);
	const A = [0, 1, 2].map(i => f(np[i] / np[3])), B = [0, 1, 2].map(i => f(fp[i] / fp[3])), d = [0, 1, 2].map(i => f(B[i] - A[i]));
	const aa = dot32(d, d), bb = f(2 * dot32(A, d)), cc = f(dot32(A, A) - 1);
	const disc = f(f(bb * bb) - f(f(4 * aa) * cc));
	if (disc < 0) return null;
	const t = f(f(-bb - f(Math.sqrt(disc))) / f(2 * aa));
	return t < 0 ? null : [0, 1, 2].map(i => f(A[i] + f(t * d[i])));
}
// 新式：基底（f64→f32 の uniform）＋E＋c → d＝F＋x·X＋y·Y → t＝2c/(−b＋√h) → 交点の原点相対 δ＝EO＋t·d（f32）＝wgsl.js/glsl.js の sphereRay と同じ手順。
// 戻りは f64 の O＋δ（＝シェーダが δ から恒等式で作る経緯度の情報量）
const ORIGIN = [139.7671, 35.6812];
function deltaNew(st, x, y) {
	const u = sphereRayUniforms(st, ORIGIN), F = u.F.map(f), X = u.X.map(f), Y = u.Y.map(f), E = u.E.map(f), c = f(u.c), EO = u.EO.map(f);
	const d = [0, 1, 2].map(i => f(f(F[i] + f(x * X[i])) + f(y * Y[i])));
	const aa = dot32(d, d), bb = f(2 * dot32(E, d));
	const disc = f(f(bb * bb) - f(f(4 * aa) * c));
	if (disc < 0) return null;
	const q = f(-bb + f(Math.sqrt(disc)));
	if (q <= 0) return null;
	const t = f(f(2 * c) / q);
	return { dl: [0, 1, 2].map(i => f(EO[i] + f(t * d[i]))), u };
}
function hitNew(st, x, y) { const r = deltaNew(st, x, y); return r && [0, 1, 2].map(i => r.u.O[i] + r.dl[i]); }
// deltaLL（wgsl.js/glsl.js と同式・f32）：δ → 経緯度の差（deg・測地）
function deltaLL32(dl, O, rhoO, beta0, ell) {
	const dlon = f(Math.atan2(f(f(dl[2] * O[0]) - f(dl[0] * O[2])), f(f(f(rhoO * rhoO) + f(dl[0] * O[0])) + f(dl[2] * O[2]))));
	const s = f(f(2 * f(f(O[0] * dl[0]) + f(O[2] * dl[2]))) + f(f(dl[0] * dl[0]) + f(dl[2] * dl[2])));
	const rhoP = f(Math.sqrt(Math.max(f(f(rhoO * rhoO) + s), 0)));
	const drho = f(s / f(rhoP + rhoO));
	const dbeta = f(Math.atan2(f(f(dl[1] * rhoO) - f(drho * O[1])), f(f(rhoP * rhoO) + f(f(O[1] + dl[1]) * O[1]))));
	const b1 = f(beta0 + dbeta);
	const corr = f(ell * f(f(0.0016792203863837047 * f(f(Math.sin(2 * b1)) - f(Math.sin(2 * beta0)))) + f(0.0000014098905530233192 * f(f(Math.sin(4 * b1)) - f(Math.sin(4 * beta0))))));
	return [f(dlon * 57.29577951308232), f(f(dbeta + corr) * 57.29577951308232)];
}
// 床の点をカメラで画面へ戻し、画素で比べる
const toPx = (st, P) => { const m = st.mvp, c = [0, 1, 2, 3].map(i => m[i] * P[0] + m[4 + i] * P[1] + m[8 + i] * P[2] + m[12 + i]); return [(c[0] / c[3] + 1) * W / 2, (1 - c[1] / c[3]) * H / 2]; };
// 真値（f64）：同じ視線基底で t＝2c/(−b＋√h)
function hit64(st, x, y) {
	const r = viewRays(st.mvp, st.invMvp), E = st.eye, d = [0, 1, 2].map(i => r.F[i] + x * r.X[i] + y * r.Y[i]);
	const aa = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, bb = 2 * (E[0] * d[0] + E[1] * d[1] + E[2] * d[2]), c = E[0] ** 2 + E[1] ** 2 + E[2] ** 2 - 1;
	const disc = bb * bb - 4 * aa * c; if (disc < 0) return null;
	const q = -bb + Math.sqrt(disc); if (q <= 0) return null;
	const t = 2 * c / q; return E.map((e, i) => e + t * d[i]);
}
// 床の点の画面上の誤差（f32 の実装 vs f64 の真値・画素）＝ズームやチルトの摂動で誤差が画素単位に変わる＝鋸歯・揺れの正体。
// ズームの摂動（+0.0005）も入れて最悪値を取る（f32 の刻みが偶々合う 1 姿勢で通り抜けない）
function jitter(hit, cam) {
	let worst = 0, n = 0;
	for (const dz of [0, 0.0005]) {
		const st = cameraState({ ...cam, zoom: cam.zoom + dz }, W, H);
		for (let py = 420; py < 800; py += 19) for (let px = 20; px < W; px += 41) {   // 画面の下半分（床が見える側）
			const x = (px + 0.5) / (W / 2) - 1, y = 1 - (py + 0.5) / (H / 2);
			const P = hit(st, x, y), T = hit64(st, x, y);
			if (!P || !T) continue;
			const a = toPx(st, P), b = toPx(st, T);
			worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1])); n++;
		}
	}
	return { worst, n };
}

console.log('― 旧式（invMvp を f32 で積和）＝高ズームのチルトで床がズーム摂動に跳ぶ（戻さない理由） ―');
console.log('― 新式（f64 の基底＋c・t＝2c/(−b＋√h)）＝跳ばない ―');
for (const [z, pitch, brg, lon, lat] of CASES) {
	const cam = { center: [lon, lat], zoom: z, pitch: pitch * D2R, bearing: brg * D2R, dpr: 1 };
	const o = jitter(hitOld, cam), n = jitter(hitNew, cam);
	ok(o.n > 100 && o.worst > 0.5, `旧 z${z} チルト${pitch}°：最大 ${o.worst.toFixed(2)} 画素ずれる（${o.n} 点・>0.5）`);
	ok(n.n > 100 && n.worst < 0.05, `新 z${z} チルト${pitch}°：最大 ${n.worst.toFixed(3)} 画素（${n.n} 点・<0.05）`);
}

console.log('― deltaLL（f32）＝真の経緯度差と 1e-8° 以内（球・楕円体） ―');
for (const ell of [false, true]) {
	setEllipsoid(ell);
	let worst = 0, n = 0;
	for (const [z, pitch, brg] of [[17.5, 70, 20], [12, 60, 0], [5, 30, 90]]) {
		const st = cameraState({ center: ORIGIN, zoom: z, pitch: pitch * D2R, bearing: brg * D2R, dpr: 1 }, W, H);
		for (let py = 300; py < 800; py += 61) for (let px = 20; px < W; px += 97) {
			const x = (px + 0.5) / (W / 2) - 1, y = 1 - (py + 0.5) / (H / 2), r = deltaNew(st, x, y);
			if (!r) continue;
			const { u, dl } = r, P = [0, 1, 2].map(i => u.O[i] + dl[i]);   // δ（f32）を真として、そこから恒等式（f32）で作った差 vs f64 の経緯度差
			const ll = lonlatOf3D(P), truth = [ll[0] - ORIGIN[0], ll[1] - ORIGIN[1]];
			const got = deltaLL32(dl, u.O.map(f), f(u.rho), f(u.beta0), ell ? 1 : 0);
			// 遠く（|δ|≳0.01＝60 km 超）は f32 の相対誤差 1e-7 × |δll| が 1e-9° を超えて当然＝画素も粗い。近景の絶対誤差を見る
			const tol = 1e-8 + Math.hypot(truth[0], truth[1]) * 5e-7;   // 1e-8°＝1 mm（楕円体の補正＝sin の差の f32 刻み 6e-8×0.0017 rad≈6e-9°）
			const err = Math.max(Math.abs(got[0] - truth[0]), Math.abs(got[1] - truth[1]));
			if (err > tol) console.log(`    z${z} px${px} py${py} |δll|=${Math.hypot(...truth).toExponential(2)} err=${err.toExponential(2)}`);
			worst = Math.max(worst, err / tol); n++;
		}
	}
	ok(n > 50 && worst < 1, `${ell ? "楕円体" : "球"}：最悪 ${worst.toFixed(2)}×許容（${n} 点・近景 1e-8°≈1 mm）`);
}
setEllipsoid(false);

console.log('― 基底と c（f64）＝自明に正しい ―');
{
	const st = cameraState({ center: [139.7671, 35.6812], zoom: 17.5, pitch: 70 * D2R, bearing: 20 * D2R, dpr: 1 }, W, H);
	const u = sphereRayUniforms(st), r = viewRays(st.mvp, st.invMvp);
	ok(u.F === st.rays.F && sphereRayUniforms(st).F === u.F && r.F.every((v, i) => v === u.F[i]), 'sphereRayUniforms は st.rays に記憶（フレームに一度）');
	ok(Math.abs(u.c - (st.eye[0] ** 2 + st.eye[1] ** 2 + st.eye[2] ** 2 - 1)) < 1e-15, `c＝|E|²−1＝${u.c.toExponential(3)}（f32 の |E|²−1 だと ${(f(dot32(st.eye.map(f), st.eye.map(f)) - 1) / u.c - 1).toExponential(1)} の相対誤差）`);
	const m = st.mvp, g = [m[3], m[7], m[11]];
	let worst = 0;
	for (const [x, y] of [[0, 0], [1, 1], [-1, 1], [0.3, -0.7]]) { const v = [0, 1, 2].map(i => u.F[i] + x * u.X[i] + y * u.Y[i]); worst = Math.max(worst, Math.abs(g[0] * v[0] + g[1] * v[1] + g[2] * v[2] - 1)); }
	ok(worst < 1e-9, `視線 v の長さ＝clip w が 1（誤差 ${worst.toExponential(1)}）＝P＝E＋w·v`);
	// 床の点の真値（f64）と新式（f32）の差＝画素の 0.01 未満
	const P64 = (() => { const E = st.eye, d = r.F, aa = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, bb = 2 * (E[0] * d[0] + E[1] * d[1] + E[2] * d[2]), t = 2 * u.c / (-bb + Math.sqrt(bb * bb - 4 * aa * u.c)); return E.map((e, i) => e + t * d[i]); })();
	const a = toPx(st, P64), b = toPx(st, hitNew(st, 0, 0));
	ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01, `画面中心の床の点：f64 との差 ${Math.hypot(a[0] - b[0], a[1] - b[1]).toExponential(1)} 画素`);
	const uv = anchorUV([139.5, 35.5], [139, 35, 1, 2]);
	ok(uv[0] === 0.5 && uv[1] === 0.25 && uv[2] === 1 && uv[3] === 0.5 && anchorUV([0, 0], null).every(v => v === 0), 'anchorUV＝(原点の uv, 1/span)・窓なし＝0');
}

console.log(fails ? `\n✗ ${fails} 件失敗` : '\nPASS');
process.exit(fails ? 1 : 0);
