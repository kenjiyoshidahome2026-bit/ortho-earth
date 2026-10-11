#!/usr/bin/env node
// 関門の node 検定を**並べて**回す走らせ台（2026-10-03・関門の最適化 段 3）。root の `npm test` はこれ。
// 旧＝package.json の test が `npm test -w A && npm test -w B && …` の直列の鎖（19 段・83 秒）で、
//   ・1 本落ちると `&&` が鎖を切り、後ろの検定は走らない（globe は expr-golden の既知の 6 件で止まり、mlcompat 以降 8 本が走っていなかった）
//   ・npm の起動（1 段 0.3 秒）が 20 回以上・solar の test が ephem の test をもう一度回していた
// ここは
//   ・各 workspace の package.json の test（と nested の `npm run X`）を読んで `&&` の鎖を葉（node tests/x.mjs）までほどく＝検定の一覧は各 package の scripts が正本のまま
//   ・同じ葉（同じ cwd・同じ命令）は 1 回だけ（solar→ephem の重複）
//   ・CPU の数だけ並べて回す（TEST_JOBS=N で変える・1 で直列）。出力は葉ごとに溜めて**元の並び順**で出す（混ざらない）
//   ・落ちても止めず全部回し、最後に落ちた葉の一覧と遅い葉を出す。exit 1＝どれか落ちた
// 使い方: node scripts/test-all.mjs [--gate test|i18n] [--list] [絞り込み語…]（例：`node scripts/test-all.mjs geopbf` ＝葉の cwd か命令に geopbf を含む物だけ）
//   TEST_VERBOSE=1＝通った葉の出力も全部出す
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// root の関門。workspace 名＝package.json の name
//   test＝旧 package.json の test の鎖と同じ並び（node の検定・regionless・mirrors）
//   i18n＝各アプリの verify:i18n（5 本・ブラウザ不要）＝`npm run verify:i18n`（root）
const GATES = {
	test: [
		["@ortho-earth/core", "test"], ["@ortho-earth/tile-formats", "test"], ["@ortho-earth/columnar", "test"], ["geopbf", "test"], ["altpbf", "test"],
		["@ortho-earth/ephem", "test"], ["space-data", "test"], ["glbconv", "test"], ["@ortho-earth/japan", "test"], ["ortho-equal", "test"], ["solar", "test"],
		["account", "test"], ["www", "test"], ["native-bucket", "test:proxy"], ["native-bucket", "test:tellus"], ["native-bucket", "test:bucket"],
		["@ortho-earth/globe", "test"], ["@ortho-earth/globe", "verify:regionless"], [".", "test:mirrors"],
	],
	i18n: [["@ortho-earth/japan", "verify:i18n"], ["ortho-globe", "verify:i18n"], ["www", "verify:i18n"], ["solar", "verify:i18n"], ["geopbf-demo", "verify:i18n"]],
};

// workspace 名 → ディレクトリ（root の workspaces の glob を歩く）
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const dirs = new Map([[".", ROOT]]);
for (const g of rootPkg.workspaces) {
	const base = path.join(ROOT, g.replace(/\/\*$/, ""));
	for (const e of fs.readdirSync(base, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const pj = path.join(base, e.name, "package.json");
		if (fs.existsSync(pj)) dirs.set(JSON.parse(fs.readFileSync(pj, "utf8")).name, path.join(base, e.name));
	}
}
const scriptsOf = dir => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts || {};

// `npm test -w X`／`npm run -s X -w W`／`npm run X`／`npm test` を葉までほどく。それ以外の命令は葉。
function leaves(dir, script, trail = []) {
	const src = scriptsOf(dir)[script];
	if (src == null) throw new Error(`${path.relative(ROOT, dir) || "."}: scripts.${script} が無い`);
	const out = [];
	for (const cmd of src.split(/\s+&&\s+/)) {
		const m = /^npm\s+(?:run\s+)?(?:-s\s+|--silent\s+)?(test|[\w:.-]+)(?:\s+-s)?(?:\s+-w\s+(\S+))?\s*$/.exec(cmd.trim());
		if (m) {
			const [, sc, ws] = m;
			const d = ws ? dirs.get(ws) : dir;
			if (!d) throw new Error(`workspace ${ws} が見当たらない`);
			const key = `${d}#${sc}`;
			if (trail.includes(key)) throw new Error(`scripts が循環している: ${[...trail, key].join(" → ")}`);
			out.push(...leaves(d, sc, [...trail, key]));
		} else out.push({ dir, cmd: cmd.trim() });
	}
	return out;
}

const argv = process.argv.slice(2);
const gateName = argv[argv.indexOf("--gate") + 1] || "test";
const GATE = GATES[argv.includes("--gate") ? gateName : "test"];
if (!GATE) { console.error(`--gate は ${Object.keys(GATES).join("／")} のどれか`); process.exit(2); }
const list = argv.includes("--list"), words = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--gate");
const seen = new Set();
let jobs = [];
for (const [ws, sc] of GATE) {
	const d = dirs.get(ws);
	if (!d) { console.error(`workspace ${ws} が見当たらない`); process.exit(2); }
	for (const L of leaves(d, sc)) {
		const key = `${L.dir}\0${L.cmd}`;
		if (seen.has(key)) continue;   // 同じ葉は 1 回（solar の test が ephem の test を含む）
		seen.add(key);
		jobs.push({ ...L, rel: path.relative(ROOT, L.dir) || ".", ws });
	}
}
if (words.length) jobs = jobs.filter(j => words.some(w => j.rel.includes(w) || j.cmd.includes(w) || j.ws.includes(w)));
if (list) { for (const j of jobs) console.log(`${j.rel.padEnd(28)} ${j.cmd}`); process.exit(0); }
if (!jobs.length) { console.error("該当する検定が無い"); process.exit(2); }

// 葉を 1 本回す（cwd＝package・node_modules/.bin を PATH に＝npm run と同じ）。出力は溜めて返す
const binPath = [path.join(ROOT, "node_modules/.bin"), process.env.PATH].join(path.delimiter);
const run = j => new Promise(res => {
	const t0 = Date.now();
	let out = "";
	const p = spawn("sh", ["-c", j.cmd], { cwd: j.dir, env: { ...process.env, PATH: binPath }, stdio: ["ignore", "pipe", "pipe"] });
	p.stdout.on("data", b => { out += b; }); p.stderr.on("data", b => { out += b; });
	p.on("error", e => res({ ...j, code: 1, out: out + "\n" + e.message, s: (Date.now() - t0) / 1000 }));
	p.on("close", code => res({ ...j, code, out, s: (Date.now() - t0) / 1000 }));
});

const N = Math.max(1, Math.min(+process.env.TEST_JOBS || os.availableParallelism?.() || os.cpus().length || 1, jobs.length));
console.log(`node の検定 ${jobs.length} 本を ${N} 本ずつ並べて回す（TEST_JOBS=${N}）`);
const t0 = Date.now();
const res = new Array(jobs.length);
let printed = 0, k = 0;
const flush = () => {
	while (printed < jobs.length && res[printed]) {
		const r = res[printed++];
		const head = `${r.code ? "✗ FAIL" : "✓ PASS"}  ${r.rel}  ${r.cmd}  〔${r.s.toFixed(1)}s〕`;
		if (r.code) console.log(`\n${head}\n${r.out.trimEnd()}\n`);
		else { const tail = r.out.trim().split("\n").slice(-1)[0] || ""; console.log(`${head}${process.env.TEST_VERBOSE ? "\n" + r.out.trimEnd() : tail ? `  ${tail.slice(0, 100)}` : ""}`); }
	}
};
// 遅い葉から先に始める（前回の目安＝long）＝最後に長い葉が 1 本だけ残って待つ尻尾を短くする
const LONG = ["t-anchors", "raster.mjs", "elevation-resample", "t-pmtiles", "t-cli.mjs"];
const order = jobs.map((j, i) => i).sort((a, b) => (LONG.findIndex(w => jobs[a].cmd.includes(w)) + 1 || 99) - (LONG.findIndex(w => jobs[b].cmd.includes(w)) + 1 || 99) || a - b);
await Promise.all(Array.from({ length: N }, async () => { while (k < order.length) { const i = order[k++]; res[i] = await run(jobs[i]); flush(); } }));
flush();
const failed = res.filter(r => r.code);
const slow = [...res].sort((a, b) => b.s - a.s).slice(0, 5).map(r => `${path.basename(r.cmd.split(" ").pop())} ${r.s.toFixed(1)}s`).join("・");
console.log(`\n壁時計 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（${N} 本ずつ・葉の合計 ${res.reduce((s, r) => s + r.s, 0).toFixed(0)} 秒）・遅い葉：${slow}`);
console.log(failed.length ? `\n✗ ${failed.length}/${jobs.length} 本失敗：\n${failed.map(r => `  ${r.rel}  ${r.cmd}`).join("\n")}` : `\n✓ 全 ${jobs.length} 本 PASS`);
process.exit(failed.length ? 1 : 0);
