#!/usr/bin/env node
// npm に載る物の長さの門（2026-11-03・npm の齟齬確認）。`npm test` の葉（root の test:npm-meta）。
// 公開する workspace（private でない package.json）ごとに見る：
//   description ≤ 255 文字＝npm の登録簿がそこで切る（10 本が語の途中で切れて載っていた）
//   README.md ≤ 64 KB（65,536 バイト）＝登録簿がそこで切る（geopbf の README は末尾の License が落ちていた）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DESC_MAX = 255, README_MAX = 65536;
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const dirs = [];
for (const g of rootPkg.workspaces) {
	if (!g.endsWith("/*")) { dirs.push(path.join(ROOT, g)); continue; }
	const base = path.join(ROOT, g.slice(0, -2));
	for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(base, e.name));
}
const bad = [];
let n = 0;
for (const d of dirs) {
	const pj = path.join(d, "package.json");
	if (!fs.existsSync(pj)) continue;
	const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
	if (pkg.private) continue;
	n++;
	const rel = path.relative(ROOT, d);
	const desc = pkg.description || "";
	if (desc.length > DESC_MAX) bad.push(`${rel}/package.json: description ${desc.length} 文字（上限 ${DESC_MAX}）`);
	const rm = path.join(d, "README.md");
	if (fs.existsSync(rm)) { const b = fs.statSync(rm).size; if (b > README_MAX) bad.push(`${rel}/README.md: ${b} バイト（上限 ${README_MAX}）`); }
}
if (bad.length) { console.error(`✗ npm で切れる物 ${bad.length} 件：\n  ` + bad.join("\n  ")); process.exit(1); }
console.log(`✓ npm の description と README の長さ（公開 ${n} 本を検査）`);
