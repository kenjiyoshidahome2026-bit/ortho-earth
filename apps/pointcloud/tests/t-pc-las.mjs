// pc-las.ts の検定：LAS 1.2 の見出し・点の形式 2・(E, N, U) のまま 1 mm・色（8→16 bit）と分類・間引き・錨の VLR・範囲
import assert from "node:assert/strict";
import { dumpToLas, LAS_ANCHOR_USER } from "../pc-las.ts";

let pass = 0; const ok = (n, f) => { f(); pass++; console.log("✓", n); };
const dump = { n: 3, anchor: [139.1, 35.1, 12.5], pts: new Float32Array([1, 2, 3, -4, -5, -6, 7.25, 8.5, 9.125]), rgb: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]), cls: new Uint8Array([2, 6, 5]) };
const str = (b, o, n) => new TextDecoder().decode(b.subarray(o, o + n)).replace(/\0+$/, "");
const head = (b) => {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return { dv, sig: str(b, 0, 4), ver: [b[24], b[25]], hsize: dv.getUint16(94, true), off: dv.getUint32(96, true), nvlr: dv.getUint32(100, true), fmt: b[104], len: dv.getUint16(105, true), n: dv.getUint32(107, true),
		scale: [0, 1, 2].map(a => dv.getFloat64(131 + a * 8, true)), max: [0, 1, 2].map(a => dv.getFloat64(179 + a * 16, true)), min: [0, 1, 2].map(a => dv.getFloat64(187 + a * 16, true)) };
};
ok("見出し：LASF 1.2・形式 2・26 B・点の数・大きさ", () => {
	const b = dumpToLas(dump), h = head(b);
	assert.equal(h.sig, "LASF"); assert.deepEqual(h.ver, [1, 2]); assert.equal(h.hsize, 227); assert.equal(h.nvlr, 1);
	assert.equal(h.fmt, 2); assert.equal(h.len, 26); assert.equal(h.n, 3); assert.equal(b.length, h.off + 3 * 26);
	assert.deepEqual(h.scale, [0.001, 0.001, 0.001]);
});
ok("錨の VLR：user orthoEarth・JSON に lon/lat/height", () => {
	const b = dumpToLas(dump, { source: "atami.copc.laz" }), h = head(b);
	assert.equal(str(b, 227 + 2, 16), LAS_ANCHOR_USER); assert.equal(h.dv.getUint16(227 + 18, true), 1);
	const len = h.dv.getUint16(227 + 20, true), j = JSON.parse(str(b, 227 + 54, len));
	assert.deepEqual(j.anchor, { lon: 139.1, lat: 35.1, height: 12.5, datum: "orthometric" }); assert.equal(j.source, "atami.copc.laz");
	assert.equal(227 + 54 + len, h.off);
});
ok("点：(E, N, U) のまま 1 mm・色 ×257・分類・範囲", () => {
	const b = dumpToLas(dump), h = head(b), p = (k, o) => h.off + k * 26 + o;
	assert.deepEqual([0, 4, 8].map(o => h.dv.getInt32(p(2, o), true)), [7250, 8500, 9125]);
	assert.deepEqual([0, 4, 8].map(o => h.dv.getInt32(p(1, o), true)), [-4000, -5000, -6000]);
	assert.equal(b[p(0, 15)], 2); assert.equal(b[p(1, 15)], 6); assert.equal(b[p(0, 14)], 9);
	assert.deepEqual([20, 22, 24].map(o => h.dv.getUint16(p(0, o), true)), [10 * 257, 20 * 257, 30 * 257]);
	assert.deepEqual(h.min, [-4, -5, -6]); assert.deepEqual(h.max, [7.25, 8.5, 9.125]);
});
ok("色・分類が無い時：白・0", () => {
	const b = dumpToLas({ ...dump, rgb: null, cls: null }), h = head(b);
	assert.equal(h.dv.getUint16(h.off + 20, true), 65535); assert.equal(b[h.off + 15], 0);
});
ok("間引き：maxPoints で均等に", () => {
	const big = { n: 10, anchor: [0, 0, 0], pts: new Float32Array(30).map((_, i) => i), rgb: null, cls: null };
	const b = dumpToLas(big, { maxPoints: 5 }), h = head(b);
	assert.equal(h.n, 5); assert.equal(h.dv.getInt32(h.off + 26, true), 6000);   // 2 番目＝元の 2 番（x=6）
});
ok("日付：通日と年", () => {
	const b = dumpToLas(dump, { date: new Date(Date.UTC(2026, 10, 8)) }), dv = new DataView(b.buffer);
	assert.equal(dv.getUint16(90, true), 312); assert.equal(dv.getUint16(92, true), 2026);
});
console.log(`t-pc-las: ${pass} ok`);
