// 1 枚のタイルの中の標高（createGetHeight.js sampleCell）の門（点群計画 段 4・2026-10-15）。node tests/elevation-sample.mjs
// 守るもの＝値は画素の中心にある（row0＝北）＝焼き（bake-dem10b）と描く側（downsampleFlipped・gx = u·w − ½）と同じ所の値を返す
import assert from "node:assert/strict";
import { sampleCell } from "../src/elevation/createGetHeight.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("✓", name); };
// 4×4 のタイル：値＝列×10 ＋ 南からの行（北の行 0 が y=3）
const w = 4, h = 4, data = new Int16Array(w * h);
for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = c * 10 + (h - 1 - r);
const v = { data, width: w, height: h };
const at = (c, rs) => [(c + 0.5) / w, (rs + 0.5) / h];   // 画素の中心（rs＝南からの行）

t("画素の中心はその画素の値", () => {
	for (let c = 0; c < w; c++) for (let rs = 0; rs < h; rs++) { const [x, y] = at(c, rs); assert.equal(sampleCell(v, x, y), c * 10 + rs); }
});
t("中心の間は一次補間（東西・南北）", () => {
	assert.equal(sampleCell(v, 2 / w, (1.5) / h), 15 + 1);   // 列 1 と 2 の中間・南から行 1 の中心
	assert.equal(sampleCell(v, 1.5 / w, 2 / h), 10 + 1.5);   // 列 1 の中心・南から行 1 と 2 の中間
});
t("縁は端の画素の値で止める・データ無しは 0", () => {
	assert.equal(sampleCell(v, 0, 0), 0); assert.equal(sampleCell(v, 1, 1), 33); assert.equal(sampleCell(v, 0.999, 0.001), 30);
	assert.equal(sampleCell(null, 0.5, 0.5), 0); assert.equal(sampleCell({}, 0.5, 0.5), 0);
});
t("北が上（row0＝北）", () => {
	assert.ok(sampleCell(v, 0.5, 0.9) > sampleCell(v, 0.5, 0.1));
});
console.log(`elevation-sample: ${n} passed`);
