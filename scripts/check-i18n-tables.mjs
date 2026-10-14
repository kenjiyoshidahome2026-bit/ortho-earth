#!/usr/bin/env node
// 実行時の訳の表（packages/globe/src/i18n/lang/*.json・langs.js・japan のページ辞書）が正本から焼き直されているかだけを見る（verify:i18n ⑥ と同じ）。
// 本体の表を束ねる他のアプリ（nl・census2020・world・equal）の deploy の先頭で走らせる＝japan を出さずに他を出しても焼き忘れが本番へ行かない。
// 置き場＝root の scripts/（2026-10-14・旧 apps/ortho-japan/scripts/＝他のアプリが japan の中を読んでいた。apps は apps を読まない＝check-app-imports.mjs）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staleTables } from "@ortho-earth/globe/scripts/lib/i18n-tables.mjs";
const APP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "apps/ortho-japan");   // 頁の辞書の殻＝japan（正本の ui.json は packages/globe）
const stale = staleTables(APP);
if (stale.length) {
	console.error(`✗ ${stale.length} runtime translation table(s) are stale — run: npm run i18n:build -w @ortho-earth/japan (and commit the result)`);
	for (const [f, why] of stale) console.error(`   ${path.relative(process.cwd(), f)}  (${why})`);
	process.exit(1);
}
console.log("✓ runtime translation tables are up to date");
