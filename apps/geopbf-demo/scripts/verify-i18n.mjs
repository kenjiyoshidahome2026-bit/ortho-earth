#!/usr/bin/env node
// 門：コードで使う UI キー（t("…") / L(sel, "…")・.call(L, "…") / LA(sel, attr, "…") / check("…")）が i18n/ui.json に全部あり、
// 25 言語すべてに訳があり、$1/$2 の書式が訳に残っているか。焼いた i18n/lang/*.json が ui.json と一致しているか（焼き忘れ）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = ["main.js", "formats.js"].map(f => fs.readFileSync(path.join(APP, f), "utf8")).join("\n");
const ui = JSON.parse(fs.readFileSync(path.join(APP, "i18n/ui.json"), "utf8")).ui;
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8")).map(l => l.code).filter(c => c !== "en");
const S = `"((?:[^"\\\\]|\\\\.)*)"`;
const used = new Set();
for (const re of [new RegExp(`\\bt\\(${S}`, "g"), new RegExp(`\\bL\\([^;]*?\\), ${S}(?:, [^)]*)?\\)`, "g"), new RegExp(`\\.call\\(L, ${S}`, "g"), new RegExp(`\\bLA\\((?:[^;]*?), "(?:placeholder|title|aria-label|alt)", ${S}\\)`, "g"), new RegExp(`\\bcheck\\(${S}`, "g")])
	for (const m of src.matchAll(re)) used.add(m[1]);
const errs = [];
for (const k of used) if (!ui[k]) errs.push(`missing key: ${k}`);
for (const [k, row] of Object.entries(ui)) {
	if (!used.has(k)) errs.push(`unused key: ${k}`);
	for (const c of langs) {
		if (!row[c]) errs.push(`${c}: no translation for "${k}"`);
		else for (const n of ["$1", "$2"]) if (k.includes(n) && !row[c].includes(n)) errs.push(`${c}: ${n} dropped in "${k}"`);
	}
}
for (const c of langs) {
	const f = path.join(APP, `i18n/lang/${c}.json`);
	const baked = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
	for (const [k, row] of Object.entries(ui)) if (row[c] && baked[k] !== row[c]) { errs.push(`${c}.json is stale (run npm run i18n:build)`); break; }
}
console.log(`keys used in code: ${used.size} · ui.json: ${Object.keys(ui).length} · languages: ${langs.length}`);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log("i18n OK");
