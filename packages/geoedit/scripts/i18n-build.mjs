#!/usr/bin/env node
// i18n/ui.json（{ ui: { 英語キー: { ja, zh, … } } }）→ i18n/lang/<code>.json（{ 英語キー: 訳 }・空＝英語のままは落とす）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = JSON.parse(fs.readFileSync(path.join(PKG, "i18n/ui.json"), "utf8")).ui ?? {};
const codes = new Set(); for (const row of Object.values(ui)) for (const c of Object.keys(row)) codes.add(c);
const out = path.join(PKG, "i18n/lang"); fs.mkdirSync(out, { recursive: true });
for (const code of [...codes].sort()) {
	const table = {}; for (const [k, row] of Object.entries(ui)) if (row[code]) table[k] = row[code];
	fs.writeFileSync(path.join(out, `${code}.json`), JSON.stringify(table, null, 0) + "\n");
	console.log(`${code.padEnd(3)} ${String(Object.keys(table).length).padStart(4)} keys`);
}
