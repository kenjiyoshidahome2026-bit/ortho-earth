import { thenMap, slice, isNumber, isArray, xy2yx } from "common";
import { Cache } from "native-bucket";
import type { CacheFn } from "native-bucket";
/** Wikipedia API の応答のうち使う形（query 系と parse 系） */
interface WikiPage { pageid: number; title: string; langlinks?: { "*": string }[]; pageprops?: { wikibase_item?: string }; coordinates?: { lon: number; lat: number }[]; extract?: string }
interface WikiResponse { query?: { pages?: Record<string, WikiPage>; redirects?: { from: string; to: string }[] }; parse?: { text?: { "*": string } } }
type WikiParams = Record<string, string | number | boolean>;
type Coords = [number | null, number | null] | null | undefined;
const parser = new DOMParser(), parseHTML = (s: string): Document => parser.parseFromString(s, "text/html");
const divide_length = 25;
const wikiDB: Record<string, CacheFn> = {}, wikiExtract: Record<string, CacheFn> = {};
const wikiAPI = (q: WikiParams, lang = "ja"): string => `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*&` + Object.entries(q).map(t => t[1] === true ? t[0] : t.join("=")).join("&");
const fetchJSON = (url: string): Promise<WikiResponse> => fetch(url).then(r => r.json());
const fetchHTML = (url: string): Promise<Document> => fetch(url).then(r => r.text()).then(t => parser.parseFromString(t, "text/html"));
const tohtml = (str: string): Document => new DOMParser().parseFromString(str, 'text/html');
const logo = 'https://upload.wikimedia.org/wikipedia/commons/8/80/Wikipedia-logo-v2.svg';
const WS = /\s/;
// 括弧で囲んだ所を落とす（旧 /O[^C]*C/g と同じ削り方）。開きの次の最初の閉じまで＝中に開きがあっても良い・閉じの無い開き以降はそのまま。ws＝前後の空白 1 字も落とす（旧 /\s?\(…\)\s?/g）
function stripBracketed(s: string, open: string, close: string, ws = false): string {
	let out = "", i = 0;
	for (;;) {
		let j = i; while (j < s.length && !open.includes(s[j])) j++;
		if (j >= s.length) return out + s.slice(i);
		let k = j + 1; while (k < s.length && !close.includes(s[k])) k++;
		if (k >= s.length) return out + s.slice(i);
		let a = j, b = k + 1;
		if (ws && a > i && WS.test(s[a - 1])) a--;
		if (ws && b < s.length && WS.test(s[b])) b++;
		out += s.slice(i, a); i = b;
	}
}
// 旧＝.replace(/（[^）]*）/g,"").replace(/\s?\([^\)]*\)\s?/g,"").replace(/\[[^\]]*\]/g,"")。閉じの無い開きが続くと二乗の後戻り（CodeQL）＝添字で同じ削り方
const clean = (str: string): string => stripBracketed(stripBracketed(stripBracketed(str, "（", "）"), "(", ")", true), "[", "]").replace(/\&nbsp\;/g, " ");
export const wiki = { title2id, id2title, id2langlink, langLinksById, langLinksByTitle, getContent, id2qid, title2qid, title2coords, openWikipediaByQID, qid2titles, id2coords, extract, logo, clean };
async function title2id(title: string | string[], lang = "ja"): Promise<(number | void)[] | number> {
	return isArray(title) ?
		(await thenMap(slice(title, divide_length), t => conv(t))).flat() :
		Object.values(await conv([title]) as number[])[0];
	async function conv(title: string[]): Promise<number[] | void> { //console.log(`- wiki-api(title=>id, lang=${lang}): ${title.join("|")}`);
		const v = await fetchJSON(wikiAPI({ action: "query", titles: title.map(encodeURIComponent).join("|"), redirects: true }, lang));
		if (!(v && v.query)) return console.error("wiki-api:failed:", title, v)
		const q: Record<string, number> = {}; Object.values(v.query.pages || {}).forEach(t => q[t.title] = t.pageid);
		const r: Record<string, string> = {}; Object.values(v.query.redirects || {}).forEach(t => r[t.from] = t.to);
		const p = title.map(t => q[r[t] || t] || 0);
		title.forEach((t, i) => p[i] || console.log("failed: couldn't find pageid...", t));
		return p;
	}
}
async function id2title(id: number | number[], lang = "ja"): Promise<(string | void)[] | string> {
	return isArray(id) ?
		(await thenMap(slice(id, divide_length), t => conv(t))).flat() :
		(await conv([id]) as string[])[0];
	async function conv(id: number[]): Promise<string[] | void> {
		console.log(`- wiki-api(id=>title, lang=${lang}): ${id.join("|")}`);
		const v = await fetchJSON(wikiAPI({ action: "query", pageids: id.join("|") }, lang));
		if (!(v && v.query)) return console.error("wiki-api:failed:", v);
		return id.map(id => v.query!.pages![id].title);
	}
}
async function id2langlink(id: number | number[], tolang: string, fromlang = "ja"): Promise<(string | void)[] | string> {
	return isArray(id) ?
		(await thenMap(slice(id, divide_length), t => conv(t))).flat() :
		(await conv([id]) as string[])[0];
	async function conv(id: number[]): Promise<string[] | void> {
		console.log(`- wiki-api(id(${fromlang})=>id(${tolang}): ${id.join("|")}`);
		const v = await fetchJSON(wikiAPI({ action: "query", prop: "langlinks", lllang: tolang, lllimit: 500, pageids: id.join("|") }, fromlang));
		if (!(v && v.query)) return console.error("wiki-api:failed:", v);
		return id.map(id => v.query!.pages![id].langlinks ? v.query!.pages![id].langlinks![0]["*"] : "");
	}
}
async function langLinksById(id: number[], tolangs: string | string[], fromLang = "ja"): Promise<Record<string, unknown>[]> {
	tolangs = isArray(tolangs) ? tolangs : [tolangs];
	const func = async (lang: string): Promise<unknown> => title2id(await id2langlink(id, lang, fromLang) as string[], lang);
	const langs = [fromLang].concat(tolangs)
	const a = xy2yx([id as unknown[]].concat(await thenMap(tolangs, func) as unknown[][]));
	return a.map(t => { const q: Record<string, unknown> = {}; langs.forEach((lang, i) => q[lang] = t[i]); return q; })
}
async function langLinksByTitle(titles: string[], tolangs: string | string[], fromLang = "ja"): Promise<Record<string, unknown>[]> {
	tolangs = isArray(tolangs) ? tolangs : [tolangs];
	const func = async (lang: string): Promise<unknown> => id2langlink(await title2id(titles, fromLang) as number[], lang, fromLang);
	const langs = [fromLang].concat(tolangs)
	const a = xy2yx([titles as unknown[]].concat(await thenMap(tolangs, func) as unknown[][]));
	return a.map(t => { const q: Record<string, unknown> = {}; langs.forEach((lang, i) => q[lang] = t[i]); return q; })
}
async function extract(id: number | string, lang = "ja"): Promise<unknown> {
	var idb = wikiExtract[lang] = wikiExtract[lang] || (await Cache(["wikiExtract", lang].join("/")));
	var v = await idb(id); if (v) return v;
	const func = { action: "query", pageids: id, prop: "extracts", exintro: true/*,explaintext:true*/ }
	const res = await fetchJSON(wikiAPI(func, lang));
	if (!(res && res.query)) return console.error("wiki-api:failed:", res);
	const doc = parseHTML(res.query.pages![id].extract!);
	[...doc.querySelectorAll("body sup[class]")].forEach(t => t.remove());
	const text = clean([...doc.querySelectorAll<HTMLElement>("body >p")].map(t => t.innerText).join(""));
	await idb(id, text); return text;
}
async function get(title: string | number, lang = "ja"): Promise<string | null> {
	const func: WikiParams = isNumber(title) ? { action: "parse", prop: "text", pageid: title } :
		{ action: "parse", prop: "text", page: encodeURIComponent(title), redirects: true };
	const v = await fetchJSON(wikiAPI(func, lang));
	return (v && v.parse && v.parse.text) ? v.parse.text["*"] : null;
};
async function getContent(id: string | number, lang = "ja"): Promise<Document | void> {
	var idb = wikiDB[lang] = wikiDB[lang] || (await Cache(["wikiDB", lang].join("/")));
	var v = await idb(id); if (v) return parseHTML(v as string);
	const html = await get(id, lang); if (!html) return console.error("fail to get data: ", id, lang)   // B17：旧＝lang を渡さず常に ja から取った
	await idb(id, html);
	return getContent(id, lang);
}
async function id2qid(id: number | number[], lang = "ja"): Promise<(string | undefined | void)[] | string | undefined> {
	return isArray(id) ?
		(await thenMap(slice(id, divide_length), t => conv(t))).flat() :
		(await conv([id]) as (string | undefined)[])[0];
	async function conv(id: number[]): Promise<(string | undefined)[] | void> {
		console.log(`- wiki-api(id=>qid, lang=${lang}): ${id.join("|")}`);
		const v = await fetchJSON(wikiAPI({ action: "query", prop: "pageprops", pageids: id.join("|") }, lang));
		if (!(v && v.query)) return console.error("wiki-api:failed:", v);
		return id.map(id => (v.query!.pages![id].pageprops || {}).wikibase_item);
	}
}
async function title2qid(title: string | string[], lang = "ja"): Promise<(string | number | void)[] | string | number> {
	return isArray(title) ?
		(await thenMap(slice(title, divide_length), t => conv(t))).flat() :
		Object.values(await conv([title]) as (string | number)[])[0];
	async function conv(title: string[]): Promise<(string | number)[] | void> {
		console.log(`- wiki-api(title=>qid, lang=${lang}): ${title.join("|")}`);
		const v = await fetchJSON(wikiAPI({ action: "query", prop: "pageprops", titles: title.map(encodeURIComponent).join("|"), redirects: true }, lang));
		if (!(v && v.query)) return console.error("wiki-api:failed:", v)
		const q: Record<string, string | undefined> = {}; Object.values(v.query.pages || {}).forEach(t => q[t.title] = (t.pageprops || {}).wikibase_item);
		const r: Record<string, string> = {}; Object.values(v.query.redirects || {}).forEach(t => r[t.from] = t.to);
		const p = title.map(t => q[r[t] || t] || 0);
		title.forEach((t, i) => p[i] || console.log("failed: couldn't find pageid...", t));
		return p;
	}
}
async function qid2titles(qid: string, flag = false): Promise<Record<string, string>> {
	const v = await fetchHTML(`https://www.wikidata.org/wiki/${qid}`);
	const langs = ["en", "de", "es", "fr", "pt", "ru", "zh", "ar", "bn", "el", "hi", "hu", "id", "it", "ja", "ko", "nl", "pl", "sv", "tr", "vi", "fa", "he", "uk", "ur", "zht"];
	const a = [...v.querySelectorAll<HTMLAnchorElement>("a:not(.external)")], q: Record<string, string> = {};
	a.forEach(t => {
		var r = t.href.match(/^https\:\/\/([a-z]+)\.wikipedia\.org\/wiki\//);
		if (r && langs.includes(r[1])) q[r[1]] = flag ? t.title : clean(t.title);
	});
	console.log(qid, "=>", Object.keys(q).length, q);
	return q;
}
async function openWikipediaByQID(qid: string, lang: string): Promise<void> {
	const v = await fetchHTML(`https://www.wikidata.org/wiki/${qid}`);
	const a = [...v.querySelectorAll<HTMLAnchorElement>("a:not(.external)")];
	const wiki = (_: string): string => `^https://${_}.wikipedia.org/wiki/`;
	const url = a.filter(t => t.href.match(wiki(lang))).map(t => t.href)[0]
		|| a.filter(t => t.href.match(wiki("en"))).map(t => t.href)[0];
	url && open(url, "_wiki_");
}
async function title2coords(title: string | string[], lang = "ja"): Promise<unknown> {
	if (!(lang == "ja" || lang == "en")) return console.error(`This function accepts only 'ja' or 'en'.`);
	return isArray(title) ?
		(await thenMap(slice(title, 10), t => conv(t))).flat() :
		Object.values(await conv([title]) as object)[0];
	async function conv(title: string[]): Promise<unknown> { return id2coords(await title2id(title, lang) as number[], lang); }
}
async function id2coords(id: number | number[], lang = "ja"): Promise<unknown> {
	if (!(lang == "ja" || lang == "en")) return console.error(`This function accepts only 'ja' or 'en'.`);
	return isArray(id) ?
		(await thenMap(slice(id, 10), t => conv(t))).flat() :
		(await conv([id]) as unknown[])[0];
	async function conv(ids: number[]): Promise<(Coords | void)[] | void> {
		console.log(`- wiki-api(id=>coords, lang=${lang}): ${ids.join("|")}`);
		var v = await fetchJSON(wikiAPI({ action: "query", prop: "coordinates", pageids: ids.join("|") }, lang));
		if (!(v && v.query)) return console.error("wiki-api:failed:", v);
		return thenMap(ids, async (id): Promise<Coords> => {
			const q = v.query!.pages![id].coordinates;
			if (!isArray(q)) {
				var coords = await getCoords(id, lang);
				if (!coords) {
					const xlang = lang == "ja" ? "en" : "ja";
					const xid = (await langLinksById([id], xlang, lang))[0][xlang] as number;
					coords = await getCoords(xid, xlang);
				}
				coords || console.warn(v.query!.pages![id]);
				return coords;
			}
			return [q[0].lon, q[0].lat];
		});
	}
}
async function getCoords(id: number, lang: string): Promise<[number | null, number | null] | null> {
	function pos(s: string): number | null {
		let r: RegExpMatchArray | null;
		r = s.match(/^(\d+)\°(\d+)\′([\d.]+)\″([NSEW])$/); if (r) return ((+r[1]) + (+r[2]) / 60 + (+r[3] / 3600)) * (r[4].match(/[SW]/) ? -1 : 1);
		r = s.match(/^(\d+)\°(\d+)\′([NSEW])$/); if (r) return ((+r[1]) + (+r[2]) / 60) * (r[3].match(/[SW]/) ? -1 : 1);
		r = s.match(/^(\d+)\°([NSEW])$/); if (r) return (+r[1]) * (r[2].match(/[SW]/) ? -1 : 1);
		r = s.match(/^(北緯|南緯|東経|西経)(\d+)度(\d+)分([\d\.]+)秒$/); if (r) return ((+r[2]) + (+r[3]) / 60 + (+r[4] / 3600)) * (r[1].match(/(南緯|西経)/) ? -1 : 1);
		r = s.match(/^(北緯|南緯|東経|西経)(\d+)度(\d+)分$/); if (r) return ((+r[2]) + (+r[3]) / 60) * (r[1].match(/(南緯|西経)/) ? -1 : 1);
		r = s.match(/^(北緯|南緯|東経|西経)(\d+)度$/); if (r) return (+r[2]) * (r[1].match(/(南緯|西経)/) ? -1 : 1);
		console.warn(`coors error: ${s}`);
		return null;
	}
	var html = await get(id, lang); if (!html) return null;
	const doc = parseHTML(html);
	var info = doc.querySelector(".infobox"); if (!info) return null;
	var [lng, lat] = [info.querySelector<HTMLElement>(".longitude"), info.querySelector<HTMLElement>(".latitude")];
	if (!lng || !lat) return null;
	var coords: [number | null, number | null] = [pos(lng.innerText), pos(lat.innerText)];
	console.log(lng.innerText, lat.innerText, coords);
	return coords;
}
