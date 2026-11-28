// Range の端末キャッシュ（src/pmtiles-src.ts cachingSource・2026-11-16・既定で入）。node packages/ortho-core/tests/pmtiles-rangecache.mjs
// 2 回目は回線へ行かない・次の起動は残した先頭ですぐ開いて裏で見比べる・差し替わっていたら「版が合わない」を投げて新しい先頭で開き直させる・
// ETag の無い置き場でも働く・回線なしでも残した分は読める。
import assert from "node:assert/strict";
import { cachingSource } from "../src/pmtiles-src.ts";

const fakeStore = () => { const m = new Map(); return { m, match: async k => m.get(k)?.clone(), put: async (k, r) => { m.set(k, r); }, keys: async () => [...m.keys()], delete: async k => m.delete(k) }; };
const CHECKED = "https://range-cache.invalid/" + encodeURIComponent("https://x.test/a.pmtiles") + "/checked";   // 先頭を見比べた印（10 秒は他の realm もそれを信じる）＝「次の起動」を試す時は消す
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
	assert.ok(st.m.has(CHECKED), "先頭を読んだ印が残る"); st.m.delete(CHECKED);
	const s2 = mk();
	await s2.getBytes(0, 16);   // hold 中でも返る＝回線を待っていない
	assert.deepEqual(new Uint8Array((await s2.getBytes(1000, 8, undefined, etag)).data), new Uint8Array(a.data), "見比べの途中でも残した範囲は読める");
	let done = false; const p = s2.getBytes(2000, 8, undefined, etag).then(r => { done = true; return r; });
	await settle(); assert.equal(done, false, "残していない範囲は見比べが済むまで回線へ行かない");
	release(); hold = null; await p; await settle();
	assert.equal(done, true);

	// アーカイブが差し替わった＝裏の見比べが気づく → 残していない範囲の取得は「版が合わない」→ 先頭の読み直しは手元の新しい先頭
	gen = 2; if (withEtag) etag = '"b"'; st.m.delete(CHECKED);
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
	online = false; st.m.delete(CHECKED);
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
{	// 同時に開いた realm たち（同じ置き場・別々の Source）＝同じ範囲で回線へ出るのは 1 人だけ（Web Locks の代わりに名前ごとの列）
	etag = '"a"'; calls = 0; online = true; gen = 1;
	const chains = new Map(), lock = (name, fn) => { const p = (chains.get(name) || Promise.resolve()).then(fn); chains.set(name, p.catch(() => {})); return p; };
	const st = fakeStore(), mk = () => cachingSource("https://x.test/a.pmtiles", inner, async () => st, () => new Mismatch("changed"), lock);
	const realms = [mk(), mk(), mk(), mk(), mk()];
	const heads = await Promise.all(realms.map(r => r.getBytes(0, 16)));
	assert.equal(calls, 1, "先頭は 1 回だけ回線へ");
	assert.ok(heads.every(h => new Uint8Array(h.data)[0] === 1));
	const leaves = await Promise.all(realms.map(r => r.getBytes(7000, 8, undefined, etag)));
	assert.equal(calls, 2, "同じ葉の索引も 1 回だけ");
	assert.ok(leaves.every(l => new Uint8Array(l.data)[0] === new Uint8Array(leaves[0].data)[0]));
	await Promise.all(realms.map((r, i) => r.getBytes(8000 + i * 100, 8, undefined, etag)));
	assert.equal(calls, 7, "別々の範囲は今までどおり別々に出る");
	// 次の起動（印が新しい間）＝見比べは 1 人だけ。残りはその結果を使う
	await settle(); st.m.delete(CHECKED); calls = 0;
	const again = [mk(), mk(), mk()];
	await Promise.all(again.map(r => r.getBytes(0, 16)));
	await Promise.all(again.map((r, i) => r.getBytes(9000 + i * 100, 8, undefined, etag)));
	assert.equal(calls, 1 + 3, "見比べの先頭は 1 回＋別々の範囲 3 本");
	// 差し替わっていた時＝1 人が気づけば、残りも回線へ行かずに新しい先頭へ切り替わる
	gen = 2; etag = '"b"'; st.m.delete(CHECKED); calls = 0;
	const later = [mk(), mk()];
	await Promise.all(later.map(r => r.getBytes(0, 16)));
	for (const r of later) await assert.rejects(r.getBytes(9900, 8, undefined, etag), Mismatch);
	assert.equal(calls, 1, "差し替えの見比べも 1 回");
	for (const r of later) assert.equal(new Uint8Array((await r.getBytes(0, 16)).data)[0], 2, "どの realm も新しい先頭で開き直す");
	assert.equal(calls, 1);
	// 回線へ出た realm が失敗しても、待っていた realm は自分で取りに行く
	online = false; const two = [mk(), mk()];
	const res = await Promise.allSettled(two.map(r => r.getBytes(12000, 8, undefined, etag)));
	assert.ok(res.every(r => r.status === "rejected"));
	online = true;
	console.log("  ✔ 同時に開いた realm：同じ範囲は 1 回だけ回線へ・見比べも 1 回・差し替えは全員が気づく");
}
{	// Range を無視する置き場（全量が 200 で返る）＝先頭の読みが「Byte Serving」で失敗 → 全量を 1 回取って以後はメモリから（探りの 0-0 は送らない）
	const { probingSource } = await import("../src/pmtiles-src.ts");
	const whole = new Uint8Array(5000).map((_, i) => i & 255); let slurps = 0, inners = 0;
	const noRange = { getKey: () => "k", getBytes: async () => { inners++; throw new Error("Server returned no content-length header or content-length exceeding request. Check that your storage backend supports HTTP Byte Serving."); } };
	const s = probingSource("https://x.test/w.pmtiles", noRange, async () => { slurps++; return whole.buffer; });
	const [h, t] = await Promise.all([s.getBytes(0, 16), s.getBytes(0, 16)]);
	assert.equal(new Uint8Array(h.data).length, 16); assert.equal(new Uint8Array(t.data)[5], 5);
	assert.equal(new Uint8Array((await s.getBytes(300, 4)).data)[0], 300 & 255);
	assert.equal(slurps, 1, "全量は 1 回だけ"); assert.ok(inners <= 2, "以後は内側へ行かない");
	// Range で読める置き場＝そのまま通す・ほかの失敗はそのまま投げる
	let n = 0; const ranged = { getKey: () => "k", getBytes: async (o, l) => { n++; if (o === 99) throw new TypeError("Failed to fetch"); return { data: new ArrayBuffer(l) }; } };
	const s2 = probingSource("https://x.test/r.pmtiles", ranged, async () => { throw new Error("no slurp"); });
	await s2.getBytes(0, 16); await s2.getBytes(500, 8); assert.equal(n, 2);
	await assert.rejects(s2.getBytes(99, 1), TypeError);
	console.log("  ✔ 探りなし：Range を無視する置き場だけ全量を丸呑み");
}
{
	calls = 0;
	const s = cachingSource("https://x.test/d.pmtiles", inner, async () => null);
	await s.getBytes(0, 16); await s.getBytes(10, 4, undefined, etag); await s.getBytes(10, 4, undefined, etag);
	assert.equal(calls, 3, "Cache API の無い環境＝素通し");
	console.log("  ✔ Cache API が無ければ素通し");
}
