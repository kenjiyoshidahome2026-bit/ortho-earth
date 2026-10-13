// Wikipedia の共通の芯（src/wiki.js）の単体＝URL・言語の順・冒頭（REST summary）・候補（opensearch）。網は使わない（fetch を差し込む）。
// 枠（createWikiFrame）は DOM が要る＝tests/t-wiki.html（verify:ui）で見る。
import assert from "node:assert/strict";
import { wikiUrl, wikiTitle, toMobile, toDesktop, parseWikiUrl, langChain, pickTitle, summary, summaryIn, search, SUMMARY_URL, CAN_FRAME } from "../src/wiki.js";

// URL
assert.equal(wikiTitle(" Mount Fuji "), "Mount_Fuji");
assert.equal(wikiUrl("Mount Fuji"), "https://en.wikipedia.org/wiki/Mount_Fuji");
assert.equal(wikiUrl("富士山", "ja"), "https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1");
assert.equal(wikiUrl("Mount Fuji", "en", { mobile: true }), "https://en.m.wikipedia.org/wiki/Mount_Fuji");
assert.equal(toMobile("https://ja.wikipedia.org/wiki/富士山"), "https://ja.m.wikipedia.org/wiki/富士山");
assert.equal(toMobile("https://ja.m.wikipedia.org/wiki/富士山"), "https://ja.m.wikipedia.org/wiki/富士山");   // 二重に m. を付けない
assert.equal(toDesktop("https://zh-yue.m.wikipedia.org/wiki/X"), "https://zh-yue.wikipedia.org/wiki/X");
assert.equal(toMobile("https://www.wikidata.org/wiki/Q42"), "https://www.wikidata.org/wiki/Q42");           // Wikipedia 以外は触らない
assert.deepEqual(parseWikiUrl("https://ja.m.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1?x=1#s"), { lang: "ja", title: "富士山" });
assert.deepEqual(parseWikiUrl("https://en.wikipedia.org/wiki/Mount_Fuji"), { lang: "en", title: "Mount Fuji" });
assert.equal(parseWikiUrl("https://example.com/wiki/X"), null);
assert.equal(CAN_FRAME, false);   // node＝iframe なし

// 言語の順
assert.deepEqual(langChain("fr"), ["fr", "en", "ja"]);
assert.deepEqual(langChain("en"), ["en", "ja"]);
assert.deepEqual(langChain("ja", ["en", "ja"]), ["ja", "en"]);
assert.deepEqual(langChain(null, ["en"]), ["en"]);
assert.deepEqual(pickTitle({ en: "Mount Fuji", ja: "富士山" }, ["fr", "ja", "en"]), { lang: "ja", title: "富士山" });
assert.equal(pickTitle({ en: "" }, ["en"]), null);
assert.equal(pickTitle(undefined, ["en"]), null);

// 冒頭＝REST summary（fetch を差し込む・IDB は node に無い＝メモリだけで続く）
const calls = [];
const fakeFetch = (bodies) => async (url) => {
	calls.push(url);
	const b = bodies[url];
	if (b === undefined) return { ok: false, status: 404, json: async () => ({}) };
	if (b === "boom") return { ok: false, status: 503, json: async () => ({}) };
	return { ok: true, status: 200, json: async () => b };
};
const JA = SUMMARY_URL("富士山", "ja"), EN = SUMMARY_URL("Mount Fuji", "en"), FR = SUMMARY_URL("Mont Fuji", "fr");
assert.equal(JA, "https://ja.wikipedia.org/api/rest_v1/page/summary/%E5%AF%8C%E5%A3%AB%E5%B1%B1");
const f = fakeFetch({
	[JA]: { title: "富士山", extract: "富士山は…", description: "日本の山", thumbnail: { source: "https://upload.wikimedia.org/x.jpg" }, content_urls: { desktop: { page: "https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1" } } },
	[EN]: { title: "Mount Fuji", extract: "Mount Fuji is…" },
});
const s1 = await summary("富士山", "ja", { fetch: f });
assert.deepEqual(s1, { lang: "ja", title: "富士山", extract: "富士山は…", extractHtml: "", description: "日本の山", thumbnail: "https://upload.wikimedia.org/x.jpg", url: "https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1" });
const s2 = await summary("富士山", "ja", { fetch: f });
assert.equal(s2, s1); assert.equal(calls.length, 1);                          // 同じ頁では 1 回だけ取る
assert.equal(await summary("Nope", "en", { fetch: f }), null);              // 404＝記事なし
assert.equal(await summary("", "en", { fetch: f }), null);
const sEn = await summary("Mount Fuji", "en", { fetch: f });
assert.equal(sEn.url, "https://en.wikipedia.org/wiki/Mount_Fuji");         // content_urls が無ければ組む
assert.equal(sEn.thumbnail, null);
// 言語の順＝fr（無い）→ en（取れる）
calls.length = 0;
const sIn = await summaryIn({ fr: "Mont Fuji", en: "Mount Fuji", ja: "富士山" }, ["fr", "en", "ja"], { fetch: f });
assert.equal(sIn.lang, "en"); assert.deepEqual(calls, [FR]);               // en・ja はメモリから
assert.equal(await summaryIn({ fr: "Mont Fuji" }, ["fr", "de"], { fetch: f }), null);
assert.equal(await summaryIn(null, ["en"], { fetch: f }), null);
// 失敗（503・例外）＝null（投げない）。abort は投げる
assert.equal(await summary("X", "de", { fetch: fakeFetch({ [SUMMARY_URL("X", "de")]: "boom" }) }), null);
assert.equal(await summary("Y", "de", { fetch: async () => { throw new TypeError("offline"); } }), null);
await assert.rejects(summary("Z", "de", { fetch: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } }), { name: "AbortError" });

// 候補＝opensearch
const os = fakeFetch({ ["https://ja.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&namespace=0&limit=3&search=%E5%AF%8C%E5%A3%AB"]: ["富士", ["富士山", "富士市"], ["日本の山", "静岡県の市"], ["https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1"]] });
const hits = await search("富士", "ja", { limit: 3, fetch: os });
assert.deepEqual(hits, [{ title: "富士山", description: "日本の山", url: "https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1" }, { title: "富士市", description: "静岡県の市", url: "https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B8%82" }]);
assert.deepEqual(await search("  ", "ja", { fetch: os }), []);
assert.deepEqual(await search("none", "ja", { fetch: os }), []);   // 404＝空
console.log("✓ wiki: url/langChain/summary/summaryIn/search");
