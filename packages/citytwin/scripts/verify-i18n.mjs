#!/usr/bin/env node
// i18n の門（市のデジタルツインの共通の芯）：src/ が呼ぶ英語キーが共通の辞書（i18n/pages/citytwin.json）か本体（globe の ui.json）に揃っているか。
// 市ごとの文言（区・名所・地下鉄・救急）は市の頁の辞書（apps/<市>/i18n/pages/<市>.json）＝ここには置かない（1 つのキーは 1 つの辞書だけ）。門の中身は殻のアプリと同じ verifyShellI18n。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyShellI18n } from "@ortho-earth/globe/scripts/lib/i18n-shell.mjs";

process.exit(verifyShellI18n(path.dirname(path.dirname(fileURLToPath(import.meta.url))), { strict: process.argv.includes("--strict") }));
