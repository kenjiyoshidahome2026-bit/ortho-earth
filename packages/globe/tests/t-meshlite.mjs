// 軽量 index（meshlite.ts）の検定＝面積で落とす・順序を保つ・lodCounts を詰め直す・橋梁は呼び手が外す。node packages/globe/tests/t-meshlite.mjs
import assert from "node:assert/strict";
import { liteIndex } from "../src/meshlite.ts";
const S = 6371000;   // 世界単位→m
// 4 枚：A 大（10×10/2=50 m²）・B 小（0.1×0.1/2=0.005 m²）・C 中（1×1/2=0.5 m²）・D 小（0.2×0.2/2=0.02 m²）。高さ降順に並んでいる想定
const m = v => v / S;
const pos = new Float32Array([
	0, 0, 0,  m(10), 0, 0,  0, m(10), 0,        // A
	0, 0, 0,  m(0.1), 0, 0,  0, m(0.1), 0,      // B
	0, 0, 0,  m(1), 0, 0,  0, m(1), 0,          // C
	0, 0, 0,  m(0.2), 0, 0,  0, m(0.2), 0,      // D
]);
const idx = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const lodCounts = [12, 9, 6, 3];   // ≥h0 全部・≥h1 A,B,C・≥h2 A,B・≥h3 A
{
	const r = liteIndex(pos, idx, lodCounts, 0.25, S);
	assert.deepEqual(Array.from(r.idx), [0, 1, 2, 6, 7, 8], "0.25 m² 未満（B・D）が落ち、A・C の順序は保つ");
	assert.equal(r.dropped, 2); assert.equal(r.tris, 4);
	assert.deepEqual(r.lodCounts, [6, 6, 3, 3], "lodCounts：各段の先頭 count を残った枚数で詰め直す");
	console.log("  ✓ liteIndex：面積で落とす・順序・lodCounts");
}
{
	const r = liteIndex(pos, idx, lodCounts, 0, S);
	assert.equal(r.idx, idx, "minArea 0＝そのまま（同じ配列）"); assert.equal(r.dropped, 0);
	const r2 = liteIndex(pos, idx, null, 1, S);
	assert.deepEqual(Array.from(r2.idx), [0, 1, 2]); assert.equal(r2.lodCounts, null, "lodCounts 無し＝null のまま");
	const r3 = liteIndex(pos, new Uint32Array(0), lodCounts, 1, S);
	assert.equal(r3.tris, 0, "空の index");
	console.log("  ✓ liteIndex：無効値・lodCounts 無し・空");
}
{
	// 1 m² 直上は残る（閾値の等号＝残す側）・単位：面積は scale² で m² に
	const r = liteIndex(pos, idx, lodCounts, 0.5, S);
	assert.deepEqual(Array.from(r.idx), [0, 1, 2, 6, 7, 8], "C（0.5 m²）は閾値 0.5 で残る");
	console.log("  ✓ liteIndex：閾値の等号・単位");
}
console.log("✓ t-meshlite PASS");
{   // liteReorder：段ごとに残す三角形を先頭へ・落とす三角形は後ろ・段の境界と prefix は不変
	const { liteReorder } = await import("../src/meshlite.ts");
	const idx2 = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);   // A B C D（高さ降順）
	const lc2 = [12, 9, 6, 3];   // 段 3＝[0,3)=A・段 2＝[3,6)=B・段 1＝[6,9)=C・段 0＝[9,12)=D
	const r = liteReorder(pos, idx2, lc2, 0.25, S);
	assert.deepEqual(r.liteCounts, [0, 3, 0, 3], "段ごとの残す index 数：A と C だけ残る（B・D は 0.25 m² 未満）");
	assert.equal(r.dropped, 2);
	assert.deepEqual(Array.from(idx2), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "1 段 1 枚なので並びは不変");
	// 1 段に 2 枚：小さい B を A の前に置いた段では、A が先頭へ来る
	const idx3 = new Uint32Array([3, 4, 5, 0, 1, 2, 6, 7, 8, 9, 10, 11]);
	const r3 = liteReorder(pos, idx3, [12, 6], 0.25, S);   // 段 1＝[0,6)={B,A}・段 0＝[6,12)={C,D}
	assert.deepEqual(Array.from(idx3), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "段の中で残す A を先頭に、落とす B を後ろに（段の境界は動かない）");
	assert.deepEqual(r3.liteCounts, [3, 3]);
	assert.equal(liteReorder(pos, idx3, null, 0.25, S).liteCounts[0], 6, "lodCounts 無し＝全体 1 段");
	assert.equal(liteReorder(pos, idx3, lc2, 0, S), null, "minArea 0＝何もしない");
	console.log("  ✓ liteReorder：段ごとの並べ替えと liteCounts");
}
