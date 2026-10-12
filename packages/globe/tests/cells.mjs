#!/usr/bin/env node
// セルの算法（deck.gl 差分 PR-5・2026-10-12・src/cells/core.js）の常設検定：
//   ・geohash（Wikipedia の例 ezs42 ≈ 42.605, −5.603）・quadkey（Bing の例 タイル (3,5) z3 ＝ "213"）・地域メッシュ（東京駅＝53394611）・経緯度格子
//   ・S2：面 level 0 の token＝1,3,5,7,9,b・中心を再符号化すると同じ token・親子・level・環の中に点がある・±180° と極
//   ・binPoints の count/sum/mean/min/max・cellsToGeoJSON・resForZoom が単調
// 使い方：node packages/globe/tests/cells.mjs
import { grid, mesh, geohash, quadkey, s2, binPoints, cellsToGeoJSON, resForZoom, gridRes, pointsOf } from "../src/cells/core.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
// 多角形（環）の中に点があるか（偶奇）
const inside = (ring, [x, y]) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };

console.log("geohash");
ok(geohash.encode(-5.603, 42.605, 5) === "ezs42", "ezs42（Wikipedia の例）");
{ const b = geohash.bbox("ezs42"); ok(b[0] < -5.603 && -5.603 < b[2] && b[1] < 42.605 && 42.605 < b[3], `bbox が点を含む ${b.map(v => v.toFixed(3))}`); ok(near(b[2] - b[0], 0.0439453125) && near(b[3] - b[1], 0.0439453125), "5 文字＝0.044°×0.044°"); }
ok(geohash.encode(139.7671, 35.6812, 7).startsWith("xn76"), `東京駅 ${geohash.encode(139.7671, 35.6812, 7)}（xn76…）`);
ok(geohash.ring("ezs42").length === 5 && inside(geohash.ring("ezs42"), [-5.603, 42.605]), "環（閉じた 5 点）に点がある");
ok(geohash.res("ezs42") === 5, "res＝文字数");

console.log("quadkey");
ok(JSON.stringify(quadkey.tile("213")) === JSON.stringify({ x: 3, y: 5, z: 3 }), "213 → タイル (3,5) z3（Bing の例）");
{ const b = quadkey.bbox("213"), c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; ok(quadkey.encode(c[0], c[1], 3) === "213", "bbox の中心を再符号化＝同じ鍵"); ok(near(b[0], -45) && near(b[2], 0), `経度 −45..0 ${b.map(v => v.toFixed(2))}`); }
ok(quadkey.encode(139.7671, 35.6812, 1) === "1" && quadkey.encode(-100, -30, 1) === "2", "z1＝北東 1・南西 2");
ok(quadkey.encode(139.7671, 35.6812, 12).length === 12 && quadkey.res("1230") === 4, "長さ＝z");

console.log("mesh（地域メッシュ）");
ok(mesh.encode(139.7671, 35.6812, 1) === "5339" && mesh.encode(139.7671, 35.6812, 2) === "533946" && mesh.encode(139.7671, 35.6812, 3) === "53394611", `東京駅 ${mesh.encode(139.7671, 35.6812, 3)}`);
{ const r = mesh.ring("53394611"); ok(inside(r, [139.7671, 35.6812]), "3 次メッシュの環に東京駅がある"); ok(near(r[1][0] - r[0][0], 45 / 3600, 1e-9) && near(r[2][1] - r[1][1], 30 / 3600, 1e-9), "3 次＝45″×30″"); }
{ const r = mesh.ring("5339"); ok(near(r[1][0] - r[0][0], 1) && near(r[2][1] - r[1][1], 40 / 60), "1 次＝1°×40′"); }
ok(mesh.encode(-122, 37, 3) === null, "日本の外＝null");
ok(mesh.res("5339") === 1 && mesh.res("533946") === 2 && mesh.res("53394611") === 3, "res＝桁数");

console.log("grid");
{ const r = { dLon: 0.5, dLat: 0.25 }; const id = grid.encode(139.7671, 35.6812, r); ok(id === "639:502", `id ${id}`); ok(inside(grid.ring(id, r), [139.7671, 35.6812]), "環に点がある"); }
{ const g = gridRes(1000, 35); ok(near(g.dLat, 1000 / 111319.49, 1e-6) && near(g.dLon, g.dLat / Math.cos(35 * Math.PI / 180), 1e-9), `1 km ＝ ${g.dLat.toFixed(5)}° × ${g.dLon.toFixed(5)}°（緯度 35°）`); }

console.log("s2");
ok([[0, 0], [90, 0], [0, 90], [180, 0], [-90, 0], [0, -90]].map(([lo, la]) => s2.encode(lo, la, 0)).join(",") === "1,3,5,7,9,b", "面（level 0）の token＝1,3,5,7,9,b");
{
	const t = s2.encode(139.7671, 35.6812, 10);
	ok(s2.res(t) === 10 && s2.level(s2.fromToken(t)) === 10, `東京駅 level 10 ＝ ${t}`);
	const c = s2.center(t); ok(s2.encode(c[0], c[1], 10) === t, "中心を再符号化＝同じ token");
	const r = s2.ring(t); ok(r.length === 5 && inside(r, [139.7671, 35.6812]) && inside(r, c), "環（4 隅）に点と中心がある");
	const t30 = s2.encode(139.7671, 35.6812, 30); ok(s2.res(t30) === 30 && s2.parent(t30, 10) === t, "葉（level 30）の親＝同じ level 10 のセル");
	const t12 = s2.encode(139.7671, 35.6812, 12); ok(t12.startsWith(t.slice(0, -1)) && s2.parent(t12, 10) === t, `level 12 ${t12} の親＝${t}`);
	ok(s2.token(s2.fromToken(t)) === t, "token ↔ id の往復");
}
{ const t = s2.encode(179.9, 10, 6), r = s2.ring(t); ok(r.every(p => p[0] >= 0) && inside(r, [179.9, 10]), "±180° を跨ぐ環＝経度を東へ伸ばす"); }
{ const t = s2.encode(10, 89.5, 4), r = s2.ring(t, 8); ok(r.length === 33 && r.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])), "極の近くの大きいセル＝辺を 8 分割（33 点）"); }
{ const a = s2.encode(139.7671, 35.6812, 15), b = s2.encode(139.7672, 35.6812, 15); ok(a !== b || s2.res(a) === 15, "level 15 の隣り合う点"); const pa = s2.parent(a, 8), pb = s2.parent(b, 8); ok(pa === pb, "どちらも同じ level 8 の親"); }

console.log("binPoints / cellsToGeoJSON");
{
	const pts = [{ lon: 139.7671, lat: 35.6812, props: { v: 2 } }, { lon: 139.7672, lat: 35.6813, props: { v: 4 } }, { lon: 139.9, lat: 35.9, props: { v: 10 } }];
	const m = binPoints(pts, "geohash", 5, { weight: "v" });
	ok(m.size === 2, `2 セル（${[...m.keys()]}）`);
	const a = m.get(geohash.encode(139.7671, 35.6812, 5)); ok(a.count === 2 && a.sum === 6 && a.mean === 3 && a.min === 2 && a.max === 4, JSON.stringify(a));
	const g = cellsToGeoJSON(m, "geohash", 5, (id, i, p) => ({ dbl: p.sum * 2 }));
	ok(g.features.length === 2 && g.features[0].geometry.type === "Polygon" && g.features[0].properties.dbl === 12 && g.features[0].properties.kind === "geohash", "GeoJSON＋props");
	const gi = cellsToGeoJSON(["5339", "5340"], "mesh"); ok(gi.features.length === 2 && gi.features[1].properties.cell === "5340" && gi.features[1].properties.res === 1, "id の配列");
	const gs = cellsToGeoJSON({ [s2.encode(0, 0, 3)]: { name: "x" } }, "s2"); ok(gs.features[0].properties.name === "x" && gs.features[0].properties.res === 3, "{ id: props }（s2）");
	ok(binPoints([[139.7, 35.6], [139.71, 35.61]], "grid", { dLon: 1, dLat: 1 }).size === 1, "[[lon, lat], …] も受ける（grid）");
	let threw = false; try { binPoints(pts, "hex", 1); } catch { threw = true; } ok(threw, "知らない kind は投げる");
	ok(pointsOf({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] }, properties: { a: 1 } }] }).length === 2, "MultiPoint は 2 点");
}

console.log("resForZoom");
{ const a = resForZoom("s2", 3), b = resForZoom("s2", 10), c = resForZoom("s2", 16); ok(a < b && b < c, `s2: z3→${a} z10→${b} z16→${c}`); }
{ const a = resForZoom("geohash", 3), b = resForZoom("geohash", 12); ok(a < b, `geohash: z3→${a} z12→${b}`); }
{ const a = resForZoom("quadkey", 5), b = resForZoom("quadkey", 14); ok(a < b && b <= 23, `quadkey: z5→${a} z14→${b}`); }
ok(resForZoom("mesh", 6) === 1 && resForZoom("mesh", 10) === 2 && resForZoom("mesh", 14) === 3, "mesh: z6→1 次 z10→2 次 z14→3 次");
{ const g = resForZoom("grid", 10, { lat: 35 }); ok(g.dLon > 0 && g.dLat > 0 && g.dLat < 0.1, `grid: z10 → ${g.dLat.toFixed(4)}°`); }

if (fails) { console.error(`\n${fails} failed`); process.exit(1); } else console.log("\nall passed");
