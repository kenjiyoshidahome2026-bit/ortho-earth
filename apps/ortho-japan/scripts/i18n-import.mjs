#!/usr/bin/env node
// 翻訳ファイル（out/tr/<code>.json＝{ 英語キー: 訳 }）を正本 i18n/ui.json へ取り込む。
// 取り込む前に機械で検める：キー集合が正本と一致・$1 $2 の顔ぶれが一致・文脈標識 " ##" の混入なし・
// RTL に bidi 制御文字の混入なし。1 つでも欠ければその言語は**取り込まない**（半端な訳で正本を汚さない）。
//
// 使い方: node scripts/i18n-import.mjs [code …]   （無指定＝out/tr/ にある全部）
import fs from "node:fs";
import path from "node:path";
import { hostDir } from "./lib/i18n-scan.mjs";
import { fileURLToPath } from "node:url";
import { placeholders, CTX_SEP } from "./lib/i18n-scan.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(hostDir(APP), "i18n/ui.json");   // 本体の訳の正本は地球儀のホスト（packages/globe/src）に住む（S4）
const TR = path.join(APP, "out/tr");
const doc = JSON.parse(fs.readFileSync(UI, "utf8"));
const ui = doc.ui;
const keys = Object.keys(ui);
const want = new Set(keys);
const langs = new Set(JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8")).map(l => l.code));
const only = process.argv.slice(2).filter(a => !a.startsWith("--"));
const BIDI = /[‎‏‪-‮⁦-⁩]/;

let taken = 0, refused = 0;
for (const file of fs.readdirSync(TR).sort()) {
	if (!file.endsWith(".json")) continue;
	const code = file.slice(0, -5);
	if (only.length && !only.includes(code)) continue;
	if (!langs.has(code) || code === "en") { console.error(`REFUSE ${code}: not a known language code`); refused++; continue; }
	let table;
	try { table = JSON.parse(fs.readFileSync(path.join(TR, file), "utf8")); }
	catch (e) { console.error(`REFUSE ${code}: not valid JSON — ${e.message}`); refused++; continue; }

	const missing = keys.filter(k => !(k in table));
	const extra = Object.keys(table).filter(k => !want.has(k));
	const ph = [], ctx = [], bidi = [], notStr = [];
	for (const k of keys) {
		const v = table[k];
		if (v === undefined) continue;
		if (typeof v !== "string") { notStr.push(k); continue; }
		if (!v) continue;                                              // "" ＝意図して英語のまま
		if (v.includes(CTX_SEP)) ctx.push(k);
		if (placeholders(v) !== placeholders(k)) ph.push(`${k} → ${v}`);
		if (BIDI.test(v)) bidi.push(k);
	}
	const bad = [missing.length && `${missing.length} missing`, extra.length && `${extra.length} unknown keys`,
		notStr.length && `${notStr.length} non-string`, ph.length && `${ph.length} placeholder mismatch`,
		ctx.length && `${ctx.length} context marker leak`, bidi.length && `${bidi.length} bidi control char`].filter(Boolean);
	if (bad.length) {
		console.error(`REFUSE ${code}: ${bad.join(", ")}`);
		for (const x of [...missing.slice(0, 3), ...ph.slice(0, 3), ...ctx.slice(0, 3), ...bidi.slice(0, 3)]) console.error(`       ${JSON.stringify(x).slice(0, 140)}`);
		refused++; continue;
	}
	let english = 0;
	for (const k of keys) { ui[k][code] = table[k]; if (!table[k]) english++; }
	console.log(`take   ${code}: ${keys.length - english} translated, ${english} left in English ("")`);
	taken++;
}

if (taken) {
	doc.ui = Object.fromEntries(Object.keys(ui).sort().map(k => [k, ui[k]]));
	fs.writeFileSync(UI, JSON.stringify(doc, null, "\t") + "\n");
	console.log(`\nwrote i18n/ui.json (${keys.length} keys, ${taken} language(s) added/updated)`);
}
if (refused) { console.error(`\n${refused} language(s) refused — fix them and run again`); process.exit(1); }
