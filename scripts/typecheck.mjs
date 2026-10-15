#!/usr/bin/env node
// tsconfig.json を持つ package（packages/*・sdk/*）を strict で型検査する（TS化 段 1・2026-10-15）。root の `npm run typecheck`＝npm test の門の一つ。
// 使い方: node scripts/typecheck.mjs [絞り込み語…]（例：ephem）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const words = process.argv.slice(2);
const dirs = [];
for (const base of ["packages", "sdk"]) for (const e of fs.readdirSync(path.join(ROOT, base), { withFileTypes: true })) {
	const d = path.join(base, e.name);
	if (e.isDirectory() && fs.existsSync(path.join(ROOT, d, "tsconfig.json")) && (!words.length || words.some(w => d.includes(w)))) dirs.push(d);
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
