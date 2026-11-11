// MCP サーバーが読む資料の門（2026-11-11）：/compat.json の例の数が facts.json の採点と同じ・style-spec の表が読める・型の写しが出る
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompat, refFiles, styleCoverage } from "../agent-data.js";
import { buildFacts } from "../facts.js";

const c = buildCompat(), f = buildFacts();

test("例の数と段の内訳が facts.json の互換の数と同じ", () => {
	for (const [k, lib] of [["maplibre", c.maplibre], ["cesium", c.cesium]]) {
		const fc = f.compatibility[k], ex = lib.examples;
		assert.equal(ex.length, fc.examples, k);
		for (const lv of ["samePicture", "sameAnswers", "runsPartly", "doesNotRun"]) assert.equal(ex.filter(e => e.level === lv).length, fc[lv], `${k} ${lv}`);
		for (const e of ex) {
			assert.ok(e.id && e.title, `${k}: id と title`);
			assert.ok(e.url.startsWith(`https://www.ortho-earth.com/${k === "cesium" ? "sandcastle" : "maplibre"}/#`), e.url);
		}
	}
});

test("style-spec の性質の表：見出しの計と同じ数が読める", () => {
	const md = "計 2：読む 1・未 1\n\n| 層 | 置き場 | 性質 | 状態 | 中身 |\n|---|---|---|---|---|\n| fill | paint | `fill-color` | 読む |  |\n| line | layout | `line-cap` | 未 | 丸だけ |\n";
	assert.deepEqual(styleCoverage(md), [
		{ layer: "fill", kind: "paint", property: "fill-color", status: "reads" },
		{ layer: "line", kind: "layout", property: "line-cap", status: "notYet", note: "丸だけ" },
	]);
	assert.ok(c.styleSpec.length >= 100);
	assert.ok(c.styleSpec.some(p => p.property === "fill-color"));
});

test("型の写し：globe.d.ts に createGlobe・maplibre.d.ts に Map・globe-map.ts に flyTo", () => {
	const r = refFiles();
	assert.match(r["ref/globe.d.ts"], /createGlobe/);
	assert.match(r["ref/maplibre.d.ts"], /\bMap\b/);
	assert.match(r["ref/globe-map.ts"], /\bflyTo\(/);
});
