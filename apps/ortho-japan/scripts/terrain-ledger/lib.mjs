// terrain-ledger の共通部品（種の読み・名前のゆれ・距離・CSV）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(DIR, ".cache");

export function parseCsv(text) {
	const rows = [], re = /("([^"]|"")*"|[^,\n]*)(,|\n|$)/g; let row = [], m;
	text = text.replace(/\r/g, ""); if (!text.endsWith("\n")) text += "\n";
	while ((m = re.exec(text)) && m[0] !== "") { let v = m[1]; if (v.startsWith('"')) v = v.slice(1, -1).replace(/""/g, '"'); row.push(v); if (m[3] !== ",") { rows.push(row); row = []; } }
	const head = rows.shift(); return rows.filter(r => r.length > 1 || r[0]).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
export const toCsv = (rows, cols) => { const esc = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }; return cols.join(",") + "\n" + rows.map(r => cols.map(c => esc(r[c])).join(",")).join("\n") + "\n"; };

// 種＝注記由来（生成物）＋手動層の add（人が持つ）。key＝"名前|code"（add は code を "m" に）
export function readSeed() {
	const anno = parseCsv(fs.readFileSync(path.join(DIR, "seed/terrains-anno.csv"), "utf8")).map(r => ({ name: r.name, code: +r.code, cat: r.category, rank: +r.rank, lon: +r.lon, lat: +r.lat, kana: r.kana, key: r.key, src: "anno" }));
	const manual = readManual(), drop = new Set(manual.drop || []);
	const add = (manual.add || []).map(a => ({ name: a.name, code: "m", cat: a.category, rank: a.rank ?? 9, lon: a.lon, lat: a.lat, kana: "", key: a.name + "|m", src: "manual", qid: a.qid || null }));
	const out = [...anno, ...add].filter(s => !drop.has(s.key) && !drop.has(s.name));
	for (const s of out) if (manual.category?.[s.key]) s.cat = manual.category[s.key];
	return out;
}
export const readManual = () => JSON.parse(fs.readFileSync(path.join(DIR, "seed/terrains-manual.json"), "utf8"));

// 名前のゆれ（ヶ/ケ/が・ノ/の・括弧の別名・全角数字・「山（やま）」）＝Wikidata のラベルや jawiki の記事名との照合に使う
export function variants(name) {
	const out = new Set(), n = String(name || "").trim(); if (!n) return [];
	const push = s => { if (s) out.add(s); };
	push(n);
	const paren = n.match(/^(.+?)[（(](.+?)[）)]$/); if (paren) { push(paren[1]); push(paren[2]); }
	const base = [...out];
	for (const b of base) { push(b.replace(/ヶ/g, "ケ")); push(b.replace(/ケ/g, "ヶ")); push(b.replace(/ヶ/g, "が")); push(b.replace(/ノ/g, "の")); push(b.replace(/の/g, "ノ")); push(b.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))); push(b.replace(/・/g, "")); push(b.replace(/・/g, "-")); }
	return [...out];
}
export const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
