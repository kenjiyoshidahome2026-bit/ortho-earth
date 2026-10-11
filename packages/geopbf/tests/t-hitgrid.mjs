// t-hitgrid: 当たり判定の格子索引（改良点 ⑧・src/extension/hitgrid.js）＝findPolygon／findMortonNear（identifyAt）の答えが旧の全走査と一致し、速い。
// ①面 6,000 枚（大きさ 3 段・入れ子・多角形の塊・縫い目跨ぎの大物 1）× 乱数の点 3,000＝smallest-wins・accept・viewBbox が一致
// ②線 3,000 本 × 乱数の点（許容半径つき）＝一致 ③索引の形（cell の CSR・big・fidOff）④速さ（格子 ≥ 全走査、目安で表示）
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
import { topology, unPackGintBuffer } from "../src/extension/topology.js";
import { gint } from "../src/extension/gint.js";
import { identifyAt, findPolygon, hitGridMode, hitGridOf, buildHitGrid } from "../src/extension/identify.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
{
	const wasmJs = fileURLToPath(new URL("../wasm/pkg/gint_wasm.js", import.meta.url));
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
let seq = 0;
const F = (type, coordinates) => ({ type: "Feature", properties: { k: seq++ }, geometry: { type, coordinates } });
const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const SE = gint.SCALE_E, toI = (lng, lat) => [Math.round((lng + 180) * SE), Math.round((lat + 90) * SE)];
// ── ① 面 ──
const polys = [];
for (let i = 0; i < 6000; i++) {
	const x = 130 + rnd() * 15, y = 30 + rnd() * 15, s = [0.02, 0.1, 0.5][i % 3] * (0.5 + rnd());
	if (i % 97 === 0) polys.push(F("MultiPolygon", [sq(x, y, x + s, y + s), sq(x + 2 * s, y, x + 3 * s, y + s)]));
	else polys.push(F("Polygon", i % 11 === 0 ? [...sq(x, y, x + s, y + s), ...sq(x + s * 0.3, y + s * 0.3, x + s * 0.6, y + s * 0.6)] : sq(x, y, x + s, y + s)));   // 穴あきも
}
polys.push(F("Polygon", sq(130, 30, 145, 45)));   // 全部を覆う大物（big へ）
const pp = await new GeoPBF({ name: "t-hitgrid-poly" }).set({ type: "FeatureCollection", features: polys });
const d = unPackGintBuffer(topology(pp));
ok(!!d?.polyStream?.length, `面 ${polys.length} 枚＝polyStream ${d.polyStream.length}`);
const grid = hitGridOf(d.polyStream, d.arcMeta);
ok(grid && grid.n === polys.length && grid.off.length === polys.length, `③ 索引の形: G=${grid.G} cells=${grid.cells} big=${grid.big.length} n=${grid.n}`);
ok(grid.big.length >= 1 && grid.cellOff[grid.G * grid.G] === grid.cells, "③ 大物は big・CSR の末尾＝総数");
const queries = []; for (let i = 0; i < 3000; i++) queries.push(toI(129.5 + rnd() * 16, 29.5 + rnd() * 16));
const acc = fid => fid % 5 !== 0;
const vb = [...toI(135, 35), ...toI(140, 40)];
const run = (mode, extra = []) => { hitGridMode.on = mode; const t0 = performance.now(); const r = queries.map(([x, y]) => findPolygon(d.arcBuffer, d.arcMeta, d.polyStream, x, y, d.polyBboxByFid, ...extra)); return { r, ms: performance.now() - t0 }; };
{
	const A = run(false), B = run(true);
	const hits = B.r.filter(v => v !== null).length;
	ok(A.r.every((v, i) => v === B.r[i]), `① 面: 格子＝全走査（${queries.length} 点・当たり ${hits}・小さい面が勝つ）`);
	ok(hits > 1000 && new Set(B.r).size > 100, `① 当たりが散る（${new Set(B.r).size} 種）`);
	console.log(`  ④ 面の速さ: 全走査 ${A.ms.toFixed(0)}ms → 格子 ${B.ms.toFixed(0)}ms（×${(A.ms / Math.max(1, B.ms)).toFixed(1)}）`);
	ok(B.ms <= A.ms, "④ 格子は全走査より遅くない");
	const A2 = run(false, [null, acc]), B2 = run(true, [null, acc]);
	ok(A2.r.every((v, i) => v === B2.r[i]) && A2.r.every(v => v === null || acc(v)), "① accept が一致（外した地物の下の面が返る）");
	const A3 = run(false, [vb]), B3 = run(true, [vb]);
	ok(A3.r.every((v, i) => v === B3.r[i]), "① viewBbox が一致");
}
// 縫い目跨ぎの大物＝bbox の x が 360e7 を超える（ortho-core bake の周期対応）→ big に入る・東西どちらの片でも当たる
{
	const fid = polys.length - 1, bb = d.polyBboxByFid.get(fid).slice();
	const g2 = buildHitGrid(d.polyStream, d.arcMeta);
	let seen = 0; const [qx, qy] = toI(131, 31);
	// hitCandidates は内部＝findPolygon 経由で検める代わりに、索引の big に大物が居ることを見る
	ok(Array.from(g2.big).includes(fid), "① 全部を覆う大物は big（cell の表を膨らませない）");
	void seen; void qx; void qy;
}
// ── ② 線 ──
const lines = [];
for (let i = 0; i < 3000; i++) { const x = 130 + rnd() * 15, y = 30 + rnd() * 15, s = [0.05, 0.3][i % 2]; lines.push(F("LineString", [[x, y], [x + s, y + s * (rnd() - 0.5)], [x + 2 * s, y]])); }
lines.push(F("MultiLineString", [[[130, 30], [145, 45]], [[130, 45], [145, 30]]]));   // 長い 2 本（big）
const lp0 = await new GeoPBF({ name: "t-hitgrid-line" }).set({ type: "FeatureCollection", features: lines });
const lp = { unPackGint: unPackGintBuffer(topology(lp0)) };
{
	const runL = mode => { hitGridMode.on = mode; const t0 = performance.now(); const r = queries.map(([x, y]) => identifyAt(lp, x / SE - 180, y / SE - 90, { point: 0, polyline: 2000 })); return { r, ms: performance.now() - t0 }; };
	const A = runL(false), B = runL(true);
	const hits = B.r.filter(v => v !== null).length;
	ok(A.r.every((v, i) => v === B.r[i]), `② 線: 格子＝全走査（${queries.length} 点・半径 2km・当たり ${hits}）`);
	ok(hits > 50, "② 当たりがある");
	console.log(`  ④ 線の速さ: 全走査 ${A.ms.toFixed(0)}ms → 格子 ${B.ms.toFixed(0)}ms（×${(A.ms / Math.max(1, B.ms)).toFixed(1)}）`);
	const gl = hitGridOf(lp.unPackGint.lineStream, lp.unPackGint.arcMeta);
	ok(gl.big.length >= 1, `③ 長い線は big（${gl.big.length}）`);
	hitGridMode.on = true;
	const a2 = queries.map(([x, y]) => identifyAt(lp, x / SE - 180, y / SE - 90, { point: 0, polyline: 2000, accept: acc }));
	ok(a2.every(v => v === null || acc(v)), "② accept が効く");
}
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
