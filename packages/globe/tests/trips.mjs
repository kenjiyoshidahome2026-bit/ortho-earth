#!/usr/bin/env node
// deck.gl 差分 PR-6（Trips・フィルタ／ブラシ／マスク・トランジション）の純関数の常設検定（src/adddata.js）：
//   ・bakeTrips＝線分ごとに 4 頂点・6 索引、side の符号と |2|（oth が前の点）、時刻は頂点に、id は軌跡の番号（1〜）、高さは法線に沿って上、tMin/tMax、原点＝重心
//   ・rasterMask＝多角形を bbox の R8 画像に（中は 255・外は 0・穴・MultiPolygon・GeoJSON Feature）
//   ・getFilterValue＝点・弧の f
// GPU の経路は tests/t-trips.html（verify:ui）。使い方：node packages/globe/tests/trips.mjs
import { bakeTrips, rasterMask, bakePoints, bakeArcs } from "../src/adddata.js";
import { lonlatTo3D } from "@ortho-earth/core/camera";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

console.log("bakeTrips");
{
	const data = [{ path: [[139.7, 35.6], [139.71, 35.61, 100], [139.72, 35.62]], ts: [0, 10, 20] }, { path: [[139.8, 35.7], [139.81, 35.71]], ts: [5, 15] }, { path: [[1, 1]], ts: [0] }];
	const b = bakeTrips(data, { getPath: d => d.path, getTimestamps: d => d.ts, getColor: (d, i) => [i * 100, 0, 0], getWidth: 3 });
	ok(b.n === 2, `1 点だけの軌跡は飛ばす n=${b.n}`);
	ok(b.nv === 12 && b.ni === 18 && b.index.length === 18, `3 線分＝12 頂点・18 索引（nv=${b.nv} ni=${b.ni}）`);
	ok(Array.from(b.side.subarray(0, 4)).join() === "-1,1,-2,2", `side＝−1,1,−2,2（${Array.from(b.side.subarray(0, 4))}）`);
	ok(Array.from(b.time.subarray(0, 8)).join() === "0,0,10,10,10,10,20,20", `時刻は頂点に（${Array.from(b.time.subarray(0, 8))}）`);
	ok(Array.from(b.id.subarray(0, 12)).join() === "1,1,1,1,1,1,1,1,2,2,2,2", "id＝軌跡の番号 1〜");
	ok(Array.from(b.index.subarray(0, 6)).join() === "0,1,2,1,3,2", "索引＝2 三角形");
	ok(b.tMin === 0 && b.tMax === 20, `tMin ${b.tMin} tMax ${b.tMax}`);
	ok(b.rgba[0] === 0 && b.rgba[8 * 4] === 100 && b.width[0] === 3 && b.rgba.length === 12 * 4, "色・幅は頂点ごとに写す");
	ok(near(Math.hypot(...b.origin), 1, 1e-12), "原点は単位球の上");
	// 高さ 100 m の頂点は地表の点より |P| が大きい（法線に沿って上）
	const k = 2, P = [b.pos[k * 3] + b.origin[0], b.pos[k * 3 + 1] + b.origin[1], b.pos[k * 3 + 2] + b.origin[2]], Q = lonlatTo3D(139.71, 35.61);
	ok(Math.hypot(...P) > Math.hypot(...Q) && Math.hypot(...P) - 1 < 2e-5, `高さ 100 m → |P|−1 ＝ ${(Math.hypot(...P) - 1).toExponential(2)}（≈100/6371000）`);
	// oth＝同じ線分のもう一方の端（頂点 0 の oth＝頂点 2 の pos）
	ok(near(b.oth[0], b.pos[6], 1e-7) && near(b.oth[1], b.pos[7], 1e-7) && near(b.oth[2], b.pos[8], 1e-7), "oth は線分のもう一方の端");
	ok(b.trips.length === 2 && b.trips[1].i === 1 && b.trips[1].t0 === 5 && b.trips[1].t1 === 15 && b.trips[1].lngLat[0] === 139.8, JSON.stringify(b.trips[1]));
	const g = bakeTrips({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 0], [2, 0]] }, properties: { timestamps: [1, 2, 3] } }] }, {});
	ok(g.n === 1 && g.nv === 8 && g.time[7] === 3, "GeoJSON の LineString＋properties.timestamps");
	const nt = bakeTrips([{ path: [[0, 0], [1, 1], [2, 2]] }], { getPath: d => d.path });
	ok(nt.tMin === 0 && nt.tMax === 2 && nt.rgba === null && nt.width === null, "時刻が無ければ頂点番号・色と幅は null");
}
console.log("rasterMask");
{
	const m = rasterMask([[139, 35], [140, 35], [140, 36], [139, 36]], { w: 32, h: 32, pad: 0.25 });
	ok(m.w === 32 && m.h === 32 && m.data.length === 1024, "R8 の画像");
	ok(near(m.bbox[0], 138.75) && near(m.bbox[2], 140.25), `bbox に余白（${m.bbox.map(v => v.toFixed(2))}）`);
	let inside = 0; for (const v of m.data) if (v) inside++;
	ok(inside > 1024 * 0.4 && inside < 1024 * 0.5, `中は 255（${inside}/1024 ≈ (1/1.5)²＝0.444）`);
	const at = (lon, lat) => { const i = Math.floor((lon - m.bbox[0]) / (m.bbox[2] - m.bbox[0]) * m.w), j = Math.floor((lat - m.bbox[1]) / (m.bbox[3] - m.bbox[1]) * m.h); return m.data[j * m.w + i]; };
	ok(at(139.5, 35.5) === 255 && at(138.8, 35.5) === 0 && at(139.5, 36.2) === 0, "中＝255・外＝0");
	const hole = rasterMask({ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] }, { w: 64, h: 64, pad: 0 });
	const hat = (x, y) => hole.data[Math.floor(y / 10 * 64) * 64 + Math.floor(x / 10 * 64)];
	ok(hat(2, 2) === 255 && hat(5, 5) === 0, "穴（偶奇）");
	const mp = rasterMask({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1]]], [[[5, 5], [6, 5], [6, 6], [5, 6]]]] } }, { w: 60, h: 60, pad: 0 });
	const mat = (x, y) => mp.data[Math.floor(y / 6 * 60) * 60 + Math.floor(x / 6 * 60)];
	ok(mat(0.5, 0.5) === 255 && mat(5.5, 5.5) === 255 && mat(3, 3) === 0, "MultiPolygon の Feature");
	ok(rasterMask(null) === null && rasterMask([]) === null, "空＝null");
}
console.log("getFilterValue");
{
	const p = bakePoints([{ p: [1, 1], v: 3 }, { p: [2, 2], v: 7 }], { getPosition: d => d.p, getFilterValue: d => d.v });
	ok(p.f && p.f.length === 2 && p.f[0] === 3 && p.f[1] === 7, `点の f ${Array.from(p.f)}`);
	ok(bakePoints([[1, 1]], {}).f === null, "無ければ null");
	const a = bakeArcs([{ s: [0, 0], t: [1, 1], v: 5 }], { getSourcePosition: d => d.s, getTargetPosition: d => d.t, getFilterValue: "v" === "v" ? d => d.v : 0 });
	ok(a.f && a.f[0] === 5, "弧の f");
}

if (fails) { console.error(`\n${fails} failed`); process.exit(1); } else console.log("\nall passed");
