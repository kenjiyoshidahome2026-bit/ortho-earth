#!/usr/bin/env node
// i18n の門（ortho-globe）：この殻のファイル（頁＝quakes／sats）が呼ぶ英語キーが、頁の辞書か本体（globe の ui.json）に揃っているか。
// 走査器と表の作り方は globe の共通の道具（japan の門と同じ物差し）。ここは globe を走査しない（extraRoots: []）
// ＝本体のキーの生死と本体の表の焼きは本体の持ち主の門が見る。この殻だけが使うキーは頁の辞書に置く（本体に置くと生死の判定から漏れる）。
//   ① 呼ばれたキーが頁の辞書か本体にある・頁の辞書と本体に同じキーが無い（ERROR）
//   ② ja 列がある ③ プレースホルダの顔ぶれが一致 ④ 訳に文脈標識 " ##" が混ざらない（ERROR）
//   ⑤ 実行時が読む頁の表（i18n/lang/<page>/）が正本から焼き直されている（ERROR＝npm run i18n:build の焼き忘れ）
//   ⑥ 頁の辞書の未訳（WARN・--strict で ERROR）・使われなくなった頁のキー（WARN）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanApp, hostDir, placeholders, CTX_SEP } from "@ortho-earth/globe/scripts/lib/i18n-scan.mjs";
import { loadPages } from "@ortho-earth/globe/scripts/lib/i18n-pages.mjs";
import { i18nTables, staleTables } from "@ortho-earth/globe/scripts/lib/i18n-tables.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const strict = process.argv.includes("--strict");
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8")).filter(l => l.code !== "en");
const ui = JSON.parse(fs.readFileSync(path.join(hostDir(APP), "i18n/ui.json"), "utf8")).ui ?? {};
const P = loadPages(APP);
const own = { extraRoots: [], literalRoots: [] };   // 自分のファイルだけ
const r = scanApp(APP, {}, { ...own, exclude: P.pageFiles });
const rp = Object.fromEntries(Object.keys(P.pages).map(page => [page, scanApp(APP, {}, { ...own, only: new Set(P.pages[page]) })]));

let err = 0, warn = 0;
const E = (why, rows = []) => { err++; console.error(`ERROR  ${why}`); for (const x of rows.slice(0, 25)) console.error("       " + x); };
const W = (why, rows = []) => { warn++; console.warn(`WARN   ${why}`); for (const x of rows.slice(0, 10)) console.warn("       " + x); };
const where = rr => k => `${JSON.stringify(k)}  (${[...rr.keys.get(k).files].join(", ")})`;
const calls = u => `${u.rel}:${u.line}  ${JSON.stringify(u.value)}`;

// ①
const miss = [...r.keys.keys()].filter(k => !(k in ui));
if (miss.length) E(`${miss.length} key(s) used outside the pages are not in globe's ui.json`, miss.map(where(r)));
if (r.untranslated.length) E(`${r.untranslated.length} t() call(s) use a key that is in no table`, r.untranslated.map(calls));
for (const [page, rr] of Object.entries(rp)) {
	const tbl = P.tables[page];
	const m = [...rr.keys.keys()].filter(k => !(k in tbl) && !(k in ui));
	if (m.length) E(`${m.length} key(s) used by page "${page}" are in neither i18n/pages/${page}.json nor globe's ui.json`, m.map(where(rr)));
	const dup = Object.keys(tbl).filter(k => k in ui);
	if (dup.length) E(`${dup.length} key(s) of page "${page}" also exist in globe's ui.json (one home per key)`, dup.map(k => JSON.stringify(k)));
	if (rr.untranslated.length) E(`${rr.untranslated.length} t() call(s) in page "${page}" use a key that is in no table`, rr.untranslated.map(calls));
	const dead = Object.keys(tbl).filter(k => !rr.keys.has(k) && !rr.literals.has(k));
	if (dead.length) W(`${dead.length} key(s) in i18n/pages/${page}.json are no longer used by that page`, dead.map(k => JSON.stringify(k)));
}
// ②③④（頁の辞書の中身）
const rows = Object.values(P.tables).flatMap(t => Object.entries(t));
const noJa = [], phBad = [], ctxLeak = [];
for (const [key, row] of rows) {
	if (!("ja" in row)) noJa.push(JSON.stringify(key));
	for (const [lang, text] of Object.entries(row)) {
		if (typeof text !== "string") { phBad.push(`${JSON.stringify(key)} [${lang}] is not a string`); continue; }
		if (text === "") continue;   // "" ＝意図して英語のまま
		if (text.includes(CTX_SEP)) ctxLeak.push(`${JSON.stringify(key)} [${lang}] contains "${CTX_SEP}"`);
		if (placeholders(text) !== placeholders(key)) phBad.push(`${JSON.stringify(key)} [${lang}] has ${placeholders(text) || "none"}, key has ${placeholders(key) || "none"}`);
	}
}
if (noJa.length) E(`${noJa.length} key(s) have no ja column`, noJa);
if (phBad.length) E(`${phBad.length} placeholder mismatch(es)`, phBad);
if (ctxLeak.length) E(`${ctxLeak.length} translation(s) carry the context marker`, ctxLeak);
// ⑤（この殻の頁の表だけ）
const stale = staleTables(APP, new Map([...i18nTables(APP).files].filter(([f]) => f.startsWith(APP + path.sep))));
if (stale.length) E(`${stale.length} page table(s) are stale — run: npm run i18n:build (and commit the result)`, stale.map(([f, why]) => `${path.relative(APP, f)}  (${why})`));
// ⑥
const short = langs.map(({ code }) => [code, rows.filter(([, row]) => row[code] === undefined).length]).filter(([, n]) => n);
if (short.length) { const msg = `${short.length} language(s) are incomplete in the page tables: ${short.map(([c, n]) => `${c} ${n}`).join(", ")} — those keys fall back to English`; strict ? E(msg) : W(msg); }

console.log(`pages: ${Object.entries(P.tables).map(([p, t]) => `${p} ${Object.keys(t).length}`).join(" · ")} · languages ${langs.length + 1}`);
console.log(err ? `FAIL  ${err} error(s), ${warn} warning(s)` : `PASS  ${warn} warning(s)`);
process.exit(err ? 1 : 0);
