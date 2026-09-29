#!/usr/bin/env node
// 断面とクリッピング平面（#111 段 0）の純関数 clip.js の検証。外部データ不要＝決定的。
//   1. 鉛直面は a と b を通り、a→b に向かって右側を残す（東向き＝南を残す／北向き＝東を残す）
//   2. 中点で鉛直（高さを変えても面からの距離が変わらない）＝球と楕円体の両方
//   3. packClip の K（f64 で引いてから f32）＋原点相対の位置（f32）で出した距離が、f64 の直の距離と mm で合う（東京駅・z17 の画面の範囲）
//   4. 日付変更線を跨ぐ 2 点も短い方の中点で鉛直・面の枚数は 6 枚まで
// 使い方: node packages/ortho-core/tests/clip.mjs
import { lonlatTo3D, ellNormal3D, setEllipsoid, worldRadiusM } from "../src/camera.js";
import { clipPlaneVertical, clipPlanes, packClip, clipDistanceM, CLIP_MAX } from "../src/clip.js";

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const f = Math.fround;

for (const ell of [false, true]) {
	setEllipsoid(ell);
	console.log(`― ${ell ? "楕円体" : "球"} ―`);
	const a = [139.760, 35.681], b = [139.770, 35.681];   // 東京駅の北を東向き
	const P = clipPlanes({ vertical: [[a, b]] });
	ok(P.length === 1 && Math.abs(Math.hypot(P[0][0], P[0][1], P[0][2]) - 1) < 1e-12, "面は 1 枚・法線は単位");
	ok(Math.abs(clipDistanceM(P, ...a)) < 1e-6 && Math.abs(clipDistanceM(P, ...b)) < 1e-6, "a と b を通る");
	ok(clipDistanceM(P, 139.765, 35.680) > 100 && clipDistanceM(P, 139.765, 35.682) < -100, "東向き＝南（右）を残し北を切る");
	const Pn = clipPlanes({ vertical: [[[139.765, 35.67], [139.765, 35.69]]] });
	ok(clipDistanceM(Pn, 139.766, 35.68) > 80 && clipDistanceM(Pn, 139.764, 35.68) < -80, "北向き＝東（右）を残し西を切る");
	const mid = [139.765, 35.681];
	const dH = Math.abs(clipDistanceM(P, ...mid, 0) - clipDistanceM(P, ...mid, 600));
	ok(dH < 1e-6, `中点で鉛直（0m と 600m の距離の差 ${dH.toExponential(1)} m）`);
	// 3. f32 の原点相対で出した距離（シェーダと同じ式）と f64 の直の距離
	const origin = [139.7671, 35.6812], O = lonlatTo3D(...origin), Re = worldRadiusM();
	const U = packClip(P, O);
	let worst = 0;
	for (let i = 0; i < 200; i++) {
		const lon = origin[0] + (Math.sin(i * 1.7) * 0.01), lat = origin[1] + (Math.cos(i * 2.3) * 0.008), h = (i % 7) * 50;
		const u = lonlatTo3D(lon, lat), m = ellNormal3D(lon, lat), k = h / Re;
		const rel = [f(u[0] + m[0] * k - O[0]), f(u[1] + m[1] * k - O[1]), f(u[2] + m[2] * k - O[2])];   // シェーダの relW（f32）
		const dGpu = f(f(f(U[0] * rel[0]) + f(U[1] * rel[1])) + f(U[2] * rel[2])) + U[3];
		worst = Math.max(worst, Math.abs(dGpu * Re - clipDistanceM(P, lon, lat, h)));
	}
	ok(worst < 0.01, `原点相対 f32 の距離が f64 と合う（最大の差 ${(worst * 1000).toFixed(2)} mm・±1km・高さ 0〜300m）`);
}
setEllipsoid(false);
console.log("― 日付変更線と枚数 ―");
const Pd = clipPlaneVertical([179.99, -17], [-179.99, -17]);
ok(!!Pd && clipDistanceM([Pd], 180, -17.01) > 0 && clipDistanceM([Pd], 180, -16.99) < 0, "跨ぐ 2 点（東向き）＝南を残す");
ok(clipPlaneVertical([139, 35], [139, 35]) === null, "同じ 2 点は面にならない");
const many = clipPlanes({ vertical: Array.from({ length: 9 }, (_, i) => [[139 + i * 0.01, 35], [139 + i * 0.01 + 0.001, 35.001]]) });
ok(many.length === CLIP_MAX, `面は ${CLIP_MAX} 枚まで`);
const U0 = packClip([], [1, 0, 0]);
ok(U0.every(v => v === 0), "面 0 枚＝uniform は全部 0（p.x＝0）");

if (fails) { console.error(`FAIL ${fails}`); process.exit(1); }
console.log("PASS clip");
