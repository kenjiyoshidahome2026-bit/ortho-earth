#!/usr/bin/env node
// src の t("…") が全部 i18n/ui.json にあるか（無い＝ERROR）・使われなくなったキー（WARN）・$1 の顔ぶれ一致（ERROR）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = JSON.parse(fs.readFileSync(path.join(PKG, "i18n/ui.json"), "utf8")).ui ?? {};
const used = new Map();
for (const f of fs.readdirSync(path.join(PKG, "src")).filter(f => f.endsWith(".js"))) {
	const src = fs.readFileSync(path.join(PKG, "src", f), "utf8");
	for (const m of src.matchAll(/(?<![\w$.])t\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) used.set(m[2], f);   // 第一引数がリテラルの t(…) だけ（式は対象外）
}
let err = 0;
const ph = s => [...String(s).matchAll(/\$\d/g)].map(m => m[0]).sort().join();
for (const [k, f] of used) {
	if (!(k in ui)) { console.error(`ERROR  missing key (${f}): ${JSON.stringify(k)}`); err++; continue; }
	for (const [c, v] of Object.entries(ui[k])) if (v && ph(v) !== ph(k.split(" ##")[0])) { console.error(`ERROR  placeholder mismatch ${c}: ${JSON.stringify(k)}`); err++; }
}
const unused = Object.keys(ui).filter(k => !used.has(k));
if (unused.length) console.warn(`WARN   ${unused.length} unused key(s): ${unused.slice(0, 5).map(k => JSON.stringify(k)).join(", ")}${unused.length > 5 ? " …" : ""}`);
console.log(err ? `FAIL  ${err} error(s)` : `PASS  ${used.size} keys used, ${Object.keys(ui).length} in table`);
process.exit(err ? 1 : 0);
