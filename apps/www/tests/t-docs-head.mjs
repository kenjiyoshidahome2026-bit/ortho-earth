// docs の head の門（Issue #308 の続き・2026-10-23）：sitemap に載る docs は description と自分を指す canonical を持つ・
// 英日の対（x と x-jp）は同じ hreflang（en・ja・x-default＝英語）を互いに持つ・トップと Stories の docs へのリンクは .html を付けない（本番は 308 で送る）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { docsUrls, ORIGIN } from "../sitemap.js";
import { withDocsHead, docsMeta, OG_IMAGE } from "../docs-head.js";

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
// 共有カードと構造化データ（2026-10-23）：sitemap に載る docs は og:title・og:image・twitter:card と TechArticle の JSON-LD を持ち、title・description と揃う
test("sitemap に載る docs は共有カードと JSON-LD を持ち、写しがずれていない", () => {
	const stale = [];
	for (const p of docsUrls(DIR)) {
		const f = p.replace("/docs/", ""), html = read(f + ".html"), m = docsMeta(html);
		if (withDocsHead(html) !== html) stale.push(f);
		assert.ok(m.ogTitle, f);
		assert.ok(html.includes(`<meta property="og:image" content="${OG_IMAGE}">`), f);
		assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), f);
		const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^\n]*)<\/script>/)[1]);
		assert.equal(ld["@type"], "TechArticle", f);
		assert.equal(ld.url, ORIGIN + p, f);
		assert.equal(ld.description, m.description, f);
		assert.equal(ld.inLanguage, m.lang, f);
		assert.ok(ld.headline && ld.headline.length <= 110, f);
		assert.equal(ld.datePublished, m.published ?? undefined, f);
	}
	assert.deepEqual(stale, [], "run node apps/www/scripts/docs-head.mjs");
});
test("withDocsHead は何度通しても同じ・og:title が無い頁には title から足す", () => {
	const src = '<html lang="en">\n<title>A &amp; B</title>\n<meta name="description" content="say &quot;hi&quot;">\n<link rel="canonical" href="https://www.ortho-earth.com/docs/x">\n<link rel="icon" href="favicon.svg">\n';
	const once = withDocsHead(src);
	assert.equal(withDocsHead(once), once);
	assert.ok(once.includes('<meta property="og:title" content="A &amp; B">'));
	const ld = JSON.parse(once.match(/ld\+json">([^\n]*)<\/script>/)[1]);
	assert.equal(ld.headline, "A & B");
	assert.equal(ld.description, 'say "hi"');
});
test("トップは WebSite・Person・SoftwareApplication の JSON-LD を持つ", () => {
	const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
	const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
	assert.deepEqual(ld["@graph"].map(n => n["@type"]), ["WebSite", "Person", "SoftwareApplication"]);
	for (const n of ld["@graph"]) assert.ok(n["@id"].startsWith(ORIGIN + "/#"), n["@id"]);
});
test("一番上に 404.html がある（無いと Pages が無い URL にトップを 200 で返す＝ソフト 404）", () => {
	const html = readFileSync(new URL("../public/404.html", import.meta.url), "utf8");
	assert.match(html, /<meta name="robots" content="noindex">/);
	assert.doesNotMatch(html, /<script/);
});
