#!/usr/bin/env node
// 訳の正本 i18n/ui.json から、実行時が読む薄い表 i18n/lang/<code>.json を焼く。
// 作法は equal / ortho-japan の scripts/i18n-build.mjs と同じ（空文字・欠落は落とす＝実行時は「表に無い＝英語」の一本道）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = JSON.parse(fs.readFileSync(path.join(APP, "i18n/ui.json"), "utf8")).ui ?? {};
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8"));
const outDir = path.join(APP, "i18n/lang");
fs.mkdirSync(outDir, { recursive: true });
const rows = [];
for (const { code } of langs) {
	if (code === "en") continue;
	const table = {};
	for (const [key, row] of Object.entries(ui)) if (row[code]) table[key] = row[code];
	const keys = Object.keys(table).sort();
	const file = path.join(outDir, `${code}.json`);
	if (!keys.length) { fs.existsSync(file) && fs.rmSync(file); rows.push([code, 0, 0]); continue; }
	const body = JSON.stringify(Object.fromEntries(keys.map(k => [k, table[k]])));
	fs.writeFileSync(file, body + "\n");
	rows.push([code, keys.length, Buffer.byteLength(body)]);
}
console.log(`ui.json: ${Object.keys(ui).length} keys`);
for (const [code, n, b] of rows) console.log(`${code.padEnd(5)} ${String(n).padStart(4)}  ${n ? (b / 1024).toFixed(1) + " KB" : "(no file)"}`);
