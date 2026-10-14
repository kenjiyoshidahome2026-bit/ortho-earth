#!/usr/bin/env node
// 門：アプリが別のアプリを読んでいないかを数える爪車（本人 2026-10-14「アプリがアプリを読んでいるのが基本的な問題。2 つ以上で使うならモジュールにして共に参照」）。
//   数える物＝apps/<A> のソース（js/mjs/html/css・vite.config・package.json の scripts）から apps/<B>（B≠A）へ届く参照
//     ・相対パスの文字列（'../ortho-japan/app.js'・new URL("../../census2020/…", import.meta.url)・path.resolve(__dirname, '../ortho-globe/public')）
//     ・アプリの workspace 名での import（import("ortho-equal/src/equal.js")）
//     ・package.json の scripts の中の ../<B>/ の道
//   例外＝www（他のアプリの dist と docs を束ねて載せる集約役・本人 2026-10-14「やっていいのは、www だけ」）。
//   許可表＝scripts/app-imports-allow.json（A→B ごとの数と理由）。超えたら・表に無い組が出たら落ちる。減ったら `--ratchet` で枠を下げる（上げない）。
//   移し先＝2 つ以上で使う物は packages/*、実行時に共有する物は /globe/engine/<版>/ の入口（modules/proposal-2026-10-14.md §6）。
// 使い方: node scripts/check-app-imports.mjs [--ratchet] [--list]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APPS = path.join(ROOT, "apps");
const ALLOW_FILE = path.join(ROOT, "scripts/app-imports-allow.json");
const EXEMPT = new Set(["www"]);
const SKIP_DIR = new Set(["node_modules", "dist", ".wrangler", ".vite", "coverage"]);
const EXT = /\.(m?js|html|css)$/;

const apps = fs.readdirSync(APPS, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name);   // package.json の無いアプリ（quakes-mirror 等の Worker）も 1 つのアプリ
const pkgName = new Map(apps.filter(a => fs.existsSync(path.join(APPS, a, "package.json"))).map(a => [JSON.parse(fs.readFileSync(path.join(APPS, a, "package.json"), "utf8")).name, a]));

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => SKIP_DIR.has(e.name) || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const appSet = new Set(apps);
const appOf = abs => { const r = path.relative(APPS, abs); if (r.startsWith("..") || path.isAbsolute(r)) return null; const a = r.split(path.sep)[0]; return appSet.has(a) ? a : null; };
// 相対の道はファイルの置き場起点（import・new URL）とアプリ起点（path.join(APP, …)・vite.config の resolve）の両方があり得る＝実在する方を採る
const target = (bases, ref) => { const c = bases.map(b => path.resolve(b, ref.replace(/[?#].*$/, ""))); return appOf(c.find(x => fs.existsSync(x)) ?? c[0]); };

// 行の // コメントを外す（文字列の中の // ＝URL は残す：直前が : か 引用の中なら外さない・粗いが参照の文字列を拾うには足りる）
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(l => {
	let q = null;
	for (let i = 0; i < l.length; i++) {
		const c = l[i];
		if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
		if (c === '"' || c === "'" || c === "`") q = c;
		else if (c === "/" && l[i + 1] === "/") return l.slice(0, i);
	}
	return l;
}).join("\n");

const hits = [];   // [from, to, file, ref]
for (const from of apps) {
	if (EXEMPT.has(from)) continue;
	const dir = path.join(APPS, from);
	for (const file of walk(dir)) {
		const rel = path.relative(ROOT, file);
		const base = path.dirname(file);
		if (path.basename(file) === "package.json") {
			const scripts = JSON.parse(fs.readFileSync(file, "utf8")).scripts || {};
			for (const cmd of Object.values(scripts))
				for (const m of cmd.matchAll(/(?:^|[\s=])((?:\.\.\/)+[^\s&|;"'<>]+)/g)) {
					const to = target([dir], m[1]);
					if (to && to !== from) hits.push([from, to, rel, m[1]]);
				}
			continue;
		}
		if (!EXT.test(file) && !/vite\..*config\.m?js$/.test(file)) continue;
		const src = stripComments(fs.readFileSync(file, "utf8"));
		for (const m of src.matchAll(/(["'`])((?:\.\.\/)+[^"'`\n]*)\1/g)) {
			const to = target([base, dir], m[2]);
			if (to && to !== from) hits.push([from, to, rel, m[2]]);
		}
		for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g)) {
			const spec = m[2];
			const name = [...pkgName.keys()].find(n => spec === n || spec.startsWith(n + "/"));
			const to = name && pkgName.get(name);
			if (to && to !== from) hits.push([from, to, rel, spec]);
		}
	}
}

const count = {};
for (const [from, to] of hits) count[`${from} → ${to}`] = (count[`${from} → ${to}`] || 0) + 1;
const allowDoc = fs.existsSync(ALLOW_FILE) ? JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8")) : { allow: {} };
const allow = allowDoc.allow;

if (process.argv.includes("--list")) for (const [from, to, file, ref] of hits) console.log(`${from} → ${to}\t${file}\t${ref}`);

const over = [], under = [];
for (const [k, n] of Object.entries(count)) { const a = allow[k]?.n ?? 0; if (n > a) over.push([k, n, a]); else if (n < a) under.push([k, n, a]); }
for (const [k, a] of Object.entries(allow)) if (!(k in count)) under.push([k, 0, a.n]);

if (process.argv.includes("--ratchet")) {
	for (const [k, n] of under) { if (n === 0) delete allow[k]; else allow[k].n = n; }
	fs.writeFileSync(ALLOW_FILE, JSON.stringify(allowDoc, null, "\t") + "\n");
	console.log(`ratchet: ${under.length} 組の枠を下げた`);
}
if (over.length) {
	console.error(`✗ アプリが別のアプリを読んでいる（許可表 scripts/app-imports-allow.json を超えた）：`);
	for (const [k, n, a] of over) {
		console.error(`   ${k}  ${n}（枠 ${a}）`);
		const [from, to] = k.split(" → ");
		for (const h of hits.filter(h => h[0] === from && h[1] === to)) console.error(`      ${h[2]}  ${h[3]}`);
	}
	console.error(`   2 つ以上で使う物は packages/* へ（実行時の共有は /globe/engine/<版>/ の入口）。例外は www だけ。`);
	process.exit(1);
}
const total = Object.values(count).reduce((s, n) => s + n, 0);
console.log(`✓ アプリ→アプリの参照 ${total} 件（${Object.keys(count).length} 組）＝許可表の内${under.length && !process.argv.includes("--ratchet") ? `・${under.length} 組は枠より少ない＝ --ratchet で下げる` : ""}`);
