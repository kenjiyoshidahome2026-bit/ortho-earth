#!/usr/bin/env node
// 台帳を組む＝種（seed）× 結び（.cache/match.json）× Wikidata の中身（.cache/entities.json）→
//   public/terrain.json               … items[]（qid・category・rank・name{ja,en}・wiki{ja,en}・coord・物理量・kana）＝起動時に読む
//   public/terrain-i18n/<lang>.json   … { qid: [名前, 記事名] }（ja/en 以外の 24 言語・言語を選んだ時だけ読む）
// 決め事（world の TerrainDB と同じ）: 日本語版 Wikipedia の記事が無い物は入れない（名前と記事が揃う＝「地図で選んで読める」が最低線）。
//   同じ QID に複数の種が結ばれた時（日本海溝 z6/z8・立山 311/314）は小さい rank を取る。位置＝Wikidata の P625。
//   海域・海底・列島（名前だけで結んだ分類）は P625 が海域の中心や遠い代表点＝地理院の注記の位置を使う。面の地形（山地・平野・盆地・高原）も
//   注記の位置が 150 km より離れていれば注記の方（地理院が名前を置く場所＝地図帳の位置）。
import fs from "node:fs";
import path from "node:path";
import { DIR, CACHE, readSeed, kmOf } from "./lib.mjs";
import { LANGS } from "./wikidata-fetch.mjs";
const PUB = path.join(DIR, "../../public");
const seed = readSeed(), match = JSON.parse(fs.readFileSync(path.join(CACHE, "match.json"), "utf8")), ents = JSON.parse(fs.readFileSync(path.join(CACHE, "entities.json"), "utf8"));
const VOLCANO = new Set(JSON.parse(fs.readFileSync(path.join(CACHE, "volcano-classes.json"), "utf8")));
const BY_NAME = new Set(["sea", "strait", "trench", "ridge", "seamount", "islands", "reef", "current", "plate", "fault"]);
const AREAL = new Set(["range", "plain", "basin", "plateau", "hills", "peninsula", "wetland", "beach", "bay"]);
// 単位（Wikidata の単位 QID → 台帳の単位へ）
const UNIT = { elevation: { Q11573: 1, Q3710: 0.3048, Q828224: 1000 }, prominence: { Q11573: 1, Q3710: 0.3048 }, height: { Q11573: 1, Q3710: 0.3048 }, depth: { Q11573: 1, Q3710: 0.3048 },
	length: { Q828224: 1, Q11573: 0.001, Q253276: 1.609344 }, area: { Q712226: 1, Q25343: 1e-6, Q35852: 0.01, Q232291: 2.589988 }, basin: { Q712226: 1, Q25343: 1e-6, Q35852: 0.01, Q232291: 2.589988 },
	volume: { Q4243638: 1, Q25517: 1e-9, Q1056044: 1e-3 }, discharge: { Q794261: 1 } };   // Q1056044＝hm³（百万 m³）
const quantity = (e, k) => { const vs = e.q?.[k]; if (!vs?.length) return null; const use = vs.some(v => v.pref) ? vs.filter(v => v.pref) : vs; for (const v of use) { const f = UNIT[k][v.u]; if (f != null) return +(v.v * f).toFixed(f === 1 ? 1 : 2); } return null; };

const items = new Map(), drop = { nowiki: [], noent: [] };
for (const s of seed) {
	const m = match[s.key]; if (!m) continue; const e = ents[m.qid]; if (!e) { drop.noent.push(s.key); continue; }
	if (!e.wiki.ja) { drop.nowiki.push(s.key + " " + m.qid); continue; }
	const prev = items.get(m.qid);
	if (prev) { if (s.rank < prev.rank) { prev.rank = s.rank; } if (s.kana && !prev.kana) prev.kana = s.kana; continue; }
	let cat = s.cat; if (cat === "peak" && e.cls.some(c => VOLCANO.has(c))) cat = "volcano";
	const annoPos = [s.lon, s.lat], wd = e.coord;
	const coord = BY_NAME.has(cat) || !wd ? annoPos : (AREAL.has(cat) && kmOf(wd, annoPos) > 150) ? annoPos : wd;
	const it = { qid: m.qid, category: cat, rank: s.rank, name: { ja: e.labels.ja || s.name, en: e.labels.en || (e.wiki.en || "").replace(/ \(.*\)$/, "") || undefined }, wiki: { ja: e.wiki.ja, en: e.wiki.en || undefined },
		coord: [+coord[0].toFixed(4), +coord[1].toFixed(4)], kana: s.kana || undefined, src: s.src === "manual" ? "manual" : undefined };
	for (const k of Object.keys(UNIT)) { const v = quantity(e, k); if (v != null) it[k] = v; }
	if (it.name.en === undefined) delete it.name.en; if (it.wiki.en === undefined) delete it.wiki.en;
	items.set(m.qid, it);
}
// 分類名（26 言語）＝world の i18n/ui.json の categories（Wikidata のクラスのラベル）＋この台帳だけの分類（海山・丘陵・砂丘・浜・断層・洞窟＝.cache/class-labels.json・SPARQL で一度だけ取る）
const worldCats = JSON.parse(fs.readFileSync(path.join(DIR, "../../../../packages/world/i18n/ui.json"), "utf8")).categories;
const EXTRA = { seamount: "Q503269", hills: "Q54050", dune: "Q25391", beach: "Q40080", fault: "Q47089", cave: "Q35509" };
const clsFile = path.join(CACHE, "class-labels.json");
if (!fs.existsSync(clsFile)) {
	const q = `SELECT ?x ?l WHERE { VALUES ?x { ${Object.values(EXTRA).map(q => "wd:" + q).join(" ")} } ?x rdfs:label ?l FILTER(lang(?l) IN (${LANGS.map(l => `"${l}"`).join(",")})) }`;
	const r = await fetch("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q), { headers: { "User-Agent": "ortho-earth-terrain/0.1 (kenji.yoshida.home.2026@gmail.com)", Accept: "application/sparql-results+json" } });
	const out = {}; for (const b of (await r.json()).results.bindings) (out[b.x.value.split("/").pop()] ??= {})[b.l["xml:lang"]] = b.l.value;
	fs.writeFileSync(clsFile, JSON.stringify(out, null, 1));
}
const extraLabels = JSON.parse(fs.readFileSync(clsFile, "utf8"));
const catNames = {}; for (const [c, v] of Object.entries(worldCats)) { const { qid, ...names } = v; catNames[c] = names; }
for (const [c, q] of Object.entries(EXTRA)) catNames[c] = extraLabels[q] || { en: c };
const list = [...items.values()].sort((a, b) => a.rank - b.rank || a.category.localeCompare(b.category) || a.name.ja.localeCompare(b.name.ja, "ja"));
const cnt = {}; for (const it of list) cnt[it.category] = (cnt[it.category] || 0) + 1;
fs.mkdirSync(path.join(PUB, "terrain-i18n"), { recursive: true });
fs.writeFileSync(path.join(PUB, "terrain.json"), JSON.stringify({ _: "日本の地形の台帳（scripts/terrain-ledger が組む・手で編集しない）。名前と記事＝Wikidata/Wikipedia（CC BY-SA）・選抜＝地理院ベクトルタイルの注記（z4〜9）＋手動層・物理量＝Wikidata", built: new Date().toISOString().slice(0, 10), categories: cnt, catNames: Object.fromEntries(Object.keys(cnt).map(c => [c, catNames[c] || { en: c }])), items: list }, null, 0));
for (const l of LANGS) { if (l === "ja" || l === "en") continue; const t = {};
	for (const it of list) { const e = ents[it.qid]; const n = e.labels[l], w = e.wiki[l]; if (n || w) t[it.qid] = [n || "", w || ""]; }
	fs.writeFileSync(path.join(PUB, "terrain-i18n", l + ".json"), JSON.stringify(t)); }
fs.writeFileSync(path.join(CACHE, "dropped.json"), JSON.stringify(drop, null, 1));
console.log(list.length, "件", JSON.stringify(cnt)); console.log("落とした: 記事なし", drop.nowiki.length, "項目なし", drop.noent.length);
