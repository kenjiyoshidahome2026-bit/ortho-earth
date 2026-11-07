// map.readPointCloud の worker 側（copc-worker の open { read } → dump・2026-11-07）の node の検定。node packages/globe/tests/t-copc-read.mjs
//  ① 普通の LAS（Blob）＝上限までに間引く・八分木を作らない・total はファイルの総数
//  ② ZIP の中の LAS＝流して読む（Blob を作らない）＝①と同じ点
//  ③ 分類で落とす（classes）＝残るのはその分類だけ・上限の枠をその分類に使う
import assert from "node:assert/strict";
import zlib from "node:zlib";

let tn = 0;
const t = async (name, fn) => { await fn(); tn++; console.log("  ✔", name); };
// worker の口を node で＝self.onmessage／postMessage を差し替える
const replies = [];
let waiters = [];
globalThis.self = { location: { href: "file:///" }, postMessage: m => { replies.push(m); for (const w of waiters) w(); } };
await import("../src/copc-worker.ts");
const call = async (m, type) => {
	const at = replies.length;
	self.onmessage({ data: m });
	for (;;) {
		const r = replies.slice(at).find(x => (x.type === type || x.type === "error") && x.id === m.id);
		if (r) { if (r.type === "error") throw new Error(r.error); return r; }
		await new Promise(res => waiters.push(res)); waiters = [];
	}
};
// LAS 1.2・形式 3（34B）＝東京駅のあたり（平面直角 IX 系）の 200 m 四方・分類は 10 点に 1 点が建物（6）・他は地面（2）
function makeLas12(n) {
	const keys = new Uint16Array([1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, 6677]), vlr = 54 + keys.byteLength, L = 34, off = 227 + vlr;
	const u8 = new Uint8Array(off + n * L), dv = new DataView(u8.buffer), sc = 0.001, ox = -6000, oy = -35000;
	u8.set(new TextEncoder().encode("LASF")); u8[24] = 1; u8[25] = 2;
	dv.setUint16(94, 227, true); dv.setUint32(96, off, true); dv.setUint32(100, 1, true); u8[104] = 3; dv.setUint16(105, L, true); dv.setUint32(107, n, true);
	for (const [k, v] of [[131, sc], [139, sc], [147, sc], [155, ox], [163, oy], [171, 0], [179, ox + 200], [187, ox], [195, oy + 200], [203, oy], [211, 40], [219, 3]]) dv.setFloat64(k, v, true);
	u8.set(new TextEncoder().encode("LASF_Projection"), 227 + 2); dv.setUint16(227 + 18, 34735, true); dv.setUint16(227 + 20, keys.byteLength, true); u8.set(new Uint8Array(keys.buffer), 227 + 54);
	for (let i = 0, o = off; i < n; i++, o += L) {
		const x = (i * 0.618034 % 1) * 200, y = i / n * 200, z = 3 + 37 * (0.5 + 0.5 * Math.sin(x / 30) * Math.cos(y / 25));
		dv.setInt32(o, Math.round(x / sc), true); dv.setInt32(o + 4, Math.round(y / sc), true); dv.setInt32(o + 8, Math.round(z / sc), true);
		dv.setUint16(o + 12, 1000, true); u8[o + 15] = i % 10 === 0 ? 6 : 2; dv.setUint16(o + 28, 40000, true); dv.setUint16(o + 30, 50000, true); dv.setUint16(o + 32, 20000, true);
	}
	return u8;
}
function zip1(name, data) {
	const nm = new TextEncoder().encode(name), comp = new Uint8Array(zlib.deflateRawSync(data)), lh = new Uint8Array(30 + nm.length), lv = new DataView(lh.buffer);
	lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nm.length, true); lh.set(nm, 30);
	const out = new Uint8Array(lh.length + comp.length); out.set(lh); out.set(comp, lh.length); return out;
}
const N = 250000, las = makeLas12(N);
let id = 0;
const read = async (src, read, extra = {}) => {
	const k = ++id;
	const o = await call({ type: "open", id: k, src, read }, "opened");
	const d = await call({ type: "dump", id: k, rid: 1, maxPoints: read.maxPoints, classes: read.classes, ...extra }, "dump");
	self.onmessage({ data: { type: "close", id: k } });
	return { o, d };
};
let first;
await t("① 普通の LAS＝上限までに間引く・八分木なし・total はファイルの総数", async () => {
	const { o, d } = await read(new Blob([las]), { maxPoints: 40000 });
	assert.ok(d.n <= 40000 && d.n > 20000, `n ${d.n}`); assert.equal(d.total, N);
	assert.equal(o.root.nodes.length, 0); assert.equal(o.info.inMemory, true);
	assert.ok(Math.abs(o.info.center[0] - 139.77) < 0.05 && Math.abs(o.info.center[1] - 35.68) < 0.05, JSON.stringify(o.info.center));
	assert.ok(d.bb[3] - d.bb[0] > 190 && d.bb[4] - d.bb[1] > 190, JSON.stringify(d.bb));   // 間引いても全体に散る
	assert.ok(d.rgb && d.rgb[0] === 40000 >> 8);
	first = d;
	const all = await read(new Blob([las]), { maxPoints: 0 });
	assert.equal(all.d.n, N);
});
await t("② ZIP の中の LAS＝流して読む＝①と同じ点", async () => {
	const { d } = await read(new Blob([zip1("08MC4919.las", las)]), { maxPoints: 40000 });
	assert.equal(d.n, first.n); assert.equal(d.total, N);
	assert.deepEqual(Array.from(d.pts.subarray(0, 300)), Array.from(first.pts.subarray(0, 300)));
	assert.deepEqual(Array.from(d.cls.subarray(0, 300)), Array.from(first.cls.subarray(0, 300)));
});
await t("③ 分類で落とす＝建物だけ・枠をその分類に使う", async () => {
	const { d } = await read(new Blob([zip1("a.las", las)]), { maxPoints: 40000, classes: [6] });
	assert.ok(d.cls.every(c => c === 6)); assert.ok(d.n > 20000 && d.n <= 25000, `n ${d.n}`);   // 建物 25,000 点のうち上限 40,000 まで＝全部
	await assert.rejects(read(new Blob([las]), { maxPoints: 1000, classes: [9] }), /no points of the chosen classes/);
});
console.log(`t-copc-read: ${tn} 件 OK`);
