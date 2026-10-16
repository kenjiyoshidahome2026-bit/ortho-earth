#!/usr/bin/env node
// 等高線（deck.gl 差分 PR-5・2026-10-12・src/cells/contour.js）の常設検定：既知の場で線の本数・位置・帯の面積。
//   ・gridField＝点を格子に数える（count/sum/mean）・外側に 1 セルの余白（線が閉じる）
//   ・isolines＝円錐の場 v = max(0, 1 − r) を 0.5 で切ると半径 0.5 の閉じた 1 本の線（頂点は r ≈ 0.5）・2 つの山＝2 本
//   ・isobands＝[0.25, 0.75] の帯は環状（面積 ≈ π(0.75² − 0.25²)）・帯の外には頂点が出ない
//   ・joinSegments＝線分が 1 本の折れ線に繋がる・閉じる
// 使い方：node packages/globe/tests/contour.mjs
import { gridField, isolines, isobands, joinSegments, contourGeoJSON, autoThresholds, smooth } from "../src/cells/contour.ts";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const near = (a, b, e) => Math.abs(a - b) < e;
// 格子点＝セル中心の場を直接作る（経緯度を x, y と見る＝dLon = dLat = h）
const fieldOf = (n, h, f) => { const v = new Float64Array(n * n); for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) v[j * n + i] = f((i + 0.5) * h, (j + 0.5) * h); return { nx: n, ny: n, lon0: 0, lat0: 0, dLon: h, dLat: h, values: v }; };
const area = ring => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]); return Math.abs(a) / 2; };

console.log("gridField");
{
	const pts = [[139.73, 35.63], [139.7301, 35.6301], [139.93, 35.83], { lon: 139.73, lat: 35.63, props: { w: 5 } }];   // セルの境目（0.1° の倍数）から離す
	const f = gridField(pts, { cellSize: { dLon: 0.1, dLat: 0.1 } });
	ok(f.nx >= 4 && f.ny >= 4, `格子 ${f.nx}×${f.ny}（余白 1 セル込み）`);
	ok(f.lon0 < 139.73 && f.lat0 < 35.63, "原点は点の外（余白）");
	const k = Math.floor((139.73 - f.lon0) / 0.1) + Math.floor((35.63 - f.lat0) / 0.1) * f.nx;
	ok(f.values[k] === 3, `同じセルの 3 点が count 3（${f.values[k]}）`);
	ok(gridField(pts, { cellSize: { dLon: 0.1, dLat: 0.1 }, agg: "sum", weight: "w" }).values[k] === 5, "sum（重みの無い点は 0）");
	ok(near(gridField(pts, { cellSize: { dLon: 0.1, dLat: 0.1 }, agg: "mean", weight: p => p.w ?? 1 }).values[k], 7 / 3, 1e-12), "mean");
	const fm = gridField(pts, { cellSize: 1000 }); ok(fm.dLat > 0.008 && fm.dLat < 0.01, `cellSize m → 度 ${fm.dLat.toFixed(5)}`);
	ok(gridField([], {}).nx === 0, "空＝空の場");
	let threw = false; try { gridField([[0, 0], [100, 50]], { cellSize: { dLon: 0.001, dLat: 0.001 } }); } catch { threw = true; } ok(threw, "セルが多すぎる時は投げる");
}

console.log("isolines（円錐）");
{
	const f = fieldOf(41, 0.05, (x, y) => Math.max(0, 1 - Math.hypot(x - 1, y - 1)));   // 中心 (1,1)・r=1 で 0
	const [L] = isolines(f, [0.5]);
	ok(L.coordinates.length === 1, `閉じた線が 1 本（${L.coordinates.length}）`);
	const line = L.coordinates[0], rs = line.map(([x, y]) => Math.hypot(x - 1, y - 1));
	ok(rs.every(r => near(r, 0.5, 0.03)), `頂点は r ≈ 0.5（${Math.min(...rs).toFixed(3)}〜${Math.max(...rs).toFixed(3)}）`);
	ok(line.length > 40 && near(line[0][0], line[line.length - 1][0], 1e-9) && near(line[0][1], line[line.length - 1][1], 1e-9), `閉じている（${line.length} 点）`);
	ok(near(area(line), Math.PI * 0.25, 0.02), `囲む面積 ≈ π·0.5²（${area(line).toFixed(3)}）`);
	ok(isolines(f, [2]).length === 1 && isolines(f, [2])[0].coordinates.length === 0, "場の最大より上＝線なし");
	const two = fieldOf(41, 0.05, (x, y) => Math.max(0, 0.4 - Math.hypot(x - 0.5, y - 1)) + Math.max(0, 0.4 - Math.hypot(x - 1.5, y - 1)));
	ok(isolines(two, [0.2])[0].coordinates.length === 2, "2 つの山＝2 本");
}
console.log("isobands（環）");
{
	const f = fieldOf(81, 0.025, (x, y) => Math.max(0, 1 - Math.hypot(x - 1, y - 1)));
	const [B] = isobands(f, [[0.25, 0.75]]);
	const a = B.coordinates.reduce((s, poly) => s + area(poly[0]), 0), want = Math.PI * (0.75 ** 2 - 0.25 ** 2);
	ok(near(a, want, want * 0.03), `面積 ≈ π(0.75²−0.25²)＝${want.toFixed(3)}（${a.toFixed(3)}）`);
	const rs = B.coordinates.flatMap(poly => poly[0].map(([x, y]) => Math.hypot(x - 1, y - 1)));
	ok(rs.every(r => r > 0.25 - 0.03 && r < 0.75 + 0.03), `頂点は帯の中（${Math.min(...rs).toFixed(3)}〜${Math.max(...rs).toFixed(3)}）`);
	ok(B.coordinates.every(poly => poly[0].length >= 4), "各片は閉じた多角形");
	const [B2] = isobands(f, [[0.9, 1]]); ok(B2.coordinates.length > 0 && B2.coordinates.length < 100, `頂上の小さな帯（${B2.coordinates.length} 片）`);
}
console.log("joinSegments");
{
	const L = joinSegments([[[0, 0], [1, 0]], [[2, 0], [1, 0]], [[2, 0], [2, 1]]]);
	ok(L.length === 1 && L[0].length === 4, `3 線分 → 1 本（${L.length} 本・${L[0]?.length} 点）`);
	const sq = joinSegments([[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]]);
	ok(sq.length === 1 && sq[0].length === 5, "四角＝閉じた 1 本（5 点）");
	ok(joinSegments([[[0, 0], [1, 0]], [[5, 5], [6, 5]]]).length === 2, "離れた 2 線分＝2 本");
}
console.log("contourGeoJSON / autoThresholds / smooth");
{
	const f = fieldOf(21, 0.1, (x, y) => Math.max(0, 1 - Math.hypot(x - 1, y - 1)));
	const g = contourGeoJSON(f, { thresholds: [0.3, 0.6], bands: [[0.3, 0.6]] });
	ok(g.features.length === 3 && g.features[0].geometry.type === "MultiLineString" && g.features[2].geometry.type === "MultiPolygon", "線 2＋帯 1");
	ok(g.features[0].properties.threshold === 0.3 && g.features[2].properties.lo === 0.3 && g.features[2].properties.hi === 0.6, "属性 threshold / lo・hi");
	const th = autoThresholds(f, 4); ok(th.length === 4 && th[0] < th[3] && th[3] < 1, `自動の閾値 ${th.map(v => v.toFixed(2))}`);
	const s = smooth(f, 1); ok(s.values.length === f.values.length && Math.max(...s.values) < Math.max(...f.values), "滑らかに＝山が低くなる");
}

if (fails) { console.error(`\n${fails} failed`); process.exit(1); } else console.log("\nall passed");
