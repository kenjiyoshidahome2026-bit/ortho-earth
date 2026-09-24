#!/usr/bin/env node
// 門：www の文言が i18n/ui.json に揃っているか。
//   ・頁の UI（index.html の data-t）＝全 25 言語の訳が必須（欠けたら失敗）
//   ・デモの文言（demos.json）＝訳が無ければ英語で出る＝**警告だけ**（サンプルはどんどん増える＝訳は後追いでよい。本人 9/22）
//   ・訳が任意の文言（固有名詞の題・Japanese only）＝欠けは咎めない（訳がある言語だけ訳が出る）
//   ・焼いた i18n/lang/*.json が ui.json と一致（焼き忘れ）＝失敗
import fs from "node:fs";
import path from "node:path";
import { APP, uiKeys, demoTextKeys, demoOptionalKeys } from "./keys.mjs";

const ui = JSON.parse(fs.readFileSync(path.join(APP, "i18n/ui.json"), "utf8")).ui;
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8")).map(l => l.code).filter(c => c !== "en");
const page = uiKeys(), demos = demoTextKeys().filter(k => !page.includes(k)), optional = demoOptionalKeys();
const errs = [], warns = [];
const missing = k => langs.filter(c => !ui[k]?.[c]);
for (const k of page) { const m = missing(k); if (m.length) errs.push(`page "${k}": no ${m.length === langs.length ? "entry" : m.join(",")}`); }
for (const k of demos) { const m = missing(k); if (m.length) warns.push(`demo "${k}": English only in ${m.length === langs.length ? "all languages" : m.join(",")}`); }
for (const k of Object.keys(ui)) if (!page.includes(k) && !demos.includes(k) && !optional.includes(k)) warns.push(`unused key: ${k}`);
for (const c of langs) {
	const f = path.join(APP, `public/i18n/${c}.json`);
	const baked = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
	for (const [k, row] of Object.entries(ui)) if (row[c] && baked[k] !== row[c]) { errs.push(`${c}.json is stale (run npm run i18n:build -w www)`); break; }
}
console.log(`page keys: ${page.length} · demo keys: ${demos.length} · optional: ${optional.length} · ui.json: ${Object.keys(ui).length} · languages: ${langs.length}`);
if (warns.length) console.warn("⚠ " + warns.join("\n⚠ "));
if (errs.length) { console.error("✗ " + errs.join("\n✗ ")); process.exit(1); }
console.log("i18n OK");
