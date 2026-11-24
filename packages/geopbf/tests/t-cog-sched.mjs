#!/usr/bin/env node
// t-cog-sched: 範囲読みの共通の取り順（src/cog/sched.ts・共通化 段 4・2026-11-24）。
//   優先度の順・鍵ごとの同時数・待ちの付け替え・中断（待ち＝回線に出ない／走り＝signal が止まる）・Source の URL 読みが列を通る（同時数が呼び手を跨いで効く）
import { createScheduler } from "../src/cog/sched.ts";
import { openSource } from "../src/cog/source.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

{   // 優先度の順（同時 1）
	const s = createScheduler({ concurrency: 1 }), order = [], g = gate();
	s.run(async () => { await g.p; order.push("first"); });
	const ps = [["lo", 1], ["hi", 9], ["mid", 5], ["hi2", 9]].map(([n, p]) => s.run(async () => { order.push(n); }, { priority: p }));
	await tick(); g.open(); await Promise.all(ps);
	ok(order.join() === "first,hi,hi2,mid,lo", `優先度の高い順・同じなら頼んだ順（${order}）`);
}
{   // 鍵ごとの同時数
	const s = createScheduler({ concurrency: 2 }); let a = 0, pa = 0, b = 0, pb = 0;
	const job = (k) => async () => { if (k === "a") { a++; pa = Math.max(pa, a); } else { b++; pb = Math.max(pb, b); } await tick(10); if (k === "a") a--; else b--; };
	await Promise.all([...Array(8)].map((_, i) => s.run(job(i % 2 ? "a" : "b"), { key: i % 2 ? "a" : "b" })));
	ok(pa === 2 && pb === 2, `鍵ごとに同時 2（a=${pa} b=${pb}）`);
	s.setConcurrency(1, "a"); a = 0; pa = 0;
	await Promise.all([...Array(4)].map(() => s.run(job("a"), { key: "a" })));
	ok(pa === 1, `鍵だけ同時数を変えられる（a=${pa}）`);
}
{   // 待ちの付け替え・中断
	const s = createScheduler({ concurrency: 1 }), order = [], g = gate();
	s.run(async () => { await g.p; });
	const t1 = s.schedule(async () => { order.push("t1"); }, { priority: 1 });
	const t2 = s.schedule(async () => { order.push("t2"); }, { priority: 2 });
	const ac = new AbortController();
	const t3 = s.schedule(async () => { order.push("t3"); }, { priority: 3, signal: ac.signal });
	t1.setPriority(10); ac.abort();
	const r3 = await t3.promise.then(() => "resolved", e => e.name);
	g.open(); await Promise.all([t1.promise, t2.promise]);
	ok(order.join() === "t1,t2" && r3 === "AbortError" && t3.state === "done", `付け替え（t1 が先）・待ちの中断は走らない（${order} t3=${r3}）`);
	let sawAbort = false;
	const t4 = s.schedule(sig => new Promise((res, rej) => sig.addEventListener("abort", () => { sawAbort = true; rej(new Error("stopped")); })));
	await tick(); ok(t4.state === "running", "走り出した");
	t4.abort(); const r4 = await t4.promise.then(() => "resolved", e => e.message);
	ok(sawAbort && r4 === "stopped" && s.stats.running === 0, `走っている物は signal で止まる（${r4}）・枠が空く`);
	const pre = new AbortController(); pre.abort();
	ok(await s.run(async () => 1, { signal: pre.signal }).then(() => false, e => e.name === "AbortError"), "既に止まった signal は即 reject");
}
{   // 優先度を関数で（出す時に問う＝呼び手が画面に合わせて付け替える）
	const s = createScheduler({ concurrency: 1 }), order = [], g = gate(), pri = { a: 1, b: 2 };
	s.run(async () => { await g.p; });
	const ps = ["a", "b"].map(n => s.run(async () => { order.push(n); }, { priority: () => pri[n] }));
	pri.a = 5; g.open(); await Promise.all(ps);
	ok(order.join() === "a,b", `関数の優先度は出す時に問う（${order}）`);
}
{   // Source（URL）は列を通る＝2 つの readMany を跨いで同時数が効く・優先度の高い読みが先に回線へ
	const data = new Uint8Array(1 << 20); for (let i = 0; i < data.length; i++) data[i] = i & 255;
	let active = 0, peak = 0; const seen = [];
	const fetchFn = async (url, init) => {
		const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); const from = +a, to = +b;
		seen.push(from); active++; peak = Math.max(peak, active); await tick(8); active--;
		if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		return new Response(data.slice(from, to + 1), { status: 206, headers: { "content-range": `bytes ${from}-${to}/${data.length}` } });
	};
	const sched = createScheduler({ concurrency: 2 });
	const s = await openSource("https://example.test/a.copc.laz", { fetch: fetchFn, headerBytes: 64, gapBytes: 0, scheduler: sched });
	seen.length = 0; peak = 0;
	const far = (k) => [...Array(6)].map((_, i) => ({ from: 100000 * (k + 1) + i * 5000, len: 100 }));
	const [x, y] = await Promise.all([s.readMany(far(0), undefined, 1), s.readMany(far(5), undefined, 1)]);
	ok(peak === 2 && x.length === 6 && y.length === 6 && x[3][0] === ((100000 + 15000) & 255), `2 つの readMany を跨いで同時 2（peak=${peak}）`);
	seen.length = 0; const g = gate();
	sched.run(() => g.p, { key: "https://example.test" }); sched.run(() => g.p, { key: "https://example.test" });   // 枠を塞ぐ
	const lo = s.readMany([{ from: 700000, len: 10 }], undefined, 1), hi = s.readMany([{ from: 800000, len: 10 }], undefined, 50);
	await tick(); g.open(); await Promise.all([lo, hi]);
	ok(seen[0] === 800000 && seen[1] === 700000, `優先度の高い読みが先に回線へ（${seen}）`);
	const ac = new AbortController(); const g2 = gate();
	sched.run(() => g2.p, { key: "https://example.test" }); sched.run(() => g2.p, { key: "https://example.test" });
	seen.length = 0;
	const gone = s.readMany([{ from: 900000, len: 10 }], ac.signal, 5); ac.abort();
	const r = await gone.then(() => "resolved", e => e.name); g2.open(); await tick(20);
	ok(r === "AbortError" && !seen.includes(900000), `待ちの読みの中断は回線に出ない（${r}）`);
	const s2 = await openSource("https://example.test/b.tif", { fetch: fetchFn, headerBytes: 64, scheduler: false });
	ok((await s2.readMany([{ from: 10, len: 5 }]))[0][0] === 10, "scheduler:false＝従来どおり直に読む");
}
if (fails) { console.error(`t-cog-sched: ${fails} 件 NG`); process.exit(1); }
console.log("t-cog-sched: all ok");
