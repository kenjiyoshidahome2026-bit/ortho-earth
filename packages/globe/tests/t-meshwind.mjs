// 巻き順を法線に揃える（meshwind.ts）の検定＝逆向きだけ入れ替える・退化は触らない。node packages/globe/tests/t-meshwind.mjs
import assert from "node:assert/strict";
import { windToNormals } from "../src/meshwind.ts";
// 3 枚：A は +z 法線で反時計回り（そのまま）・B は +z 法線で時計回り（入れ替え）・C は退化（3 点同一線上）
const pos = new Float32Array([
	0, 0, 0,  1, 0, 0,  0, 1, 0,   // A（cross = +z）
	0, 0, 0,  0, 1, 0,  1, 0, 0,   // B（cross = −z）
	0, 0, 0,  1, 0, 0,  2, 0, 0,   // C（退化）
]);
const nrm = new Int8Array(9 * 4);
for (let i = 0; i < 9; i++) nrm[i * 4 + 2] = 127;   // 全頂点 +z
const idx = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const n = windToNormals(pos, nrm, idx);
assert.equal(n, 1, "逆向きの B だけ入れ替える");
assert.deepEqual(Array.from(idx), [0, 1, 2, 3, 5, 4, 6, 7, 8], "B の 2・3 頂点目を入れ替え、A と退化の C はそのまま");
assert.equal(windToNormals(pos, nrm, idx), 0, "2 回目は何も変えない（冪等）");
// 法線が −z なら A が入れ替わる
for (let i = 0; i < 9; i++) nrm[i * 4 + 2] = -127;
const idx2 = new Uint32Array([0, 1, 2, 3, 4, 5]);
assert.equal(windToNormals(pos, nrm, idx2), 1);
assert.deepEqual(Array.from(idx2), [0, 2, 1, 3, 4, 5]);
console.log("  ✓ windToNormals：逆向きだけ入れ替え・退化は不変・冪等");
