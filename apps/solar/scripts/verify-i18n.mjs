#!/usr/bin/env node
// i18n の常設検定＝「訳が機械で検められる正解の定義」（ortho-japan の verify-i18n.mjs の solar 版＝
// solar は英語キー期から始まるので、走査は t("…") と index.html の data-t / data-t-title だけで足りる）。
//
//   ① コードと HTML が使う英語キーが全て i18n/ui.json にある（無ければ ERROR）
//   ② ja は必ず 1 列ある（無ければ ERROR）。値 "" ＝意図して英語のまま＝正常（欠落と区別する）
//   ③ プレースホルダ（$1 $2 …）の顔ぶれがキーと各訳で一致（ずれは ERROR＝実行時に穴が開く）
//   ④ 訳文に文脈標識 " ##" が混ざっていない（ERROR＝文脈はキーを分けるための印＝訳す対象でない）
//   ⑤ 焼いた i18n/lang/<code>.json が正本と一致（古ければ ERROR＝npm run i18n:build を促す）
//   ⑥ 各言語の未訳件数・使われなくなったキー（WARN）
//
// 使い方: npm run verify:i18n [-- --strict]   （--strict＝未訳の WARN も落とす＝訳が揃った後の門）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const strict = process.argv.includes("--strict");
const CTX_SEP = " ##";
const placeholders = s => (String(s).match(/\$\d/g) ?? []).sort().join("");
const rd = f => fs.readFileSync(path.join(APP, f), "utf8");

const ui = JSON.parse(rd("i18n/ui.json")).ui ?? {};
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8"));

// コメントを空白で潰す（長さは保つ）。文字列/テンプレートの中の // は守る＝"http://…" を切らない。
// 正規表現リテラルは追わない（この 2 本に // を含む正規表現は無い＝入れる時はここも直す）。
// これが無いと、i18n.js の作法コメントに書いた t("…") の例が「使っているキー」に化ける。
function stripComments(src) {
	let out = "", i = 0, q = null;                     // q＝今いる文字列の種類（' " `）
	while (i < src.length) {
		const c = src[i], d = src[i + 1];
		if (q) {
			if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
			if (c === q) q = null;
			out += c; i++; continue;
		}
		if (c === "'" || c === '"' || c === "`") { q = c; out += c; i++; continue; }
		if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
		if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2), stop = e < 0 ? src.length : e + 2;
			for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " "; continue; }
		out += c; i++;
	}
	return out;
}

// ---- 走査：コードの t("…")／表に並べた英語リテラル（BODY_KEYS のような台帳）／HTML の data-t・data-t-title ----
const used = new Map();                      // キー → 出所の並び
const put = (k, where) => { if (!used.has(k)) used.set(k, []); used.get(k).push(where); };
const jsFiles = fs.readdirSync(APP).filter(f => f.endsWith(".js"));
for (const f of jsFiles) {
	const src = stripComments(rd(f));
	for (const m of src.matchAll(/(?<![\w$.])t\(\s*"((?:[^"\\]|\\.)*)"/g)) put(JSON.parse(`"${m[1]}"`), f);
	for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {   // 表/配列のキー（t(x) の間接参照）も「在る」印
		const v = JSON.parse(`"${m[1]}"`);
		if (v in ui) put(v, f);
	}
}
const html = rd("index.html");
for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\sdata-t(?![\w-])[^>]*>([^<]*)</gi)) put(m[2].trim(), "index.html");
for (const m of html.matchAll(/\stitle="([^"]*)"[^>]*\sdata-t-title(?![\w-])/gi)) put(m[1].replace(/&amp;/g, "&"), "index.html");

let err = 0, warn = 0;
const E = (why, rows = []) => { err++; console.error(`ERROR  ${why}`); for (const x of rows.slice(0, 25)) console.error("       " + x); };
const W = (why, rows = []) => { warn++; console.warn(`WARN   ${why}`); for (const x of rows.slice(0, 10)) console.warn("       " + x); };

// ① 使っているキーが正本にあるか
const missing = [...used.keys()].filter(k => !(k in ui));
if (missing.length) E(`${missing.length} key(s) used in code/HTML are not in i18n/ui.json`,
	missing.map(k => `${JSON.stringify(k)}  (${[...new Set(used.get(k))].join(", ")})`));

// ②③④ 正本の中身
const noJa = [], phBad = [], ctxLeak = [];
for (const [key, row] of Object.entries(ui)) {
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

// ⑤ 焼いた表が正本と一致しているか（古い lang/*.json を配らない）
const stale = [];
for (const { code } of langs) {
	if (code === "en") continue;
	const want = {};
	for (const [key, row] of Object.entries(ui)) if (row[code]) want[key] = row[code];
	const file = path.join(APP, `i18n/lang/${code}.json`);
	const has = fs.existsSync(file);
	if (!Object.keys(want).length) { if (has) stale.push(`${code}: baked file exists but ui.json has no translation`); continue; }
	if (!has) { stale.push(`${code}: i18n/lang/${code}.json is missing`); continue; }
	const baked = JSON.parse(fs.readFileSync(file, "utf8"));
	const keys = new Set([...Object.keys(want), ...Object.keys(baked)]);
	const diff = [...keys].filter(k => want[k] !== baked[k]);
	if (diff.length) stale.push(`${code}: ${diff.length} key(s) differ from ui.json (e.g. ${JSON.stringify(diff[0])})`);
}
if (stale.length) E(`${stale.length} baked table(s) are out of date — run: npm run i18n:build`, stale);

// ⑥ 死にキー・未訳
const dead = Object.keys(ui).filter(k => !used.has(k));
if (dead.length) W(`${dead.length} key(s) in ui.json are no longer used`, dead.map(k => JSON.stringify(k)));

const total = Object.keys(ui).length;
console.log(`\nkeys ${total}   used ${used.size}\n`);
console.log("lang  translated  intentionally-English  missing   note");
const short = [];
for (const { code, name, rtl } of langs) {
	if (code === "en") { console.log(`${code.padEnd(5)} ${String(total).padStart(9)} ${"-".padStart(22)} ${"0".padStart(8)}   base language (key itself)`); continue; }
	const have = Object.values(ui).filter(row => row[code] !== undefined);
	const eng = have.filter(row => row[code] === "").length;
	const miss = total - have.length;
	if (miss) short.push(`${code} ${miss}`);
	console.log(`${code.padEnd(5)} ${String(have.length - eng).padStart(9)} ${String(eng).padStart(22)} ${String(miss).padStart(8)}   ${name}${rtl ? " (RTL)" : ""}`);
}
if (short.length) {
	const msg = `${short.length} language(s) are incomplete: ${short.join(", ")} — those keys fall back to English`;
	strict ? E(msg) : W(msg);
}

console.log(err ? `\nFAIL  ${err} error(s), ${warn} warning(s)` : `\nPASS  ${warn} warning(s)`);
process.exit(err ? 1 : 0);
