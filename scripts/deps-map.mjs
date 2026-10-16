#!/usr/bin/env node
// 依存マップの元データ：www と www に並ぶデモ（apps/www/demos.json）が、どのパッケージを
// 共有エンジン経由（URL で読む）と自分の束（各アプリに焼く）のどちらで使うかを esbuild で辿る。
//   node scripts/deps-map.mjs > deps.json
// 共有エンジンを読むアプリ（vite.config.js に sharedEngine()）は apps/engine/src/entries.mjs の入口を外に出して束を辿り、
// 外に出た入口は入口のソースから辿り直して「エンジン経由」とする。new URL("…", import.meta.url) の worker も入口として足す。
// scss は @use／@import／@forward を辿り、build:css の生成物（GENERATED）はその正本の scss を辿る（2026-10-15・quiet-mono の線が出るように）。
// 大きさ＝esbuild で minify した出力の中で各ファイルが占めるバイト（tree-shake 後）。動的 import で後から読む分も含む（頁が読みうる最大）。
// gz は出力全体を gzip -9 した比率で割り振った見積り。画像・wasm・フォント等の資産は数えない（JSON の import は数える）。
// 言語ファイル（i18n/lang/*.json）は "(lang)" として別に数える（頁が読むのは 1 言語分）。
// 限り：import.meta.glob は辿らない。
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { gzipSync } from "node:zlib";

// DEPS_ROOT＝別の checkout（前の版と比べる時）。入口の一覧が無い古い版（2026-10-15 より前）は当時の 5 つ
const ROOT = path.resolve(process.env.DEPS_ROOT || path.join(import.meta.dirname, ".."));
const ENTRIES = fs.existsSync(path.join(ROOT, "apps/engine/src/entries.mjs")) ? (await import(path.join(ROOT, "apps/engine/src/entries.mjs"))).ENTRIES
	: [["@ortho-earth/globe", "globe", "apps/ortho-globe/engine/globe.js"], ["@ortho-earth/globe/i18n.js", "i18n", "packages/globe/src/i18n.js"], ["@ortho-earth/core", "core", "packages/ortho-core/src/index.js"], ["geopbf", "geopbf", "packages/geopbf/src/index.js"], ["@ortho-earth/h3/core", "h3", "packages/h3/src/core.js"]].map(([a, b, c]) => [a, b, path.join(ROOT, c)]);
const rel = p => path.relative(ROOT, p);
const SPEC = new Map(ENTRIES.map(([spec, , src]) => [spec, src]));
const NONE = path.join(ROOT, "packages/geopbf/src/modules/builtinWorkers.none.ts");
const usesEngine = dir => fs.existsSync(path.join(ROOT, dir, "vite.config.js")) && /sharedEngine\(\)/.test(fs.readFileSync(path.join(ROOT, dir, "vite.config.js"), "utf8").replace(/\/\/.*$/gm, ""));

// ---- 置き場（ファイル → パッケージ名） ----
const owners = new Map();
function ownerOf(file) {
	const nm = file.lastIndexOf("node_modules/");
	if (nm >= 0) { const p = file.slice(nm + 13).split("/"); return "npm:" + (p[0].startsWith("@") ? p[0] + "/" + p[1] : p[0]); }
	let d = path.dirname(file);
	const r = rel(file).split("/");
	if (r[0] === "apps" && r.length > 2) d = path.join(ROOT, "apps", r[1]);   // アプリの中の物（apps/himekuri/lib の npm himekuri など）はそのアプリの持ち物＝地図ではアプリに数える
	while (d.startsWith(ROOT) && d !== ROOT) {
		if (owners.has(d)) return owners.get(d);
		const pj = path.join(d, "package.json");
		if (fs.existsSync(pj)) { const n = JSON.parse(fs.readFileSync(pj, "utf8")).name || rel(d); owners.set(d, n); return n; }
		d = path.dirname(d);
	}
	return null;
}
const dirs = {};
for (const top of ["apps", "packages", "sdk"]) for (const n of fs.readdirSync(path.join(ROOT, top))) {
	const pj = path.join(ROOT, top, n, "package.json");
	if (fs.existsSync(pj)) dirs[JSON.parse(fs.readFileSync(pj, "utf8")).name] = `${top}/${n}`;
}
// npm は内製パッケージの package.json に名がある物だけ出す（その下の依存は出さない）・@loaders.gl/* は 1 つにまとめる
const npmDirect = new Set();
for (const dir of Object.values(dirs)) { const pj = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8")); for (const k of Object.keys({ ...pj.dependencies, ...pj.peerDependencies })) if (!dirs[k]) npmDirect.add(k); }
const npmFamily = n => n.replace(/^npm:@loaders\.gl\/.*/, "npm:loaders.gl");
const shown = n => !n.startsWith("npm:") || n === "npm:loaders.gl" || npmDirect.has(n.slice(4));

// ---- scss と build:css ----
// build:css の生成物 → 正本（packages/globe/scripts/build-css.mjs・packages/geoedit/scripts/css-build.mjs と同じ並び）。生成物は素の CSS／文字列＝そのままでは正本が見えない
const GENERATED = {
	"packages/globe/src/globe.css": ["quiet-mono/tokens.scss", "quiet-mono/components.scss", "./style.scss"],
	"packages/geoedit/src/editor.css.js": ["./editor.scss"],
};
for (const f of Object.keys(GENERATED)) if (!fs.existsSync(path.join(ROOT, f))) process.stderr.write(`  GENERATED に無いファイル: ${f}（build:css の出力が変わったら直す）\n`);
// sass の道の解き方（相対＝partial の _ と拡張子と index を試す・裸の名＝esbuild の解決＝package.json の exports）
const sassRel = (dir, spec) => {
	const p = path.resolve(dir, spec), d = path.dirname(p), b = path.basename(p);
	return [p, p + ".scss", p + ".sass", path.join(d, "_" + b), path.join(d, "_" + b + ".scss"), path.join(p, "index.scss"), path.join(p, "_index.scss")].find(c => fs.existsSync(c) && fs.statSync(c).isFile());
};
const scssDeps = file => [...fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").matchAll(/@(?:use|import|forward)\s+["']([^"']+)["']/g)].map(m => m[1]).filter(x => !/^(sass:|https?:|url\()/.test(x));
// 辿り先を JS の import に書き直す（sass と同じく、まず自分の dir から解く・無ければ裸の名＝esbuild に解かせる）
const asImports = (file, specs) => specs.map(spec => sassRel(path.dirname(file), spec) || (spec.startsWith(".") ? null : spec)).filter(Boolean).map(x => `import ${JSON.stringify(x)};`).join("\n");

// 言語ファイル（i18n/lang/<言語>.json 等）＝頁は 1 言語分だけ読む＝大きさは「全言語の和」として別に数える
const LANG = /\/i18n\/lang\/(?:[^/]+\/)*[a-z]{2,3}(?:-[A-Za-z]+)?\.json$/;
// ---- 1 つの入口から辿る ----
const ASSET = Object.fromEntries(["css", "scss", "sass", "png", "jpg", "jpeg", "webp", "svg", "gif", "glb", "wasm", "bin", "ttf", "woff", "woff2", "mp3", "wav", "ktx2", "txt", "html", "geopbf", "pbf", "zip", "gz"].map(e => ["." + e, "empty"]));
async function trace(entry, { engine, stdin, inEngine }) {
	const hits = new Set(), workers = new Set();
	const plugin = {
		name: "trace",
		setup(b) {
			b.onResolve({ filter: /^https?:|^data:|^\/globe\/engine\// }, a => ({ path: a.path, external: true }));
			b.onResolve({ filter: /\?/ }, async a => {
				const [p, q] = a.path.split("?");
				const r = await b.resolve(p, { kind: a.kind, resolveDir: a.resolveDir, importer: a.importer });
				if (/worker/.test(q) && r.path) workers.add(r.path);
				return { path: r.path, namespace: /raw|url|worker/.test(q) ? "asset" : "file", external: false };
			});
			b.onLoad({ filter: /.*/, namespace: "asset" }, a => /\.s[ac]ss$/.test(a.path) ? { contents: asImports(a.path, scssDeps(a.path)), loader: "js", resolveDir: path.dirname(a.path) } : { contents: "", loader: "empty" });
			b.onLoad({ filter: /\.s[ac]ss$/ }, a => ({ contents: asImports(a.path, scssDeps(a.path)), loader: "js", resolveDir: path.dirname(a.path) }));
			b.onLoad({ filter: /\.css(\.js)?$/ }, a => {
				const g = GENERATED[rel(a.path)]; if (!g) return null;
				const own = a.path.endsWith(".js") ? fs.readFileSync(a.path, "utf8") + "\n" : "";
				return { contents: own + asImports(a.path, g), loader: "js", resolveDir: path.dirname(a.path) };
			});
			if (engine) {
				if (!inEngine) b.onResolve({ filter: /.*/ }, a => SPEC.has(a.path) ? (hits.add(a.path), { path: a.path, external: true }) : null);
				b.onResolve({ filter: /builtinWorkers\.(js|ts)$/ }, () => ({ path: NONE }));   // engineAliases と同じ＝エンジンは builtin worker を焼かない
			}
			b.onResolve({ filter: /^(common|native-bucket)\// }, a => { if (a.pluginData === "alias") return null; const [pk, ...rest] = a.path.split("/"); return b.resolve("./" + rest.join("/"), { kind: a.kind, resolveDir: path.join(ROOT, "packages", pk, "src"), pluginData: "alias" }); });
			b.onResolve({ filter: /^#tile-formats$/ }, () => ({ path: path.join(ROOT, "packages/ortho-core/src/tileformats-mlt.js") }));
			b.onResolve({ filter: /^#pointcloud-formats$/ }, () => ({ path: path.join(ROOT, "packages/tile-formats/src/pointcloud.ts") }));
			b.onLoad({ filter: /\.(m?js|ts)$/ }, a => {
				if (a.path.includes("node_modules")) return null;
				const src = fs.readFileSync(a.path, "utf8");
				for (const m of src.matchAll(/new URL\(\s*["'`]([^"'`]+\.m?js)["'`]\s*,\s*import\.meta\.url\s*\)/g)) {
					const w = path.resolve(path.dirname(a.path), m[1]); if (fs.existsSync(w)) workers.add(w);
				}
				return null;
			});
		},
	};
	const opts = { absWorkingDir: ROOT, bundle: true, write: false, metafile: true, minify: true, format: "esm", platform: "browser", splitting: true, outdir: "/tmp/deps-map-out", logLevel: "silent", loader: { ...ASSET, ".json": "json" }, plugins: [plugin], define: { "import.meta.env": "{}" }, conditions: ["browser", "import", "default"], external: ["node:*"] };
	let r;
	for (let i = 0; ; i++) {   // 解決できない import（vite だけの別名など）は外に出して辿り直す＝stderr に出す
		try { r = stdin ? await esbuild.build({ ...opts, stdin }) : await esbuild.build({ ...opts, entryPoints: [entry] }); break; }
		catch (err) {
			const miss = (err.errors || []).map(x => x.text.match(/Could not resolve "([^"]+)"/)?.[1]).filter(Boolean);
			if (!miss.length || i > 20) throw err;
			process.stderr.write(`  外に出した: ${miss.join(", ")}（${rel(entry || stdin.sourcefile)}）\n`);
			opts.external = [...opts.external, ...miss];
		}
	}
	const bytes = new Map(); let min = 0, gz = 0;
	for (const o of Object.values(r.metafile.outputs)) for (const [f, v] of Object.entries(o.inputs)) bytes.set(f, (bytes.get(f) || 0) + v.bytesInOutput);
	for (const o of r.outputFiles || []) if (/\.js$/.test(o.path)) { min += o.contents.length; gz += gzipSync(o.contents, { level: 9 }).length; }
	return { meta: r.metafile, hits, workers, bytes, min, gz };
}

// 入口 → 辿れたファイルの集合＋外に出たエンジンの入口（worker は入口に足して繰り返す）
async function walk(roots, engine, inEngine = false) {
	const files = new Set(), hits = new Set(), seen = new Set(), q = [...roots], edges = new Set(), size = new Map(); let min = 0, gz = 0;
	while (q.length) {
		const e = q.shift(); const key = e.stdin ? e.stdin.sourcefile : e;
		if (seen.has(key)) continue; seen.add(key);
		const { meta, hits: h, workers, bytes, min: m1, gz: g1 } = await trace(e.stdin ? null : e, { engine, stdin: e.stdin, inEngine });
		for (const [f, v] of Object.entries(meta.inputs)) {
			const inline = /#inline\d+$/.test(f) || f === "<stdin>";   // HTML の中の script（stdin）＝その HTML のコードとして数える
			const abs = f === "<stdin>" ? e.stdin.sourcefile.replace(/#inline\d+$/, "") : path.resolve(ROOT, f.replace(/#inline\d+$/, "")); if (!fs.existsSync(abs)) continue; if (!inline) files.add(abs); size.set(abs, (size.get(abs) || 0) + (bytes.get(f) || 0));
			for (const im of v.imports) { const t = path.resolve(ROOT, im.path); if (fs.existsSync(t)) edges.add(abs + "\n" + t); }
		}
		h.forEach(x => hits.add(x)); workers.forEach(w => q.push(w)); min += m1; gz += g1;
	}
	return { files, hits, edges, size, min, gz };
}

function htmlRoots(html, appDir) {
	const src = fs.readFileSync(html, "utf8"), out = [];
	for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {   // 手元の HTML を読むだけ（無害化ではない）
		if (!/type\s*=\s*["']?module/i.test(m[1])) continue;
		const s = m[1].match(/src\s*=\s*["']([^"']+)["']/i);
		if (s) out.push(s[1].startsWith("/") ? path.join(ROOT, appDir, s[1]) : path.resolve(path.dirname(html), s[1]));
		else if (m[2].trim()) out.push({ stdin: { contents: m[2], resolveDir: path.dirname(html), sourcefile: html + "#inline" + out.length, loader: "js" } });
	}
	return out;
}

const ENTRY = {
	"/": "apps/www/index.html", "/quiz/": "apps/world-quiz/index.html", "/world/": "apps/world/index.html", "/solar/": "apps/solar/index.html",
	"/himekuri/": "apps/himekuri/index.html", "/geopbf/": "apps/geopbf-demo/index.html", "/maplibre/": fs.existsSync(path.join(ROOT, "apps/engine/src/maplibre.js")) ? "apps/engine/src/maplibre.js" : "apps/ortho-globe/engine/maplibre.js",
	"/gishub-jp/": "apps/gishub-jp/index.html", "/japan/census2020/": "apps/census2020/index.html", "/nl/": "apps/ortho-nl/index.html", "/globe/quakes/": "apps/quakes/index.html",
};
const entryOf = href => {
	const p = href.replace(/[?#].*$/, "");
	if (ENTRY[p]) return ENTRY[p];
	const m = p.match(/^\/(japan|globe)\/(.*)$/);
	const dir = m[1] === "japan" ? "apps/ortho-japan" : "apps/ortho-globe";
	return `${dir}/${m[2] ? m[2] + ".html" : "index.html"}`;
};

const demos = [{ id: "www", title: "www (top page)", href: "/" }, ...JSON.parse(fs.readFileSync(path.join(ROOT, "apps/www/demos.json"), "utf8")).demos];
const engineCache = new Map();
async function engineFiles(spec) {
	if (!engineCache.has(spec)) engineCache.set(spec, await walk([SPEC.get(spec)], true, true));
	return engineCache.get(spec);
}
const allEdges = new Set();
const rows = [];
for (const d of demos) {
	const entry = entryOf(d.href), appDir = entry.split("/").slice(0, 2).join("/");
	const isMl = d.id === "maplibre";
	const shared = isMl || usesEngine(appDir);
	const roots = entry.endsWith(".html") ? htmlRoots(path.join(ROOT, entry), appDir) : [path.join(ROOT, entry)];
	const own = isMl ? { files: new Set(), hits: new Set([...SPEC.keys()].filter(s => s === "@ortho-earth/globe")), edges: new Set(), size: new Map(), min: 0, gz: 0 } : await walk(roots, shared);
	if (isMl) { const w = await walk(roots, true); w.hits.forEach(h => own.hits.add(h)); w.edges.forEach(e => allEdges.add(e)); }
	own.edges.forEach(e => allEdges.add(e));
	const cells = {}, appName = ownerOf(path.join(ROOT, appDir, "package.json"));
	const mark = (f, k) => { const o = ownerOf(f); if (!o || o === appName || o === "ortho-engine") return; const n = npmFamily(o); if (!shown(n)) return; cells[n] = (cells[n] || "").includes(k) ? cells[n] : (cells[n] || "") + k; };
	const baked = {};   // 束に入る内製パッケージのファイル（共有エンジンを読む頁で、どのサブパスが焼かれるか）
	for (const f of own.files) if (!isMl) { mark(f, "B"); const o = ownerOf(f); if (shared && o && o !== appName && !o.startsWith("npm:") && /\.m?js$/.test(f)) (baked[o] ??= []).push(rel(f)); }
	// 大きさ：束＝own.size の和（worker の束ごとに数える）・エンジン＝読む入口の和集合（同じファイルは 1 つ＝エンジンの chunk は入口を跨いで共有）
	const sizeOf = {}, add = (k, n, kind) => { if (!n) return; const s = sizeOf[k] ??= { B: 0, E: 0 }; s[kind] += n; };
	const keyOf = f => { if (LANG.test(f)) return "(lang)"; const o = ownerOf(f); return !o ? null : o === appName ? "(app)" : npmFamily(o).startsWith("npm:") ? (shown(npmFamily(o)) ? npmFamily(o) : "npm:(other)") : o; };
	if (!isMl) for (const [f, n] of own.size) add(keyOf(f), n, "B");
	const engSize = new Map(); let engMin = 0, engGz = 0;
	for (const h of own.hits) { const e = await engineFiles(h); e.edges.forEach(x => allEdges.add(x)); for (const f of e.files) mark(f, "E"); for (const [f, n] of e.size) engSize.set(f, Math.max(engSize.get(f) || 0, n)); }
	for (const [f, n] of engSize) { add(keyOf(f), n, "E"); engMin += n; }
	const ratio = w => w.min ? w.gz / w.min : 0.3;
	const engRatio = own.hits.size ? [...own.hits].reduce((a, h) => { const e = engineCache.get(h); return [a[0] + e.gz, a[1] + e.min]; }, [0, 0]) : [0, 0];
	engGz = Math.round(engMin * (engRatio[1] ? engRatio[0] / engRatio[1] : 0.3));
	const ownMin = isMl ? 0 : [...own.size.values()].reduce((a, b) => a + b, 0);
	const sizes = { own: { min: ownMin, gz: Math.round(ownMin * ratio(own)) }, engine: { min: engMin, gz: engGz }, byPkg: sizeOf, top: [...own.size].filter(() => !isMl).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([f, n]) => [rel(f), n]), gzRatio: { own: +ratio(own).toFixed(3), engine: engRatio[1] ? +(engRatio[0] / engRatio[1]).toFixed(3) : null } };
	for (const k in cells) cells[k] = cells[k].includes("E") && cells[k].includes("B") ? "EB" : cells[k];
	// 直に import＝アプリのファイルから出る辺の先
	const direct = new Set();
	const appFiles = [...own.files].filter(f => ownerOf(f) === appName);
	for (const e of own.edges) { const [a, b] = e.split("\n"); if (ownerOf(a) === appName || a.endsWith(".html")) { const o = ownerOf(b); if (o && o !== appName) direct.add(npmFamily(o)); } }
	const pkgOfSpec = h => h.startsWith("@") ? h.split("/").slice(0, 2).join("/") : h.split("/")[0];
	const texts = [...appFiles, ...(entry.endsWith(".html") ? [path.join(ROOT, entry)] : [])].map(a => fs.readFileSync(a, "utf8"));   // HTML の中の script も＝アプリのコード
	for (const h of own.hits) if (texts.some(t => t.includes(`"${h}"`) || t.includes(`'${h}'`))) direct.add(pkgOfSpec(h));
	rows.push({ id: d.id, title: d.title, href: d.href, app: appName, appDir, entry, shared, engineEntries: [...own.hits].map(h => ENTRIES.find(e => e[0] === h)[1]), cells, direct: [...direct].sort(), baked, sizes });
	process.stderr.write(`${d.id} ${Object.keys(cells).length}\n`);
}

// 層の図の辺＝実際の import（パッケージ → パッケージ）＋どこからも辿れないパッケージは package.json の依存
const edges = {}, npmEdges = {};
for (const e of allEdges) {
	const [a, b] = e.split("\n").map(ownerOf); if (!a || !b || a === b || a.startsWith("npm:")) continue;
	if (b.startsWith("npm:")) { if (shown(npmFamily(b))) (npmEdges[a] ??= new Set()).add(npmFamily(b).slice(4)); } else (edges[a] ??= new Set()).add(b);
}
for (const r of rows) { edges[r.app] ??= new Set(); for (const k of r.direct) if (!k.startsWith("npm:")) edges[r.app].add(k); }
const reached = new Set(rows.flatMap(r => Object.keys(r.cells)));
const unused = [];
for (const [n, dir] of Object.entries(dirs)) {
	if (!dir.startsWith("packages/")) continue;
	edges[n] ??= new Set();
	if (!reached.has(n)) {
		unused.push(n);
		const pj = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
		for (const dep of Object.keys({ ...pj.dependencies, ...pj.peerDependencies })) if (dirs[dep]?.startsWith("packages/")) edges[n].add(dep);
	}
}
// sdk/*＝外へ配る SDK と単体の道具（2026-10-15）。デモの頁からは辿らない＝src の import と peerDependencies に出る内製パッケージを辺にする（unused には数えない）
const importsIn = d => { const out = new Set(); const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else if (/\.m?js$/.test(e.name)) for (const m of fs.readFileSync(q, "utf8").matchAll(/(?:from\s*|import\s*\(\s*)["']([^"'./][^"']*)["']/g)) out.add(m[1]); } }; if (fs.existsSync(d)) walk(d); return out; };
for (const [n, dir] of Object.entries(dirs)) {
	if (!dir.startsWith("sdk/")) continue;
	edges[n] ??= new Set();
	const pj = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
	for (const spec of [...importsIn(path.join(ROOT, dir, "src")), ...Object.keys(pj.peerDependencies || {})]) { const dep = Object.keys(dirs).find(k => spec === k || spec.startsWith(k + "/")); if (dep && dep !== n) edges[n].add(dep); }
}
// エンジンの中身（全入口の和）＝束に入るファイルのうち、これと重なる物が二重焼き
const engineAll = new Set();
for (const [spec] of ENTRIES) for (const f of (await engineFiles(spec)).files) engineAll.add(rel(f));
for (const r of rows) r.doubled = Object.values(r.baked).flat().filter(f => engineAll.has(f)).sort();
// エンジン全体（全入口の和集合）の大きさ＝パッケージごと・大きいファイル上位
const engineTop = new Map(), engineByPkg = {};
for (const [spec] of ENTRIES) for (const [f, n] of (await engineFiles(spec)).size) engineTop.set(rel(f), Math.max(engineTop.get(rel(f)) || 0, n));
for (const [f, n] of engineTop) { const o = ownerOf(path.join(ROOT, f)), k = LANG.test(f) ? "(lang)" : !o ? null : shown(npmFamily(o)) ? npmFamily(o) : "npm:(other)"; if (k) engineByPkg[k] = (engineByPkg[k] || 0) + n; }
const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
const sets = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort()]));
process.stdout.write(JSON.stringify({ rows, edges: sets(edges), npmEdges: sets(npmEdges), dirs, unused: unused.sort(), engine: ENTRIES.map(([spec, name, src]) => ({ spec, name, pkg: ownerOf(src) })), engineByPkg, engineTop: [...engineTop].sort((x, y) => y[1] - x[1]).slice(0, 15), commit }, null, "\t") + "\n");
