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
import { loadPages } from "./lib/i18n-pages.mjs";

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
	if (!keys.length && code !== "ja") { fs.existsSync(file) && fs.rmSync(file); rows.push([code, 0, 0]); continue; }
	fs.writeFileSync(file, body + "\n");
	rows.push([code, keys.length, Buffer.byteLength(body)]);
}
// showcase ページの辞書（i18n/pages/<page>.json）＝i18n/lang/<page>/<code>.json へ。SDK（本体）は運ばない＝そのページの chunk だけが読む
const { tables } = loadPages(APP);
for (const [page, tbl] of Object.entries(tables)) {
	const dir = path.join(outDir, page); fs.mkdirSync(dir, { recursive: true });
	let nLangs = 0;
	for (const { code } of langs) {
		if (code === "en") continue;
		const table = {};
		for (const [key, row] of Object.entries(tbl)) if (row[code]) table[key] = row[code];
		const keys = Object.keys(table).sort(), file = path.join(dir, `${code}.json`);
		if (!keys.length) { fs.existsSync(file) && fs.rmSync(file); continue; }
		fs.writeFileSync(file, JSON.stringify(Object.fromEntries(keys.map(k => [k, table[k]]))) + "\n");
		nLangs++;
	}
	console.log(`pages/${page}.json: ${Object.keys(tbl).length} keys -> lang/${page}/ (${nLangs} languages)`);
}
const total = Object.keys(ui).length;
console.log(`ui.json: ${total} keys`);
console.log("lang  translated  bytes");
for (const [code, n, b] of rows) console.log(`${code.padEnd(5)} ${String(n).padStart(9)}  ${n ? (b / 1024).toFixed(1) + " KB" : "(no file)"}`);
