// sitemap.xml の門（Issue #308 段 1）：XML として読める・URL が重複しない・? と # を含まない・canonical が別の頁を指す docs を載せない
// vite.config.js の generateBundle と同じ buildSitemap() を検める＝ビルドしたものと同じ中身。本番の 200 は scripts/verify-sitemap.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSitemap, ORIGIN } from "../sitemap.js";

const xml = buildSitemap();
const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);

test("XML として読める（宣言・urlset・url/loc と任意の lastmod だけ・タグが閉じている）", () => {
	assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n(<url><loc>[^<>&]*<\/loc>(<lastmod>\d{4}-\d\d-\d\d<\/lastmod>)?<\/url>\n)+<\/urlset>\n$/);
});
test("URL が重複しない", () => assert.equal(new Set(locs).size, locs.length));
test("? と # を含まない・本番のオリジンだけ・.html で終わらない（Pages が 308 で送る形）", () => {
	for (const u of locs) {
		assert.ok(!u.endsWith(".html"), u);
		assert.ok(!/[?#]/.test(u), u);
		assert.equal(new URL(u).origin, ORIGIN, u);
	}
});
test("トップ・/maplibre/・/equal/・アプリ・docs が載る", () => {
	for (const p of ["/", "/maplibre/", "/equal/", "/globe/", "/japan/", "/docs/core"]) assert.ok(locs.includes(ORIGIN + p), p);
});
test("canonical が別の頁を指す docs は載せない", () => {
	for (const p of ["/docs/index", "/docs/GC", "/docs/MO", "/docs/ST"]) assert.ok(!locs.includes(ORIGIN + p), p);
});
test("canonical が自分を指す docs は載せる（段 2 の頁の形）", async () => {
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { docsUrls } = await import("../sitemap.js");
	const dir = mkdtempSync(`${tmpdir()}/sitemap-`) + "/";
	writeFileSync(dir + "self.html", `<link rel="canonical" href="${ORIGIN}/docs/self">`);
	writeFileSync(dir + "other.html", `<link rel="canonical" href="gint.html#lod">`);
	writeFileSync(dir + "none.html", "");
	assert.deepEqual(docsUrls(new URL(`file://${dir}`)), ["/docs/none", "/docs/self"]);
});
test("lastmod＝元ファイルが repo の中で決まる頁だけ（トップ・/maplibre/・docs）。アプリの頁には書かない", async () => {
	const { sourcesOf, gitLastmod, sitemapXml } = await import("../sitemap.js");
	for (const p of ["/", "/maplibre/", "/docs/core"]) assert.ok(sourcesOf(ORIGIN + p), p);
	for (const p of ["/japan/", "/globe/", "/equal/"]) assert.equal(sourcesOf(ORIGIN + p), null, p);
	const d = gitLastmod(sourcesOf(ORIGIN + "/docs/core"));
	assert.ok(d === null || /^\d{4}-\d\d-\d\d$/.test(d), String(d));   // 浅い clone の境目なら null（書かない）
	assert.equal(sitemapXml([ORIGIN + "/a", ORIGIN + "/b"], u => u.endsWith("/a") ? "2026-10-23" : null),
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${ORIGIN}/a</loc><lastmod>2026-10-23</lastmod></url>\n<url><loc>${ORIGIN}/b</loc></url>\n</urlset>\n`);
});
test("git の外では lastmod を書かない", async () => {
	const { gitLastmod } = await import("../sitemap.js");
	const { tmpdir } = await import("node:os");
	assert.equal(gitLastmod([new URL(`file://${tmpdir()}/no-such-file`)]), null);
});
