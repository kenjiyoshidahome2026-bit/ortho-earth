// 進捗の保存の検定（偽の localStorage）
import assert from "node:assert/strict";
import { createProgress, STORE_KEY } from "../src/progress.js";
const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
const P = createProgress(storage);
assert.equal(P.answer("JP", true), 1); assert.equal(P.answer("FR", true), 2); assert.equal(P.answer("DE", false), 0);
assert.equal(P.state.bestStreak, 2); assert.equal(P.state.totalAnswered, 3); assert.equal(P.state.totalCorrect, 2);
assert.ok(P.isDue("DE")); assert.ok(!P.isDue("JP"), "正解した国は 1 日先まで出ない");
assert.deepEqual(P.state.recent, ["DE", "FR", "JP"]);
let r = P.finish({ mode: "capital", level: 1, region: "0", correct: 7, total: 10, ms: 60000 });
assert.deepEqual(r.got, ["first-set"]); assert.ok(r.isBest);
r = P.finish({ mode: "capital", level: 1, region: "0", correct: 7, total: 10, ms: 50000 });
assert.ok(r.isBest, "同点なら速い方が記録"); assert.equal(P.bestFor("capital", 1, "0").ms, 50000);
r = P.finish({ mode: "capital", level: 1, region: "0", correct: 6, total: 10, ms: 1000 });
assert.ok(!r.isBest);
r = P.finish({ mode: "flag", level: 1, region: "0", correct: 10, total: 10, ms: 1000 });
assert.ok(r.got.includes("perfect"));
r = P.finish({ mode: "map", level: 1, region: "3", correct: 10, total: 10, ms: 1000, poolKeys: ["JP", "FR"] });
assert.ok(r.got.includes("all-modes")); assert.ok(r.got.includes("region-master")); assert.deepEqual(P.state.regionsMastered, ["3/1"]);
r = P.finish({ mode: "map", level: 1, region: "3", correct: 10, total: 10, ms: 1000, poolKeys: ["JP", "DE"] });
assert.ok(!r.got.includes("region-master"), "間違えたままの国があれば地域マスターにならない");
// 読み直し＝同じ中身。壊れた JSON＝空から
const P2 = createProgress(storage); assert.equal(P2.state.sets, 6); assert.equal(P2.seenCount(), 3);
mem.set(STORE_KEY, "{broken"); assert.equal(createProgress(storage).state.sets, 0);
assert.equal(createProgress(null).state.sets, 0, "storage が無くても動く");
console.log("t-progress: ok");
