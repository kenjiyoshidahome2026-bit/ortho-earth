// ?bench（boot/bench.ts）の純関数の検定＝URL の組み立て・順番・表。node packages/globe/tests/t-bench.mjs
import assert from "node:assert/strict";
import { BENCH_VARIANTS, BENCH_COMMON, benchBase, benchUrl, benchStep, benchTable, benchX } from "../src/boot/bench.ts";

const href = "https://example.test/japan/?hud=1&bench=2&lineelev=1#17.8/35.8/139.7/74t";
const base = benchBase(href);
assert.equal(base, "https://example.test/japan/?hud=1&lineelev=1#17.8/35.8/139.7/74t");   // bench だけ外す・視点（#）と元のノブは残す
assert.equal(benchUrl(base, 0, 2), "https://example.test/japan/?hud=1&lineelev=1&res=0.7&bench=2#17.8/35.8/139.7/74t");   // 全変種＝解像度を固定
assert.equal(BENCH_COMMON, "res=0.7");
const iRes = BENCH_VARIANTS.findIndex(v => v[1] === "res=0.4");
assert.equal(new URL(benchUrl(base, iRes, 2)).searchParams.get("res"), "0.4");   // 変種の解像度が共通に勝つ
assert.equal(new URL(benchUrl("https://example.test/?res=0.85", 0, 2)).searchParams.get("res"), "0.85");   // 利用者のノブが最優先
assert.equal(benchX(32), 6); assert.equal(benchX(3), 1); assert.equal(benchX(1000), 48);
const iNoTerr = BENCH_VARIANTS.findIndex(v => v[1] === "noterr=1");
assert.ok(new URL(benchUrl(base, iNoTerr, 3)).searchParams.get("noterr") === "1" && new URL(benchUrl(base, iNoTerr, 3)).searchParams.get("bench") === "3");
const iLine = BENCH_VARIANTS.findIndex(v => v[1].startsWith("lineelev=0"));
const uLine = new URL(benchUrl(base, iLine, 2));
assert.equal(uLine.searchParams.get("lineelev"), "1");   // 元の URL のノブを優先
assert.equal(uLine.searchParams.get("elevcheap"), "0");
// 変種のノブの名は重ならない書式（k=v を & つなぎ）
for (const [name, knobs] of BENCH_VARIANTS) { assert.ok(name); for (const kv of knobs.split("&")) if (kv) assert.match(kv, /^[a-z]+=[\w.]+$/); }
assert.equal(BENCH_VARIANTS[0][1], "");   // 先頭＝既定（倍率の分母）
// 順番＝巡ごとに全変種
const n = BENCH_VARIANTS.length;
assert.deepEqual(benchStep(0), { v: 0, round: 0 });
assert.deepEqual(benchStep(n - 1), { v: n - 1, round: 0 });
assert.deepEqual(benchStep(n + 1), { v: 1, round: 1 });
// 表：1 回あたりの ms（1000／fps／x）・中央値・既定との差・failed
const run = (v, round, fps, extra = {}) => ({ v, round, fps, frames: fps * 6, secs: 6, cpu: 4, res: 0.7, shed: 0, idleS: 5, ...extra });
const t = benchTable({ base, rounds: 2, i: 0, tries: 0, t0: Date.now(), head: "H", x: 5, runs: [run(0, 0, 10), run(0, 1, 5), run(1, 0, 20), run(1, 1, 20), run(2, 0, 0, { failed: true }), run(2, 1, 0, { failed: true })] });
const row = k => t.split("\n").find(l => l.startsWith(BENCH_VARIANTS[k][0]));
assert.match(row(0), /20\.0 \/ 40\.0 \| 30\.0 \| \+0\.0 ms \(×1\.00\)/);
assert.match(row(1), /10\.0 \/ 10\.0 \| 10\.0 \| −20\.0 ms \(×0\.33\)/);
assert.match(row(2), /failed \/ failed \| - \| -/);
assert.ok(!row(3));   // 測っていない変種は出さない
assert.ok(t.includes("draws the scene 5 time(s)"));
// 素の頁（1 コマ 1 回描き）の列＝コマ数・GPU の実時間（本体／海岸線・国境の層）の中央値。無い時は -
const t1 = benchTable({ base, rounds: 2, i: 0, tries: 0, t0: Date.now(), head: "H", x: 5, runs: [run(0, 0, 10, { fps1: 30, gm1: 12, gg1: 3 }), run(0, 1, 10, { fps1: 32, gm1: 14, gg1: 0 }), run(1, 0, 10)] });
assert.match(t1.split("\n").find(l => l.startsWith(BENCH_VARIANTS[0][0])), /\| 31\.0 · 13\.0 · 3\.0 \|/);
assert.match(t1.split("\n").find(l => l.startsWith(BENCH_VARIANTS[1][0])), /\| - · - · - \|/);
console.log("t-bench OK");
