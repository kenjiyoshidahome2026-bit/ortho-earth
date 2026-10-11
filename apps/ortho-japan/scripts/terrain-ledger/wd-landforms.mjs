// 日本の地形項目（landform Q271669 の下位クラスのインスタンス・P17=日本・座標あり）を Wikidata から一括取得 → wd-landforms.json
const UA = { "User-Agent": "ortho-earth-terrain/0.1 (kenji.yoshida.home.2026@gmail.com)", Accept: "application/sparql-results+json" };
const sparql = async q => { const r = await fetch("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q), { headers: UA }); if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 300)); return (await r.json()).results.bindings; };
const ROOTS = { Q8502: "peak", Q8072: "volcano", Q46831: "range", Q23397: "lake", Q4022: "river", Q34763: "peninsula", Q185113: "cape", Q23442: "island", Q33837: "islands", Q39594: "bay", Q37901: "strait", Q165: "sea", Q160091: "plain", Q3634830: "basin", Q75520: "plateau", Q54050: "hills", Q133056: "pass", Q34038: "waterfall", Q119253: "trench", Q40080: "beach", Q25391: "dune", Q1322134: "gulf", Q131681: "reservoir", Q355304: "watercourse", Q12284: "canal", Q27590: "swamp", Q170321: "wetland", Q1176098: "lagoon", Q170127: "ridge", Q27019: "tableland", Q16917: "hill", Q35509: "cave", Q5157503: "volcanic_field", Q1286653: "basin2", Q7936: "ocean trench?", Q1210950: "channel" };
const out = {};
for (const [root, cat] of Object.entries(ROOTS)) {
  const q = `SELECT DISTINCT ?x ?ja ?en ?c WHERE { ?x wdt:P31/wdt:P279* wd:${root}; wdt:P17 wd:Q17; wdt:P625 ?c . OPTIONAL { ?x rdfs:label ?ja FILTER(lang(?ja)="ja") } OPTIONAL { ?x rdfs:label ?en FILTER(lang(?en)="en") } }`;
  let rows; try { rows = await sparql(q); } catch (e) { console.error(root, cat, "FAILED", e.message); continue; }
  let n = 0;
  for (const r of rows) { const id = r.x.value.split("/").pop(); const m = r.c.value.match(/Point\(([-\d.e]+) ([-\d.e]+)\)/); if (!m) continue;
    const o = out[id] ??= { qid: id, ja: r.ja?.value, en: r.en?.value, lon: +m[1], lat: +m[2], cats: [] }; if (!o.cats.includes(cat)) o.cats.push(cat); n++; }
  console.error(root, cat, rows.length, "total", Object.keys(out).length);
  await new Promise(s => setTimeout(s, 1500));
}
await import("node:fs").then(fs => fs.writeFileSync("wd-landforms.json", JSON.stringify(Object.values(out))));
