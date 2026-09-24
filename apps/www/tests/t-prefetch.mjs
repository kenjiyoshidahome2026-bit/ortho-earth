// prefetch.js の一覧（planPrefetch）の検定＋消費者との鍵の照合（先読みが使われない事故＝鍵/解像度/gint のずれを落とす）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planPrefetch, shouldPrefetch } from "../prefetch.js";
import { WORLD_ATLAS } from "altpbf/loader";

const ids = jobs => jobs.map(j => j.id);
const src = p => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("1 段目：全端末で admin0 50m・全球アトラス・ne-cultural-base を先頭に読む", () => {
	for (const low of [false, true]) {
		const { tier1 } = planPrefetch({ low, free: 1e12 });
		assert.deepEqual(ids(tier1).slice(0, 3), ["admin0-50m", "world-atlas", "cultural-base"]);
		assert.ok(ids(tier1).includes("below-sea") && ids(tier1).includes("stars"));
	}
});
test("省メモリ：湖は 50m（gint なし）・河川/海洋境界と 2 段目は読まない＝エンジンの LOW_MEM と同じ", () => {
	const p = planPrefetch({ low: true, effectiveType: "4g", free: 1e12 });
	assert.ok(ids(p.tier1).includes("lakes-50m") && !ids(p.tier1).includes("rivers") && !ids(p.tier1).includes("maritime"));
	assert.equal(p.tier1.find(j => j.id === "lakes-50m").gint, false);
	assert.deepEqual(p.tier2, []); assert.equal(p.tier2Skipped, "lowMem");
});
test("通常：湖は 10m を gint ありで（japan の gint:false と equal の gint ありの両方が IDB から立つ）", () => {
	const j = planPrefetch({ free: 1e12 }).tier1.find(j => j.id === "lakes-10m");
	assert.equal(j.gint, true); assert.deepEqual(j.opts, {});
});
test("2 段目：速い回線かつ空き 512MB 以上だけ・不明な回線は速い扱い・空き不明は見送り", () => {
	assert.deepEqual(ids(planPrefetch({ effectiveType: "4g", free: 1e12 }).tier2), ["cultural-detail", "admin0-10m"]);
	assert.deepEqual(ids(planPrefetch({ effectiveType: null, free: 1e12 }).tier2), ["cultural-detail", "admin0-10m"]);
	assert.equal(planPrefetch({ effectiveType: "3g", free: 1e12 }).tier2Skipped, "slow");
	assert.equal(planPrefetch({ effectiveType: "4g", free: 100 << 20 }).tier2Skipped, "storage");
	assert.equal(planPrefetch({ effectiveType: "4g", free: null }).tier2Skipped, "storage");
});
test("見送り：Save-Data・2g/3g", () => {
	assert.equal(shouldPrefetch({ connection: { saveData: true } }), false);
	assert.equal(shouldPrefetch({ connection: { effectiveType: "slow-2g" } }), false);
	assert.equal(shouldPrefetch({ connection: { effectiveType: "3g" } }), false);
	assert.equal(shouldPrefetch({ connection: { effectiveType: "4g" } }), true);
	assert.equal(shouldPrefetch({}), true);
});

// ── 消費者との照合（ソースの文字列で）＝鍵の名前・gint の有無が読む側と一致しているか ──
test("全球アトラスの鍵＝altpbf の WORLD_ATLAS", () => {
	assert.equal(planPrefetch().tier1.find(j => j.id === "world-atlas").key, WORLD_ATLAS);
});
test("国境：globe は起動 50m・寄って 10m を読む", () => {
	const s = src("packages/globe/src/gint/layers.js");
	assert.match(s, /ne_\$\{res\}_admin_0_countries/);
	assert.match(s, /loadAdmin0\("50m"\)/); assert.match(s, /loadAdmin0\("10m"\)/);
});
test("湖・海面下の陸：globe は gint:false・湖は LOW_MEM で 50m", () => {
	const s = src("packages/globe/src/globe.js");
	assert.match(s, /LOW_MEM \? "50m" : "10m"/); assert.match(s, /ne_\$\{RES\}_lakes/);
	assert.match(s, /geopbf\(NAME, \{ gint: false \}\)/); assert.match(s, /geopbf\("below_sea_land", \{ gint: false \}\)/);
	assert.match(src("apps/equal/src/layers.js"), /"ne_10m_lakes"/);
});
test("恒星：sky/theater は stars.6 を gint:false", () => {
	assert.match(src("packages/globe/src/sky/theater.js"), /geopbf\("stars\.6", \{ gint: false \}\)/);
});
test("ミニ地球儀：gadgets/globe.js は ne_110m_land を gint:false", () => {
	assert.match(src("packages/globe/src/gadgets/globe.js"), /geopbf\("ne_110m_land", \{ gint: false \}\)/);
	assert.ok(ids(planPrefetch({ low: true }).tier1).includes("minimap-land"));
});
test("河川・海洋境界：globe（gint あり・LOW_MEM は読まない）と equal", () => {
	const s = src("packages/globe/src/gint/layers.js");
	for (const n of ["ne_10m_rivers_lake_centerlines", "ne_10m_admin_0_boundary_lines_maritime_indicator"]) {
		assert.ok(s.includes(`"${n}"`), n); assert.ok(src("apps/equal/src/layers.js").includes(`"${n}"`), n);
	}
	assert.match(s, /geopbf\(def\.name\)/); assert.match(s, /worldLinesState \|\| LOW_MEM/);
});
test("ne-cultural：equal と world が同じ URL・同じ name で読む", () => {
	const { tier1, tier2 } = planPrefetch({ free: 1e12 });
	const base = tier1.find(j => j.id === "cultural-base"), detail = tier2.find(j => j.id === "cultural-detail");
	assert.equal(base.key, "https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-base.geopbf");
	assert.equal(detail.opts.name, "ne-cultural-detail.geopbf");
	assert.ok(src("apps/equal/src/equal.js").includes("https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-${g}.geopbf"));
	assert.match(src("apps/equal/src/equal.js"), /\{ name: `ne-cultural-\$\{g\}\.geopbf` \}/);
	assert.ok(src("apps/world/src/worldlayers.js").includes('"https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-"'));
	assert.match(src("apps/world/src/worldlayers.js"), /\{ name: `ne-cultural-\$\{g\}\.geopbf` \}/);
});
