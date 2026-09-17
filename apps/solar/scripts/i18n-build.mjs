#!/usr/bin/env node
// 訳の正本 i18n/ui.json から、実行時が読む薄い表を焼く（ortho-japan の scripts/i18n-build.mjs と同じ型）。
//   i18n/langs.js        … 言語一覧（正本は packages/world/i18n/langs.json＝一覧は全アプリで 1 本）。
//                           .json でなく .js なのは、Node が JSON の静的 import に import 属性を要求するため。
//   i18n/lang/<code>.json … その言語の { "<英語キー>": "訳" }。空文字（意図して英語）と欠落は落とす＝
//                           実行時は「表に無い＝英語（キー）」の一本道で、二つを区別しなくてよい。
// en は表を持たない＝キーそのもの。ja も他言語と同じ遅延 import（母語だけ特別扱いしない）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = JSON.parse(fs.readFileSync(path.join(APP, "i18n/ui.json"), "utf8")).ui ?? {};
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8"));
const outDir = path.join(APP, "i18n/lang");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(APP, "i18n/langs.js"), "// 生成物＝npm run i18n:build（正本は packages/world/i18n/langs.json）。手で編集しない。\nexport default " + JSON.stringify(langs) + ";\n");

const rows = [];
for (const { code } of langs) {
	if (code === "en") continue;                                   // 英語＝キーそのもの＝表は要らない
	const table = {};
	for (const [key, row] of Object.entries(ui)) if (row[code]) table[key] = row[code];
	const keys = Object.keys(table).sort();
	const body = JSON.stringify(Object.fromEntries(keys.map(k => [k, table[k]])));
	const file = path.join(outDir, `${code}.json`);
	if (!keys.length) { fs.existsSync(file) && fs.rmSync(file); rows.push([code, 0, 0]); continue; }
	fs.writeFileSync(file, body + "\n");
	rows.push([code, keys.length, Buffer.byteLength(body)]);
}
console.log(`ui.json: ${Object.keys(ui).length} keys`);
console.log("lang  translated  bytes");
for (const [code, n, b] of rows) console.log(`${code.padEnd(5)} ${String(n).padStart(9)}  ${n ? (b / 1024).toFixed(1) + " KB" : "(no file)"}`);
