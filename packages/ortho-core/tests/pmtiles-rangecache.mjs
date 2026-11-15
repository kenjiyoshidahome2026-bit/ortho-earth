// Range の端末キャッシュ（src/pmtiles-src.ts cachingSource・2026-11-16・既定で入）。node packages/ortho-core/tests/pmtiles-rangecache.mjs
// 2 回目は回線へ行かない・次の起動は残した先頭ですぐ開いて裏で見比べる・差し替わっていたら「版が合わない」を投げて新しい先頭で開き直させる・
// ETag の無い置き場でも働く・回線なしでも残した分は読める。
import assert from "node:assert/strict";
import { cachingSource } from "../src/pmtiles-src.ts";

const fakeStore = () => { const m = new Map(); return { m, match: async k => m.get(k)?.clone(), put: async (k, r) => { m.set(k, r); }, keys: async () => [...m.keys()], delete: async k => m.delete(k) }; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
class Mismatch extends Error {}
let calls = 0, etag = '"a"', online = true, gen = 1, hold = null;
const inner = { getKey: () => "u", getBytes: async (o, l) => { calls++; if (hold && o === 0) await hold; if (!online) throw new TypeError("Failed to fetch"); return { data: new Uint8Array(l).fill((o + gen) & 255).buffer, etag }; } };

for (const withEtag of [true, false]) {
	etag = withEtag ? '"a"' : undefined; calls = 0; gen = 1; online = true;
	const st = fakeStore(), mk = () => cachingSource("https://x.test/a.pmtiles", inner, async () => st, () => new Mismatch("changed")), s = mk();
	await s.getBytes(0, 16); await settle();
	const a = await s.getBytes(1000, 8, undefined, etag); await settle();
	assert.equal(calls, 2);
	const b = await s.getBytes(1000, 8, undefined, etag);
	assert.equal(calls, 2, "2 回目は回線へ行かない");
	assert.deepEqual(new Uint8Array(b.data), new Uint8Array(a.data));
	await s.getBytes(1000, 9, undefined, etag); await settle();
	assert.equal(calls, 3, "範囲が違えば別物");

	// 次の起動＝残した先頭ですぐ開く（回線の先頭を待たない）・残した範囲もすぐ読める
	let release; hold = new Promise(r => { release = r; });
	const s2 = mk();
	await s2.getBytes(0, 16);   // hold 中でも返る＝回線を待っていない
	assert.deepEqual(new Uint8Array((await s2.getBytes(1000, 8, undefined, etag)).data), new Uint8Array(a.data), "見比べの途中でも残した範囲は読める");
	let done = false; const p = s2.getBytes(2000, 8, undefined, etag).then(r => { done = true; return r; });
	await settle(); assert.equal(done, false, "残していない範囲は見比べが済むまで回線へ行かない");
	release(); hold = null; await p; await settle();
	assert.equal(done, true);

	// アーカイブが差し替わった＝裏の見比べが気づく → 残していない範囲の取得は「版が合わない」→ 先頭の読み直しは手元の新しい先頭
	gen = 2; if (withEtag) etag = '"b"';
	const s3 = mk();
	const oldHead = await s3.getBytes(0, 16);
	assert.equal(new Uint8Array(oldHead.data)[0], 1, "まず残した（古い）先頭で開く");
	await assert.rejects(s3.getBytes(3000, 8, undefined, etag), Mismatch, "差し替わっていたら版が合わないを投げる");
	const c0 = calls;
	const newHead = await s3.getBytes(0, 16);
	assert.equal(new Uint8Array(newHead.data)[0], 2, "読み直しは新しい先頭"); assert.equal(calls, c0, "その読み直しは回線へ行かない");
	const c = await s3.getBytes(1000, 8, undefined, etag); await settle();
	assert.equal(calls, c0 + 1, "古い版で残した範囲は使わない");
	assert.notDeepEqual(new Uint8Array(c.data), new Uint8Array(a.data));
	await s3.getBytes(1000, 8, undefined, etag);
	assert.equal(calls, c0 + 1, "取り直した分が残る");

	// 回線なし＝残した先頭で開き、残した範囲は読める
	online = false;
	const s4 = mk();
	assert.equal(new Uint8Array((await s4.getBytes(0, 16)).data)[0], 2, "回線なし＝残した（新しい）先頭で開く");
	assert.deepEqual(new Uint8Array((await s4.getBytes(1000, 8, undefined, etag)).data), new Uint8Array(c.data));
	await assert.rejects(s4.getBytes(5000, 4, undefined, etag), TypeError, "残していない範囲は回線なしで失敗");
	console.log(`  ✔ ETag ${withEtag ? "あり" : "なし"}：2 回目は回線なし・残した先頭ですぐ開く・差し替えで開き直す・回線なしでも読める`);
}
{
	etag = '"a"'; calls = 0; online = true; gen = 1;
	const st = fakeStore(), s = cachingSource("https://x.test/c.pmtiles", inner, async () => st);
	await s.getBytes(0, 16);
	for (let i = 0; i < 1700; i++) await s.getBytes(100 + i * 10, 4, undefined, etag);
	await settle();
	assert.ok(st.m.size <= 1601 && st.m.size >= 1500, `数は頭打ち（${st.m.size}）`);
	console.log("  ✔ 数は頭打ち・古い順に捨てる");
}
{
	calls = 0;
	const s = cachingSource("https://x.test/d.pmtiles", inner, async () => null);
	await s.getBytes(0, 16); await s.getBytes(10, 4, undefined, etag); await s.getBytes(10, 4, undefined, etag);
	assert.equal(calls, 3, "Cache API の無い環境＝素通し");
	console.log("  ✔ Cache API が無ければ素通し");
}
