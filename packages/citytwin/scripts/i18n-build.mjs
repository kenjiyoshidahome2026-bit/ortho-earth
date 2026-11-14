#!/usr/bin/env node
// 共通の辞書（i18n/pages/citytwin.json）から、実行時が読む薄い表 i18n/lang/citytwin/<code>.json を焼く（中身は殻のアプリと同じ道具 buildShellI18n）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShellI18n } from "@ortho-earth/globe/scripts/lib/i18n-shell.mjs";

buildShellI18n(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
