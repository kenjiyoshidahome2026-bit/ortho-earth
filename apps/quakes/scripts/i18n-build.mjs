#!/usr/bin/env node
// 頁の辞書（i18n/pages/<page>.json）から、実行時が読む薄い表 i18n/lang/<page>/<code>.json を焼く（この殻の頁の表だけ）。
// 中身は globe の共通の道具 scripts/lib/i18n-shell.mjs の buildShellI18n（japan と同じ i18nTables）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShellI18n } from "@ortho-earth/globe/scripts/lib/i18n-shell.mjs";

buildShellI18n(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
