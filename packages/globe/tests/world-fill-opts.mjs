// 地形・世界の塗りを切った地図が、見えない世界のデータを取りに行かないことの検定（2026-10-19）。node packages/globe/tests/world-fill-opts.mjs
//  ① terrain:false（noTerr）の地図は起動で標高ローダを作らない＝AW3D30 の一覧（index_alos）を読まない（then で初めて作る遅延の引き口）
//  ② worldFill:false の地図は湖（ne_*_lakes）と海面下の陸（below_sea_land）を読まない（世界帯の発火口で止める）
//  globe.ts の起動は DOM と GPU が要る＝ここは発火口の形だけを見る（実際の要求の数はベンチの頁で 8→0 件を確認）
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/globe.ts", import.meta.url), "utf8");
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

ok("標高ローダは noTerr の時だけ遅延（起動で作らない）", () => {
	assert.equal((src.match(/createGetHeight\(/g) || []).length, 1, "createGetHeight の呼び出しは 1 か所（ensureHeightLoader の中）");
	assert.match(src, /const ensureHeightLoader = \(\) => heightLoader \?\?=/);
	assert.match(src, /if \(!noTerr\) ensureHeightLoader\(\);/);
	assert.match(src, /const getHeightP = \{\s*then: \(ok, ng\) => ensureHeightLoader\(\)\.then\(ok, ng\),/);
});

ok("湖・海面下の陸は worldFill:false で読まない", () => {
	assert.match(src, /loadBelowSea: \(\) => \{ if \(!flying && opts\.worldFill !== false\) loadBelowSea\(\); \}/);
	assert.match(src, /loadLakes: \(\) => \{ if \(!flying && opts\.worldFill !== false\) loadLakes\(\); \}/);
	const dts = fs.readFileSync(new URL("../globe.d.ts", import.meta.url), "utf8");
	assert.match(dts, /worldFill\?: boolean;/, "globe.d.ts に worldFill の口");
});
console.log(`world-fill-opts: ${n} 件 OK`);
