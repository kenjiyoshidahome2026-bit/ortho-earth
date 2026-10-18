// common/wiki.ts の検定：括弧を削る clean（CodeQL で正規表現から添字に書き換えた所）と、JSON だけで答える API の口
//（title→id・id→title・言語間リンク・Wikidata の QID・座標）。fetch は偽の Wikipedia API（URL の問いを読んで答える）＝外部へ出ない。
// HTML を読む口（extract・getContent・qid2titles・infobox の座標）は DOMParser と IDB が要る＝ブラウザ側。
globalThis.DOMParser ??= class { parseFromString() { return { querySelectorAll: () => [], querySelector: () => null }; } };   // import の時に 1 つ作る（node に DOM は無い）
const { wiki } = await import("../src/wiki.ts");

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quiet = { log: console.log, error: console.error, warn: console.warn };
console.log = () => {}; console.error = () => {}; console.warn = () => {};

// ── clean ──
{
	const c = wiki.clean;
	const R = [
		["東京都（とうきょうと）は日本の首都", "東京都は日本の首都"],
		["Tokyo (Japanese: 東京) is big", "Tokyois big"],
		["a[1]b[注 2]c", "abc"],
		["x&nbsp;y", "x y"],
		["閉じない（括弧 のまま", "閉じない（括弧 のまま"],
		["(a) b (c)", "b"],
		["入れ子（外（内）残）", "入れ子残）"],
	];
	for (const [i, o] of R) ok(`clean：${JSON.stringify(i)}`, c(i) === o, JSON.stringify(c(i)));
	const t0 = performance.now(); c("（".repeat(20000) + "x"); c("(".repeat(20000)); c("[".repeat(20000));
	ok("clean：閉じない開きが続いても線形（後戻りしない）", performance.now() - t0 < 500, `${(performance.now() - t0).toFixed(0)}ms`);
}

// ── 偽の Wikipedia API ──
const PAGES = { ja: { 1: { title: "東京", qid: "Q1490", ll: { en: "Tokyo" }, co: [139.69, 35.69] }, 2: { title: "大阪", qid: "Q35765", ll: { en: "Osaka" } }, 3: { title: "名無し" } },
	en: { 11: { title: "Tokyo", qid: "Q1490", ll: { ja: "東京" } }, 12: { title: "Osaka", qid: "Q35765", co: [135.5, 34.69] } } };
const REDIRECTS = { ja: { "東京都": "東京" } };
const calls = [];
globalThis.fetch = async url => {
	const u = new URL(url), lang = u.hostname.split(".")[0], q = Object.fromEntries(u.searchParams), P = PAGES[lang] || {};
	calls.push({ lang, ...q });
	const page = (id, p) => ({ pageid: +id, title: p.title, ...(q.prop === "langlinks" && p.ll?.[q.lllang] ? { langlinks: [{ "*": p.ll[q.lllang] }] } : {}),
		...(q.prop === "pageprops" && p.qid ? { pageprops: { wikibase_item: p.qid } } : {}), ...(q.prop === "coordinates" && p.co ? { coordinates: [{ lon: p.co[0], lat: p.co[1] }] } : {}) });
	if (q.action === "parse") return new Response(JSON.stringify({}));   // 本文（HTML）は無い＝infobox は読めない
	const pages = {}, redirects = [];
	if (q.pageids) for (const id of q.pageids.split("|")) if (P[id]) pages[id] = page(id, P[id]);
	if (q.titles) for (let t of q.titles.split("|").map(decodeURIComponent)) {
		const to = REDIRECTS[lang]?.[t]; if (to) { redirects.push({ from: t, to }); t = to; }
		const id = Object.keys(P).find(k => P[k].title === t); if (id) pages[id] = page(id, P[id]);
	}
	return new Response(JSON.stringify({ query: { pages, redirects } }));
};

// ── title2id・id2title ──
ok("title2id：1 件", await wiki.title2id("大阪") === 2);
ok("title2id：転送（東京都→東京）", await wiki.title2id("東京都") === 1);
ok("title2id：配列・無い名前は 0", same(await wiki.title2id(["東京", "どこか", "大阪"]), [1, 0, 2]));
ok("title2id：問いの形（action=query・redirects・origin=*）", calls.at(-1).action === "query" && "redirects" in calls.at(-1) && calls.at(-1).origin === "*");
{
	const n = calls.length, titles = Array.from({ length: 30 }, (_, i) => i % 2 ? "東京" : "大阪");
	const r = await wiki.title2id(titles);
	ok("title2id：25 件ずつに分けて問う（30 件＝2 回）", calls.length - n === 2 && r.length === 30 && r[1] === 1 && r[0] === 2);
}
ok("id2title", await wiki.id2title(2) === "大阪" && same(await wiki.id2title([1, 2]), ["東京", "大阪"]));
ok("id2title：言語（en）", await wiki.id2title(11, "en") === "Tokyo");

// ── 言語間リンク ──
ok("id2langlink：ja→en・無ければ空", same(await wiki.id2langlink([1, 3], "en"), ["Tokyo", ""]) && await wiki.id2langlink(2, "en") === "Osaka");
ok("langLinksById：{ja: id, en: id}", same(await wiki.langLinksById([1, 2], "en"), [{ ja: 1, en: 11 }, { ja: 2, en: 12 }]));
ok("langLinksByTitle：{ja: 名前, en: 名前}", same(await wiki.langLinksByTitle(["東京", "大阪"], ["en"]), [{ ja: "東京", en: "Tokyo" }, { ja: "大阪", en: "Osaka" }]));

// ── QID ──
ok("id2qid・無ければ undefined", await wiki.id2qid(1) === "Q1490" && same(await wiki.id2qid([2, 3]), ["Q35765", null]));
ok("title2qid（転送も）・無ければ 0", await wiki.title2qid("東京都") === "Q1490" && same(await wiki.title2qid(["大阪", "名無し"]), ["Q35765", 0]));

// ── 座標 ──
ok("id2coords：coordinates があればそのまま [lon,lat]", same(await wiki.id2coords(1), [139.69, 35.69]));
ok("title2coords（名前→id→座標）", same(await wiki.title2coords("東京"), [139.69, 35.69]));
ok("id2coords：無ければ他言語の版（ja 大阪→en Osaka）の…本文を読む＝ここでは null", (await wiki.id2coords(2)) === null);
ok("ja・en 以外は受けない", (await wiki.id2coords(1, "fr")) === undefined && (await wiki.title2coords("x", "de")) === undefined);

// ── API が答えない ──
globalThis.fetch = async () => new Response(JSON.stringify({ error: "x" }));
// 配列の口は欠けを undefined で返す（1 件の口は Object.values(undefined) で投げる＝元の JS からの挙動・ここでは縛らない）
ok("答えが無い：配列の口は undefined を返す（落ちない）", same(await wiki.title2id(["東京"]), [null]) && same(await wiki.id2title([1]), [null]) && same(await wiki.id2qid([1]), [null]));
ok("logo の URL", wiki.logo.startsWith("https://upload.wikimedia.org/"));

console.log = quiet.log; console.error = quiet.error; console.warn = quiet.warn;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-wiki 全 PASS");
process.exit(fail ? 1 : 0);
