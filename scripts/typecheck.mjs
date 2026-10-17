#!/usr/bin/env node
// tsconfig.json を持つ package（packages/*・sdk/*）とアプリ（apps/*・入口だけ TS・2026-10-17）を strict で型検査する（TS化 段 1・2026-10-15）。root の `npm run typecheck`＝npm test の門の一つ。
// 使い方: node scripts/typecheck.mjs [絞り込み語…]（例：ephem）
// worker の入口を持つ package は tsconfig.worker.json（lib webworker・include＝worker の入口だけ）を並べて置き、本体の tsconfig.json はその入口を exclude する
//（DOM と webworker の lib は一つの program に同居できない）。ここは tsconfig.worker.json があればそれも検査する（例：packages/jp の estat-worker.ts・2026-10-15）。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const words = process.argv.slice(2);
const dirs = [];
// アプリは入口（index.html が読む main.ts 等）だけが TS＝tsconfig.json は root の tsconfig.app.json（bundler 解決・allowJs で JS の中身は推論だけ・noEmit）を継ぐ。himekuri/lib のような入れ子の workspace も拾う
const appDirs = ["apps", "apps/himekuri"];
for (const base of ["packages", "sdk", ...appDirs]) for (const e of fs.readdirSync(path.join(ROOT, base), { withFileTypes: true })) {
	const d = path.join(base, e.name);
	if (!e.isDirectory() || !fs.existsSync(path.join(ROOT, d, "tsconfig.json")) || (words.length && !words.some(w => d.includes(w)))) continue;
	dirs.push(d);
	// worker 用の第 2 プログラム（lib: webworker＝onmessage／postMessage を持つ decoder・encoder・worker の入口）は tsconfig.worker.json＝あれば続けて回す（geopbf・TS 化 段 3）
	const w = path.join(d, "tsconfig.worker.json");
	if (fs.existsSync(path.join(ROOT, w))) dirs.push(w);
}
let bad = 0;
for (const d of dirs) {
	const t0 = Date.now();
	const r = spawnSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", d, "--noEmit"], { cwd: ROOT, encoding: "utf8" });
	const ok = r.status === 0;
	console.log(`${ok ? "✓" : "✗"} typecheck ${d} 〔${((Date.now() - t0) / 1000).toFixed(1)}s〕`);
	if (!ok) { bad++; process.stdout.write(r.stdout + r.stderr); }
}
console.log(bad ? `✗ ${bad}/${dirs.length} package で型エラー` : `✓ ${dirs.length} package すべて型検査 OK`);
process.exit(bad ? 1 : 0);
