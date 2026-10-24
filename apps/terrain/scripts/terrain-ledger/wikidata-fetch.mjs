#!/usr/bin/env node
// 結んだ QID（.cache/match.json）の中身を Wikidata から取る（SPARQL・100 件束）→ .cache/entities.json
//   名前＝rdfs:label 26 言語・記事＝各言語の Wikipedia の sitelink・位置＝P625・分類＝P31・物理量＝標高 P2044／プロミネンス P2660／長さ P2043／面積 P2046／
//   流域面積 P2053／深さ P4511／落差 P2048／流量 P2225／体積 P2234（単位は QID のまま持ち、ledger-build で換算）
import fs from "node:fs";
import path from "node:path";
import { CACHE } from "./lib.mjs";
export const LANGS = ["ja", "en", "zh", "ko", "fr", "de", "es", "pt", "it", "nl", "pl", "ru", "uk", "hu", "sv", "tr", "el", "id", "vi", "th", "bn", "hi", "ar", "fa", "ur", "he"];
const UA = { "User-Agent": "ortho-earth-terrain/0.1 (kenji.yoshida.home.2026@gmail.com)", Accept: "application/sparql-results+json" };
const sparql = async q => { for (let k = 0; k < 5; k++) { const r = await fetch("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q), { headers: UA }); if (r.ok) return (await r.json()).results.bindings; await new Promise(s => setTimeout(s, 3000 * (k + 1))); } throw new Error("sparql failed"); };
const match = JSON.parse(fs.readFileSync(path.join(CACHE, "match.json"), "utf8"));
const qids = [...new Set(Object.values(match).map(m => m.qid))];
const file = path.join(CACHE, "entities.json"), ents = fs.existsSync(file) && !process.argv.includes("--fresh") ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const todo = qids.filter(q => !ents[q]); console.error("QID", qids.length, "取得", todo.length);
const QUANT = { P2044: "elevation", P2660: "prominence", P2043: "length", P2046: "area", P2053: "basin", P4511: "depth", P2048: "height", P2225: "discharge", P2234: "volume" };
for (let i = 0; i < todo.length; i += 100) {
	const ids = todo.slice(i, i + 100), V = ids.map(q => "wd:" + q).join(" ");
	for (const q of ids) ents[q] = { labels: {}, wiki: {}, coord: null, cls: [], q: {} };
	// 名前と記事（言語ごと）
	const rows1 = await sparql(`SELECT ?x ?l ?a WHERE { VALUES ?x { ${V} } { ?x rdfs:label ?l FILTER(lang(?l) IN (${LANGS.map(l => `"${l}"`).join(",")})) } UNION { ?a schema:about ?x; schema:isPartOf ?site . FILTER(STRSTARTS(STR(?site), "https://") && STRENDS(STR(?site), ".wikipedia.org/")) } }`);
	for (const r of rows1) { const e = ents[r.x.value.split("/").pop()];
		if (r.l) e.labels[r.l["xml:lang"]] = r.l.value;
		if (r.a) { const m = r.a.value.match(/^https:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/); if (m && LANGS.includes(m[1])) e.wiki[m[1]] = decodeURIComponent(m[2]).replace(/_/g, " "); } }
	// 位置・分類・物理量（量は値と単位・順位＝preferred を優先するため wikibase:rank も取る）
	const rows2 = await sparql(`SELECT ?x ?c ?cls ?p ?v ?u ?rank WHERE { VALUES ?x { ${V} } { ?x wdt:P625 ?c } UNION { ?x wdt:P31 ?cls } UNION { VALUES ?p { ${Object.keys(QUANT).map(p => "p:" + p).join(" ")} } ?x ?p ?st . ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) ?st ?psv ?node . ?node wikibase:quantityAmount ?v . OPTIONAL { ?node wikibase:quantityUnit ?u } FILTER(STRSTARTS(STR(?psv), "http://www.wikidata.org/prop/statement/value/")) } }`);
	for (const r of rows2) { const e = ents[r.x.value.split("/").pop()];
		if (r.c && !e.coord) { const m = r.c.value.match(/Point\(([-\d.e]+) ([-\d.e]+)\)/); if (m) e.coord = [+m[1], +m[2]]; }
		if (r.cls) { const c = r.cls.value.split("/").pop(); if (!e.cls.includes(c)) e.cls.push(c); }
		if (r.p) { const k = QUANT[r.p.value.split("/").pop()], pref = r.rank.value.endsWith("PreferredRank"); (e.q[k] ??= []).push({ v: +r.v.value, u: r.u ? r.u.value.split("/").pop() : "1", pref }); } }
	fs.writeFileSync(file, JSON.stringify(ents));
	console.error(`取得 ${Math.min(i + 100, todo.length)}/${todo.length}`); await new Promise(s => setTimeout(s, 1000));
}
console.error("done", Object.keys(ents).length);
