#!/usr/bin/env node
// 解析（日影時間・可視域の GPU 版・2026-10-24）の純関数の検証：窓の合わせ方（shadow.ts shadowWindowFit）と升目の位置（gpu/analysis.ts cellPositions）。外部データ不要＝決定的。
//   1. shadowWindowFit：渡した点が全部クリップ [−1,1]² に入る・点の上 hMax までの落とす物（光に沿って手前）も奥行き [0,1] に入る・真上（高度 90°）でも立つ・高度 0.5° 未満は null
//   2. 受け手と同じ xy に落ちる物は窓の xy で同じ所（正射影）＝建物の頂を光の向きに投げると受け手のクリップ xy と一致
//   3. cellPositions：錨相対の f32 でも lonlatTo3D（f64）との差が 1mm 以下・row0＝北・列 0＝西・測定面の持ち上げは動径
//   4. bboxPoints：四隅＋中心×高さ 2 段＝10 点
// 使い方: node packages/ortho-core/tests/shadow-fit.mjs
import { lonlatTo3D, worldRadiusM } from "../src/camera.ts";
import { shadowWindowFit } from "../src/shadow.ts";
import { cellPositions, bboxPoints } from "../src/gpu/analysis.ts";

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const Re = worldRadiusM(), N = 2048;
const LON = 139.7, LAT = 35.7, K = 111320, cosL = Math.cos(LAT * Math.PI / 180);
const ll = (e, n) => [LON + e / (K * cosL), LAT + n / K];
const bbox = [...ll(-500, -500), ...ll(500, 500)];
const clip = (m, P) => [m[0] * P[0] + m[4] * P[1] + m[8] * P[2] + m[12], m[1] * P[0] + m[5] * P[1] + m[9] * P[2] + m[13], m[2] * P[0] + m[6] * P[1] + m[10] * P[2] + m[14]];
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
const C = lonlatTo3D(LON, LAT), up = norm(C);
const east = norm([-up[2], 0, up[0]]), north = [east[1] * up[2] - east[2] * up[1], east[2] * up[0] - east[0] * up[2], east[0] * up[1] - east[1] * up[0]];   // 東＝up×北極軸・北＝東×up
const sunOf = (altDeg, azDeg) => { const a = altDeg * Math.PI / 180, z = azDeg * Math.PI / 180; return up.map((u, i) => Math.sin(a) * u + Math.cos(a) * (Math.cos(z) * north[i] + Math.sin(z) * east[i])); };

console.log("― 1. 窓に全部入る ―");
const pts = bboxPoints(bbox, 0, 4);
for (const [alt, az] of [[10, 150], [31, 180], [60, 240], [90, 0]]) {
	const win = shadowWindowFit(sunOf(alt, az), pts, N, 700, up);
	ok(win !== null, `高度 ${alt}°・方位 ${az}° で窓が立つ（半幅 ${win ? Math.round(win.R * Re) : "-"}m・texel ${win ? win.texelM.toFixed(2) : "-"}m）`);
	if (!win) continue;
	const cs = pts.map(P => clip(win.mvp, P));
	ok(cs.every(c => Math.abs(c[0]) <= 1 && Math.abs(c[1]) <= 1 && c[2] > 0 && c[2] < 1), `  受け手の点は全部 [−1,1]²×(0,1) の中`);
	ok(Math.abs(win.alt * 180 / Math.PI - alt) < 1e-9, `  高度 ${alt}° を正しく測る`);
	// 落とす物＝受け手の真上 700m（高さの上限）＝奥行きの中・それより手前（光に沿って 700/sin 手前）も中
	const s = sunOf(alt, az), hi = pts.map(P => P.map((v, i) => v + up[i] * 700 / Re)), along = pts.map(P => P.map((v, i) => v + s[i] * 700 / Re / Math.sin(alt * Math.PI / 180)));
	ok([...hi, ...along].every(P => { const c = clip(win.mvp, P); return c[2] >= 0 && c[2] < 1; }), `  上 700m と光に沿って手前の物も奥行きの中`);
}
ok(shadowWindowFit(sunOf(0.3, 180), pts, N, 700, up) === null, "高度 0.3°（0.5° 未満）は null");

console.log("― 2. 同じ xy に落ちる ―");
{
	const alt = 31, az = 200, s = sunOf(alt, az), win = shadowWindowFit(s, pts, N, 700, up);
	const G = lonlatTo3D(...ll(120, -80)), T = G.map((v, i) => v + s[i] * 95 / Re);   // 地面の点 G と、そこから太陽の向きに 95m 戻った点 T（T を遮る物は G を影にする）
	const cg = clip(win.mvp, G), ct = clip(win.mvp, T);
	ok(Math.abs(cg[0] - ct[0]) < 1e-9 && Math.abs(cg[1] - ct[1]) < 1e-9 && ct[2] < cg[2], `光の上の点は同じ xy・手前の深さ（Δz＝${((cg[2] - ct[2]) * win.zRangeM).toFixed(1)}m≈95）`);
	ok(Math.abs((cg[2] - ct[2]) * win.zRangeM - 95) < 0.01, "奥行きの目盛りは m");
}

console.log("― 3. 升目の位置 ―");
{
	const W = 40, H = 30, g = new Float32Array(W * H).fill(12.5), anchor = lonlatTo3D((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
	const pos = cellPositions(bbox, W, H, g, 1 / Re, 4, anchor);
	ok(pos.length === W * H * 4, "vec4 × W·H");
	let maxErr = 0;
	for (let r = 0; r < H; r += 7) for (let c = 0; c < W; c += 9) {
		const lon = bbox[0] + (c + 0.5) / W * (bbox[2] - bbox[0]), lat = bbox[3] - (r + 0.5) / H * (bbox[3] - bbox[1]);
		const P = lonlatTo3D(lon, lat), l = Math.hypot(...P), k = 1 + (12.5 + 4) / Re / l, i = (r * W + c) * 4;
		maxErr = Math.max(maxErr, Math.hypot(pos[i] - (P[0] * k - anchor[0]), pos[i + 1] - (P[1] * k - anchor[1]), pos[i + 2] - (P[2] * k - anchor[2])) * Re);
	}
	ok(maxErr < 1e-3, `錨相対の f32 と f64 の差 ${(maxErr * 1000).toFixed(3)}mm`);
	ok(pos[3] === 12.5, "w＝地形の高さ（本当の m）");
	const top = pos.subarray(0, 4), bot = pos.subarray((H - 1) * W * 4, (H - 1) * W * 4 + 4);
	ok(top[1] > bot[1], "row0 が北（y＝北極の軸が大きい）");
	const left = pos.subarray(0, 4), right = pos.subarray((W - 1) * 4, W * 4);
	const dE = east[0] * (right[0] - left[0]) + east[1] * (right[1] - left[1]) + east[2] * (right[2] - left[2]);
	ok(dE > 0, "列 0 が西");
	const flat = cellPositions(bbox, W, H, null, 0, 0, anchor);
	ok(flat[3] === 0 && Math.abs(Math.hypot(flat[0] + anchor[0], flat[1] + anchor[1], flat[2] + anchor[2]) - 1) < 1e-9, "地形なし・持ち上げなし＝単位球の上");
}
ok(bboxPoints(bbox, 0, 10).length === 10, "― 4. bboxPoints＝10 点");

if (fails) { console.error(`\n✗ ${fails} 件失敗`); process.exit(1); }
console.log("\n✓ 全部通過");
