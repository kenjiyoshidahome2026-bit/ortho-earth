// PMTiles の範囲読みが共通の取り順（geopbf/cog/sched・COG×点群の共通化 段 4）を通る（src/pmtiles-src.ts scheduledSource・2026-11-25）。node packages/ortho-core/tests/pmtiles-sched.mjs
// 同時数の上限・先頭（offset 0）が一番先・新しい読みほど先・待ちの中断は回線に出ない・走りの中断は内側へ伝わる。
import assert from "node:assert/strict";
import { createScheduler } from "geopbf/cog/sched";
import { scheduledSource } from "../src/pmtiles-src.ts";

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
let active = 0, peak = 0; const seen = []; let gate = null;
const inner = { getKey: () => "k", getBytes: async (o, l, signal) => {
	seen.push(o); active++; peak = Math.max(peak, active);
	try { if (gate) await Promise.race([gate, new Promise((_, rej) => signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))]); else await tick(); }
	finally { active--; }
	return { data: new ArrayBuffer(l) };
} };
{
	const s = scheduledSource(inner, "https://tiles.test/a.pmtiles", createScheduler({ concurrency: 2 }));
	assert.equal(s.getKey(), "k");
	await Promise.all([...Array(8)].map((_, i) => s.getBytes(100 + i, 4)));
	assert.equal(peak, 2, "オリジンごとの同時数");
}
{
	const sched = createScheduler({ concurrency: 1 }), s = scheduledSource(inner, "https://tiles.test/a.pmtiles", sched);
	let open; gate = new Promise(r => { open = r; });
	const first = s.getBytes(50, 4);   // 枠を塞ぐ
	await tick(); seen.length = 0;
	const old = s.getBytes(1000, 4), mid = s.getBytes(2000, 4), head = s.getBytes(0, 16);
	const ac = new AbortController(), gone = s.getBytes(3000, 4, ac.signal);
	ac.abort();
	assert.equal(await gone.then(() => "ok", e => e.name), "AbortError", "待ちの中断");
	open(); gate = null; await Promise.all([first, old, mid, head]);
	assert.deepEqual(seen, [0, 2000, 1000], "先頭が一番先・次は新しい読みから・中断した読みは回線に出ない");
	let open2; gate = new Promise(r => { open2 = r; });
	const ac2 = new AbortController(), run = s.getBytes(4000, 4, ac2.signal);
	await tick(); ac2.abort();
	assert.equal(await run.then(() => "ok", e => e.name), "AbortError", "走りの中断は内側の signal へ");
	open2(); gate = null;
}
{	// PMTiles の枠は COG・COPC の枠（オリジン）と別＝鍵を渡して同時数を上げられる（既定の枠はそのまま）
	const sched = createScheduler({ concurrency: 2 }); sched.setConcurrency(5, "https://tiles.test|pmtiles");
	const s = scheduledSource(inner, "https://tiles.test/a.pmtiles", sched, "https://tiles.test|pmtiles"), plain = scheduledSource(inner, "https://tiles.test/b.pmtiles", sched);
	peak = 0; await Promise.all([...Array(12)].map((_, i) => s.getBytes(100 + i, 4)));
	assert.equal(peak, 5, "PMTiles の枠の同時数");
	peak = 0; await Promise.all([...Array(8)].map((_, i) => plain.getBytes(100 + i, 4)));
	assert.equal(peak, 2, "鍵を渡さなければオリジンの枠のまま");
}
console.log("PASS pmtiles-sched");
