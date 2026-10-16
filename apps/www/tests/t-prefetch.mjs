// prefetch.js の一覧（planPrefetch）の検定＋消費者との鍵の照合（先読みが使われない事故＝鍵/解像度/gint のずれを落とす）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planPrefetch, shouldPrefetch } from "../prefetch.js";
import { WORLD_ATLAS } from "@ortho-earth/core/elevation";

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
test("国境：globe は起動 50m・寄って 10m を読む（世界帯の中身＝worldContent は z4＝州境の帯から 10m・LOW_MEM は 50m のまま）", () => {
	const s = src("packages/globe/src/gint/layers.ts");
	assert.match(s, /ne_\$\{res\}_admin_0_countries/);
	assert.match(s, /loadAdmin0\("50m"\)/); assert.match(s, /loadAdmin0\("10m"\)/);
	assert.match(s, /WORLD_CONTENT \? WORLD_Z\.admin1 : ADMIN0_FINE_Z/);
});
test("湖・海面下の陸：globe は gint:false・湖は LOW_MEM で 50m", () => {
	const s = src("packages/globe/src/globe.js");
	assert.match(s, /LOW_MEM \? "50m" : "10m"/); assert.match(s, /ne_\$\{RES\}_lakes/);
	assert.match(s, /geopbf\(NAME, \{ gint: false \}\)/); assert.match(s, /geopbf\("below_sea_land", \{ gint: false \}\)/);
	assert.match(src("packages/equal/src/layers.ts"), /"ne_10m_lakes"/);
});
test("恒星：sky/theater は GitHub Pages の sky/stars.6.geopbf を読む＝先読みも同じ URL（HTTP キャッシュを温める）", () => {
	assert.match(src("packages/globe/src/sky/theater.js"), /skyPbf\(geopbf, "stars\.6"\)/);
	const data = src("packages/globe/src/sky/data.js"), core = src("packages/ortho-core/src/worldcontent.ts");
	assert.match(data, /SKY_DATA = WORLD_DATA \+ "sky\/"/); assert.match(data, /`\$\{SKY_DATA\}\$\{name\}\.geopbf`/);
	const base = /WORLD_DATA = "([^"]+)"/.exec(core)[1];
	const job = planPrefetch({ low: false }).tier1.find(j => j.id === "stars");
	assert.equal(job.kind, "fetch"); assert.equal(job.url, base + "sky/stars.6.geopbf");
});
test("ミニ地球儀：gadgets/globe.js は ne_110m_land を gint:false", () => {
	assert.match(src("packages/globe/src/gadgets/globe.ts"), /geopbf\("ne_110m_land", \{ gint: false \}\)/);
	assert.ok(ids(planPrefetch({ low: true }).tier1).includes("minimap-land"));
});
test("河川・海洋境界：globe（gint あり・LOW_MEM は読まない）と equal", () => {
	const s = src("packages/globe/src/gint/layers.ts");
	for (const n of ["ne_10m_rivers_lake_centerlines", "ne_10m_admin_0_boundary_lines_maritime_indicator"]) {
		assert.ok(s.includes(`"${n}"`), n); assert.ok(src("packages/equal/src/layers.ts").includes(`"${n}"`), n);
	}
	assert.match(s, /geopbf\(def\.name\)/); assert.match(s, /worldLinesState \|\| LOW_MEM/);
});
test("ne-cultural：equal・world・globe が同じ URL・同じ name で読む（正本＝ortho-core worldcontent）", () => {
	const { tier1, tier2 } = planPrefetch({ free: 1e12 });
	const base = tier1.find(j => j.id === "cultural-base"), detail = tier2.find(j => j.id === "cultural-detail");
	assert.equal(base.key, "https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-base.geopbf");
	assert.equal(detail.opts.name, "ne-cultural-detail.geopbf");
	const core = src("packages/ortho-core/src/worldcontent.ts");   // URL と名前の正本＝先読みの鍵と同じ綴り
	assert.ok(core.includes('WORLD_GIS = "https://api.ortho-earth.com/bucket/GIS/world/"'));
	assert.match(core, /culturalUrl = \(g: string\): string => `\$\{WORLD_GIS\}ne-cultural-\$\{g\}\.geopbf`/);   // 2.0：worldcontent.ts＝引数と返りに型が付く
	assert.match(core, /culturalName = \(g: string\): string => `ne-cultural-\$\{g\}\.geopbf`/);
	for (const f of ["packages/equal/src/equal.ts", "packages/world/src/worldlayers.ts", "packages/globe/src/gint/worldcontent.ts"]) {   // 三者とも正本の口で読む（写しを持たない）
		assert.match(src(f), /culturalUrl\(g\), \{ name: culturalName\(g\) \}|culturalUrl\("base"\), \{ name: culturalName\("base"\) \}/, f);
		assert.ok(!src(f).includes("bucket/GIS/world/ne-cultural-"), f + "：URL の写しを持たない");
	}
});
