#!/usr/bin/env node
// 断面とクリッピング平面（#111 段 0）の純関数 clip.js の検証。外部データ不要＝決定的。
//   1. 鉛直面は a と b を通り、a→b に向かって右側を残す（東向き＝南を残す／北向き＝東を残す）
//   2. 中点で鉛直（高さを変えても面からの距離が変わらない）＝球と楕円体の両方
//   3. packClip の K（f64 で引いてから f32）＋原点相対の位置（f32）で出した距離が、f64 の直の距離と mm で合う（東京駅・z17 の画面の範囲）
//   4. 日付変更線を跨ぐ 2 点も短い方の中点で鉛直・面の枚数は 6 枚まで
//   5. 段 1：水平面（下を残す／上を残す・中心から 1 km で浮くのは 8 cm 程度）・箱（向きを回しても辺までの距離が幾何と合う・6 枚）・URL の書き方（?clip=）
// 使い方: node packages/ortho-core/tests/clip.mjs
import { lonlatTo3D, ellNormal3D, setEllipsoid, worldRadiusM } from "../src/camera.js";
import { meridionalRadius, primeVerticalRadius } from "../src/geodesic.js";
import { clipPlaneVertical, clipPlaneHorizontal, clipBox, clipPlanes, parseClipParam, packClip, clipDistanceM, clipStyle, CLIP_STYLE, CLIP_F32, CLIP_MAX } from "../src/clip.js";

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
		const X = [u[0] + m[0] * k, u[1] + m[1] * k, u[2] + m[2] * k], dRef = P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] - P[0][3];   // 同じ β の距離を f64 で
		worst = Math.max(worst, Math.abs(dGpu - dRef) * Re);
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
ok(U0.subarray(0, CLIP_MAX * 4 + 1).every(v => v === 0), "面 0 枚＝面の欄は全部 0（p.x＝0）");
const US = packClip([], [1, 0, 0], undefined, clipStyle({ cap: false, edge: { width: 3, color: [1, 0, 0] } }));
ok(US[CLIP_MAX * 4 + 1] === 3 && US[CLIP_MAX * 4 + 7] === 0 && US[CLIP_MAX * 4 + 11] === 0 && US[CLIP_MAX * 4 + 12] === 1, "段 2：帯の幅と色・蓋を消す（cap:false）");
const UD = packClip([], [1, 0, 0]);
ok(UD[CLIP_MAX * 4 + 1] === CLIP_STYLE.edgeWidth && UD[CLIP_MAX * 4 + 7] === 1 && UD[CLIP_MAX * 4 + 11] === 1 && UD.length === CLIP_F32, "既定＝帯 2 px・蓋あり・160B");

console.log("― 段 1：水平面・箱・URL ―");
for (const ell of [false, true]) {
	setEllipsoid(ell);
	const at = [139.7, 35.7], D = 180 / Math.PI, Rm = ell ? meridionalRadius(at[1]) : worldRadiusM(), Rn = (ell ? primeVerticalRadius(at[1]) : worldRadiusM()) * Math.cos(at[1] / D);
	const ll = (e, n) => [at[0] + e / Rn * D, at[1] + n / Rm * D];   // ENU(m)→経緯度（楕円体は子午線・卯酉線の曲率半径）
	const H = [clipPlaneHorizontal(at, 30)];
	ok(Math.abs(clipDistanceM(H, ...at, 10) - 20) < 1e-3 && Math.abs(clipDistanceM(H, ...at, 45) + 15) < 1e-3, `${ell ? "楕円体" : "球"}：水平面 30m は下を残す（10m＝+20・45m＝−15）`);
	const Ha = [clipPlaneHorizontal(at, 30, "above")];
	ok(clipDistanceM(Ha, ...at, 45) > 14.99 && clipDistanceM(Ha, ...at, 10) < -19.99, "above は上を残す");
	const sag = clipDistanceM(H, ...ll(1000, 0), 30);
	ok(sag > 0 && sag < 0.12, `平面なので 1 km 先では地表の 30m より ${(sag * 100).toFixed(1)} cm 上に来る（接平面の垂れ）`);
	const B = clipBox({ center: at, size: [100, 200], h: [0, 50], bearing: 30 }), t = 30 * Math.PI / 180;
	ok(B.length === 6, "箱は 6 枚");
	let worst = 0;
	for (const [e, n, h] of [[0, 0, 25], [40, 0, 25], [60, 0, 25], [0, 90, 25], [0, 110, 25], [0, 0, -5], [0, 0, 55], [-30, -70, 5]]) {
		const r = e * Math.cos(t) - n * Math.sin(t), f = n * Math.cos(t) + e * Math.sin(t);   // 回した軸での位置
		const want = Math.min(50 - Math.abs(r), 100 - Math.abs(f), h, 50 - h);
		worst = Math.max(worst, Math.abs(clipDistanceM(B, ...ll(e, n), h) - want));
	}
	ok(worst < 0.1, `箱（北から 30° 回す）の内外と辺までの距離が幾何と合う（最大の差 ${(worst * 100).toFixed(1)} cm）`);
}
setEllipsoid(false);
const q = parseClipParam("139.7,35.6,139.8,35.6;h:139.7,35.7,30;box:139.7,35.7,100,200,0,50,30;xx:1,2");
ok(q && q.vertical.length === 1 && q.horizontal[0].h === 30 && q.horizontal[0].keep === "below" && q.box.size[1] === 200 && q.box.h[1] === 50 && q.box.bearing === 30, "URL の書き方：鉛直・水平・箱（読めない項は捨てる）");
ok(parseClipParam("h:139.7,35.7,30,above").horizontal[0].keep === "above" && parseClipParam("box:139.7,35.7,100,200").box.h === undefined, "above と箱の既定の高さ");
ok(parseClipParam("") === null && parseClipParam("a,b") === null, "読めなければ null");
ok(clipPlanes({ param: "box:139.7,35.7,100,200" }).length === 6 && clipPlanes({ param: "box:139.7,35.7,100,200", vertical: [[[139, 35], [140, 35]]] }).length === 6, "param も面にする・7 枚目は捨てる");

if (fails) { console.error(`FAIL ${fails}`); process.exit(1); }
console.log("PASS clip");
