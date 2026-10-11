#!/usr/bin/env node
// 訳の正本 i18n/ui.json から、実行時が読む薄い表 i18n/lang/<code>.json を焼く（表の作り方は globe の i18n-tables.mjs と同じ関数）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uiTables, writeTables, printRows } from "@ortho-earth/globe/scripts/lib/i18n-tables.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = JSON.parse(fs.readFileSync(path.join(APP, "i18n/ui.json"), "utf8")).ui ?? {};
const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8"));
const { files, rows, total } = uiTables(ui, langs, path.join(APP, "i18n/lang"));   // 作る中身は globe の i18n-tables.mjs と同じ関数（4 アプリで 1 本・2026-10-03）
writeTables(files);
printRows(rows, total);
