#!/usr/bin/env node
// 配布物（dist/lib＝SDK ライブラリビルド）の計量：どのチャンクに・どのモジュールが・何回入っているか。
//   ① 主スレッドのビルドだけでなく **worker の別ビルド（30 本超）も** visualizer(raw-data) で取る
//      ＝vite は worker ごとに独立 rollup を回すので、主ビルドだけ見ると 3 MB 超を見落とす（2026-09-14 実測）。
//   ② モジュール単位で「複製」を数える：同じモジュールが n チャンクにあれば (n−1) 本分を「失われている」と数える。
//   ③ 出所別（geopbf / ortho-core / app / node_modules / その他）の占有と複製を出す。
//   ④ 閾値ゲート：--max-dup-ratio=0.xx を超えたら exit 1（軽量化の後退を CI で止める）。
// 使い方: apps/ortho-japan で `npm run measure:lib` （dist/measure/ に stats-*.json と report.json、標準出力に要約）。
//   オプション: --max-dup-ratio=0.30   複製率がこれを超えたら失敗
//              --top=20                複製上位の表示本数
//   出荷物本体（dist/lib）は触らない＝別ディレクトリへビルドする。sourcemap は計量から除外。
import { build, mergeConfig } from "vite";
import { visualizer } from "rollup-plugin-visualizer";
import { fileURLToPath } from "node:url";
import { readFile, readdir, stat, writeFile, rm, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(APP, "../..");
const OUT = path.join(APP, "dist/measure");
const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MAX_DUP = arg("max-dup-ratio", null) == null ? null : Number(arg("max-dup-ratio"));
const TOP = Number(arg("top", 20));
const fmt = b => b >= 1e6 ? (b / 1e6).toFixed(2) + " MB" : b >= 1e3 ? Math.round(b / 1e3) + " KB" : b + " B";

// ── ビルド（vite.lib.config.js をそのまま継ぎ、visualizer を主ビルドと worker ビルドの両方へ挿す）
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const base = (await import(path.join(APP, "vite.lib.config.js"))).default;
let n = 0;
const cfg = mergeConfig(base, {
	configFile: false,
	logLevel: "warn",
	plugins: [visualizer({ filename: path.join(OUT, "stats-main.json"), template: "raw-data", gzipSize: false })],
	worker: { plugins: () => [visualizer({ filename: path.join(OUT, `stats-worker-${n++}.json`), template: "raw-data", gzipSize: false })] },
	build: { outDir: OUT + "/lib", emptyOutDir: true, sourcemap: false },
	css: { preprocessorOptions: { scss: { silenceDeprecations: ["legacy-js-api"] } } },   // 計量の出力を汚さない
});
console.log("… build (measure)");
await build(cfg);

// ── 集計
const ASSETS = path.join(OUT, "lib/assets");
const files = (await readdir(OUT)).filter(f => /^stats-(main|worker-\d+)\.json$/.test(f)).sort();
const norm = id => {                                   // visualizer の id → リポジトリ相対
	if (id.startsWith("\0")) return "(virtual)" + id.slice(1);
	const abs = id.startsWith(REPO + "/") ? id : path.resolve(APP, id.replace(/^\//, ""));   // JS API 経由は絶対パス・CLI 経由はルート相対
	return path.relative(REPO, abs).replace(/\\/g, "/");
};
const origin = rel => {
	if (rel.includes("node_modules/")) return "node_modules";
	const m = rel.match(/^(packages\/[^/]+|apps\/[^/]+)/);
	if (!m) return "app";
	if (m[1] === "apps/ortho-japan") return "app";
	return m[1].startsWith("packages/") ? m[1].slice(9) : m[1];
};
const chunks = new Map();                              // chunk file → { build, mods: [{rel, rendered}] }
const copies = new Map();                              // rel → 出現チャンク数
for (const f of files) {
	const d = JSON.parse(await readFile(path.join(OUT, f), "utf8"));
	const bname = f.replace(/^stats-|\.json$/g, "");
	for (const m of Object.values(d.nodeMetas)) {
		const rel = norm(m.id);
		for (const [bundle, pu] of Object.entries(m.moduleParts)) {
			const c = path.basename(bundle);
			if (!chunks.has(c)) chunks.set(c, { build: bname, mods: [] });
			chunks.get(c).mods.push({ rel, rendered: d.nodeParts[pu].renderedLength });
			copies.set(rel, (copies.get(rel) || 0) + 1);
		}
	}
}
let totRaw = 0, totGz = 0;
const perOrigin = {}, wastedOrigin = {}, modBytes = new Map(), rows = [];
for (const [c, info] of chunks) {
	let raw; try { raw = (await stat(path.join(ASSETS, c))).size; } catch { continue; }   // 実ファイルの無いもの（inline 等）は除外
	const gz = gzipSync(await readFile(path.join(ASSETS, c)), { level: 9 }).length;
	totRaw += raw; totGz += gz;
	const rs = info.mods.reduce((s, m) => s + m.rendered, 0) || 1, k = raw / rs;   // rendered → 実バイトへ比例配分
	let dup = 0;
	for (const m of info.mods) {
		const v = Math.round(m.rendered * k), o = origin(m.rel);
		perOrigin[o] = (perOrigin[o] || 0) + v;
		if (!modBytes.has(m.rel)) modBytes.set(m.rel, []);
		modBytes.get(m.rel).push({ chunk: c, v });
		if (copies.get(m.rel) > 1) dup += v;
	}
	rows.push({ chunk: c, build: info.build, raw, gz, dupBytes: dup, mods: info.mods.length });
}
const dupmods = [];
for (const [rel, vs] of modBytes) {
	if (vs.length < 2) continue;
	const sizes = vs.map(x => x.v), wasted = sizes.reduce((a, b) => a + b, 0) - Math.max(...sizes);
	dupmods.push({ module: rel, copies: vs.length, wasted, chunks: vs.map(x => x.chunk) });
	const o = origin(rel); wastedOrigin[o] = (wastedOrigin[o] || 0) + wasted;
}
dupmods.sort((a, b) => b.wasted - a.wasted);
rows.sort((a, b) => b.raw - a.raw);
const wasted = dupmods.reduce((s, m) => s + m.wasted, 0);
const report = {
	date: new Date().toLocaleDateString("sv-SE"), chunks: rows.length, builds: files.length, totRaw, totGz,
	wasted, dupRatio: +(wasted / totRaw).toFixed(4), dupModules: dupmods.length, perOrigin, wastedOrigin,
	top: dupmods.slice(0, 60), rows,
};
await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));

// ── 要約（Markdown・そのまま Issue に貼れる）
const pct = (a, b) => Math.round(a / b * 100) + "%";
console.log(`\n## 配布物の計量 ${report.date}\n`);
console.log(`| | 値 |\n| :-- | --: |`);
console.log(`| JS 合計 | ${fmt(totRaw)} raw / ${fmt(totGz)} gzip |`);
console.log(`| チャンク / ビルド | ${rows.length} / ${files.length}（主 1 ＋ worker ${files.length - 1}） |`);
console.log(`| 複製で失われている分 | **${fmt(wasted)}（${pct(wasted, totRaw)}）**・${dupmods.length} モジュール |`);
console.log(`\n出所 | 占有 | うち複製\n:-- | --: | --:`);
for (const [o, v] of Object.entries(perOrigin).sort((a, b) => b[1] - a[1])) console.log(`${o} | ${fmt(v)} (${pct(v, totRaw)}) | ${fmt(wastedOrigin[o] || 0)}`);
console.log(`\n複製上位 ${TOP} | コピー | 失われている分\n:-- | --: | --:`);
for (const m of dupmods.slice(0, TOP)) console.log(`${m.module.replace(/^packages\//, "")} | ×${m.copies} | ${fmt(m.wasted)}`);
console.log(`\n詳細: ${path.relative(APP, path.join(OUT, "report.json"))}（stats-main.json / stats-worker-*.json は visualizer raw-data）`);
if (MAX_DUP != null && report.dupRatio > MAX_DUP) {
	console.error(`\n✗ 複製率 ${report.dupRatio} が閾値 ${MAX_DUP} を超過`);
	process.exit(1);
}
