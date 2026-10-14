// sitemap.xml の門（Issue #308 段 1）：XML として読める・URL が重複しない・? と # を含まない・canonical が別の頁を指す docs を載せない
// vite.config.js の generateBundle と同じ buildSitemap() を検める＝ビルドしたものと同じ中身。本番の 200 は scripts/verify-sitemap.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSitemap, ORIGIN } from "../sitemap.js";

const xml = buildSitemap();
const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);

test("XML として読める（宣言・urlset・url/loc だけ・タグが閉じている）", () => {
	assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n(<url><loc>[^<>&]*<\/loc><\/url>\n)+<\/urlset>\n$/);
});
test("URL が重複しない", () => assert.equal(new Set(locs).size, locs.length));
test("? と # を含まない・本番のオリジンだけ", () => {
	for (const u of locs) {
		assert.ok(!/[?#]/.test(u), u);
		assert.equal(new URL(u).origin, ORIGIN, u);
	}
});
test("トップ・/maplibre/・/equal/・アプリ・docs が載る", () => {
	for (const p of ["/", "/maplibre/", "/equal/", "/globe/", "/japan/", "/docs/core.html"]) assert.ok(locs.includes(ORIGIN + p), p);
});
test("canonical が別の頁を指す docs は載せない", () => {
	for (const p of ["/docs/index.html", "/docs/GC.html", "/docs/MO.html", "/docs/ST.html"]) assert.ok(!locs.includes(ORIGIN + p), p);
});
