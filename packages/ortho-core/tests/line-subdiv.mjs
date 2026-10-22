// 線の細分の検定（vt perf plan §3.2・2026-10-22）。node packages/ortho-core/tests/line-subdiv.mjs
// 守るもの：①既定（drape）は 700m ごとに細分（最大 24） ②drape:false（subLenM=Infinity）は z≥7 で細分しない＝元の線分 1 本＝1 線分
// ③drape:false でも z≤6 は fill と同じ格子（extent/(128>>z)）で粗く刻む（球の弦の沈み） ④細分の有無で線分の端点の集合は同じ（最初の始点・最後の終点）＝絵の輪郭は変わらない
// ⑤buildTilePayload の { drape:false } が同じ口に繋がる
import assert from "node:assert/strict";
import { buildTileDrawList } from "../src/build.ts";
import { buildTilePayload } from "../src/tilepayload.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };
const style = { layers: [{ id: "r", type: "line", "source-layer": "road", paint: { "line-width": 2 } }] };
// タイル左端→右端の 1 本（extent 4096）
const tile = (z, x, y) => ({ z, x, y, layers: { road: { extent: 4096, features: [{ type: "LineString", props: {}, geom: { coords: [0, 2048, 4096, 2048], ends: [4] } }] } } });
const segs = (tl, subLenM) => { const { ops } = buildTileDrawList({ ...tl, subLenM }, style, [0, 0]); return ops[0] ? ops[0].half.length : 0; };

t("既定＝700m ごとに細分（z13 東京のタイル ≈ 4.9km → 7 片）", () => {
	const s = segs(tile(13, 7276, 3225), undefined);
	assert.ok(s >= 6 && s <= 8, `z13 の 1 本が ${s} 片`);
	assert.equal(segs(tile(10, 909, 403), undefined), 24, "z10（≈39km）は上限 24");
});
t("drape:false＝z≥7 は細分しない（1 本＝1 線分）", () => {
	assert.equal(segs(tile(13, 7276, 3225), Infinity), 1);
	assert.equal(segs(tile(10, 909, 403), Infinity), 1);
	assert.equal(segs(tile(7, 113, 50), Infinity), 1);
});
t("drape:false でも z≤6 は fill の格子で粗く刻む（z6＝extent/2 → 2 片・z4＝extent/8 → 8 片・z0＝24 で頭打ち）", () => {
	assert.equal(segs(tile(6, 56, 25), Infinity), 2);
	assert.equal(segs(tile(4, 14, 6), Infinity), 8);
	assert.equal(segs(tile(0, 0, 0), Infinity), 24);
});
t("細分の有無で線の輪郭（始点と終点）は同じ", () => {
	const a = buildTileDrawList(tile(13, 7276, 3225), style, [0, 0]).ops[0], b = buildTileDrawList({ ...tile(13, 7276, 3225), subLenM: Infinity }, style, [0, 0]).ops[0];
	assert.deepEqual([a.P1[0], a.P1[1]], [b.P1[0], b.P1[1]], "始点");
	const na = a.half.length, nb = b.half.length;
	assert.deepEqual([a.P2[(na - 1) * 2], a.P2[(na - 1) * 2 + 1]], [b.P2[(nb - 1) * 2], b.P2[(nb - 1) * 2 + 1]], "終点");
	for (let i = 1; i < na; i++) { assert.equal(a.P1[i * 2], a.P2[(i - 1) * 2]); assert.equal(a.P1[i * 2 + 1], a.P2[(i - 1) * 2 + 1]); }   // 細分は連なる
});
t("buildTilePayload の { drape:false } が同じ口", () => {
	const tl = tile(13, 7276, 3225);
	const a = buildTilePayload(tl.layers, tl, style), b = buildTilePayload(tl.layers, tl, style, { drape: false }), c = buildTilePayload(tl.layers, tl, style, { drape: true });
	assert.ok(a.dl.ops[0].half.length > 1); assert.equal(b.dl.ops[0].half.length, 1); assert.equal(c.dl.ops[0].half.length, a.dl.ops[0].half.length);
	assert.ok(b.bytes < a.bytes, "細分なしは実バイトが減る");
});
console.log(`line-subdiv: ${n} ok`);
