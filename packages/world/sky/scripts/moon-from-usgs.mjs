#!/usr/bin/env node
// 月の地名の正本（moon.json）を組む道具（2026-09-19 初版で使用）。普段は使わない＝moon.json が正本（手で直してよい）。
//   node scripts/moon-from-usgs.mjs <dir>   ＝<dir> に下を置いてから（<dir>/node_modules に opencc-js@1＝zh の繁体→簡体）
//   MOON_nomenclature_center_pts.dbf : USGS Gazetteer of Planetary Nomenclature（IAU 採択名・パブリックドメイン）
//        https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip
//   wd-moon.json    : SELECT ?gpn ?lang ?label WHERE { ?c wdt:P2824 ?gpn; wdt:P376 wd:Q405 . ?c rdfs:label ?label .
//                     BIND(LANG(?label) AS ?lang) FILTER(?lang IN (<26 言語>)) }     （P2824＝GPN の ID・P376＝月 Q405）
//   wd-moon-zh.json : 同じ問い合わせで lang IN ("zh-hans","zh-cn","zh-sg","zh-my")（zh の簡体字の見出しを優先するため）
//   取得＝https://query.wikidata.org/sparql（Accept: application/sparql-results+json）
// 範囲＝主な地名（衛星クレーター "Copernicus A" 型 7,063 件は入れない＝本人裁定 2026-09-19）。
// 多言語の規則：「(…)」の曖昧さ回避を除く・zh は zh-hans > zh-cn > zh-sg > zh-my > zh の順で取り繁体→簡体・英名と同じ見出しは持たない
// （欠けは英語へ落ちる＝同じ）・同じ言語で二つの地名が同じ見出しになるものは両方捨てる（取り違えの疑い）
import fs from "node:fs";
import { createRequire } from "node:module";
const DIR = process.argv[2];
if (!DIR) { console.error("usage: node scripts/moon-from-usgs.mjs <dir>"); process.exit(1); }
const OUT = new URL("../moon.json", import.meta.url);
const LANGS = ["en", "ja", "zh", "ko", "fr", "de", "es", "pt", "it", "nl", "pl", "ru", "uk", "hu", "sv", "tr", "el", "id", "vi", "th", "bn", "hi", "ar", "fa", "ur", "he"];
const t2s = createRequire(`${DIR}/`)("opencc-js").Converter({ from: "tw", to: "cn" });

// DBF（dBASE III）を素で読む＝依存を増やさない
function readDBF(path) {
	const b = fs.readFileSync(path), n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10), fields = [];
	for (let o = 32; b[o] !== 0x0d; o += 32) fields.push({ name: b.toString("latin1", o, o + 11).replace(/\0.*$/, ""), len: b[o + 16] });
	const rows = [];
	for (let i = 0; i < n; i++) {
		let o = hl + i * rl + 1; const r = {};
		for (const f of fields) { r[f.name] = b.toString("utf8", o, o + f.len).trim(); o += f.len; }
		rows.push(r);
	}
	return rows;
}
const rows = readDBF(`${DIR}/MOON_nomenclature_center_pts.dbf`).filter(r => r.type !== "Satellite Feature");
const wd = {};
for (const file of ["wd-moon.json", "wd-moon-zh.json"]) for (const x of JSON.parse(fs.readFileSync(`${DIR}/${file}`, "utf8")).results.bindings)
	(wd[x.gpn.value] ||= {})[x.lang.value] = x.label.value;

// 手当て（Wikidata に無い・月見で名前の要るもの）＝日本語の定訳。英名→{ lang: 名前 }
const HAND = {
	"Lacus Luxuriae": { ja: "豪奢の湖" }, "Lacus Odii": { ja: "憎しみの湖" }, "Lacus Perseverantiae": { ja: "忍耐の湖" },
	"Lacus Somniorum": { ja: "夢の湖" }, "Lacus Spei": { ja: "希望の湖" }, "Lacus Temporis": { ja: "時の湖" }, "Lacus Veris": { ja: "春の湖" },
	"Lacus Tenebrarum": { ja: "闇の湖" }, "Palus Putredinis": { ja: "腐敗の沼" }, "Sinus Viscositatis": { ja: "粘りの入江" },
	"Grimaldi": { ja: "グリマルディ" }, "Statio Tranquillitatis": { ja: "静かの基地" },
};
const clean = s => s.replace(/\s*[(（][^)）]*[)）]\s*/g, " ").replace(/\s+/g, " ").trim();
const r4 = v => Math.round(v * 1e4) / 1e4, r2 = v => Math.round(v * 100) / 100;
const features = rows.map(r => {
	const id = +r.link.split("/").pop(), w = wd[id] || {}, names = {};
	for (const l of LANGS.slice(1)) {
		let v = l === "zh" ? (w["zh-hans"] || w["zh-cn"] || w["zh-sg"] || w["zh-my"] || (w.zh && t2s(w.zh))) : w[l];
		if (!v) continue;
		v = clean(v);
		if (v && v !== r.name) names[l] = v;
	}
	Object.assign(names, HAND[r.name]);
	let lon = +r.center_lon; if (lon > 180) lon -= 360;
	return { id, name: r.name, code: r.code, diameter: r2(+r.diameter), lon: r4(lon), lat: r4(+r.center_lat), origin: r.origin.trim(), approved: +r.approvaldt.slice(0, 4), names };
}).sort((a, b) => a.id - b.id);

// 同じ言語で二つの地名が同じ見出し＝取り違えの疑い＝両方捨てる
const dropped = [];
for (const l of LANGS.slice(1)) {
	const seen = new Map();
	for (const f of features) if (f.names[l]) { const k = f.names[l]; seen.set(k, [...(seen.get(k) || []), f]); }
	for (const [k, fs_] of seen) if (fs_.length > 1) { for (const f of fs_) delete f.names[l]; dropped.push(`${l}:${k}(${fs_.map(f => f.name).join("/")})`); }
}
const out = {
	source: "IAU 採択名＝USGS Gazetteer of Planetary Nomenclature（MOON_nomenclature_center_pts・パブリックドメイン・2026-09-18 版）の主な地名（衛星クレーターを除く）。" +
		"id＝GPN の Feature ID（https://planetarynames.wr.usgs.gov/Feature/<id>）・lon/lat＝月面の経緯度（東経正・-180..180・度）・diameter＝km・code＝IAU の地形記号（AA＝クレーター ME＝海 など）・origin＝名前の由来（英語）。" +
		"names＝多言語名＝Wikidata の見出し（P2824 で突き合わせ・2026-09-19 取得・曖昧さ回避除去・zh は簡体字へ・英名と同じものは持たない）。欠けは英語（IAU 名）へ落とす。",
	features,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, "\t").replace(/\n\t\t\t"names": \{\n([^}]*)\n\t\t\t\}/g, (m, body) => `\n\t\t\t"names": { ${body.trim().split(/,\n\s*/).join(", ")} }`) + "\n");
const cov = Object.fromEntries(LANGS.slice(1).map(l => [l, features.filter(f => f.names[l]).length]));
console.log(`moon.json: ${features.length} features`, cov);
console.log(`dropped (duplicate labels): ${dropped.length}`, dropped.slice(0, 20).join(" | "));
