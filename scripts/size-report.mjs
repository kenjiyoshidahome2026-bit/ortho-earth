#!/usr/bin/env node
// 配布物の容量台帳：各アプリの dist と npm 公開物を計り、JSON に刻む（縮小の前後比較の物差し）。
//   node scripts/size-report.mjs                    計るだけ（dist は既存のものを使う）
//   node scripts/size-report.mjs --build            先に全アプリをビルドしてから計る
//   node scripts/size-report.mjs --out=sizes/x.json 結果を JSON に保存
//   node scripts/size-report.mjs --compare=sizes/baseline-2026-09-30.json   基準線との差分を表で出す
// 数え方：.map は除外。gz は gzip -9（js/css/json/html/wasm/svg/txt/csv だけ・画像や圧縮済みは生のまま）。
// 「全体の実体」は内容の sha1 で同一ファイルを 1 つと数えた合計＝アプリ間でチャンクを共有できた時に効く数。
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = k => { const a = process.argv.find(s => s === `--${k}` || s.startsWith(`--${k}=`)); return a == null ? null : a.includes("=") ? a.slice(k.length + 3) : true; };

// 配布の単位＝[名前, ワークスペース, ビルドの script, 計る dist]
const APPS = [
	["japan-sdk", "@ortho-earth/japan", "build:lib", "apps/ortho-japan/dist/lib"],
	["japan-site", "@ortho-earth/japan", "build", "apps/ortho-japan/dist/site"],
	["globe", "ortho-globe", "build", "apps/ortho-globe/dist/site"],
	["world-lib", "ortho-world", "build:lib", "apps/world/dist/lib"],
	["world", "ortho-world", "build", "apps/world/dist/site"],
	["www", "www", "build", "apps/www/dist"],
	["equal", "ortho-equal", "build", "apps/equal/dist/site"],
	["geopbf-demo", "geopbf-demo", "build", "apps/geopbf-demo/dist"],
	["solar", "solar", "build", "apps/solar/dist/site"],
	["census2020", "census2020", "build", "apps/census2020/dist/site"],
	["gishub-jp", "gishub-jp", "build", "apps/gishub-jp/dist"],
	["nl", "ortho-nl", "build", "apps/ortho-nl/dist/site"],
	["uploader", "uploader", "build", "apps/uploader/dist"],
];
// www は build:all で他アプリの dist を複写して抱える＝単体ビルドの www だけを計る（複写分は各アプリで数える）
const PACKAGES = ["altpbf", "columnar", "common", "ephem", "geoedit", "geopbf", "glbconv", "globe", "himekuri", "native-bucket", "ortho-core", "quiet-mono", "tile-formats"];

const COMPRESSIBLE = /\.(m?js|css|json|html|wasm|svg|txt|csv|geojson|webmanifest|xml)$/i;
const kindOf = f => /\.m?js$/.test(f) ? "js" : f.endsWith(".css") ? "css" : f.endsWith(".wasm") ? "wasm" : /\.(json|geojson)$/.test(f) ? "json" : f.endsWith(".html") ? "html" : /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(f) ? "img" : "data";
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

if (arg("build")) {
	for (const [name, ws, script] of APPS) {
		process.stderr.write(`build ${name} (${ws} ${script})\n`);
		execSync(`npm run ${script} -s -w ${ws}`, { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
	}
}

const union = new Map();   // sha1 → bytes（全アプリを通した実体）
const apps = {};
for (const [name, , , dir] of APPS) {
	const abs = path.join(REPO, dir);
	if (!existsSync(abs)) { apps[name] = null; continue; }
	const r = { files: 0, bytes: 0, gz: 0, kinds: {}, largestJs: [] };
	for (const f of walk(abs)) {
		if (f.endsWith(".map") || path.basename(f) === ".DS_Store") continue;
		const b = readFileSync(f), k = kindOf(f);
		const gz = COMPRESSIBLE.test(f) ? gzipSync(b, { level: 9 }).length : b.length;
		r.files++; r.bytes += b.length; r.gz += gz;
		(r.kinds[k] ??= { files: 0, bytes: 0, gz: 0 }).files++; r.kinds[k].bytes += b.length; r.kinds[k].gz += gz;
		if (k === "js") r.largestJs.push([path.relative(abs, f), b.length, gz]);
		union.set(createHash("sha1").update(b).digest("hex"), b.length);
	}
	r.largestJs = r.largestJs.sort((a, b) => b[1] - a[1]).slice(0, 5);
	apps[name] = r;
}

const packages = {};
for (const p of PACKAGES) {
	const out = execSync("npm pack --dry-run --json --ignore-scripts", { cwd: path.join(REPO, "packages", p), stdio: ["ignore", "pipe", "ignore"] }).toString();
	const j = JSON.parse(out)[0];
	packages[j.name] = { tgz: j.size, unpacked: j.unpackedSize, files: j.entryCount };
}

const sum = Object.values(apps).reduce((s, a) => s + (a?.bytes ?? 0), 0);
const report = {
	date: new Date().toISOString().slice(0, 10),
	commit: execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim(),
	site: { sumBytes: sum, uniqueBytes: [...union.values()].reduce((s, v) => s + v, 0) },
	apps, packages,
};

const K = b => b == null ? "—" : b >= 1e6 ? (b / 1e6).toFixed(2) + "MB" : Math.round(b / 1e3) + "KB";
const D = (a, b) => a == null || b == null ? "" : ` (${b - a >= 0 ? "+" : ""}${K(b - a)}, ${a ? ((b - a) / a * 100).toFixed(1) : "∞"}%)`;
const base = arg("compare") ? JSON.parse(readFileSync(path.resolve(arg("compare")), "utf8")) : null;
console.log(`| app | files | total | js raw | js gz |\n|---|---:|---:|---:|---:|`);
for (const [n, a] of Object.entries(apps)) {
	const b = base?.apps?.[n];
	console.log(`| ${n} | ${a?.files ?? "—"} | ${K(a?.bytes)}${D(b?.bytes, a?.bytes)} | ${K(a?.kinds.js?.bytes)}${D(b?.kinds.js?.bytes, a?.kinds.js?.bytes)} | ${K(a?.kinds.js?.gz)}${D(b?.kinds.js?.gz, a?.kinds.js?.gz)} |`);
}
console.log(`\nsite sum ${K(report.site.sumBytes)}${D(base?.site.sumBytes, report.site.sumBytes)} · unique ${K(report.site.uniqueBytes)}${D(base?.site.uniqueBytes, report.site.uniqueBytes)}`);
console.log(`\n| npm package | tgz | unpacked |\n|---|---:|---:|`);
for (const [n, p] of Object.entries(packages)) { const b = base?.packages?.[n]; console.log(`| ${n} | ${K(p.tgz)}${D(b?.tgz, p.tgz)} | ${K(p.unpacked)}${D(b?.unpacked, p.unpacked)} |`); }

const out = arg("out");
if (out) { mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); writeFileSync(path.resolve(out), JSON.stringify(report, null, "\t") + "\n"); }
