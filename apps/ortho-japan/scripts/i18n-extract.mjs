#!/usr/bin/env node
// ja キー辞書（各ガジェット持参の tr({…})）を英語キーへ反転し、i18n の正本と置換表を作る（Phase 0 の道具）。
//
// 出すもの：
//   i18n/ui.json          … 訳の正本（world の ui.json と同じ形＝{ ui: { "<英語キー>": { ja, zh, … } } }）。
//                           既にある訳は残す（再実行で潰さない）・使われなくなったキーは落として報告。
//   out/i18n-keymap.json  … Phase 1 の機械置換の唯一の入力（file → { "日本語リテラル": "英語キー" }）。
//
// ⚠ 表/配列に置かれたキー（t(x) の間接参照＝THEME_META・チップ一覧・PRINT_ATTR 等）は、英語キー期には
//   ただの文字列と見分けが付かない＝新設時だけ ui.json へ手で足す（既にあるキーは literals 照合で生き残る）。
//
// 使い方: npm run i18n:extract [-- --check]   （--check＝書かずに検分だけ）
import fs from "node:fs";
import path from "node:path";
import { hostDir } from "./lib/i18n-scan.mjs";
import { fileURLToPath } from "node:url";
import { CTX_SEP } from "./lib/i18n-scan.mjs";
import { scanAll } from "./lib/i18n-pages.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(hostDir(APP), "i18n/ui.json");   // 本体の訳の正本は地球儀のホスト（packages/globe/src）に住む（S4）
const KEYMAP = path.join(APP, "out/i18n-keymap.json");
const LANGS = path.join(APP, "../../packages/world/i18n/langs.json");   // 言語一覧は world と 1 本（データの共有・コードは各自）
const check = process.argv.includes("--check");

const ctx = JSON.parse(fs.readFileSync(path.join(APP, "scripts/i18n-contexts.json"), "utf8"));
const langs = JSON.parse(fs.readFileSync(LANGS, "utf8")).map(l => l.code);
const { r, alive } = scanAll(APP, ctx);   // 走査は本体だけ（showcase ページ＝i18n/pages.json は別辞書＝本体の正本へ混ぜない）・生死はページからの参照も数える（検定と同じ物差し）

let bad = 0;
const die = (why, rows) => { bad++; console.error(`ERROR  ${why}`); for (const x of rows.slice(0, 20)) console.error("       " + x); };

if (r.dictErrors.length) die(`${r.dictErrors.length} dictionary literal(s) could not be read`, r.dictErrors.map(e => `${e.rel}: ${e.key} — ${e.why}`));
if (r.collisions.size) die(`${r.collisions.size} English key(s) claimed by different Japanese strings (add a context to scripts/i18n-contexts.json)`,
	[...r.collisions].map(([k, v]) => `"${k}" <= ${[...v].join(" | ")}`));

// 既存の訳を読み、ja を入れ直して書き戻す（他言語は触らない）
const prev = fs.existsSync(UI) ? JSON.parse(fs.readFileSync(UI, "utf8")).ui ?? {} : {};
const ui = {}, added = [], retired = Object.keys(prev).filter(k => !alive(k));
for (const k of Object.keys(prev)) if (alive(k) && !r.keys.has(k)) r.keys.set(k, { ja: "", rawJa: "", files: new Set(), uses: [] });
for (const key of [...r.keys.keys()].sort()) {
	const rec = r.keys.get(key);
	if (!prev[key]) added.push(key);
	const row = { ...prev[key] };
	if (rec.ja) row.ja = rec.ja; else if (!("ja" in row)) row.ja = "";   // ja は必ず 1 列持つ（"" ＝意図して英語のまま）
	ui[key] = Object.fromEntries(langs.filter(l => l !== "en" && l in row).map(l => [l, row[l]]));
}

const keymap = {};
for (const [rel, map] of r.perFile) if (map.size) keymap[rel] = Object.fromEntries([...map].sort((a, b) => b[0].length - a[0].length));   // 長い順＝部分一致の取り違えを防ぐ

const cover = langs.filter(l => l !== "en").map(l => {
	const have = Object.values(ui).filter(row => row[l] !== undefined).length;
	const english = Object.values(ui).filter(row => row[l] === "").length;
	return { l, have, english, miss: r.keys.size - have };
});

console.log(`files with UI strings : ${r.files.length}`);
console.log(`English keys          : ${r.keys.size}  (with context: ${[...r.keys.keys()].filter(k => k.includes(CTX_SEP)).length}, new: ${added.length}, retired: ${retired.length})`);
console.log(`direct t() calls with no dictionary entry (would stay Japanese in English UI): ${r.untranslated.length}`);
for (const u of r.untranslated) console.log(`   ${u.rel}:${u.line}  ${JSON.stringify(u.value)}`);
if (retired.length) console.log(`retired keys (dropped from ui.json): ${retired.map(k => JSON.stringify(k)).join(", ")}`);
console.log("\nlang  translated  intentionally-English  missing");
for (const c of cover) console.log(`${c.l.padEnd(5)} ${String(c.have - c.english).padStart(9)} ${String(c.english).padStart(22)} ${String(c.miss).padStart(8)}`);

if (bad) process.exit(1);
if (check) { console.log("\n--check: nothing written."); process.exit(0); }
fs.mkdirSync(path.dirname(UI), { recursive: true });
fs.mkdirSync(path.dirname(KEYMAP), { recursive: true });
fs.writeFileSync(UI, JSON.stringify({ ui }, null, "\t") + "\n");
fs.writeFileSync(KEYMAP, JSON.stringify(keymap, null, "\t") + "\n");
console.log(`\nwrote ${path.relative(APP, UI)} (${r.keys.size} keys) and ${path.relative(APP, KEYMAP)} (${Object.keys(keymap).length} files)`);
