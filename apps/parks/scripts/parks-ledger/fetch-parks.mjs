// 国立公園の台帳を Wikidata/Commons から組む（ビルド時の一回物）
const UA = { "User-Agent": "ortho-earth-parks/0.1 (kenji.yoshida.home.2026@gmail.com)", "Accept": "application/json" };
const LANGS = ["ja","en","zh","ko","fr","de","es","pt","it","nl","pl","ru","uk","hu","sv","tr","el","id","vi","th","bn","hi","ar","fa","ur","he"];
const sparql = async q => (await (await fetch("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q), { headers: { ...UA, Accept: "application/sparql-results+json" } })).json()).results.bindings;
const rows = await sparql(`SELECT ?p ?inc ?area ?areaUnit ?coord ?site WHERE { ?p wdt:P31 wd:Q1071482 . OPTIONAL{?p wdt:P571 ?inc} OPTIONAL{?p p:P2046/psv:P2046 [wikibase:quantityAmount ?area; wikibase:quantityUnit ?areaUnit]} OPTIONAL{?p wdt:P625 ?coord} OPTIONAL{?p wdt:P856 ?site} }`);
const parks = {};
for (const r of rows) { const id = r.p.value.split("/").pop(); parks[id] ??= { qid: id }; const p = parks[id];
  if (r.inc) p.designated = r.inc.value.slice(0, 10); if (r.area) { p.area = +r.area.value; p.areaUnit = r.areaUnit.value.split("/").pop(); }
  if (r.coord) { const m = r.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/); p.coord = [+m[1], +m[2]]; } if (r.site) p.site = r.site.value; }
const ids = Object.keys(parks); console.error("parks", ids.length);
// 都道府県（P131）＝ja/en ラベル
const pref = await sparql(`SELECT ?p ?a ?aja ?aen WHERE { VALUES ?p { ${ids.map(i => "wd:" + i).join(" ")} } ?p wdt:P131 ?a . ?a rdfs:label ?aja FILTER(lang(?aja)="ja") ?a rdfs:label ?aen FILTER(lang(?aen)="en") }`);
for (const r of pref) { const p = parks[r.p.value.split("/").pop()]; (p.prefs ??= []).push({ qid: r.a.value.split("/").pop(), ja: r.aja.value, en: r.aen.value }); }
// エンティティ本体（labels・sitelinks・P18）
const ents = {};
for (let i = 0; i < ids.length; i += 20) {
  const j = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.slice(i, i + 20).join("|")}&props=labels|sitelinks|claims&languages=${LANGS.join("|")}&format=json`, { headers: UA })).json();
  Object.assign(ents, j.entities);
}
for (const id of ids) { const e = ents[id], p = parks[id];
  p.name = {}; for (const l of LANGS) if (e.labels?.[l]) p.name[l] = e.labels[l].value;
  p.wiki = {}; for (const l of LANGS) { const s = e.sitelinks?.[l + "wiki"]; if (s) p.wiki[l] = s.title; }
  p.image = e.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? null;
}
// Commons：写真の URL と作者・ライセンス
const files = ids.map(i => parks[i].image).filter(Boolean);
for (let i = 0; i < files.length; i += 10) {
  const titles = files.slice(i, i + 10).map(f => "File:" + f).join("|");
  const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1280&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl|Credit&titles=${encodeURIComponent(titles)}&format=json`, { headers: UA })).json();
  for (const pg of Object.values(j.query.pages)) { const ii = pg.imageinfo?.[0]; if (!ii) continue; const f = pg.title.replace(/^File:/, "");
    const em = ii.extmetadata || {}, strip = s => (s || "").replace(/<[^>]+>/g, "").trim();
    for (const id of ids) if (parks[id].image?.replace(/_/g, " ") === f.replace(/_/g, " ")) parks[id].photo = { file: f, thumb: ii.thumburl, page: ii.descriptionurl, w: ii.width, h: ii.height, artist: strip(em.Artist?.value), license: strip(em.LicenseShortName?.value), licenseUrl: em.LicenseUrl?.value }; }
}
console.log(JSON.stringify(Object.values(parks).sort((a, b) => a.name.ja.localeCompare(b.name.ja, "ja")), null, 1));
