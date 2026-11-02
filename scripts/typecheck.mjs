#!/usr/bin/env node
// tsconfig.json を持つ package（packages/*・sdk/*）とアプリ（apps/*・入口だけ TS・2026-10-17）を strict で型検査する（TS化 段 1・2026-10-15）。root の `npm run typecheck`＝npm test の門の一つ。
// 使い方: node scripts/typecheck.mjs [絞り込み語…]（例：ephem）
// tsc は project ごとに CPU の数だけ並べて回す（TYPECHECK_JOBS=N で変える・1 で直列）。直列だと 73 本で約 4 分＝PR の CI の待ちの 8 割（2026-11-02）。出力は元の並び順
// worker の入口を持つ package は tsconfig.worker.json（lib webworker・include＝worker の入口だけ）を並べて置き、本体の tsconfig.json はその入口を exclude する
//（DOM と webworker の lib は一つの program に同居できない）。ここは tsconfig.worker.json があればそれも検査する（例：packages/jp の estat-worker.ts・2026-10-15）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
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
const tsc = path.join(ROOT, "node_modules/.bin/tsc");
const run = d => new Promise(res => {
	const t0 = Date.now();
	let out = "";
	const p = spawn(tsc, ["-p", d, "--noEmit"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
	p.stdout.on("data", b => { out += b; }); p.stderr.on("data", b => { out += b; });
	p.on("error", e => res({ d, ok: false, out: out + "\n" + e.message, s: (Date.now() - t0) / 1000 }));
	p.on("close", code => res({ d, ok: code === 0, out, s: (Date.now() - t0) / 1000 }));
});
const N = Math.max(1, Math.min(+process.env.TYPECHECK_JOBS || os.availableParallelism?.() || os.cpus().length || 1, dirs.length));
const t0 = Date.now();
const res = new Array(dirs.length);
let k = 0, printed = 0;
const flush = () => {
	while (printed < dirs.length && res[printed]) {
		const r = res[printed++];
		console.log(`${r.ok ? "✓" : "✗"} typecheck ${r.d} 〔${r.s.toFixed(1)}s〕`);
		if (!r.ok) process.stdout.write(r.out);
	}
};
await Promise.all(Array.from({ length: N }, async () => { while (k < dirs.length) { const i = k++; res[i] = await run(dirs[i]); flush(); } }));
flush();
const bad = res.filter(r => !r.ok).length;
console.log(`壁時計 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（${N} 本ずつ）`);
console.log(bad ? `✗ ${bad}/${dirs.length} package で型エラー` : `✓ ${dirs.length} package すべて型検査 OK`);
process.exit(bad ? 1 : 0);
