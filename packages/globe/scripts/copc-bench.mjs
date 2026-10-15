#!/usr/bin/env node
// COPC の計測（点群計画 段 0・2026-10-15）＝tests/t-copcbench.html を実時間の Chrome で流し、数字を TSV で出す。検定ではない（合否は「節が落ちなかった」だけ）。
// 使い方: packages/globe で `node scripts/copc-bench.mjs [名前…]`（名前＝下の SETS の鍵・省略で全部）
//   既定は本物の GPU（REALGPU＝Kenji の Mac）。GPU の無い所（クラウドのコンテナ）は BENCH_SWIFT=1（フレームの数字は当てにならない）
//   --out=<file.tsv> で TSV を書き出す（並べて比べる用・globe-split の baseline と同じ形）。BENCH_PORT で口を逃がす
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runRealtime, SWIFTSHADER, REALGPU } from "./lib/ui-runner.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.BENCH_PORT || 5249;
const SETS = {
	fixture: null,   // 合成 10 万点（fixtures）
	atami: "https://kenjiyoshidahome2026-bit.github.io/ortho-data/japan/pointcloud/atami-08NF2392.copc.laz",   // 静岡県 熱海 951 万点・77 MB（VIRTUAL SHIZUOKA・CC BY 4.0）
	autzen: "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz",   // PDAL の見本 1,070 万点・81 MB（LCC フィート）
};
const args = process.argv.slice(2), names = args.filter(a => !a.startsWith("--")), outArg = args.find(a => a.startsWith("--out="))?.slice(6);
const run = names.length ? names : Object.keys(SETS);
for (const n of run) if (!(n in SETS)) { console.error(`知らない名前: ${n}（${Object.keys(SETS).join("・")}）`); process.exit(1); }

const stop = await startVite({ cwd: PKG, port: PORT, portEnv: "BENCH_PORT", readyUrl: `http://localhost:${PORT}/tests/` });
const rows = [["set", "open", "first", "fit.settle", "fit.req", "fit.MB", "near.settle", "close.settle", "close.req", "close.MB", "close.points", "decode/node", "proj/node", "decode.sum", "proj.sum", "affine", "spin.p50", "spin.p95", "spin.max", "heapMB"]];
let fail = 0;
try {
	for (const [i, n] of run.entries()) {
		const url = `http://localhost:${PORT}/tests/t-copcbench.html${SETS[n] ? `?src=${encodeURIComponent(SETS[n])}` : ""}`;
		const title = await runRealtime(url, { limitS: 600, profilePrefix: "copc-bench", seq: i + 1, flags: process.env.BENCH_SWIFT ? SWIFTSHADER : REALGPU });
		const m = /^(PASS|FAIL) \[bench\] (.*)$/.exec(title);
		if (!m) { console.log(`FAIL  ${n}  ${title.slice(0, 300)}`); fail++; continue; }
		const r = JSON.parse(m[2]), MB = b => (b / 1048576).toFixed(1);
		if (m[1] === "FAIL") fail++;
		rows.push([n, r.open, r.first, r.fit.settle, r.fit.requests, MB(r.fit.bytes), r.near.settle, r.close.settle, r.close.requests, MB(r.close.bytes), r.close.points,
			r.worker.perNode?.decode, r.worker.perNode?.proj, r.worker.decode, r.worker.proj, `${r.worker.affine ?? "-"}/${r.worker.nodes}`, r.spin.p50, r.spin.p95, r.spin.max, r.mem]);
		console.log(`${m[1]}  ${n}  ${m[2]}`);
	}
} finally { stop(); }
const tsv = rows.map(r => r.join("\t")).join("\n") + "\n";
console.log("\n" + tsv);
if (outArg) fs.writeFileSync(outArg, tsv);
process.exit(fail ? 1 : 0);
