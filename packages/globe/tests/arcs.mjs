#!/usr/bin/env node
// map.addData と弧（deck.gl 差分 PR-4・2026-10-12）の純関数の常設検定：
//   ・arcs-gl の補間 arcPoint＝slerp の中間点が大円の上（単位長・両端から等角）、原点相対の式（シェーダ arcRel）が絶対の式と一致、高さは動径の向きに 4h·弦·t(1−t)
//   ・adddata の焼き（bakePoints／bakeArcs／toGeoJSON）＝accessor（関数・定数）、GeoJSON の位置の既定、原点＝重心、theta は倍精度、無い物は null
// GPU の経路（描く・当てる）は tests/t-adddata.html（verify:ui）。使い方：node packages/globe/tests/arcs.mjs
import { arcPoint, arcTheta } from "../src/gadgets/arcs-gl.js";
import { bakePoints, bakeArcs, toGeoJSON, columnRing, originOf } from "../src/adddata.js";
import { lonlatTo3D } from "@ortho-earth/core/camera";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const len = p => Math.hypot(p[0], p[1], p[2]);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("arcPoint（大円）");
const A = lonlatTo3D(139.7671, 35.6812), B = lonlatTo3D(-122.4194, 37.7749);   // 東京 → サンフランシスコ
const th = arcTheta(A, B);
ok(th > 1.2 && th < 1.4, `開き角 ${th.toFixed(4)} rad（約 8,300 km）`);
{ const m = arcPoint(A, B, 0.5); ok(near(len(m), 1, 1e-12), "中間点は単位球の上"); ok(near(arcTheta(A, m), arcTheta(m, B), 1e-9) && near(arcTheta(A, m), th / 2, 1e-9), "両端から等角＝大円の上"); }
ok(near(len([arcPoint(A, B, 0)[0] - A[0], arcPoint(A, B, 0)[1] - A[1], arcPoint(A, B, 0)[2] - A[2]]), 0, 1e-12), "t=0 は始点");
ok(near(len([arcPoint(A, B, 1)[0] - B[0], arcPoint(A, B, 1)[1] - B[1], arcPoint(A, B, 1)[2] - B[2]]), 0, 1e-12), "t=1 は終点");
{ const q = arcPoint(A, B, 0.25), m = arcPoint(A, B, 0.5); ok(near(arcTheta(A, q), th / 4, 1e-9) && near(arcTheta(q, m), th / 4, 1e-9), "t は弧長に比例（等速）"); }
{ const m0 = arcPoint(A, B, 0.5), m1 = arcPoint(A, B, 0.5, 0.3), chord = 2 * Math.sin(th / 2); ok(near(len(m1), 1 + 0.3 * chord, 1e-9), `高さ＝弦長比 0.3 × 弦 ${chord.toFixed(4)}（t=0.5 で最大）`); ok(near(len(m1) - 1, (m1[0] - m0[0]) / (m0[0] / len(m0)), 1e-9), "持ち上げは動径の向き"); }
ok(near(len(arcPoint(A, B, 0, 0.3)), 1, 1e-12) && near(len(arcPoint(A, B, 1, 0.3)), 1, 1e-12), "両端では高さ 0");
// 近い 2 点（θ < 1e-4）＝線形補間へ切り替え
{ const C = lonlatTo3D(139.7671, 35.6812), D = lonlatTo3D(139.7672, 35.6812); const t = arcTheta(C, D); ok(t < 1e-4, `近い 2 点 θ=${t.toExponential(2)}`); const m = arcPoint(C, D, 0.5, 0, t); ok(near(m[0], (C[0] + D[0]) / 2, 1e-12), "中点は線形"); }

console.log("原点相対の式（シェーダ arcRel）＝絶対の式");
{   // p − O = cA·(A−O) + cB·(B−O) + (cA+cB−1)·O
	const O = originOf(new Float64Array([...A, ...B]), 2), t = 0.37, s = Math.sin(th), cA = Math.sin((1 - t) * th) / s, cB = Math.sin(t * th) / s;
	const rel = [0, 1, 2].map(k => cA * (A[k] - O[k]) + cB * (B[k] - O[k]) + (cA + cB - 1) * O[k]);
	const abs = arcPoint(A, B, t);
	ok([0, 1, 2].every(k => near(rel[k] + O[k], abs[k], 1e-12)), "一致（倍精度）");
	// f32 に落とした時：原点相対の方が原点の近くで精度が良い（近い 2 点＝1 km）
	const C = lonlatTo3D(139.7671, 35.6812), D = lonlatTo3D(139.7781, 35.6812), O2 = originOf(new Float64Array([...C, ...D]), 2), th2 = arcTheta(C, D);
	const f = v => Math.fround(v), s2 = Math.sin(th2), a2 = Math.sin(0.5 * th2) / s2, b2 = a2;
	const relF = [0, 1, 2].map(k => f(f(a2) * f(C[k] - O2[k]) + f(b2) * f(D[k] - O2[k]) + f(a2 + b2 - 1) * f(O2[k])));
	const absF = [0, 1, 2].map(k => f(f(a2) * f(C[k]) + f(b2) * f(D[k])));
	const ex = arcPoint(C, D, 0.5), eRel = len([0, 1, 2].map(k => relF[k] + O2[k] - ex[k])), eAbs = len([0, 1, 2].map(k => absF[k] - ex[k]));
	ok(eRel <= eAbs + 1e-12, `原点相対の f32 誤差 ${(eRel * 6371e3).toFixed(3)} m ≤ 絶対 ${(eAbs * 6371e3).toFixed(3)} m`);
}

console.log("bakePoints");
{
	const b = bakePoints([{ p: [139.7, 35.6], v: 1 }, { p: [139.8, 35.7], v: 5 }, { p: null }], { getPosition: d => d.p, getColor: d => [d.v * 50, 0, 0], getRadius: 4 });
	ok(b.n === 2, `位置の無い物は飛ばす n=${b.n}`);
	ok(b.pos.length === 6 && b.pos instanceof Float32Array, "pos＝Float32Array(n*3)");
	ok(near(len(b.origin), 1, 1e-12), "原点＝重心（単位球の上）");
	ok(Array.from(b.rgba) .join() === "50,0,0,255,250,0,0,255", `色 [r,g,b]＝a 255: ${Array.from(b.rgba)}`);
	ok(b.size.length === 2 && b.size[0] === 4 && b.size[1] === 4, "定数の accessor＝全点同じ");
	ok(b.lngLat[2] === 139.8 && b.lngLat[3] === 35.7, "lngLat を main 側に残す");
	const u = lonlatTo3D(139.7, 35.6); ok([0, 1, 2].every(k => Math.abs(b.pos[k] + b.origin[k] - u[k]) < 1e-6), "pos＋origin＝lonlatTo3D");
	const g = bakePoints({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 20] }, properties: {} }] }, {});
	ok(g.n === 1 && g.rgba === null && g.size === null, "GeoJSON の Point＝位置の既定・色と半径が無ければ null");
	ok(bakePoints([], {}).n === 0 && bakePoints([], {}).origin === null, "空＝n 0・原点なし");
}
console.log("bakeArcs");
{
	const b = bakeArcs([{ s: [139.7671, 35.6812], t: [-122.4194, 37.7749] }, { s: [139.7671, 35.6812], t: [139.7672, 35.6812] }], { getSourcePosition: d => d.s, getTargetPosition: d => d.t, getSourceColor: [0, 0, 255], getTargetColor: [255, 0, 0, 128], getWidth: (d, i) => i + 1, getHeight: 0.2 });
	ok(b.n === 2 && b.src.length === 6 && b.dst.length === 6, "src/dst＝Float32Array(n*3)");
	ok(near(b.theta[0], th, 1e-6), `theta[0]＝開き角 ${b.theta[0].toFixed(5)}`);
	ok(b.theta[1] > 0 && b.theta[1] < 1e-4, `近い 2 点の theta は倍精度で 0 にならない: ${b.theta[1].toExponential(2)}`);
	ok(Array.from(b.rgba2).join() === "255,0,0,128,255,0,0,128" && b.rgba[2] === 255, "始点色・終点色");
	ok(b.width[0] === 1 && b.width[1] === 2 && near(b.height[1], 0.2, 1e-6), "幅・高さ");
	ok(near(len(b.origin), 1, 1e-12), "原点＝始点・終点すべての重心");
	const c = bakeArcs([{ s: [0, 0], t: [1, 1] }], { getSourcePosition: d => d.s, getTargetPosition: d => d.t, getColor: [1, 2, 3] });
	ok(c.rgba[0] === 1 && c.rgba2 === null, "getColor＝始点色だけ（終点は overlay が同じ色に）");
}
console.log("toGeoJSON");
{
	const g = toGeoJSON([{ poly: [[139, 35], [140, 35], [140, 36]], h: 30 }], "polygons", { getPolygon: d => d.poly, getFillColor: [255, 0, 0, 128], getElevation: d => d.h, getProperties: d => ({ h: d.h }) });
	const f = g.features[0];
	ok(f.geometry.type === "Polygon" && f.geometry.coordinates[0].length === 4, "環は閉じる");
	ok(f.properties._fill === "rgba(255,0,0,0.502)" && f.properties._h === 30 && f.properties.h === 30 && f.properties._i === 0, JSON.stringify(f.properties));
	const p = toGeoJSON([[[0, 0], [1, 1], [2, 1]]], "paths", { getPath: d => d, getLineColor: [0, 0, 0], getLineWidth: 3 }).features[0];
	ok(p.geometry.type === "LineString" && p.geometry.coordinates.length === 3 && p.properties._lw === 3, "線");
	const c = toGeoJSON([[139.7, 35.6]], "columns", { getPosition: d => d, getRadius: 500, diskResolution: 6 }).features[0];
	ok(c.geometry.coordinates[0].length === 7, "柱＝6 角形（閉じて 7 点）");
	const ring = columnRing(139.7, 35.6, 500, 4); ok(near(ring[0][0] - 139.7, 500 / 6378137 * 180 / Math.PI / Math.cos(35.6 * Math.PI / 180), 1e-9), "柱の半径は m");
	let threw = false; try { toGeoJSON([], "hexes", {}); } catch { threw = true; } ok(threw, "知らない kind は投げる");
}

if (fails) { console.error(`\n${fails} failed`); process.exit(1); } else console.log("\nall passed");
