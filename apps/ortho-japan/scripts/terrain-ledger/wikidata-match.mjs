#!/usr/bin/env node
// 種（seed/terrains-anno.csv ＋ seed/terrains-manual.json の add）を Wikidata の項目（QID）に結ぶ。
//   ① .cache/wd-landforms.json（wd-landforms.mjs＝日本の地形項目の一括取得）で日本語ラベルの一致＋最寄り
//   ② 無ければ jawiki の記事名（wbgetentities&sites=jawiki）＝海・海峡・山地など P17 の無い項目や landform 外のクラス
//   ③ 無ければ手動層の alias（"名前|code": "QID"）
//   結果 → .cache/match.json（{ key: { qid, how, dist } }）と .cache/unmatched.csv（人が alias を書く材料）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSeed, readManual, variants, kmOf } from "./lib.mjs";
const DIR = path.dirname(fileURLToPath(import.meta.url)), CACHE = path.join(DIR, ".cache");
const UA = { "User-Agent": "ortho-earth-terrain/0.1 (kenji.yoshida.home.2026@gmail.com)", Accept: "application/sparql-results+json" };
const getJson = async url => { for (let k = 0; k < 4; k++) { const r = await fetch(url, { headers: UA }); if (r.ok) return r.json(); if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 2000 * (k + 1))); continue; } throw new Error(url + " HTTP " + r.status); } throw new Error(url + " retries"); };

const seed = readSeed(), manual = readManual();
const lf = JSON.parse(fs.readFileSync(path.join(CACHE, "wd-landforms.json"), "utf8"));
const byJa = new Map(); for (const o of lf) for (const v of variants(o.ja)) (byJa.get(v) || byJa.set(v, []).get(v)).push(o);
// 分類の相性＝Wikidata 側のクラス（cats）が種の分類と矛盾しない（山の名が付いた川や集落を拾わない）
const COMPAT = { peak: ["peak", "volcano", "hill", "range"], lake: ["lake", "reservoir", "lagoon", "wetland", "bay"], river: ["river", "watercourse", "canal"], plateau: ["plateau", "hills", "plain", "wetland", "hill", "tableland", "range"], plain: ["plain", "wetland", "plateau"], basin: ["basin", "plain", "trench"], hills: ["hills", "hill", "range", "plateau"],
	pass: ["pass"], range: ["range", "peak", "volcano", "hills", "plateau"], cape: ["cape", "peninsula", "beach", "island"], sea: ["sea", "bay", "gulf", "strait"], bay: ["bay", "gulf", "sea", "strait", "lagoon", "channel"], strait: ["strait", "channel", "bay", "sea"], peninsula: ["peninsula", "cape"], beach: ["beach", "dune", "cape"], trench: ["trench"], ridge: ["ridge"], seamount: [], reef: ["reef", "island", "beach"], islands: ["islands", "island"], island: ["island", "islands", "volcano", "peak"], wetland: ["wetland", "plain"], dune: ["dune", "beach"], waterfall: ["waterfall"] };
// 名前だけで結ぶ分類（海域・海底・列島＝Wikidata の座標が海域の中心や遠い代表点）／点の地形は 30 km／島は 100 km（大きな島の中心と注記の位置の差）
const BY_NAME = new Set(["sea", "strait", "trench", "ridge", "seamount", "islands", "reef", "basin"]);
const POINTY = new Set(["peak", "pass", "cape", "waterfall", "lake", "beach", "dune"]);
const limitOf = cat => BY_NAME.has(cat) ? Infinity : POINTY.has(cat) ? 30 : cat === "island" ? 100 : cat === "river" || cat === "range" ? 250 : 150;

const match = {}, unmatched = [];
// ③ 手動層の alias（QID か jawiki の記事名）と add の qid（記事名でもよい）＝記事名は後で SPARQL で引く
const titleAlias = new Map();
for (const s of seed) { const a = manual.alias?.[s.key] ?? s.qid; if (!a) continue; if (/^Q\d+$/.test(a)) match[s.key] = { qid: a, how: s.src === "manual" ? "add" : "alias" }; else titleAlias.set(s.key, a); }
// ① ラベル一致
for (const s of seed) {
	if (match[s.key] || titleAlias.has(s.key)) continue;
	const cands = []; for (const v of variants(s.name)) for (const o of byJa.get(v) || []) if (!cands.includes(o)) cands.push(o);
	const ok = cands.filter(o => !COMPAT[s.cat] || o.cats.some(c => COMPAT[s.cat].includes(c)) || (s.cat === "seamount"));
	let best = null, bd = Infinity;
	for (const o of ok) { const d = kmOf([s.lon, s.lat], [o.lon, o.lat]); if (d < bd) { bd = d; best = o; } }
	if (best && bd <= limitOf(s.cat)) match[s.key] = { qid: best.qid, how: "label", dist: +bd.toFixed(1) };
	else unmatched.push(s);
}
console.error("ラベル一致", Object.keys(match).length, "未", unmatched.length);
// ② jawiki の記事名（名前そのもの＝「関東平野」「日本海」「奥羽山脈」）＝SPARQL（schema:about）で引く。api.php は共有 IP で 429 が出る（2026-10-06）
//    曖昧さ回避（Q4167410）と座標の遠い物は捨てる
const DISAMBIG = new Set(["Q4167410", "Q11266439", "Q13406463"]);   // 曖昧さ回避・テンプレート・一覧
const titles = new Map(); for (const s of unmatched) for (const v of variants(s.name)) (titles.get(v) || titles.set(v, []).get(v)).push(s);
for (const t of titleAlias.values()) if (!titles.has(t)) titles.set(t, []);
const tlist = [...titles.keys()], ents = {};
const lit = t => '"' + t.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"@ja';
for (let i = 0; i < tlist.length; i += 60) {
	const q = `SELECT ?t ?x ?c ?cls WHERE { VALUES ?t { ${tlist.slice(i, i + 60).map(lit).join(" ")} } ?a schema:about ?x; schema:isPartOf <https://ja.wikipedia.org/>; schema:name ?t . OPTIONAL { ?x wdt:P625 ?c } OPTIONAL { ?x wdt:P31 ?cls } }`;
	const j = await getJson("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q));
	for (const r of j.results.bindings) { const t = r.t.value, e = ents[t] ??= { id: r.x.value.split("/").pop(), cls: [], coord: null };
		if (r.cls) { const c = r.cls.value.split("/").pop(); if (!e.cls.includes(c)) e.cls.push(c); }
		if (r.c && !e.coord) { const m = r.c.value.match(/Point\(([-\d.e]+) ([-\d.e]+)\)/); if (m) e.coord = [+m[1], +m[2]]; } }
	process.stderr.write(`jawiki ${Math.min(i + 60, tlist.length)}/${tlist.length}\r`); await new Promise(s => setTimeout(s, 800));
}
const coordOf = e => e.coord, classes = e => e.cls;
const still = [];
for (const [key, t] of titleAlias) { const e = ents[t]; if (e) match[key] = { qid: e.id, how: "alias" }; else { console.error("alias の記事が見つからない:", key, "→", t); still.push(seed.find(x => x.key === key)); } }
for (const s of unmatched) {
	let best = null, bd = Infinity;
	for (const v of variants(s.name)) { const e = ents[v]; if (!e) continue; const cl = classes(e); if (cl.some(c => DISAMBIG.has(c))) continue;
		const c = coordOf(e), d = c ? kmOf([s.lon, s.lat], c) : (["sea", "strait", "bay", "trench", "ridge", "range", "basin", "plain", "plateau", "islands", "river"].includes(s.cat) ? 0 : Infinity);   // 座標の無い海域・山地は名前だけで受ける
		if (d < bd) { bd = d; best = e; } }
	if (best && bd <= limitOf(s.cat) * 1.5) match[s.key] = { qid: best.id, how: "jawiki", dist: +bd.toFixed(1) };
	else still.push(s);
}
console.error("\njawiki 一致", Object.keys(match).length, "未", still.length);
fs.writeFileSync(path.join(CACHE, "match.json"), JSON.stringify(match, null, 1));
fs.writeFileSync(path.join(CACHE, "unmatched.csv"), "name,code,category,rank,lon,lat\n" + still.map(s => [s.name, s.code, s.cat, s.rank, s.lon, s.lat].join(",")).join("\n") + "\n");
const cnt = {}; for (const s of still) cnt[s.cat] = (cnt[s.cat] || 0) + 1; console.error("未一致の内訳", JSON.stringify(cnt));
