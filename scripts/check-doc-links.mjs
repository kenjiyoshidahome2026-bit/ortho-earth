#!/usr/bin/env node
// 文書の相対リンク切れの門（2026-11-02・文書の整理 PR 4）。`npm test` の葉（root の test:docs-links）。
// 見る物＝root・docs/・packages/*・sdk/*・apps/* の .md（node_modules・dist・tests/fixtures は外す）。
// 見るリンク＝[文](相対パス) と ![絵](相対パス)。http(s):・mailto:・#だけ・<…> の自動リンクは見ない。#節 と ?問い は外してファイルの有無だけ見る。
// 文書を動かしたら参照も直す、の守り（docs/README.md の表と合わせて「正本は 1 か所」を保つ）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 記録として凍結した文書＝v1（ortho-map・ortho-japan の app.js）の行番号つきリンクで書かれ、指す先がもう無い。直さずに残す。
const FROZEN = new Set(["apps/japan-map/docs/jetsam.md", "apps/japan-map/docs/zoom-control.md"]);
const SKIP = new Set(["node_modules", "dist", ".git", "fixtures", "gate-results", "ortho-data"]);

function* walk(dir, depth) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { if (depth > 0) yield* walk(p, depth - 1); }
		else if (e.name.endsWith(".md")) yield p;
	}
}
const files = [...walk(ROOT, 0), ...walk(path.join(ROOT, "docs"), 3)];
for (const top of ["packages", "sdk", "apps"]) for (const e of fs.readdirSync(path.join(ROOT, top), { withFileTypes: true })) if (e.isDirectory()) files.push(...walk(path.join(ROOT, top, e.name), 3));

const LINK = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const bad = [];
for (const f of files) {
	if (FROZEN.has(path.relative(ROOT, f).split(path.sep).join("/"))) continue;
	const text = fs.readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
	for (const m of text.matchAll(LINK)) {
		const href = m[1];
		if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
		const target = decodeURIComponent(href.replace(/[#?].*$/, ""));
		if (!target) continue;
		const abs = target.startsWith("/") ? path.join(ROOT, target) : path.resolve(path.dirname(f), target);
		if (!fs.existsSync(abs)) bad.push(`${path.relative(ROOT, f)}: ${href}`);
	}
}
if (bad.length) {
	console.error(`✗ 文書の相対リンク切れ ${bad.length} 件（${files.length} 本を検査）\n  ` + bad.join("\n  "));
	process.exit(1);
}
console.log(`✓ 文書の相対リンク切れ 0 件（${files.length} 本を検査）`);
