#!/usr/bin/env node
// 行カバレッジを測る（手動で回す用・CI には載せない・2026-10-17）。`npm run coverage`
//   ・root の npm test（scripts/test-all.mjs）を NODE_V8_COVERAGE 付きで回す。typecheck は tsc 自身を測るだけで重い（123 秒→倍）ので外す
//   ・c8 で packages/*/src・sdk/*/src・apps の .ts/.js を集める（--all＝一度も読まれないファイルも 0% で数える＝ブラウザ検定だけが通る描画・UI 側はここで 0%）
//   ・出力：coverage/index.html（ファイル別）と端末の package 別の表（読まれたファイル数／全ファイル数・行）
// 使い方: npm run coverage [-- 絞り込み語…]（test-all.mjs と同じ絞り込み。例：`npm run coverage -- ortho-core`）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "coverage"), RAW = path.join(OUT, "tmp");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });

const t = spawnSync(process.execPath, [path.join(ROOT, "scripts/test-all.mjs"), "--skip", "typecheck", ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_V8_COVERAGE: RAW } });

const c8 = spawnSync(path.join(ROOT, "node_modules/.bin/c8"), [
	"report", "--temp-directory", RAW, "--report-dir", OUT, "--reporter", "html", "--reporter", "json-summary",
	"--all", "--src", ROOT,
	"--include", "packages/*/src/**", "--include", "sdk/*/src/**", "--include", "apps/**",
	"--exclude", "**/node_modules/**", "--exclude", "**/dist/**", "--exclude", "**/tests/**", "--exclude", "**/scripts/**", "--exclude", "**/public/**", "--exclude", "**/*.d.ts",
	"--extension", ".ts", "--extension", ".tsx", "--extension", ".js", "--extension", ".mjs",
], { cwd: ROOT, stdio: "inherit" });
fs.rmSync(RAW, { recursive: true, force: true });
if (c8.status) process.exit(c8.status);

// package 別にまとめる（packages/x・sdk/x・apps/x）。行の多い順
const sum = JSON.parse(fs.readFileSync(path.join(OUT, "coverage-summary.json"), "utf8"));
const pkgs = new Map();
for (const [f, v] of Object.entries(sum)) {
	if (f === "total") continue;
	const k = path.relative(ROOT, f).split(path.sep).slice(0, 2).join("/");
	const p = pkgs.get(k) || { files: 0, hit: 0, covered: 0, total: 0 };
	p.files++; if (v.lines.covered) p.hit++;
	p.covered += v.lines.covered; p.total += v.lines.total;
	pkgs.set(k, p);
}
const pct = (c, n) => n ? `${(100 * c / n).toFixed(1)}%` : "-";
console.log(`\n${"package".padEnd(28)} ${"読まれた/全ファイル".padStart(12)} ${"行".padStart(17)}`);
for (const [k, p] of [...pkgs].sort((a, b) => b[1].total - a[1].total))
	console.log(`${k.padEnd(28)} ${`${p.hit}/${p.files}`.padStart(12)} ${`${p.covered}/${p.total}`.padStart(13)} ${pct(p.covered, p.total).padStart(6)}`);
const T = sum.total.lines;
console.log(`\n全体 ${T.covered}/${T.total} 行 ${pct(T.covered, T.total)}・ファイル別＝coverage/index.html`);
process.exit(t.status ?? 1);
