// GPU メモリの共有の台帳（src/gadgets/membudget.ts・2026-11-25）。node packages/globe/tests/t-membudget.mjs
import assert from "node:assert/strict";
import { createMemLedger, defaultGpuBudget } from "../src/gadgets/membudget.ts";

const MB = 1024 * 1024;
assert.equal(defaultGpuBudget({ lowMem: true }), 600 * MB);
assert.equal(defaultGpuBudget({ deviceMemory: 4, cores: 8 }), 1024 * MB);
assert.equal(defaultGpuBudget({ deviceMemory: 8, cores: 8 }), 2048 * MB, "M1 級");
assert.equal(defaultGpuBudget({ deviceMemory: 8, cores: 10 }), 3072 * MB);
assert.equal(defaultGpuBudget({ deviceMemory: 8, cores: 14 }), 4096 * MB);

let t = 0;
const L = createMemLedger(2000 * MB, { now: () => t });
const use = { map: 300 * MB, tiles3d: 0, copc: 0 }; let pokes = 0;
L.register("map", { bytes: () => use.map });
const off3 = L.register("tiles3d", { bytes: () => use.tiles3d, poke: () => { pokes++; } });
L.register("copc", { bytes: () => use.copc, poke: () => { pokes++; } });
assert.equal(L.limit("tiles3d"), 1700 * MB, "総予算 − 他が持つ量");
assert.equal(L.limit("tiles3d", 1024 * MB), 1024 * MB, "自分の望みが小さければそれ");
use.tiles3d = 1500 * MB;
assert.equal(L.limit("copc"), 250 * MB, "床（総予算の 1/8）は必ず渡す");
use.tiles3d = 600 * MB; use.copc = 100 * MB;
assert.equal(L.limit("tiles3d"), 1600 * MB);
L.touch(); assert.equal(pokes, 0, "総予算の内＝押さない");
use.map = 1500 * MB; L.touch(); assert.equal(pokes, 2, "越えたら捨てられる描き手を押す");
L.touch(); assert.equal(pokes, 2, "1 s に 1 回まで");
t = 1500; L.touch(); assert.equal(pokes, 4);
assert.deepEqual(L.snapshot(), { total: 2000 * MB, used: 2200 * MB, by: { map: 1500 * MB, tiles3d: 600 * MB, copc: 100 * MB } });
off3(); assert.equal(L.snapshot().by.tiles3d, undefined, "外せる");
L.register("bad", { bytes: () => { throw new Error("x"); } });
assert.equal(L.limit("copc"), 500 * MB, "数えられない描き手は 0 として続ける");
console.log("PASS t-membudget");
