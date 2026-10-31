#!/usr/bin/env node
// Cesium の公式例の門（Cesium との機能差の段 0・2026-10-25）の目録＝CesiumJS の Sandcastle の例・素材・本物の Build を**版を固定して**手元の取り置きへ取る。
// MapLibre の門（tests/mlexamples/corpus.mjs）と同じ作り。違い＝例が 300 本を超え、素材（Apps/SampleData）も 160 件ある＝GitHub の contents API
// （無認証 60 回/時）では足りない＝git の部分 clone（--filter=blob:none --sparse）で 3 つの dir だけ取る。
//   ・例＝CesiumGS/cesium の packages/sandcastle/gallery/<名>/{main.js,index.html,sandcastle.yaml}（Apache-2.0）。名が -dev で終わる物は開発者用（門は回すが数を分ける）
//   ・素材＝Apps/SampleData（例は "../../SampleData/…" で取る＝走らせ台が振り替える）・Sandcastle の助け手＝packages/sandcastle/templates/Sandcastle.ts
//   ・本物＝npm の cesium（`npm pack`＝lock を触らない）の Build/Cesium/
//   ・置き場＝<repo>/.cache/csexamples/<版>/{gallery,SampleData,templates,Build}（.cache/ は gitignore 済＝repo に入れない）
//   ・corpus.json（commit する）＝版・commit・各ファイルの sha256・例ごとの分類。取り直した物が corpus.json と違えば落ちる（黙って別物を測らない）
// 使い方: node packages/globe/tests/csexamples/corpus.mjs [--update]
//   既定＝取り置きが無ければ取り、corpus.json の sha256 と照合して分類の本数を出す
//   --update＝取り直して corpus.json を書き直す（版を上げる時だけ・上の PIN を変えてから）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
export const PIN = { version: "1.146.0", tag: "1.146", commit: "b8d3a36fe98a3e432eb89253c95d5f20e605e0f1", repo: "CesiumGS/cesium" };
export const CACHE = path.join(REPO, ".cache/csexamples", PIN.version);
const CORPUS = path.join(HERE, "corpus.json");
const DIRS = ["packages/sandcastle/gallery", "packages/sandcastle/templates", "packages/sandcastle/public/templates", "packages/sandcastle/public/images", "Apps/SampleData"];   // public/templates＝例が @import する bucket.css・public/images＝例が "../images/…" で取る絵（Cesium_Logo_Color.jpg など。無いと Cesium は白い四角・ortho は何も描かない）
const EX_FILES = ["main.js", "index.html", "sandcastle.yaml"];   // 縮図（thumbnail）は取らない

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);

// ── 分類（正規表現の見立て＝走らせる前の予想。本当の段は門が決める）──
// ion＝Cesium ion の配信（トークンが要る）・google＝Google の写実 3D Tiles（鍵が要る）
const ION_RE = /IonResource|fromIonAssetId|createWorldTerrainAsync|createWorldImageryAsync|createOsmBuildingsAsync|Terrain\.fromWorld(?:Terrain|Bathymetry)|IonImageryProvider|IonGeocodeProviderType|createGooglePhotorealistic3DTileset|ITwinData|ITwinPlatform/;
function classify(name, js, html, yaml) {
	const title = (yaml.match(/^title:\s*(.*)$/m) || [])[1]?.trim() ?? name;
	const labels = [...(yaml.match(/^labels:\s*\n((?:\s+-\s+.*\n?)*)/m)?.[1] || "").matchAll(/-\s+(.*)/g)].map(m => m[1].trim()).filter(Boolean);
	const hosts = [...new Set([...js.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase()))].sort();
	const imports = [...new Set([...js.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g)].map(m => m[1]))].filter(m => m !== "cesium" && m !== "Sandcastle").sort();
	const flags = {
		dev: name.endsWith("-dev"),
		ion: ION_RE.test(js),
		google: /createGooglePhotorealistic3DTileset|GoogleMaps\./.test(js),
		thirdParty: imports.length > 0,
		sampleData: /SampleData\//.test(js),
		toolbar: /Sandcastle\.add(?:ToolbarButton|ToggleButton|ToolbarMenu|DefaultToolbarButton|DefaultToolbarMenu)/.test(js),
		animated: /shouldAnimate\s*:\s*true|clock\.shouldAnimate\s*=\s*true|requestAnimationFrame|setInterval\(/.test(js),
		customShader: /CustomShader|Fabric|Material\s*\(|PostProcessStage\b/.test(js),
		primitiveApi: /new Cesium\.Primitive\b|GeometryInstance/.test(js),
	};
	const plain = !flags.dev && !flags.ion && !flags.google && !flags.thirdParty;
	const classes = [...new Set([...js.matchAll(/Cesium\.([A-Za-z_]\w*)/g)].map(m => m[1]))].sort();
	const members = [...new Set([...js.matchAll(/\bviewer\.([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)/g)].map(m => m[1]))].sort();
	const graphics = [...new Set([...js.matchAll(/^\s*(billboard|label|point|polyline|polygon|model|box|ellipse|ellipsoid|corridor|cylinder|wall|rectangle|path|plane|polylineVolume|tileset)\s*:/gm)].map(m => m[1]))].sort();
	return { title, labels, plain, flags, hosts, imports, classes, members, graphics, hasHtml: html.trim().length > 0 };
}

function fetchAll() {
	fs.mkdirSync(path.dirname(CACHE), { recursive: true });
	const tmp = fs.mkdtempSync(path.join(path.dirname(CACHE), ".clone-"));
	try {
		const git = (...a) => execFileSync("git", a, { cwd: tmp, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
		git("init", "-q");
		git("remote", "add", "origin", `https://github.com/${PIN.repo}.git`);
		git("sparse-checkout", "set", "--no-cone", ...DIRS.map(d => `/${d}/`));
		git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", PIN.commit);
		git("checkout", "-q", "FETCH_HEAD");
		const head = git("rev-parse", "HEAD").trim();
		if (head !== PIN.commit) throw new Error(`取った commit（${head}）が PIN（${PIN.commit}）と違う`);
		for (const d of ["gallery", "templates", "images", "SampleData", "Build"]) fs.rmSync(path.join(CACHE, d), { recursive: true, force: true });
		fs.mkdirSync(CACHE, { recursive: true });
		const gal = path.join(tmp, "packages/sandcastle/gallery");
		const examples = fs.readdirSync(gal, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().map(name => {
			const files = {}, text = {};
			for (const f of EX_FILES) {
				const src = path.join(gal, name, f);
				const buf = fs.existsSync(src) ? fs.readFileSync(src) : Buffer.alloc(0);
				if (buf.length) { const dst = path.join(CACHE, "gallery", name, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); files[f] = sha256(buf); }
				text[f] = String(buf);
			}
			return { name, files, ...classify(name, text["main.js"], text["index.html"], text["sandcastle.yaml"]) };
		}).filter(e => e.files["main.js"]);
		// Sandcastle の助け手（templates/Sandcastle.ts・bucket.html）と例が @import する bucket.css を templates に
		fs.cpSync(path.join(tmp, "packages/sandcastle/templates"), path.join(CACHE, "templates"), { recursive: true });
		fs.cpSync(path.join(tmp, "packages/sandcastle/public/templates"), path.join(CACHE, "templates"), { recursive: true });
		fs.cpSync(path.join(tmp, "packages/sandcastle/public/images"), path.join(CACHE, "images"), { recursive: true });
		fs.cpSync(path.join(tmp, "Apps/SampleData"), path.join(CACHE, "SampleData"), { recursive: true });
		const listed = sub => walk(path.join(CACHE, sub)).sort().map(f => ({ path: path.relative(path.join(CACHE, sub), f), sha256: sha256(fs.readFileSync(f)), bytes: fs.statSync(f).size }));
		// 本物＝npm pack → Build/Cesium だけ残す
		const pk = fs.mkdtempSync(path.join(path.dirname(CACHE), ".pack-"));
		try {
			const packOut = execFileSync("npm", ["pack", `cesium@${PIN.version}`, "--pack-destination", pk, "--json"], { encoding: "utf8" });
			const filename = [...packOut.matchAll(/"filename":\s*"([^"]+)"/g)].at(-1)?.[1];
			const integrity = [...packOut.matchAll(/"integrity":\s*"([^"]+)"/g)].at(-1)?.[1] ?? null;
			if (!filename) throw new Error("npm pack の出力から filename を特定できない");
			execFileSync("tar", ["-xzf", path.join(pk, filename), "-C", pk, "package/Build/Cesium"]);
			fs.cpSync(path.join(pk, "package/Build/Cesium"), path.join(CACHE, "Build/Cesium"), { recursive: true });
			const build = listed("Build");
			return { cesium: { ...PIN, npm: { integrity } }, examples, templates: listed("templates"), images: listed("images"), sampleData: listed("SampleData"), build: { files: build.length, bytes: build.reduce((s, f) => s + f.bytes, 0), sha256: sha256(Buffer.from(build.map(f => f.path + " " + f.sha256).join("\n"))) } };
		} finally { fs.rmSync(pk, { recursive: true, force: true }); }
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function counts(examples) {
	const c = { examples: examples.length, plain: 0 };
	for (const e of examples) {
		if (e.plain) c.plain++;
		for (const [k, v] of Object.entries(e.flags)) if (v) c[k] = (c[k] || 0) + 1;
	}
	return c;
}

// 取り置きの中身が corpus.json と同じか（無い・違う＝名前を返す）。Build は数が多い（数千）＝一覧の要約の sha256 で照合
function verifyCache(corpus) {
	const bad = [];
	const check = (rel, want) => {
		const f = path.join(CACHE, rel);
		if (!fs.existsSync(f)) return bad.push(`missing ${rel}`);
		if (sha256(fs.readFileSync(f)) !== want) bad.push(`changed ${rel}`);
	};
	for (const e of corpus.examples) for (const [f, h] of Object.entries(e.files)) check(`gallery/${e.name}/${f}`, h);
	for (const t of corpus.templates) check(`templates/${t.path}`, t.sha256);
	for (const i of corpus.images ?? []) check(`images/${i.path}`, i.sha256);
	for (const s of corpus.sampleData) check(`SampleData/${s.path}`, s.sha256);
	const bdir = path.join(CACHE, "Build");
	if (!fs.existsSync(bdir)) bad.push("missing Build");
	else {
		const build = walk(bdir).sort().map(f => path.relative(bdir, f) + " " + sha256(fs.readFileSync(f)));
		if (sha256(Buffer.from(build.join("\n"))) !== corpus.build.sha256) bad.push("changed Build");
	}
	return bad;
}

// 走らせ台が起動時に呼ぶ＝取り置きを揃えて corpus を返す
export function ensureCorpus({ log = console.log } = {}) {
	if (!fs.existsSync(CORPUS)) throw new Error(`corpus.json が無い＝先に node ${path.relative(REPO, fileURLToPath(import.meta.url))} --update`);
	const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
	if (corpus.cesium.commit !== PIN.commit) throw new Error(`corpus.json の版（${corpus.cesium.tag}）が PIN（${PIN.tag}）と違う＝--update で取り直す`);
	let bad = verifyCache(corpus);
	if (bad.length) {
		log(`取り置きを取り直す（${bad.length} 件：${bad.slice(0, 3).join(", ")}${bad.length > 3 ? " …" : ""}）`);
		fetchAll();
		bad = verifyCache(corpus);
		if (bad.length) throw new Error(`取り直しても corpus.json と合わない（${bad.slice(0, 5).join(", ")}）＝上流が変わった？ 版を確かめて --update`);
	}
	return corpus;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let corpus;
	if (process.argv.includes("--update")) {
		corpus = fetchAll();
		corpus.counts = counts(corpus.examples);
		fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, "\t") + "\n");
		console.log(`corpus.json を書いた（${path.relative(REPO, CORPUS)}）`);
	} else corpus = ensureCorpus();
	const c = corpus.counts;
	console.log(`CesiumJS ${corpus.cesium.version}（${corpus.cesium.commit.slice(0, 8)}）・例 ${c.examples} 本・素材 ${corpus.sampleData.length}・Build ${corpus.build.files} files`);
	console.log(`  開発者用でも ion・Google・外部ライブラリでもない＝${c.plain} 本`);
	console.log("  " + Object.entries(c).filter(([k]) => !["examples", "plain"].includes(k)).map(([k, v]) => `${k} ${v}`).join("・"));
}
