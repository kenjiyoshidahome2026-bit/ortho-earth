#!/usr/bin/env node
// 訳の正本 i18n/ui.json から、実行時が読む薄い表を焼く。
//   i18n/langs.js        … 言語一覧（world の packages/world/i18n/langs.json の写し＝一覧は 1 本）。
//                           .json でなく .js なのは、Node が JSON の静的 import に import 属性を要求するため
//                           （Vite は要らない＝食い違うと npm test だけが落ちる。2026-09-17 に実際に踏んだ）。
//   i18n/lang/<code>.json … その言語の { "<英語キー>": "訳" }。空文字（意図して英語）と欠落は落とす＝
//                           実行時は「表に無い＝英語（キー）」の一本道で、二つを区別する必要がない。
// ja は i18n.js が静的に import する（母語＝英語のちらつきを出さない・裁定 2026-09-16）。他言語は遅延 import。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { i18nTables } from "./lib/i18n-tables.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { files, rows, pageRows, total } = i18nTables(APP);   // 作る中身は verify:i18n の照合と同じ関数（焼き忘れはそちらで落ちる）
for (const [file, body] of files) {
	if (body == null) { fs.existsSync(file) && fs.rmSync(file); continue; }
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
}
for (const [page, n, nLangs] of pageRows) console.log(`pages/${page}.json: ${n} keys -> lang/${page}/ (${nLangs} languages)`);
console.log(`ui.json: ${total} keys`);
console.log("lang  translated  bytes");
for (const [code, n, b] of rows) console.log(`${code.padEnd(5)} ${String(n).padStart(9)}  ${n ? (b / 1024).toFixed(1) + " KB" : "(no file)"}`);
