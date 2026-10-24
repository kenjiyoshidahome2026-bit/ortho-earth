#!/usr/bin/env node
// 頁の辞書（i18n/pages/<page>.json）から、実行時が読む薄い表 i18n/lang/<page>/<code>.json を焼く。
// 作る中身は globe の共通の道具（i18nTables＝japan と同じ関数）。そのうちこの殻の頁の表だけを書く
// ＝本体（globe の ui.json → packages/globe/src/i18n/lang）は持ち主の側で焼く。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { i18nTables } from "@ortho-earth/globe/scripts/lib/i18n-tables.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { files, pageRows } = i18nTables(APP);
for (const [file, body] of files) {
	if (!file.startsWith(APP + path.sep)) continue;
	if (body == null) { fs.existsSync(file) && fs.rmSync(file); continue; }
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
}
for (const [page, n, nLangs] of pageRows) console.log(`pages/${page}.json: ${n} keys -> lang/${page}/ (${nLangs} languages)`);
