#!/usr/bin/env node
// i18n の常設検定＝「訳が機械で検められる正解の定義」。ja キー期／英語キー期のどちらでも同じ目で回る。
//
//   ① コードが呼ぶ英語キーが全て i18n/ui.json にある（無ければ ERROR）
//   ② ja は必ず 1 列ある（無ければ ERROR）。値 "" ＝意図して英語のまま＝正常（欠落と区別する）
//   ③ プレースホルダ（$1 $2 …）の顔ぶれがキーと各訳で一致（ずれは ERROR＝実行時に穴が開く）
//   ④ 訳文に文脈標識 " ##" が混ざっていない（ERROR＝文脈は訳す対象でなく、キーを分けるための印）
//   ⑤ 各言語の未訳件数（WARN）・使われなくなったキー（WARN）・辞書にない t() 呼び（WARN/ERROR）
//   ⑥ 実行時が読む表（i18n/lang/*.json・langs.js・ページ辞書）が正本から焼き直されている（ERROR＝i18n:build の焼き忘れ。
//      2026-09-23 に可視域の訳を焼き忘れ、本番の日本語 UI が英語で出た＝正本だけ直っても実行時の表が古いまま）
//
// 使い方: npm run verify:i18n [-- --strict]   （--strict＝未訳の WARN も落とす＝訳が揃った後の門）
import fs from "node:fs";
import path from "node:path";
import { hostDir } from "@ortho-earth/globe/scripts/lib/i18n-scan.mjs";
import { fileURLToPath } from "node:url";
import { placeholders, CTX_SEP } from "@ortho-earth/globe/scripts/lib/i18n-scan.mjs";
import { scanAll } from "@ortho-earth/globe/scripts/lib/i18n-pages.mjs";
import { staleTables } from "@ortho-earth/globe/scripts/lib/i18n-tables.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const strict = process.argv.includes("--strict");
const ctx = JSON.parse(fs.readFileSync(path.join(APP, "scripts/i18n-contexts.json"), "utf8"));
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8"));
const uiPath = path.join(hostDir(APP), "i18n/ui.json");   // 本体の訳の正本は地球儀のホスト（packages/globe/src）に住む（S4）
if (!fs.existsSync(uiPath)) { console.error(`ERROR  ${path.relative(APP, uiPath)} is missing — run: npm run i18n:extract`); process.exit(1); }
const ui = JSON.parse(fs.readFileSync(uiPath, "utf8")).ui ?? {};
// showcase ページ（i18n/pages.json）＝自分の表（i18n/pages/<page>.json）＋本体の表で引く。本体のファイルは本体の表だけ
const { P, r, rp, alive: usedAnywhere } = scanAll(APP, ctx);   // 生死の物差し＝抽出と共通（本体の共有キーはページからの参照でも生きている）
const jaEra = [...r.perFile.values()].some(m => m.size > 0);   // ja キー期＝まだ持参辞書が生きている

let err = 0, warn = 0;
const E = (why, rows = []) => { err++; console.error(`ERROR  ${why}`); for (const x of rows.slice(0, 25)) console.error("       " + x); };
const W = (why, rows = []) => { warn++; console.warn(`WARN   ${why}`); for (const x of rows.slice(0, 10)) console.warn("       " + x); };

if (r.dictErrors.length) E(`${r.dictErrors.length} dictionary literal(s) could not be read`, r.dictErrors.map(e => `${e.rel}: ${e.why}`));
if (r.collisions.size) E(`${r.collisions.size} English key(s) claimed by different Japanese strings`, [...r.collisions].map(([k, v]) => `"${k}" <= ${[...v].join(" | ")}`));

// ① コードのキーが正本にあるか
const missing = [...r.keys.keys()].filter(k => !(k in ui));
if (missing.length) E(`${missing.length} key(s) used in code are not in i18n/ui.json (run: npm run i18n:extract)`,
	missing.map(k => `${JSON.stringify(k)}  (${[...r.keys.get(k).files].join(", ")})`));
for (const [page, rr] of Object.entries(rp)) {
	const tbl = P.tables[page];
	const miss = [...rr.keys.keys()].filter(k => !(k in tbl) && !(k in ui));
	if (miss.length) E(`${miss.length} key(s) used by page "${page}" are in neither i18n/pages/${page}.json nor ui.json`, miss.map(k => `${JSON.stringify(k)}  (${[...rr.keys.get(k).files].join(", ")})`));
	const dup = Object.keys(tbl).filter(k => k in ui);
	if (dup.length) E(`${dup.length} key(s) of page "${page}" also exist in ui.json (keep shared keys in ui.json only)`, dup.map(k => JSON.stringify(k)));
}

// ②③④ 正本の中身（本体＋ページ）
const noJa = [], phBad = [], ctxLeak = [];
const allRows = [...Object.entries(ui), ...Object.values(P.tables).flatMap(t => Object.entries(t))];
for (const [key, row] of allRows) {
	if (!("ja" in row)) noJa.push(key);
	for (const [lang, text] of Object.entries(row)) {
		if (typeof text !== "string") { phBad.push(`${JSON.stringify(key)} [${lang}] is not a string`); continue; }
		if (text === "") continue;                                     // "" ＝意図して英語のまま
		if (text.includes(CTX_SEP)) ctxLeak.push(`${JSON.stringify(key)} [${lang}] contains "${CTX_SEP}"`);
		if (placeholders(text) !== placeholders(key)) phBad.push(`${JSON.stringify(key)} [${lang}] has ${placeholders(text) || "none"}, key has ${placeholders(key) || "none"}`);
	}
}
if (noJa.length) E(`${noJa.length} key(s) have no ja column`, noJa);
if (phBad.length) E(`${phBad.length} placeholder mismatch(es)`, phBad);
if (ctxLeak.length) E(`${ctxLeak.length} translation(s) carry the context marker`, ctxLeak);

// ⑥ 焼き忘れ＝正本から作った表と、書かれている表の食い違い
const stale = staleTables(APP);
if (stale.length) E(`${stale.length} runtime translation table(s) are stale — run: npm run i18n:build (and commit the result)`, stale.map(([f, why]) => `${path.relative(APP, f)}  (${why})`));

// ⑤ 未訳・死にキー・辞書にない呼び出し
const dead = Object.keys(ui).filter(k => !usedAnywhere(k));   // 表/配列に置かれたキーは生きている
if (dead.length) W(`${dead.length} key(s) in ui.json are no longer used in code`, dead.map(k => JSON.stringify(k)));
for (const [page, rr] of Object.entries(rp)) {
	const d = Object.keys(P.tables[page]).filter(k => !rr.keys.has(k) && !rr.literals.has(k));
	if (d.length) W(`${d.length} key(s) in i18n/pages/${page}.json are no longer used by that page`, d.map(k => JSON.stringify(k)));
	if (rr.untranslated.length) E(`${rr.untranslated.length} t() call(s) in page "${page}" use a key that is in no table`, rr.untranslated.map(u => `${u.rel}:${u.line}  ${JSON.stringify(u.value)}`));
}
if (r.untranslated.length) {
	const rows = r.untranslated.map(u => `${u.rel}:${u.line}  ${JSON.stringify(u.value)}`);
	if (jaEra) W(`${r.untranslated.length} t() call(s) have no dictionary entry (they stay Japanese in the English UI)`, rows);
	else E(`${r.untranslated.length} t() call(s) use a key that is not in ui.json`, rows);
}

const total = Object.keys(ui).length;
console.log(`\nkeys ${total} (ui.json)${Object.entries(P.tables).map(([p, t]) => ` + ${Object.keys(t).length} (${p})`).join("")}   era ${jaEra ? "ja-key (pre Phase 1)" : "English-key"}\n`);
console.log("lang  translated  intentionally-English  missing   note");
const short = [];
for (const { code, name, rtl } of langs) {
	if (code === "en") { console.log(`${code.padEnd(5)} ${String(allRows.length).padStart(9)} ${"-".padStart(22)} ${"0".padStart(8)}   base language (key itself)`); continue; }
	const rows = allRows.map(([, row]) => row);
	const have = rows.filter(row => row[code] !== undefined);
	const eng = have.filter(t => t[code] === "").length;
	const miss = rows.length - have.length;
	if (miss) short.push(`${code} ${miss}`);
	console.log(`${code.padEnd(5)} ${String(have.length - eng).padStart(9)} ${String(eng).padStart(22)} ${String(miss).padStart(8)}   ${name}${rtl ? " (RTL)" : ""}`);
}
if (short.length) {
	const msg = `${short.length} language(s) are incomplete: ${short.join(", ")} — those keys fall back to English`;
	strict ? E(msg) : W(msg);
}

console.log(err ? `\nFAIL  ${err} error(s), ${warn} warning(s)` : `\nPASS  ${warn} warning(s)`);
process.exit(err ? 1 : 0);
