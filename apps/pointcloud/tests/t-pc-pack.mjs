// 点群の保管の詰め物（pc-pack.ts）の検定。node tests/t-pc-pack.mjs
//  ① pack → unpack が同じ物（typed array の型と中身・入れ子・配列でない値・8 B 揃え） ② 空の配列・配列なし ③ 鍵＝見せ方で分かれる・src が戻る ④ 壊れた物は投げる
import assert from "node:assert/strict";
import { pack, unpack, cacheKey, srcOfKey, PACK_VERSION } from "../pc-pack.ts";

let tn = 0;
const t = (name, fn) => { fn(); tn++; console.log("  ✔", name); };
t("① pack → unpack（dump の形）", () => {
	const d = { n: 3, anchor: [139.08, 35.11, 12.5], pts: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9.5]), elev: new Float32Array([10, 11, 12]), rgb: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), intensity: new Uint16Array([100, 65535, 0]), cls: new Uint8Array([2, 6, 2]), bb: [1, 2, 3, 7, 8, 9.5], total: 100000, info: { crs: "EPSG:6676", copc: false }, levels: [{ n: 1, ctr: new Float32Array([1, 2, 3, 4]), col: new Uint32Array([0xffeeddcc]) }] };
	const buf = pack(d);
	assert.equal(buf.byteLength % 8, 0);
	const u = unpack(buf);
	assert.equal(u.n, 3); assert.deepEqual(u.anchor, d.anchor); assert.deepEqual(u.bb, d.bb); assert.deepEqual(u.info, d.info); assert.equal(u.total, 100000);
	assert.ok(u.pts instanceof Float32Array && u.elev instanceof Float32Array && u.rgb instanceof Uint8Array && u.intensity instanceof Uint16Array && u.cls instanceof Uint8Array);
	assert.deepEqual([...u.pts], [...d.pts]); assert.deepEqual([...u.intensity], [...d.intensity]); assert.deepEqual([...u.cls], [...d.cls]);
	assert.ok(u.levels[0].ctr instanceof Float32Array && u.levels[0].col instanceof Uint32Array); assert.equal(u.levels[0].col[0], 0xffeeddcc);
	assert.equal(u.pts.buffer, buf);   // コピーしない（view）
	for (const a of [u.pts, u.elev, u.intensity, u.levels[0].ctr]) assert.equal(a.byteOffset % 8, 0, "8 B 揃え");
});
t("② 空の配列・null・配列なし", () => {
	const u = unpack(pack({ n: 0, pts: new Float32Array(0), rgb: null, s: "x" }));
	assert.equal(u.pts.length, 0); assert.equal(u.rgb, null); assert.equal(u.s, "x");
	assert.deepEqual(unpack(pack({ a: 1, b: [1, "2", { c: true }] })), { a: 1, b: [1, "2", { c: true }] });
});
t("③ 鍵", () => {
	const p = cacheKey("points", "s3:2020/LP/Ground/08/NF/23/08NF2392.zip", "auto");
	assert.equal(p, `points:v${PACK_VERSION}:s3%3A2020%2FLP%2FGround%2F08%2FNF%2F23%2F08NF2392.zip:auto`);
	const c1 = cacheKey("cloud", "atami", 4e6, { color: "rgb", detail: 1, opacity: 1 }), c2 = cacheKey("cloud", "atami", 4e6, { color: "rgb", detail: 2, opacity: 1 }), c3 = cacheKey("cloud", "atami", 4e6, { color: "rgb", detail: 1, opacity: 0.5 });
	assert.notEqual(c1, c2); assert.notEqual(c1, c3); assert.equal(c1, cacheKey("cloud", "atami", 4e6, { color: "rgb", detail: 1, opacity: 1.001 }));
	assert.equal(srcOfKey(p), "s3:2020/LP/Ground/08/NF/23/08NF2392.zip"); assert.equal(srcOfKey(c1), "atami"); assert.equal(srcOfKey("junk"), null);
});
t("④ 壊れた物", () => {
	assert.throws(() => unpack(new ArrayBuffer(4)), /not a packed/);
	assert.throws(() => unpack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer), /not a packed/);
	assert.throws(() => pack({ a: new Float64Array(2) }), /unsupported/);
});
console.log(`t-pc-pack: ${tn} 件 OK`);
