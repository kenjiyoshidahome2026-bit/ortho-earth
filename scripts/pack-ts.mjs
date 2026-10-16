#!/usr/bin/env node
// npm pack／publish の前後で package.json の口を src/*.ts ⇄ dist/*.js に差し替える（TS化 段 1・2026-10-15）。
//   リポジトリの中では exports が src/*.ts を直に指す＝Vite も node（型の剥ぎ取り）もビルド無しで読める。
//   npm に出す時だけ tsc で dist/（.js と .d.ts）を出し、package.json の口を dist/ へ向ける（node_modules の中の .ts は node が読まない）。
// 使い方（各 package の scripts）: "prepack": "node ../../scripts/pack-ts.mjs pre", "postpack": "node ../../scripts/pack-ts.mjs post"
// worker の URL：ソースは new URL("./x.ts", import.meta.url) と書く（リポジトリの中では Vite がそのまま読む）。tsc は import 文の拡張子は
//   書き換える（rewriteRelativeImportExtensions）が文字列は触らないので、pre が dist/**/*.js の new URL("…​.ts") を ".js" に直す（2026-10-15・段 3）。
// 段 5-9（2026-10-16）で足した分：
//   - tsconfig.worker.json があればそれも tsc する（worker の入口は本体の tsconfig から外してある＝これが無いと dist に worker が出ない）。
//   - src の .ts 以外（手書きの .js・.mjs・.d.ts・json・css・画像など）を dist の同じ場所へ写す。写した .js／.mjs／.d.ts の
//     相対の "….ts" は ".js" に直す（例：geopbf の src/maplibre.js → ./modules/geojson-load.ts）。
//   - 口の差し替えは main・exports・imports・types・sideEffects・bin の全部（"src/x.ts" の ./ 無しも・.mjs／.js／json はそのまま dist へ）。
//   - files の "src" は "dist" に置き換える（口は全部 dist を指す＝src の .ts は npm では読めない死に物）。"!src/…" は "!dist/…" に写す。
//   - files に入らない所を指す exports は落とす（globe の "./scripts/*"＝build の道具・Q6）。
//   - 一番上の手書きの .d.ts と types/ の .d.ts が "./src/x.ts" を指していれば "./dist/x.js" に直す（globe.d.ts → src/types/map.ts）。
//     元の中身は .pack-ts-backup/ に置き、post で戻す。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = process.cwd(), pj = path.join(dir, "package.json"), bak = path.join(dir, ".package.json.prepack"), bakDir = path.join(dir, ".pack-ts-backup");
const mode = process.argv[2];
// ./src/a/b.ts → ./dist/a/b.js・./src/a.mts → .mjs・./src/x.js／x.json／x.d.ts／i18n/* は拡張子そのままで dist へ
const distPath = v => {
	if (!v.startsWith("./src/") && !v.startsWith("src/")) return v;
	let r = v.slice(v.indexOf("src/") + 4);
	if (!/\.d\.[mc]?ts$/.test(r)) r = r.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js");
	return "./dist/" + r;
};
const toDist = v => typeof v === "string" ? distPath(v) : Array.isArray(v) ? v.map(toDist) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toDist(x)])) : v;

// 相対の "….ts"（.d.ts 以外）→ ".js"：new URL("./x.ts", …)・from "./x.ts"・import("./x.ts")。他の文字列は触らない
const fixSpecifiers = s => s
	.replace(/(new URL\(\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g, "$1$2.js$3")
	.replace(/(\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s+["'])(\.{1,2}\/[^"']+?)(?<!\.d)\.ts(["'])/g, "$1$2.js$3");
function walk(d, fn, rel = "") {
	if (!fs.existsSync(d)) return;
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const f = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name;
		if (e.isDirectory()) walk(f, fn, r); else fn(f, r);
	}
}
const isTsSource = n => /\.(m|c)?ts$/.test(n) && !/\.d\.(m|c)?ts$/.test(n);
const textLike = n => /\.(m?js|d\.ts)$/.test(n);
// 一つのファイルを書き換える前に .pack-ts-backup/ へ取っておく（post で戻す）
function rewriteWithBackup(f, fn) {
	const src = fs.readFileSync(f, "utf8"), out = fn(src);
	if (out === src) return false;
	const b = path.join(bakDir, path.relative(dir, f));
	fs.mkdirSync(path.dirname(b), { recursive: true });
	fs.writeFileSync(b, src);
	fs.writeFileSync(f, out);
	return true;
}

if (mode === "pre") {
	const dist = path.join(dir, "dist");
	fs.rmSync(dist, { recursive: true, force: true });   // 前の build の残り物を出さない
	const tsc = path.join(ROOT, "node_modules/.bin/tsc");
	execFileSync(tsc, ["-p", dir], { stdio: "inherit" });
	if (fs.existsSync(path.join(dir, "tsconfig.worker.json"))) execFileSync(tsc, ["-p", path.join(dir, "tsconfig.worker.json")], { stdio: "inherit" });
	// src の .ts 以外を dist へ写す（tsc が出した物は上書きしない）
	walk(path.join(dir, "src"), (f, r) => {
		if (isTsSource(r)) return;
		const to = path.join(dist, r);
		if (fs.existsSync(to)) return;
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(f, to);
	});
	walk(dist, f => { if (textLike(f)) { const s = fs.readFileSync(f, "utf8"), o = fixSpecifiers(s); if (o !== s) fs.writeFileSync(f, o); } });

	const raw = fs.readFileSync(pj, "utf8");
	fs.writeFileSync(bak, raw);
	const p = JSON.parse(raw);
	for (const k of ["main", "module", "types", "typings", "exports", "imports", "sideEffects", "bin"]) if (p[k] != null && typeof p[k] !== "boolean") p[k] = toDist(p[k]);
	if (Array.isArray(p.files)) {
		const files = p.files.flatMap(f => f === "src" || f === "src/" ? [] : /^!src\//.test(f) ? [f.replace(/^!src\//, "!dist/")] : [f]);
		if (!files.includes("dist")) files.unshift("dist");
		p.files = files;
		// files に入らない所を指す exports は落とす（Q6：globe の "./scripts/*"）
		const shipped = new Set(files.filter(f => !f.startsWith("!")).map(f => f.replace(/^\.\//, "").split("/")[0]));
		const targets = v => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(targets) : v && typeof v === "object" ? Object.values(v).flatMap(targets) : [];
		if (p.exports && typeof p.exports === "object" && !Array.isArray(p.exports)) for (const [k, v] of Object.entries(p.exports)) {
			const t = targets(v);
			if (k.startsWith(".") && t.length && t.every(x => x !== "./package.json" && !shipped.has(x.replace(/^\.\//, "").split("/")[0]))) { delete p.exports[k]; console.log(`pack-ts: exports "${k}" は files の外を指すので npm の版から外す`); }
		}
		// 一番上の .d.ts と types/ の .d.ts の "./src/x.ts"（types/ からは "../src/x.ts"）→ dist
		const dts = [];
		for (const f of files) {
			if (f.startsWith("!")) continue;
			const abs = path.join(dir, f);
			if (!fs.existsSync(abs)) continue;
			if (fs.statSync(abs).isDirectory()) { if (f.replace(/\/$/, "") !== "dist") walk(abs, x => { if (x.endsWith(".d.ts")) dts.push(x); }); }
			else if (f.endsWith(".d.ts")) dts.push(abs);
		}
		for (const f of dts) rewriteWithBackup(f, s => s.replace(/(["'])((?:\.\.?\/)+)src\/([^"']+?)(?<!\.d)\.ts\1/g, "$1$2dist/$3.js$1"));
	}
	fs.writeFileSync(pj, JSON.stringify(p, null, "\t") + "\n");
} else if (mode === "post") {
	if (fs.existsSync(bak)) { fs.copyFileSync(bak, pj); fs.unlinkSync(bak); }
	if (fs.existsSync(bakDir)) { walk(bakDir, (f, r) => fs.copyFileSync(f, path.join(dir, r))); fs.rmSync(bakDir, { recursive: true, force: true }); }
} else { console.error("usage: pack-ts.mjs pre|post"); process.exit(2); }
