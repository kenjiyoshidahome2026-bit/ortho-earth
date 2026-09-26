// ベクタタイルの押し出し（段 8①・src/vtmesh.js）の単体検定：輪の分類・枠で切る・縁の壁・屋根の面積・外向きの法線・縦の陰影・置き換え・ズームの鍵・filter の zoom。
// 実描画は t-mlcompat.html?g=vector。使い方：node packages/globe/tests/vtextrude.mjs
import { classifyRings, clipRing, ringArea2, tessellatePolygon, buildMesh, verticalShade, retainTiles, paintZoomKey, filterZoom, tileToLonLat } from "../src/vtmesh.js";
import { evalExpr } from "../../ortho-core/src/expr.js";

let bad = 0, n = 0;
const ok = (name, cond, note = "") => { n++; if (!cond) { bad++; console.log(`✗ ${name}${note ? ` (${note})` : ""}`); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const E = 4096;
// MVT の幾何（閉じた輪＝先頭の複製つき）。外周は画面で時計回り（y 下向き）＝MVT の仕様
const geomOf = rings => { const coords = [], ends = []; for (const r of rings) { for (const [x, y] of r) coords.push(x, y); coords.push(r[0][0], r[0][1]); ends.push(coords.length); } return { coords: Int32Array.from(coords), ends }; };
const cw = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];     // y 下向きで時計回り（外周）
const ccw = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];    // 逆（穴）
const triArea = (xy, t) => { let s = 0; for (let i = 0; i < t.length; i += 3) { const a = t[i] * 2, b = t[i + 1] * 2, c = t[i + 2] * 2; s += Math.abs((xy[b] - xy[a]) * (xy[c + 1] - xy[a + 1]) - (xy[c] - xy[a]) * (xy[b + 1] - xy[a + 1])) / 2; } return s; };

// ── 輪の分類 ──
{
	const g = geomOf([cw(100, 100, 300, 300), ccw(150, 150, 200, 200), cw(500, 500, 600, 600), [[700, 700], [800, 700], [750, 700]]]);   // 外周・穴・次の面・面積 0
	const p = classifyRings(g);
	ok("classify-count", p.length === 2 && p[0].length === 2 && p[1].length === 1, JSON.stringify(p.map(q => q.length)));
	ok("classify-open", p[0][0].length === 8, `len=${p[0][0].length}`);   // 閉じ点を落とす
	const g2 = geomOf([ccw(100, 100, 300, 300), cw(150, 150, 200, 200)]);   // 最初の輪の向きが外周（逆向きのタイルも受ける）
	ok("classify-first-ring-orientation", classifyRings(g2).length === 1 && classifyRings(g2)[0].length === 2);
}
// ── 枠で切る ──
{
	const inside = Float64Array.from([10, 10, 20, 10, 20, 20]);
	ok("clip-inside-same", JSON.stringify(Array.from(clipRing(inside, E))) === JSON.stringify([10, 10, 20, 10, 20, 20]));
	const cross = Float64Array.from([4000, 100, 4200, 100, 4200, 300, 4000, 300]);
	const c = clipRing(cross, E);
	ok("clip-cross-exact-edge", c && Math.max(...c.filter((_, i) => i % 2 === 0)) === E && near(Math.abs(ringArea2(c)) / 2, 96 * 200), c && JSON.stringify(Array.from(c)));
	ok("clip-outside-null", clipRing(Float64Array.from([4200, 100, 4300, 100, 4300, 300]), E) === null);
	ok("clip-sliver-null", clipRing(Float64Array.from([4096, 100, 4200, 100, 4200, 100.001, 4096, 100.001]), E) === null);
}
// ── 縁をまたぐ建物＝左右のタイルで切って屋根の面積が元と一致・縁に壁なし ──
{
	const B = cw(4000, 1000, 4200, 1200);   // 左のタイル（x が E をはみ出す＝バッファ）
	const left = tessellatePolygon(classifyRings(geomOf([B]))[0], E);
	const right = tessellatePolygon(classifyRings(geomOf([B.map(([x, y]) => [x - E, y])]))[0], E);   // 右のタイルでは x−E
	const aL = triArea(left.xy, left.tris), aR = triArea(right.xy, right.tris);
	ok("seam-roof-area", near(aL + aR, 200 * 200, 1e-6), `${aL}+${aR}`);
	const wallsOnSeam = g => { let k = 0; const m = g.xy.length / 2; for (let i = 0; i < m; i++) { const j = (i + 1) % m; if (g.wall[i] && g.xy[i * 2] === g.xy[j * 2] && (g.xy[i * 2] === 0 || g.xy[i * 2] === E)) k++; } return k; };
	ok("seam-no-wall", wallsOnSeam(left) === 0 && wallsOnSeam(right) === 0);
	ok("seam-other-walls", left.wall.reduce((a, b) => a + b, 0) === 3 && right.wall.reduce((a, b) => a + b, 0) === 3, `${left.wall} ${right.wall}`);
	// 穴つき・凹
	const h = tessellatePolygon(classifyRings(geomOf([cw(100, 100, 400, 400), ccw(200, 200, 300, 300)]))[0], E);
	ok("hole-area", near(triArea(h.xy, h.tris), 300 * 300 - 100 * 100));
	const L = [[100, 100], [300, 100], [300, 200], [200, 200], [200, 300], [100, 300]];
	const lg = tessellatePolygon(classifyRings(geomOf([L]))[0], E);
	ok("concave-area", near(triArea(lg.xy, lg.tris), 200 * 200 - 100 * 100));
	// 外周が枠の外＝面ごと消える
	ok("outer-gone", tessellatePolygon(classifyRings(geomOf([cw(4200, 100, 4300, 200)]))[0], E) === null);
}
// ── メッシュ：外向きの法線・色・高さ・形 ──
{
	const tile = { z: 14, x: 14552, y: 6451, extent: E };
	const g = tessellatePolygon(classifyRings(geomOf([cw(1000, 1000, 1200, 1200)]))[0], E);
	const r = buildMesh([{ ...g, fi: 0 }], () => ({ h: 30, base: 0, rgba: [200, 100, 50, 255] }), tile);
	const m = r.mesh, nv = m.pos.length / 3;
	ok("mesh-shape", m.nrm.length === nv * 4 && m.col.length === nv * 4 && m.uv.length === nv * 2 && m.twoSided === 0 && m.idx.length === 6 + 4 * 6, `nv=${nv} ni=${m.idx.length}`);
	// 中心（ECEF の向き）から見て、壁の法線が外を向く
	const [clon, clat] = tileToLonLat(14, tile.x, tile.y, E, 1100, 1100);
	const D2R = Math.PI / 180, u = (lon, lat) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.sin(lat * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R)];
	const c = u(clon, clat);
	let out = 0, walls = 0;
	for (let i = 4; i < nv; i += 4) {   // 屋根 4 点のあとに壁 4 点ずつ
		const p = [m.pos[i * 3] + m.origin[0], m.pos[i * 3 + 1] + m.origin[1], m.pos[i * 3 + 2] + m.origin[2]];
		const q = [m.pos[(i + 1) * 3] + m.origin[0], m.pos[(i + 1) * 3 + 1] + m.origin[1], m.pos[(i + 1) * 3 + 2] + m.origin[2]];
		const mid = [(p[0] + q[0]) / 2 - c[0], (p[1] + q[1]) / 2 - c[1], (p[2] + q[2]) / 2 - c[2]];
		const nn = [m.nrm[i * 4], m.nrm[i * 4 + 1], m.nrm[i * 4 + 2]];   // ortho 軸（x, y＝北極, z）＝pos と同じ軸
		walls++; if (nn[0] * mid[0] + nn[1] * mid[1] + nn[2] * mid[2] > 0) out++;
	}
	ok("wall-normals-outward", walls === 4 && out === 4, `${out}/${walls}`);
	const top = m.pos[2 * 1] !== undefined;
	const rad = i => Math.hypot(m.pos[i * 3] + m.origin[0], m.pos[i * 3 + 1] + m.origin[1], m.pos[i * 3 + 2] + m.origin[2]);
	ok("roof-height", top && near((rad(0) - 1) * 6371000, 30, 0.05), `${(rad(0) - 1) * 6371000}`);
	ok("roof-color", m.col[0] === 200 && m.col[1] === 100 && m.col[2] === 50 && m.col[3] === 255);
	ok("wall-shade", m.col[4 * 4] === Math.round(200 * 0.84), `${m.col[16]}`);   // 低い建物の壁＝0.84
	ok("filtered-null", buildMesh([{ ...g, fi: 0 }], () => null, tile) === null && buildMesh([{ ...g, fi: 0 }], () => ({ h: 5, base: 5, rgba: [0, 0, 0, 255] }), tile) === null);
}
// ── 縦の陰影（MapLibre の式） ──
ok("vshade-low", verticalShade(false, 0, 50) === 0.84 && verticalShade(true, 0, 50) === 0.84);
ok("vshade-tall-top", near(verticalShade(true, 0, 150), 1) && verticalShade(false, 0, 150) === 0.84);
ok("vshade-floating", verticalShade(false, 20, 40) === 1);
// ── 置き換え（retain） ──
{
	const set = s => new Set(s), W = [{ z: 15, x: 0, y: 0 }, { z: 15, x: 1, y: 0 }, { z: 15, x: 0, y: 1 }, { z: 15, x: 1, y: 1 }];
	const eq = (a, b) => [...a].sort().join() === [...b].sort().join();
	const r1 = retainTiles(W, k => k === "14/0/0");
	ok("retain-parent-while-loading", eq(r1, set(["14/0/0"])), [...r1].join());
	const r2 = retainTiles(W, k => k === "14/0/0" || k === "15/0/0");   // 子が 1 枚だけ揃った＝親を出し続ける（重ねない）
	ok("retain-no-overlap", eq(r2, set(["14/0/0"])), [...r2].join());
	const r3 = retainTiles(W, k => k.startsWith("15/") || k === "14/0/0");
	ok("retain-children-when-all", eq(r3, set(W.map(t => `15/${t.x}/${t.y}`))), [...r3].join());
	const r4 = retainTiles([{ z: 14, x: 0, y: 0 }], k => k === "15/0/0" || k === "15/1/1");   // ズームアウト直後＝子孫で覆う
	ok("retain-descendants", eq(r4, set(["15/0/0", "15/1/1"])), [...r4].join());
	ok("retain-minz", retainTiles([{ z: 15, x: 0, y: 0 }], k => k === "13/0/0", { minZ: 14 }).size === 0);
}
// ── ズームの鍵 ──
{
	const ev = (e, z) => evalExpr(e, { zoom: z, props: {}, geom: null, vars: {}, origin: "ml" });
	const P = { "fill-extrusion-height": ["interpolate", ["linear"], ["-", ["zoom"], 1], 15, 0, 16, ["get", "h"]], "fill-extrusion-color": "#aaa" };   // 正規化後（MapLibre の z 15→16）
	ok("zkey-hi-const", paintZoomKey(P, 18, ev) === paintZoomKey(P, 19.3, ev) && paintZoomKey(P, 18, ev).endsWith(":hi"), paintZoomKey(P, 18, ev));
	ok("zkey-lo-const", paintZoomKey(P, 14, ev) === paintZoomKey(P, 15.9, ev), `${paintZoomKey(P, 14, ev)} ${paintZoomKey(P, 15.9, ev)}`);
	ok("zkey-inside-quant", paintZoomKey(P, 16.5, ev) !== paintZoomKey(P, 16.75, ev) && paintZoomKey(P, 16.5, ev) === paintZoomKey(P, 16.55, ev));
	const S = { "fill-extrusion-height": ["step", ["zoom"], 0, 15, 10, 16, 20] };
	ok("zkey-step", paintZoomKey(S, 15.2, ev) === paintZoomKey(S, 15.9, ev) && paintZoomKey(S, 15.2, ev) !== paintZoomKey(S, 16.1, ev));
	ok("zkey-none", paintZoomKey({ "fill-extrusion-height": ["get", "h"] }, 16, ev) === "");
	const N = { "fill-extrusion-height": ["*", ["get", "h"], ["interpolate", ["linear"], ["zoom"], 15, 0, 16, 1]] };   // 入れ子＝今の規則（0.25 刻み）
	ok("zkey-nested", paintZoomKey(N, 20, ev) !== paintZoomKey(N, 20.5, ev));
}
// ── filter の zoom（MapLibre の z＋1＝正規化した式の中で MapLibre の z に戻る） ──
{
	const f = [">=", ["-", ["zoom"], 1], 16];   // MapLibre の z 16 から
	const at = (tz, mz, cz) => !!evalExpr(f, { zoom: filterZoom(tz, mz, cz), props: {}, geom: "Polygon", vars: {}, origin: "ml" });
	ok("fzoom-overzoom-boundary", at(14, 14, 17.4) === true && at(14, 14, 16.4) === false, `${filterZoom(14, 14, 17.4)} ${filterZoom(14, 14, 16.4)}`);
	ok("fzoom-tile-z", filterZoom(12, 14, 17) === 13);   // 過拡大でないタイル＝タイルの z
}

console.log(bad ? `vtextrude: ${bad}/${n} failed` : `vtextrude: all ${n} checks passed`);
process.exit(bad ? 1 : 0);
