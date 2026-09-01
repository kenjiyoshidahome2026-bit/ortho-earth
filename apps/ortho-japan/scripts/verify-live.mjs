#!/usr/bin/env node
// デプロイ後の実配信検定：dist/site/japan の全 .js/.css/.pmtiles/.png を本番 URL で HEAD 相当（GET 1バイト）し、
// 非200を列挙する。背景＝2026-09-02: wrangler のアセットアップロードが renderworker チャンク1本だけ壊れて
// HTTP 500 を返し、本番の render worker が沈黙（WebGPU/GL2 とも frame1 不達→GL2固定化）。verify:prod は
// ローカル dist を実走するだけ＝「アップロードの成否」は誰も見ていなかった穴を塞ぐ。
// 使い方: node scripts/verify-live.mjs（deploy スクリプトが wrangler の後に自動実行）
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.join(APP, "dist/site/japan");
const BASE = "https://www.ortho-earth.com/japan";
const files = [];
(function walk(d) {
	for (const e of readdirSync(d)) {
		const p = path.join(d, e);
		if (statSync(p).isDirectory()) { walk(p); continue; }
		if (/\.(js|css|pmtiles|png|html|json)$/.test(e) && !e.endsWith(".map")) files.push(path.relative(ROOT, p));
	}
})(ROOT);
let bad = 0, done = 0;
const CONC = 12;
async function probe(rel) {
	const url = `${BASE}/${rel.split(path.sep).join("/")}`;
	try {
		const res = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store" });   // 1バイト＝転送費ほぼゼロ（Range無視の200全量でも即中断）
		res.body?.cancel?.().catch?.(() => {});
		if (!res.ok) { bad++; console.error(`✗ ${res.status} ${rel}`); }
	} catch (e) { bad++; console.error(`✗ fetch失敗 ${rel}: ${e.message}`); }
	done++;
}
for (let i = 0; i < files.length; i += CONC) await Promise.all(files.slice(i, i + CONC).map(probe));
if (bad) { console.error(`✗ 実配信の検定FAIL: ${bad}/${files.length} 本が非200＝アップロード破損の疑い（wrangler deploy をやり直す）`); process.exit(1); }
console.log(`✓ 実配信の検定PASS: ${files.length} 本すべて 200`);
