#!/usr/bin/env node
// 日影・可視域の純関数（src/sunshadow-core.ts・2026-10-24＝CPU 版から切り出した共有部）の検証。外部データ不要＝決定的。
//   1. sunAt：冬至の東京の南中＝高度 30.9°・方位 180°・朝 8 時は南東（方位 120〜135°）で低い（高度 10° 前後）
//   2. sunDirAt：世界座標の向き＝高度 90°＝up・方位 90°（東）は経度の増える向き・方位 0°（北）は北極の側・単位長
//   3. sunTimes/sunsOf：冬至 8〜16 時・30 分刻み＝17 本・全部日の出ている（CPU 版の steps と同じ）。instant＝1 本（経度と均時差で真太陽時へ）
//   4. paintSunShadow：時間＝2 時間以上の段に色・境に線・最大時間。瞬間＝影の一色。paintViewshed：半径の外は透明・見える＝緑・数
//   5. sunGrid：升目は maxCells に収まる・cell の下限
// 使い方: node packages/globe/tests/sunshadow-core.mjs
import { sunAt, sunDirAt, sunTimes, sunsOf, paintSunShadow, paintViewshed, sunGrid, band, D2R } from "../src/sunshadow-core.ts";

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const deg = r => r / D2R;

console.log("― 1. sunAt ―");
{
	const noon = sunAt(35.68, -23.44, 12), morn = sunAt(35.68, -23.44, 8);
	ok(Math.abs(deg(noon.alt) - 30.88) < 0.1 && Math.abs(deg(noon.az) - 180) < 1e-6, `冬至の南中＝高度 ${deg(noon.alt).toFixed(2)}°・方位 ${deg(noon.az).toFixed(1)}°`);
	ok(deg(morn.alt) > 5 && deg(morn.alt) < 15 && deg(morn.az) > 115 && deg(morn.az) < 140, `冬至の 8 時＝高度 ${deg(morn.alt).toFixed(1)}°・方位 ${deg(morn.az).toFixed(1)}°（南東）`);
	ok(sunAt(35.68, -23.44, 4).alt < 0, "4 時は地平線の下");
}
console.log("― 2. sunDirAt ―");
{
	const lon = 139.7 * D2R, lat = 35.7 * D2R, up = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
	const z = sunDirAt(up, 90 * D2R, 0), e = sunDirAt(up, 0, 90 * D2R), n = sunDirAt(up, 0, 0);
	ok(Math.hypot(z[0] - up[0], z[1] - up[1], z[2] - up[2]) < 1e-12, "高度 90°＝up");
	const dl = 1e-6, pe = [Math.cos(lat) * Math.cos(lon + dl), Math.sin(lat), Math.cos(lat) * Math.sin(lon + dl)], east = pe.map((v, i) => v - up[i]);
	ok(east[0] * e[0] + east[1] * e[1] + east[2] * e[2] > 0 && Math.abs(e[0] * up[0] + e[1] * up[1] + e[2] * up[2]) < 1e-12, "方位 90°＝東（経度の増える向き・水平）");
	ok(n[1] > up[1] && Math.abs(n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) < 1e-12, "方位 0°＝北（北極の側・水平）");
	ok([z, e, n].every(v => Math.abs(Math.hypot(...v) - 1) < 1e-12), "単位長");
	const s = sunDirAt(up, 30 * D2R, 180 * D2R);
	ok(Math.abs(s[0] * up[0] + s[1] * up[1] + s[2] * up[2] - Math.sin(30 * D2R)) < 1e-12, "高度 30°＝up との内積 sin30°");
}
console.log("― 3. 時刻の列 ―");
{
	const d = sunTimes({ mode: "duration" }, 139.7);
	ok(d.times.length === 17 && d.times[0] === 8 && Math.abs(d.times[16] - 16) < 1e-9 && d.decl === -23.44, `冬至 8〜16 時・30 分＝${d.times.length} 本・赤緯 ${d.decl}`);
	ok(sunsOf(35.68, -23.44, d.times).length === 17, "17 本とも日の出ている");
	const i = sunTimes({ mode: "instant", date: "2026-12-22T03:00:00Z" }, 139.7);   // 12:00 JST
	ok(i.times.length === 1 && Math.abs(i.times[0] - 12.33) < 0.1 && Math.abs(i.decl + 23.4) < 0.2, `瞬間＝真太陽時 ${i.times[0].toFixed(2)} 時・赤緯 ${i.decl.toFixed(2)}`);
	ok(sunTimes({ mode: "duration", hours: [12, 12], step: 1 }, 0).times.length === 1, "hours [12,12]＝1 本");
}
console.log("― 4. 色付け ―");
{
	const W = 8, H = 4, cnt = new Uint16Array(W * H);
	for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) cnt[y * W + x] = x;   // 列 x＝x 回＝x×0.5 時間
	const { rgba, maxH } = paintSunShadow(cnt, W, H, 0.5, "duration");
	ok(maxH === 3.5, `最大 ${maxH} 時間`);
	ok(rgba[3] === 0 && rgba[(1 * W + 1) * 4 + 3] === 0 && rgba[(1 * W + 2) * 4 + 3] > 0, "1 時間未満は透明・1 時間から色");
	ok(band(0.5) === 0 && band(1) === 1 && band(2) === 2 && band(5.5) === 5, "段");
	const edge = rgba[(1 * W + 4) * 4 + 3] === 235;   // 2 時間の段（x=4）の西隣（x=3）は 1.5 時間＝段が下がる＝線
	ok(edge, "段の境に線");
	const inst = paintSunShadow(new Uint16Array([0, 1, 2, 0]), 2, 2, 1, "instant").rgba;
	ok(inst[3] === 0 && inst[7] === 150 && inst[11] === 150 && inst[15] === 0, "瞬間＝影の一色");
	const N = 10, vis = new Uint8Array(N * N); vis[5 * N + 5] = 1; vis[5 * N + 6] = 1; vis[0] = 1;
	const v = paintViewshed(vis, N, 5.5, 5.5, 2);
	ok(v.inR === 13 && v.seen === 2, `半径 2 升＝${v.inR} 升・見える ${v.seen}`);   // 中心から 2 升以内＝1＋4＋4（斜め √2）＋4（2 升先）
	ok(v.rgba[(5 * N + 5) * 4 + 1] === 200 && v.rgba[(5 * N + 3) * 4 + 3] === 90 && v.rgba[3] === 0, "見える＝緑・見えない＝暗・外は透明");
}
console.log("― 5. 升目 ―");
{
	const bbox = [139.7, 35.7, 139.711, 35.709];   // 約 1km × 1km
	const g = sunGrid(bbox, null, 1024 * 1024);
	ok(g.cell >= 0.5 && g.W * g.H <= 1024 * 1024 * 1.01 && Math.abs(g.spanX - 998) < 10 && Math.abs(g.spanY - 1000) < 10, `1km 四方＝${g.W}×${g.H}・cell ${g.cell.toFixed(2)}m`);
	ok(sunGrid(bbox, 5, 1e9).cell === 5, "cell の指定");
}
if (fails) { console.error(`\n✗ ${fails} 件失敗`); process.exit(1); }
console.log("\n✓ 全部通過");
