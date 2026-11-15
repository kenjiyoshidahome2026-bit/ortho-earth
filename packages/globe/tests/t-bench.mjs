// ?bench（boot/bench.ts）の純関数の検定＝URL の組み立て・順番・表。node packages/globe/tests/t-bench.mjs
import assert from "node:assert/strict";
import { BENCH_VARIANTS, benchBase, benchUrl, benchStep, benchTable } from "../src/boot/bench.ts";

const href = "https://example.test/japan/?hud=1&bench=2&lineelev=1#17.8/35.8/139.7/74t";
const base = benchBase(href);
assert.equal(base, "https://example.test/japan/?hud=1&lineelev=1#17.8/35.8/139.7/74t");   // bench だけ外す・視点（#）と元のノブは残す
assert.equal(benchUrl(base, 0, 2), "https://example.test/japan/?hud=1&lineelev=1&bench=2#17.8/35.8/139.7/74t");
const iNoTerr = BENCH_VARIANTS.findIndex(v => v[1] === "noterr=1");
assert.ok(new URL(benchUrl(base, iNoTerr, 3)).searchParams.get("noterr") === "1" && new URL(benchUrl(base, iNoTerr, 3)).searchParams.get("bench") === "3");
const iLine = BENCH_VARIANTS.findIndex(v => v[1].startsWith("lineelev=2"));
const uLine = new URL(benchUrl(base, iLine, 2));
assert.equal(uLine.searchParams.get("lineelev"), "1");   // 元の URL のノブを優先
assert.equal(uLine.searchParams.get("elevcheap"), "1");
// 変種のノブの名は重ならない書式（k=v を & つなぎ）
for (const [name, knobs] of BENCH_VARIANTS) { assert.ok(name); for (const kv of knobs.split("&")) if (kv) assert.match(kv, /^[a-z]+=[\w.]+$/); }
assert.equal(BENCH_VARIANTS[0][1], "");   // 先頭＝既定（倍率の分母）
// 順番＝巡ごとに全変種
const n = BENCH_VARIANTS.length;
assert.deepEqual(benchStep(0), { v: 0, round: 0 });
assert.deepEqual(benchStep(n - 1), { v: n - 1, round: 0 });
assert.deepEqual(benchStep(n + 1), { v: 1, round: 1 });
// 表：中央値・倍率・failed
const run = (v, round, fps, extra = {}) => ({ v, round, fps, frames: fps * 8, secs: 8, gpuMap: 10, res: 1, shed: 0, idleS: 5, ...extra });
const t = benchTable({ base, rounds: 2, i: 0, tries: 0, t0: Date.now(), head: "H", runs: [run(0, 0, 10), run(0, 1, 20), run(1, 0, 30), run(1, 1, 30), run(2, 0, 0, { failed: true }), run(2, 1, 0, { failed: true })] });
const row = k => t.split("\n").find(l => l.startsWith(BENCH_VARIANTS[k][0]));
assert.match(row(0), /10\.0 \/ 20\.0 \| 15\.0 \| ×1\.00/);
assert.match(row(1), /30\.0 \/ 30\.0 \| 30\.0 \| ×2\.00/);
assert.match(row(2), /failed \/ failed \| - \| -/);
assert.ok(!row(3));   // 測っていない変種は出さない
console.log("t-bench OK");
