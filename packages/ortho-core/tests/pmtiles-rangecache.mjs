// Range の端末キャッシュ（src/pmtiles-src.ts cachingSource・?tilecache=1・2026-11-16）。node packages/ortho-core/tests/pmtiles-rangecache.mjs
// 2 回目は回線へ行かない・アーカイブが差し替わったら（先頭の中身か ETag が違う）使わない・ETag の無い置き場でも働く・先頭は毎回回線（回線なしの時だけ残した先頭）。
import assert from "node:assert/strict";
import { cachingSource } from "../src/pmtiles-src.ts";

const fakeStore = () => { const m = new Map(); return { m, match: async k => m.get(k)?.clone(), put: async (k, r) => { m.set(k, r); }, keys: async () => [...m.keys()], delete: async k => m.delete(k) }; };
const settle = () => new Promise(r => setTimeout(r, 0));
let calls = 0, etag = '"a"', online = true, gen = 1;
const inner = { getKey: () => "u", getBytes: async (o, l) => { calls++; if (!online) throw new TypeError("Failed to fetch"); return { data: new Uint8Array(l).fill((o + gen) & 255).buffer, etag }; } };

for (const withEtag of [true, false]) {
	etag = withEtag ? '"a"' : undefined; calls = 0; gen = 1; online = true;
	const st = fakeStore(), mk = () => cachingSource("https://x.test/a.pmtiles", inner, async () => st), s = mk();
	await s.getBytes(0, 16); await settle();
	const a = await s.getBytes(1000, 8, undefined, etag); await settle();
	assert.equal(calls, 2);
	const b = await s.getBytes(1000, 8, undefined, etag);
	assert.equal(calls, 2, "2 回目は回線へ行かない");
	assert.deepEqual(new Uint8Array(b.data), new Uint8Array(a.data));
	await s.getBytes(1000, 9, undefined, etag); await settle();
	assert.equal(calls, 3, "範囲が違えば別物");
	// 別の起動（新しい Source）＝先頭を読んだ後は残した範囲が使える
	const s2 = mk();
	await s2.getBytes(0, 16); await settle(); await s2.getBytes(1000, 8, undefined, etag);
	assert.equal(calls, 4, "次の起動でも残っている（先頭だけ回線）");
	// アーカイブが差し替わった＝先頭の中身が替わる
	gen = 2; if (withEtag) etag = '"b"';
	const s3 = mk();
	await s3.getBytes(0, 16); await settle();
	const c = await s3.getBytes(1000, 8, undefined, etag); await settle();
	assert.equal(calls, 6, "差し替わったら残した分は使わない");
	assert.notDeepEqual(new Uint8Array(c.data), new Uint8Array(a.data));
	await s3.getBytes(1000, 8, undefined, etag);
	assert.equal(calls, 6, "取り直した分が残る");
	// 回線なし＝残した先頭で開き、残した範囲は読める
	online = false;
	const s4 = mk();
	assert.equal((await s4.getBytes(0, 16)).data.byteLength, 16, "回線なし＝残した先頭で開く");
	assert.deepEqual(new Uint8Array((await s4.getBytes(1000, 8, undefined, etag)).data), new Uint8Array(c.data));
	await assert.rejects(s4.getBytes(5000, 4, undefined, etag), "残していない範囲は回線なしで失敗");
	console.log(`  ✔ ETag ${withEtag ? "あり" : "なし"}：2 回目は回線なし・差し替えで捨てる・回線なしでも残した分は読める`);
}
{
	etag = '"a"'; calls = 0; online = true;
	const st = fakeStore(), s = cachingSource("https://x.test/c.pmtiles", inner, async () => st);
	await s.getBytes(0, 16);
	for (let i = 0; i < 1700; i++) await s.getBytes(100 + i * 10, 4, undefined, etag);
	await settle(); await settle();
	assert.ok(st.m.size <= 1601 && st.m.size >= 1500, `数は頭打ち（${st.m.size}）`);
	assert.ok(![...st.m.keys()].some(k => k.endsWith("/100-4")), "古い順に捨てる");
	console.log("  ✔ 数は頭打ち・古い順に捨てる");
}
{
	calls = 0;
	const s = cachingSource("https://x.test/d.pmtiles", inner, async () => null);
	await s.getBytes(0, 16); await s.getBytes(10, 4, undefined, etag); await s.getBytes(10, 4, undefined, etag);
	assert.equal(calls, 3, "Cache API の無い環境＝素通し");
	console.log("  ✔ Cache API が無ければ素通し");
}
