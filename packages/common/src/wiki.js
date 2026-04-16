import { thenMap, slice, isNumber, isArray, xy2yx } from "common/src/utility.js";
import { Cache } from "native-bucket/src/Cache.js";
const paser = new DOMParser();
const divide_length = 25;
const wikiDB = {}, wikiExtract = {};
const wikiAPI = (q, lang = "ja") => `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*&` + Object.entries(q).map(t => t[1] === true ? t[0] : t.join("=")).join("&");
const fetchJSON = url => fetch(url).then(t => t.json()).catch(console.error);
const tohtml = str => new DOMParser().parseFromString(str, 'text/html');
export const logo = 'https://upload.wikimedia.org/wikipedia/commons/8/80/Wikipedia-logo-v2.svg'
export const clean = str => str.replace(/（[^）]*）/g, "").replace(/\s?\([^\)]*\)\s?/g, "").replace(/\[[^\]]*\]/g, "").replace(/\&nbsp\;/g, " ");
////------------------------------------------------------------------------------------------------------------------------
export async function title2id(title, lang = "ja") {
    return isArray(title) ?
        (await thenMap(slice(title, divide_length), t => conv(t))).flat() :
        Object.values(await conv([title]))[0];
    async function conv(title) { //console.log(`- wiki-api(title=>id, lang=${lang}): ${title.join("|")}`);
        const v = await fetchJSON(wikiAPI({ action: "query", titles: title.map(encodeURIComponent).join("|"), redirects: true }, lang));
        if (!(v && v.query)) return console.error("wiki-api:failed:", title, v)
        const q = {}; Object.values(v.query.pages || {}).forEach(t => q[t.title] = t.pageid);
        const r = {}; Object.values(v.query.redirects || {}).forEach(t => r[t.from] = t.to);
        const p = title.map(t => q[r[t] || t] || 0);
        title.forEach((t, i) => p[i] || console.log("failed: couldn't find pageid...", t));
        return p;
    }
}
export async function id2title(id, lang = "ja") {
    return isArray(id) ?
        (await thenMap(slice(id, divide_length), t => conv(t))).flat() :
        (await conv([id]))[0];
    async function conv(id) {
        console.log(`- wiki-api(id=>title, lang=${lang}): ${id.join("|")}`);
        const v = await fetchJSON(wikiAPI({ action: "query", pageids: id.join("|") }, lang));
        if (!(v && v.query)) return console.error("wiki-api:failed:", v);
        return id.map(id => v.query.pages[id].title);
    }
}
export async function id2langlink(id, tolang, fromlang = "ja") {
    return isArray(id) ?
        (await thenMap(slice(id, divide_length), t => conv(t))).flat() :
        (await conv([id]))[0];
    async function conv(id) {
        console.log(`- wiki-api(id(${fromlang})=>id(${tolang}): ${id.join("|")}`);
        const v = await fetchJSON(wikiAPI({ action: "query", prop: "langlinks", lllang: tolang, lllimit: 500, pageids: id.join("|") }, fromlang));
        if (!(v && v.query)) return console.error("wiki-api:failed:", v);
        return id.map(id => v.query.pages[id].langlinks ? v.query.pages[id].langlinks[0]["*"] : "");
    }
}
////------------------------------------------------------------------------------------------------------------------------
export async function langLinksById(id, tolangs, fromLang = "ja") {
    tolangs = isArray(tolangs) ? tolangs : [tolangs];
    const func = async lang => title2id(await id2langlink(id, lang, fromLang), lang);
    const langs = [fromLang].concat(tolangs)
    const a = xy2yx([id].concat(await thenMap(tolangs, func)));
    return a.map(t => { const q = {}; langs.forEach((lang, i) => q[lang] = t[i]); return q; })
}
export async function langLinksByTitle(titles, tolangs, fromLang = "ja") {
    tolangs = isArray(tolangs) ? tolangs : [tolangs];
    const func = async lang => id2langlink(await title2id(titles, fromLang), lang, fromLang);
    const langs = [fromLang].concat(tolangs)
    const a = xy2yx([titles].concat(await thenMap(tolangs, func)));
    return a.map(t => { const q = {}; langs.forEach((lang, i) => q[lang] = t[i]); return q; })
}
////------------------------------------------------------------------------------------------------------------------------
async function extract(id, lang = "ja") {
    var idb = wikiExtract[lang] = wikiExtract[lang] || (await Cache(["wikiExtract", lang].join("/")));
    var v = await idb(id); if (v) return v;
    const func = { action: "query", pageids: id, prop: "extracts", exintro: true/*,explaintext:true*/ }
    v = await fetchJSON(wikiAPI(func, lang));
    if (!(v && v.query)) return console.error("wiki-api:failed:", v);
    v = paser.parseFromString(v.query.pages[id].extract, "text/html");
    [...v.querySelectorAll("body sup[class]")].forEach(t => t.remove());
    v = clean([...v.querySelectorAll("body >p")].map(t => t.innerText).join(""));
    await idb(id, v); return v;
}
////------------------------------------------------------------------------------------------------------------------------
async function get(title, lang = "ja") {
    const func = isNumber(title) ? { action: "parse", prop: "text", pageid: title } :
        { action: "parse", prop: "text", page: encodeURIComponent(title), redirects: true };
    const v = await fetchJSON(wikiAPI(func, lang));
    return (v && v.parse && v.parse.text) ? v.parse.text["*"] : null;
};
export async function getContent(id, lang = "ja") {
    var idb = wikiDB[lang] = wikiDB[lang] || (await Cache(["wikiDB", lang].join("/")));
    var v = await idb(id); if (v) return paser.parseFromString(v, "text/html");
    v = await get(id); if (!v) return console.error("fail to get data: ", id, lang)
    await idb(id, v);
    return getContent(id, lang);
}
////------------------------------------------------------------------------------------------------------------------------
export async function id2qid(id, lang = "ja") {
    return isArray(id) ?
        (await thenMap(slice(id, divide_length), t => conv(t))).flat() :
        (await conv([id]))[0];
    async function conv(id) {
        console.log(`- wiki-api(id=>qid, lang=${lang}): ${id.join("|")}`);
        const v = await fetchJSON(wikiAPI({ action: "query", prop: "pageprops", pageids: id.join("|") }, lang));
        if (!(v && v.query)) return console.error("wiki-api:failed:", v);
        return id.map(id => (v.query.pages[id].pageprops || {}).wikibase_item);
    }
}
export async function title2qid(title, lang = "ja") {
    return isArray(title) ?
        (await thenMap(slice(title, divide_length), t => conv(t))).flat() :
        Object.values(await conv([title]))[0];
    async function conv(title) {
        console.log(`- wiki-api(title=>qid, lang=${lang}): ${title.join("|")}`);
        const v = await fetchJSON(wikiAPI({ action: "query", prop: "pageprops", titles: title.map(encodeURIComponent).join("|"), redirects: true }, lang));
        if (!(v && v.query)) return console.error("wiki-api:failed:", v)
        const q = {}; Object.values(v.query.pages || {}).forEach(t => q[t.title] = (t.pageprops || {}).wikibase_item);
        const r = {}; Object.values(v.query.redirects || {}).forEach(t => r[t.from] = t.to);
        const p = title.map(t => q[r[t] || t] || 0);
        title.forEach((t, i) => p[i] || console.log("failed: couldn't find pageid...", t));
        return p;
    }
}
export async function qid2titles(qid, flag = false) {
    const v = await bucket.fetchURL(`https://www.wikidata.org/wiki/${qid}`);
    const langs = ["en", "de", "es", "fr", "pt", "ru", "zh", "ar", "bn", "el", "hi", "hu", "id", "it", "ja", "ko", "nl", "pl", "sv", "tr", "vi", "fa", "he", "uk", "ur", "zht"];
    const a = [...v.querySelectorAll("a:not(.external)")], q = {};
    a.forEach(t => {
        var r = t.href.match(/^https\:\/\/([a-z]+)\.wikipedia\.org\/wiki\//);
        if (r && langs.includes(r[1])) q[r[1]] = flag ? t.title : clean(t.title);
    });
    console.log(qid, "=>", Object.keys(q).length, q);
    return q;
}
////------------------------------------------------------------------------------------------------------------------------
export async function openWikipediaByQID(qid, lang) {
    const v = await bucket.fetchURL(`https://www.wikidata.org/wiki/${qid}`);
    const a = [...v.querySelectorAll("a:not(.external)")];
    const wiki = _ => `^https://${_}.wikipedia.org/wiki/`;
    const url = a.filter(t => t.href.match(wiki(lang))).map(t => t.href)[0]
        || a.filter(t => t.href.match(wiki("en"))).map(t => t.href)[0];
    url && open(url, "_wiki_");
}
////------------------------------------------------------------------------------------------------------------------------
export async function title2coords(title, lang = "ja") {
    if (!(lang == "ja" || lang == "en")) return console.error(`This function accepts only 'ja' or 'en'.`);
    return isArray(title) ?
        (await thenMap(slice(title, 10), t => conv(t))).flat() :
        Object.values(await conv([title]))[0];
    async function conv(title) { return id2coords(await title2id(title, lang), lang); }
}
export async function id2coords(id, lang = "ja") {
    if (!(lang == "ja" || lang == "en")) return console.error(`This function accepts only 'ja' or 'en'.`);
    return isArray(id) ?
        (await thenMap(slice(id, 10), t => conv(t))).flat() :
        (await conv([id]))[0];
    async function conv(ids) {
        console.log(`- wiki-api(id=>coords, lang=${lang}): ${ids.join("|")}`);
        var v = await fetchJSON(wikiAPI({ action: "query", prop: "coordinates", pageids: ids.join("|") }, lang));
        if (!(v && v.query)) return console.error("wiki-api:failed:", v);
        return thenMap(ids, async id => {
            const q = v.query.pages[id].coordinates;
            if (!isArray(q)) {
                var coords = await getCoords(id, lang);
                if (!coords) {
                    const xlang = lang == "ja" ? "en" : "ja";
                    const xid = (await langLinksById([id], xlang, lang))[0][xlang];
                    coords = await getCoords(xid, xlang);
                }
                coords || console.warn(v.query.pages[id]);
                return coords;
            }
            return [q[0].lon, q[0].lat];
        });
    }
}
export async function getCoords(id, lang) {
    function pos(s) {
        let r;
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
    html = paser.parseFromString(html, "text/html");
    var info = html.querySelector(".infobox"); if (!info) return null;
    var [lng, lat] = [info.querySelector(".longitude"), info.querySelector(".latitude")];
    if (!lng || !lat) return null;
    var coords = [pos(lng.innerText), pos(lat.innerText)];
    console.log(lng.innerText, lat.innerText, coords);
    return coords;
}
