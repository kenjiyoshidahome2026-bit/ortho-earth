#!/usr/bin/env node
// i18n の門（yokohama・quakes の門の写し）：この殻のファイル（頁＝yokohama）が呼ぶ英語キーが、頁の辞書か本体（globe の ui.json）に揃っているか。
// 門の中身（①〜⑥）は globe の共通の道具 scripts/lib/i18n-shell.mjs の verifyShellI18n（23 の殻で同じ物）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyShellI18n } from "@ortho-earth/globe/scripts/lib/i18n-shell.mjs";

process.exit(verifyShellI18n(path.dirname(path.dirname(fileURLToPath(import.meta.url))), { strict: process.argv.includes("--strict") }));
