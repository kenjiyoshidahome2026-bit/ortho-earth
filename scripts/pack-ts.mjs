#!/usr/bin/env node
// npm pack／publish の前後で package.json の口を src/*.ts ⇄ dist/*.js に差し替える（TS化 段 1・2026-10-15）。
//   リポジトリの中では exports が src/*.ts を直に指す＝Vite も node（型の剥ぎ取り）もビルド無しで読める。
//   npm に出す時だけ tsc で dist/（.js と .d.ts）を出し、exports と main を dist/ へ向ける（node_modules の中の .ts は node が読まない）。
// 使い方（各 package の scripts）: "prepack": "node ../../scripts/pack-ts.mjs pre", "postpack": "node ../../scripts/pack-ts.mjs post"
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = process.cwd(), pj = path.join(dir, "package.json"), bak = path.join(dir, ".package.json.prepack");
const mode = process.argv[2];
const toDist = v => typeof v === "string" ? v.replace(/^\.\/src\/(.+)\.ts$/, "./dist/$1.js") : Array.isArray(v) ? v.map(toDist) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toDist(x)])) : v;

if (mode === "pre") {
	execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", dir], { stdio: "inherit" });
	const raw = fs.readFileSync(pj, "utf8");
	fs.writeFileSync(bak, raw);
	const p = JSON.parse(raw);
	if (p.main) p.main = toDist(p.main);
	if (p.exports) p.exports = toDist(p.exports);
	if (Array.isArray(p.files) && !p.files.includes("dist")) p.files.push("dist");
	fs.writeFileSync(pj, JSON.stringify(p, null, "\t") + "\n");
} else if (mode === "post") {
	if (fs.existsSync(bak)) { fs.copyFileSync(bak, pj); fs.unlinkSync(bak); }
} else { console.error("usage: pack-ts.mjs pre|post"); process.exit(2); }
