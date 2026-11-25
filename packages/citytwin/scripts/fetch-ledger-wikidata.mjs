#!/usr/bin/env node
// 全国の市区町村の台帳に、Wikidata の物（Wikipedia の記事名 ja／en・英語の名・公式サイト・Wikidata の id）を足す下ごしらえ
// → packages/citytwin/ledger/wikidata.json（git で追う）。build-ledger.mjs がこれを読んで列にする。
// Wikidata はクラウドから届かない＝手元の Mac で：node packages/citytwin/scripts/fetch-ledger-wikidata.mjs
// 鍵＝P429（全国地方公共団体コード・6 桁）の頭 5 桁。廃止された団体（P576 のある物）は採らない。
// 許諾：Wikidata は CC0。記事名は Wikipedia の題名（事実）だけを写す。
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(HERE, "../ledger/wikidata.json");
const Q = `SELECT ?item ?code ?enLabel ?jaTitle ?enTitle ?site WHERE {
  ?item wdt:P429 ?code .
  FILTER NOT EXISTS { ?item wdt:P576 ?end }
  OPTIONAL { ?item rdfs:label ?enLabel FILTER(LANG(?enLabel) = "en") }
  OPTIONAL { ?ja schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?jaTitle }
  OPTIONAL { ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enTitle }
  OPTIONAL { ?item wdt:P856 ?site }
}`;
const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(Q), { headers: { "User-Agent": "ortho-earth-ledger/1.0 (https://github.com/kenjiyoshidahome2026-bit/ortho-earth)", Accept: "application/sparql-results+json" } });
if (!r.ok) throw new Error(`Wikidata: HTTP ${r.status}`);
const rows = (await r.json()).results.bindings;
const out = {};
for (const b of rows) {
	const code = b.code.value.replace(/\D/g, "").slice(0, 5);
	if (code.length !== 5 || code.endsWith("000")) continue;   // 都道府県は採らない
	const o = out[code] ||= { qid: b.item.value.split("/").pop() };
	if (o.qid !== b.item.value.split("/").pop()) { (o.other ||= []).includes(b.item.value.split("/").pop()) || o.other.push(b.item.value.split("/").pop()); continue; }   // 同じコードに別の項目（記録だけ）
	if (b.enLabel && !o.en) o.en = b.enLabel.value;
	if (b.jaTitle && !o.wikiJa) o.wikiJa = b.jaTitle.value;
	if (b.enTitle && !o.wikiEn) o.wikiEn = b.enTitle.value;
	if (b.site) (o.site ||= []).includes(b.site.value) || o.site.push(b.site.value);
}
const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
fs.writeFileSync(OUT, JSON.stringify({ made: new Date().toISOString(), source: "Wikidata（CC0）P429", rows: sorted }, null, 0).replace(/},"/g, '},\n"'));
const v = Object.values(out);
console.log(`→ ${path.relative(process.cwd(), OUT)}：${v.length} 団体・ja 記事 ${v.filter(o => o.wikiJa).length}・en 記事 ${v.filter(o => o.wikiEn).length}・英語名 ${v.filter(o => o.en).length}・公式サイト ${v.filter(o => o.site).length}・同じコードに複数の項目 ${v.filter(o => o.other).length}`);
