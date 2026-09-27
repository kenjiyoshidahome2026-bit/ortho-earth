#!/usr/bin/env node
// 公式例の門（台帳 §8）の目録＝MapLibre GL JS の公式例・素材・本物の dist を**版を固定して**手元の取り置きへ取る。
//   ・例＝maplibre/maplibre-gl-js の test/examples/*.html（BSD-3-Clause）・素材＝docs/assets/（例は maplibre.org の絶対 URL で取る＝走らせ台が振り替える）
//   ・本物＝npm の maplibre-gl（`npm pack`＝lock を触らない）の dist/
//   ・置き場＝<repo>/.cache/mlexamples/<版>/{examples,assets,dist}（.cache/ は gitignore 済＝repo に入れない）
//   ・corpus.json（commit する）＝版・commit・各ファイルの sha256・例ごとの分類。取り直した物が corpus.json と違えば落ちる（黙って別物を測らない）
// 使い方: node packages/globe/tests/mlexamples/corpus.mjs [--update]
//   既定＝取り置きが無ければ取り、corpus.json の sha256 と照合して分類の本数を出す
//   --update＝取り直して corpus.json を書き直す（版を上げる時だけ・上の PIN を変えてから）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
export const PIN = { version: "6.11.2", tag: "v6.11.2", commit: "acb7b722f6a752ac1a2ba98cf83006c83dc4fafa", repo: "maplibre/maplibre-gl-js" };
export const CACHE = path.join(REPO, ".cache/mlexamples", PIN.version);
const CORPUS = path.join(HERE, "corpus.json");
// 素材のうち例が使わない物（例の縮図 png・サイトの css・資金の申告）は取らない
const ASSET_SKIP = /^docs\/assets\/(examples\/|\.well-known\/|extra\.css$|\.gitattributes$)/;

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ghHeaders = () => {
	const h = { "User-Agent": "ortho-earth-mlexamples", Accept: "application/vnd.github+json" };
	let tok = process.env.GITHUB_TOKEN || "";
	if (!tok) { try { tok = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); } catch { /* 無くても 60 回/時で足りる */ } }
	if (tok) h.Authorization = `Bearer ${tok}`;
	return h;
};

async function fetchBuf(url, headers = {}) {
	for (let i = 0; ; i++) {
		try {
			const r = await fetch(url, { headers });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return Buffer.from(await r.arrayBuffer());
		} catch (e) {
			if (i >= 3) throw new Error(`${url}: ${e.message}`);
			await sleep(500 * 2 ** i);
		}
	}
}

// GitHub の contents API で目録（dir は潜る）。例 139・素材 30 程度＝数回の呼び出しで済む
async function listDir(dir, headers) {
	const url = `https://api.github.com/repos/${PIN.repo}/contents/${dir}?ref=${PIN.commit}`;
	const items = JSON.parse(String(await fetchBuf(url, headers)));
	const out = [];
	for (const it of items) {
		if (it.type === "dir") out.push(...await listDir(it.path, headers));
		else if (it.type === "file") out.push(it.path);
	}
	return out;
}

async function pool(items, n, fn) {
	const out = new Array(items.length);
	let k = 0;
	await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
	return out;
}

// ── 分類（正規表現の見立て＝走らせる前の予想。本当の段は門が決める）──
const meta = (src, prop) => (src.match(new RegExp(`<meta\\s+property=["']og:${prop}["']\\s+content=["']([^"']*)["']`, "i")) || [])[1] ?? null;
function classify(name, src) {
	const title = (src.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() ?? name;
	const hosts = [...new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase()))].sort();
	// 外部ライブラリ＝本物以外の script src・http(s) からの import・import map の項目（maplibre-gl 自身は除く）
	const libs = new Set();
	for (const m of src.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)) if (!/^(?:\.\.\/)+dist\/maplibre-gl/.test(m[1])) libs.add(m[1]);   // 本物＝相対の ../../dist だけ（CDN の maplibre-gl-terradraw 等は外部）
	for (const m of src.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?["'](https?:\/\/[^"']+)["']/g)) libs.add(m[1]);
	for (const m of src.matchAll(/\bimport\(\s*["'](https?:\/\/[^"']+)["']/g)) libs.add(m[1]);
	const im = src.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
	if (im) { try { for (const [k, v] of Object.entries(JSON.parse(im[1]).imports || {})) if (k !== "maplibre-gl") libs.add(`${k}=${v}`); } catch { libs.add("importmap(unparsed)"); } }
	// 註釈（<!-- -->）を除いた本文で見立てる（分類のためだけ＝HTML の消毒ではない）。入れ子・分割を残さないよう変わらなくなるまで剥ぐ（CodeQL js/incomplete-multi-character-sanitization）
	let code = src, prev;
	do { prev = code; code = code.replace(/<!--[\s\S]*?-->/g, ""); } while (code !== prev);
	const flags = {
		needsKey: /get_your_own|[?&](?:key|api_key|apikey|access_token)=|x-api-key/i.test(code),
		thirdParty: libs.size > 0,
		custom: /type\s*:\s*["']custom["']/.test(code),
		globe: /setProjection|projection["']?\s*:\s*\{[^}]*globe|["']globe["']/.test(code),
		terrain: /setTerrain|\bterrain["']?\s*:|raster-dem/.test(code),
		animated: /requestAnimationFrame|setInterval\(/.test(code),
		interactive: /\.on\(\s*["'](?:click|dblclick|mousemove|mouseenter|mouseleave|mousedown|mouseup|contextmenu|touchstart|touchend)["']|addEventListener\(\s*["'](?:click|input|change|keydown)["']/.test(code),
		random: /Math\.random|Date\.now\(|new Date\(/.test(code),
		geolocation: /GeolocateControl|navigator\.geolocation/.test(code),
		importmap: !!im,
		maps: (code.match(/new\s+maplibregl\.Map\s*\(/g) || []).length,
	};
	const plain = !flags.needsKey && !flags.thirdParty && !flags.custom;
	// 使う口（順位表の下ごしらえ）：maplibregl.X と map.x(
	const classes = [...new Set([...code.matchAll(/maplibregl\.([A-Za-z_]\w*)/g)].map(m => m[1]))].sort();
	const methods = [...new Set([...code.matchAll(/\bmap\.([a-zA-Z_]\w*)\s*\(/g)].map(m => m[1]))].sort();
	return { title, description: meta(src, "description"), category: meta(src, "category"), plain, flags, hosts, libs: [...libs].sort(), classes, methods };
}

async function fetchAll() {
	const headers = ghHeaders();
	const exPaths = (await listDir("test/examples", headers)).filter(p => p.endsWith(".html")).sort();
	const assetPaths = (await listDir("docs/assets", headers)).filter(p => !ASSET_SKIP.test(p)).sort();
	const raw = p => `https://raw.githubusercontent.com/${PIN.repo}/${PIN.commit}/${p}`;
	const put = (rel, buf) => { const f = path.join(CACHE, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
	const examples = await pool(exPaths, 8, async p => {
		const buf = await fetchBuf(raw(p));
		const name = path.basename(p, ".html");
		put(`examples/${name}.html`, buf);
		return { name, sha256: sha256(buf), bytes: buf.length, ...classify(name, String(buf)) };
	});
	const assets = await pool(assetPaths, 8, async p => {
		const buf = await fetchBuf(raw(p));
		const rel = p.slice("docs/assets/".length);
		put(`assets/${rel}`, buf);
		return { path: rel, sha256: sha256(buf), bytes: buf.length };
	});
	// 本物の dist＝npm pack（lock も node_modules も触らない）→ dist/ だけ残す
	const tmp = fs.mkdtempSync(path.join(CACHE, "..", ".pack-"));
	const info = JSON.parse(execFileSync("npm", ["pack", `maplibre-gl@${PIN.version}`, "--pack-destination", tmp, "--json"], { encoding: "utf8" }))[0];
	execFileSync("tar", ["-xzf", path.join(tmp, info.filename), "-C", tmp]);
	fs.rmSync(path.join(CACHE, "dist"), { recursive: true, force: true });
	fs.cpSync(path.join(tmp, "package/dist"), path.join(CACHE, "dist"), { recursive: true });
	fs.rmSync(tmp, { recursive: true, force: true });
	const dist = fs.readdirSync(path.join(CACHE, "dist")).sort().map(f => {
		const buf = fs.readFileSync(path.join(CACHE, "dist", f));
		return { path: f, sha256: sha256(buf), bytes: buf.length };
	});
	return { maplibre: { ...PIN, npm: { integrity: info.integrity, shasum: info.shasum } }, examples, assets, dist };
}

function counts(examples) {
	const c = { examples: examples.length, plain: 0 };
	for (const e of examples) {
		if (e.plain) c.plain++;
		for (const [k, v] of Object.entries(e.flags)) if (k === "maps" ? v > 1 : v) c[k] = (c[k] || 0) + 1;
	}
	return c;
}

// 取り置きの中身が corpus.json と同じか（無い・違う＝名前を返す）
function verifyCache(corpus) {
	const bad = [];
	const check = (rel, want) => {
		const f = path.join(CACHE, rel);
		if (!fs.existsSync(f)) return bad.push(`missing ${rel}`);
		if (sha256(fs.readFileSync(f)) !== want) bad.push(`changed ${rel}`);
	};
	for (const e of corpus.examples) check(`examples/${e.name}.html`, e.sha256);
	for (const a of corpus.assets) check(`assets/${a.path}`, a.sha256);
	for (const d of corpus.dist) check(`dist/${d.path}`, d.sha256);
	return bad;
}

// 走らせ台（verify-examples.mjs）が起動時に呼ぶ＝取り置きを揃えて corpus を返す
export async function ensureCorpus({ log = console.log } = {}) {
	if (!fs.existsSync(CORPUS)) throw new Error(`corpus.json が無い＝先に node ${path.relative(REPO, fileURLToPath(import.meta.url))} --update`);
	const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
	if (corpus.maplibre.commit !== PIN.commit) throw new Error(`corpus.json の版（${corpus.maplibre.tag}）が PIN（${PIN.tag}）と違う＝--update で取り直す`);
	let bad = verifyCache(corpus);
	if (bad.length) {
		log(`取り置きを取り直す（${bad.length} 件：${bad.slice(0, 3).join(", ")}${bad.length > 3 ? " …" : ""}）`);
		await fetchAll();
		bad = verifyCache(corpus);
		if (bad.length) throw new Error(`取り直しても corpus.json と合わない（${bad.slice(0, 5).join(", ")}）＝上流が変わった？ 版を確かめて --update`);
	}
	return corpus;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const update = process.argv.includes("--update");
	let corpus;
	if (update) {
		corpus = await fetchAll();
		corpus.counts = counts(corpus.examples);
		fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, "\t") + "\n");
		console.log(`corpus.json を書いた（${path.relative(REPO, CORPUS)}）`);
	} else {
		corpus = await ensureCorpus();
	}
	const c = corpus.counts;
	console.log(`MapLibre GL JS ${corpus.maplibre.version}（${corpus.maplibre.commit.slice(0, 8)}）・例 ${c.examples} 本・素材 ${corpus.assets.length}・dist ${corpus.dist.length}`);
	console.log(`  鍵も外部ライブラリも custom も無い＝${c.plain} 本`);
	console.log("  " + Object.entries(c).filter(([k]) => !["examples", "plain"].includes(k)).map(([k, v]) => `${k} ${v}`).join("・"));
}
