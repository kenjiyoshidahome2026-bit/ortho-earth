// docs の head の門（Issue #308 の続き・2026-10-23）：sitemap に載る docs は description と自分を指す canonical を持つ・
// 英日の対（x と x-jp）は同じ hreflang（en・ja・x-default＝英語）を互いに持つ・トップと Stories の docs へのリンクは .html を付けない（本番は 308 で送る）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { docsUrls, ORIGIN } from "../sitemap.js";

const DIR = new URL("../../docs/", import.meta.url);
const read = (f) => readFileSync(new URL(f, DIR), "utf8");
const names = readdirSync(DIR).filter(f => f.endsWith(".html")).map(f => f.slice(0, -5));

test("sitemap に載る docs は description と自分を指す canonical を持つ", () => {
	for (const p of docsUrls(DIR)) {
		const f = p.replace("/docs/", ""), html = read(f + ".html");
		assert.match(html, /<meta name="description" content="[^"]{50,}">/, f);
		assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${p}">`), f);
	}
});
test("英日の対は互いに hreflang（en・ja・x-default）を持つ", () => {
	const pairs = names.filter(f => f.endsWith("-jp") && names.includes(f.slice(0, -3))).map(f => f.slice(0, -3));
	assert.ok(pairs.length >= 12, String(pairs.length));
	for (const b of pairs) for (const f of [b, b + "-jp"]) {
		const alt = [...read(f + ".html").matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(m => `${m[1]} ${m[2]}`);
		assert.deepEqual(alt, [`en ${ORIGIN}/docs/${b}`, `ja ${ORIGIN}/docs/${b}-jp`, `x-default ${ORIGIN}/docs/${b}`], f);
	}
});
test("片方だけの docs は hreflang を持たない", () => {
	for (const f of names.filter(f => !names.includes(f.endsWith("-jp") ? f.slice(0, -3) : f + "-jp"))) assert.ok(!read(f + ".html").includes("hreflang"), f);
});
test("トップは自分を指す canonical を持ち、docs へのリンクに .html を付けない", () => {
	const html = readFileSync(new URL("../index.html", import.meta.url), "utf8"), stories = readFileSync(new URL("../stories.json", import.meta.url), "utf8");
	assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/" />`));
	assert.doesNotMatch(html, /href="\/docs\/[^"]*\.html/);
	assert.doesNotMatch(stories, /"\/docs\/[^"]*\.html/);
});
