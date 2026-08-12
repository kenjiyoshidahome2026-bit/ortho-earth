/**
 * Wikidata P429（全国地方公共団体コード）→ ja.wikipedia 記事タイトル対応表の焼き。
 * 同名市区町村（府中市 13206/34202・伊達市 01233/07213・池田町×4 …）を実行時推測でなく
 * 事前対応表で構造的に封じる（裁定 2026-08-12）。
 *
 * 使い方: node build-wiki-titles.mjs        → ../data/wiki-titles.json を上書き
 * キー: 都道府県=2桁（P429 が NN000C 形）/ 市区町村=5桁。値= ja.wikipedia 記事タイトル。
 * 廃止団体（P576 あり）は現行団体を優先。手動補正は ../data/wiki-titles-fixup.json（任意・上書きマージ）。
 * ⚠ JPコードのキー順は明示ソートで出力（先頭ゼロの entries 順崩れの轍）。
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '../data/wiki-titles.json');
const FIXUP = join(__dir, '../data/wiki-titles-fixup.json');

const SPARQL = `
SELECT ?code ?title ?dissolved WHERE {
  ?item wdt:P429 ?code .
  ?article schema:about ?item ;
           schema:isPartOf <https://ja.wikipedia.org/> ;
           schema:name ?title .
  OPTIONAL { ?item wdt:P576 ?dissolved . }
}`;

const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(SPARQL), {
	headers: { 'User-Agent': 'ortho-earth census2020 bake (kenji.yoshida.home.2026@gmail.com)', 'Accept': 'application/sparql-results+json' },
});
if (!res.ok) { console.error(`SPARQL HTTP ${res.status}`); process.exit(1); }
const rows = (await res.json()).results.bindings;
console.log(`SPARQL: ${rows.length} 行`);

// code6 → キー（NN000C=都道府県→2桁 / それ以外→5桁）。現行（dissolved 無し）優先で1件に畳む
const best = new Map();   // key → { title, dissolved }
for (const r of rows) {
	const code6 = r.code.value.trim();
	if (!/^\d{6}$/.test(code6)) continue;
	const key = code6.slice(2, 5) === '000' ? code6.slice(0, 2) : code6.slice(0, 5);
	const cur = { title: r.title.value, dissolved: !!r.dissolved };
	const prev = best.get(key);
	if (!prev || (prev.dissolved && !cur.dissolved)) best.set(key, cur);
}
const out = {};
for (const key of [...best.keys()].sort()) out[key] = best.get(key).title;   // 明示ソート（JPコードkey順の掟）
if (existsSync(FIXUP)) Object.assign(out, JSON.parse(readFileSync(FIXUP)));

writeFileSync(OUT, JSON.stringify(out, null, '\t') + '\n');
const n5 = Object.keys(out).filter(k => k.length === 5).length, n2 = Object.keys(out).filter(k => k.length === 2).length;
console.log(`✅ ${OUT}: 都道府県 ${n2} + 市区町村 ${n5} 件`);
// 検証の定点（同名対）: 府中市・伊達市・池田町4兄弟
for (const k of ['13206', '34208', '01233', '07213', '01644', '18382', '20481', '21404'])
	console.log(`  ${k} → ${out[k] ?? '（欠落）'}`);
