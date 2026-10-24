// list.json（en 記事名）→ Wikidata（QID・名前 26 言語・Wikipedia 頁名・P18・P856・P625）→ Commons（写真 1280/640・作者・ライセンス）→ parks-raw.json。州の名前 26 言語 → states.json
import fs from "node:fs";
const [listPath, outPath, statesPath] = process.argv.slice(2);
const UA = { "User-Agent": "ortho-earth-parks/0.1 (kenji.yoshida.home.2026@gmail.com)", "Accept": "application/json" };
const LANGS = ["ja","en","zh","ko","fr","de","es","pt","it","nl","pl","ru","uk","hu","sv","tr","el","id","vi","th","bn","hi","ar","fa","ur","he"];
const getJ = async u => { for (let i = 0; i < 4; i++) { const r = await fetch(u, { headers: UA }); if (r.ok) return r.json(); console.error("retry", r.status, u.slice(0, 80)); await new Promise(s => setTimeout(s, 3000 * (i + 1))); } throw new Error("fetch failed " + u); };
const list = JSON.parse(fs.readFileSync(listPath, "utf8"));
// 1) 記事名 → QID（sites=enwiki）
const byTitle = {};
for (let i = 0; i < list.length; i += 20) {
	const j = await getJ(`https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(list.slice(i, i + 20).map(x => x.title).join("|"))}&props=info|sitelinks&format=json`);
	for (const e of Object.values(j.entities)) { const t = e.sitelinks?.enwiki?.title; if (t && e.id) byTitle[t] = e.id; }
}
const miss = list.filter(x => !byTitle[x.title]); if (miss.length) console.error("no QID:", miss.map(x => x.title));
// 2) 本体（labels・sitelinks・claims）
const ids = list.map(x => byTitle[x.title]).filter(Boolean), ents = {};
for (let i = 0; i < ids.length; i += 20) Object.assign(ents, (await getJ(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.slice(i, i + 20).join("|")}&props=labels|sitelinks|claims&languages=${LANGS.join("|")}&format=json`)).entities);
const claim = (e, p) => e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value;
const parks = list.map(x => { const qid = byTitle[x.title], e = ents[qid] || {}; const p = { ...x, qid, name: {}, wiki: {} };
	for (const l of LANGS) { if (e.labels?.[l]) p.name[l] = e.labels[l].value; const s = e.sitelinks?.[l + "wiki"]; if (s) p.wiki[l] = s.title; }
	p.p18 = claim(e, "P18") ?? null; p.site = claim(e, "P856") ?? null; const c = claim(e, "P625"); if (c) p.wdCoord = [c.longitude, c.latitude];
	return p; });
// 3) Commons：写真（P18 を優先・無ければ一覧の写真）＝1280 と 640（API に作らせた幅だけが配信される）・作者・ライセンス
const strip = s => (s || "").replace(/<[^>]+>/g, "").trim();
const files = [...new Set(parks.map(p => (p.p18 || p.image || "").replace(/_/g, " ")).filter(Boolean))], info = {};
for (const w of [1280, 640]) for (let i = 0; i < files.length; i += 10) {
	const j = await getJ(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=${w}&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl|Credit&titles=${encodeURIComponent(files.slice(i, i + 10).map(f => "File:" + f).join("|"))}&format=json`);
	const norm = j.query.normalized || [];
	for (const pg of Object.values(j.query.pages)) { const ii = pg.imageinfo?.[0]; if (!ii) continue; const title = pg.title.replace(/^File:/, "");
		const orig = norm.find(n => n.to === pg.title)?.from.replace(/^File:/, "") ?? title;
		const em = ii.extmetadata || {}, o = info[orig] ??= { file: title, page: ii.descriptionurl, w: ii.width, h: ii.height, artist: strip(em.Artist?.value), license: strip(em.LicenseShortName?.value), licenseUrl: em.LicenseUrl?.value };
		o[w === 1280 ? "src" : "thumb"] = ii.thumburl?.split("?")[0]; }
}
for (const p of parks) { const f = (p.p18 || p.image || "").replace(/_/g, " "); const i = info[f] || info[f.replace(/ /g, "_")]; p.photo = i ? { ...i } : null; if (!i) console.error("no photo", p.title, f); }
// 4) 州（一覧の Location の記事名）→ QID → 名前 26 言語・ISO 3166-2
const stTitles = [...new Set(parks.flatMap(p => p.states))], stQ = {};
for (let i = 0; i < stTitles.length; i += 20) { const j = await getJ(`https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(stTitles.slice(i, i + 20).join("|"))}&props=info|sitelinks|labels|claims&languages=${LANGS.join("|")}&format=json`);
	for (const e of Object.values(j.entities)) { const t = e.sitelinks?.enwiki?.title; if (!t) continue; const iso = claim(e, "P300") || ""; const code = iso.replace(/^US-/, "") || e.id;
		stQ[t] = code; stQ["#" + code] = { qid: e.id, name: Object.fromEntries(LANGS.filter(l => e.labels?.[l]).map(l => [l, e.labels[l].value])) }; } }
const states = {}; for (const t of stTitles) { const c = stQ[t]; if (!c) { console.error("no state", t); continue; } states[c] = stQ["#" + c]; }
for (const p of parks) p.stateCodes = p.states.map(t => stQ[t]).filter(Boolean);
fs.writeFileSync(outPath, JSON.stringify(parks, null, 1)); fs.writeFileSync(statesPath, JSON.stringify(states, null, 1));
console.log(parks.length, "parks;", Object.keys(states).length, "states; no photo:", parks.filter(p => !p.photo?.src).length, "; no ja name:", parks.filter(p => !p.name.ja).map(p => p.title));
