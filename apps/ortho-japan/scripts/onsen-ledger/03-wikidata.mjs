// 3) Wikidata で補完する
//    a. 記事に結びついた QID の P625（座標）・P131（所在する行政区画）・P18（画像）・ラベル(ja/en)
//    b. SPARQL: 日本にある「温泉」(Q177380 とその下位クラス) の項目を集め、記事の無いものも候補として残す
//    出力: wikidata.json = { QID: { coord, pref, muni, labelJa, labelEn, image, jawiki, enwiki, sparql:true|false } }
import { getJSON, sparql, readJSON, writeJSON, WD_API, PREF_RE } from "./lib.mjs";

const articles = readJSON("articles.json");
const wd = {};
// b. SPARQL（P17=日本 Q17。P31/P279* で温泉の下位クラスも拾う）
const rows = await sparql(`SELECT ?x ?xLabel ?coord ?adm ?ja ?en WHERE {
  ?x wdt:P31/wdt:P279* wd:Q177380 ; wdt:P17 wd:Q17 .
  OPTIONAL { ?x wdt:P625 ?coord }
  OPTIONAL { ?x wdt:P131 ?adm }
  OPTIONAL { ?ja schema:about ?x ; schema:isPartOf <https://ja.wikipedia.org/> }
  OPTIONAL { ?en schema:about ?x ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en" }
}`);
const point = v => { const m = v?.match(/Point\(([-\d.]+) ([-\d.]+)\)/); return m ? [+m[1], +m[2]] : null; };
const title = u => u ? decodeURIComponent(u.split("/wiki/")[1]).replace(/_/g, " ") : undefined;
for (const r of rows) { const id = r.x.value.split("/").pop(); const e = wd[id] ??= { qid: id, sparql: true }; e.labelJa ??= r.xLabel?.value; if (r.coord) e.coord ??= point(r.coord.value); if (r.ja) e.jawiki = title(r.ja.value); if (r.en) e.enwiki = title(r.en.value); if (r.adm) (e.p131 ??= []).push(r.adm.value.split("/").pop()); }
console.error("sparql items", rows.length, "distinct", Object.keys(wd).length);

// a. 記事側の QID をまとめて取る（50 件ずつ）
const ids = [...new Set(articles.map(a => a.qid).filter(Boolean))];
for (let i = 0; i < ids.length; i += 50) {
  const j = await getJSON(`${WD_API}?action=wbgetentities&ids=${ids.slice(i, i + 50).join("|")}&props=labels|sitelinks|claims&languages=ja|en&format=json`, { tag: "wd" });
  for (const [id, e] of Object.entries(j.entities || {})) {
    if (e.missing) continue;
    const o = wd[id] ??= { qid: id, sparql: false };
    o.labelJa = e.labels?.ja?.value ?? o.labelJa; o.labelEn = e.labels?.en?.value;
    o.jawiki = e.sitelinks?.jawiki?.title ?? o.jawiki; o.enwiki = e.sitelinks?.enwiki?.title ?? o.enwiki;
    const c = e.claims?.P625?.find(s => s.rank !== "deprecated")?.mainsnak?.datavalue?.value; if (c) o.coord = [+c.longitude.toFixed(6), +c.latitude.toFixed(6)];
    o.image = e.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    o.p131 = [...new Set([...(o.p131 || []), ...(e.claims?.P131 || []).map(s => s.mainsnak?.datavalue?.value?.id).filter(Boolean)])];
    o.p361 = (e.claims?.P361 || []).map(s => s.mainsnak?.datavalue?.value?.id).filter(Boolean); // 「〜の一部」= 所属する温泉郷など
    o.p527 = (e.claims?.P527 || []).map(s => s.mainsnak?.datavalue?.value?.id).filter(Boolean); // 「構成要素」= 配下の温泉
    o.p31 = (e.claims?.P31 || []).map(s => s.mainsnak?.datavalue?.value?.id).filter(Boolean);
  }
  console.error(`wd ${Math.min(i + 50, ids.length)}/${ids.length}`);
}
// 行政区画のラベル（P131 → ja ラベル、都道府県まで上る）
const adm = [...new Set(Object.values(wd).flatMap(o => o.p131 || []))];
const admLabel = {};
for (let i = 0; i < adm.length; i += 200) {
  const vals = adm.slice(i, i + 200).map(q => "wd:" + q).join(" ");
  for (const r of await sparql(`SELECT ?a ?aja ?pref ?prefja WHERE { VALUES ?a { ${vals} } ?a rdfs:label ?aja FILTER(lang(?aja)="ja") OPTIONAL { ?a wdt:P131* ?pref . ?pref wdt:P31 wd:Q50337 ; rdfs:label ?prefja FILTER(lang(?prefja)="ja") } }`, "sparql-adm"))
    admLabel[r.a.value.split("/").pop()] = { ja: r.aja.value, pref: r.prefja?.value };
}
for (const o of Object.values(wd)) { const a = (o.p131 || []).map(q => admLabel[q]).filter(Boolean)[0]; if (a) { o.muni = PREF_RE.test(a.ja) ? undefined : a.ja; o.pref = a.pref || (a.ja.match(PREF_RE) || [])[1]; } }
writeJSON("wikidata.json", wd);
