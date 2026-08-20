#!/usr/bin/env node
// npm 配布物の検定＝publish の必須ゲート。`npm pack` が作る tarball **そのもの**を展開し、
// 文書どおりの消費法（dist/lib と assets/ を静的配信・URL import）で実際に起動するかを検る。
//   ①静的: tarball の中身検査＝lib入口/CSS/d.ts/assets/skill が居る・sourcemapや開発物が紛れていない
//   ②実走: 展開物を静的サーバで配り、embed ページから import → 起動（canvas・#map）＋ request台帳404ゼロ
// verify:prod と同族＝「置き場所が変わると死ぬ」クラス（base:"/"事故の型）を npm 経路でも封じる。
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import os from "node:os";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5246, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".txt": "text/plain", ".md": "text/markdown" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

// ① pack（prepack が build:lib + d.ts + assets staging を実施）→ 一時ディレクトリへ展開
console.log("… npm pack");
const packOut = execFileSync("npm", ["pack", "--json"], { cwd: APP, encoding: "utf8" });
// --json でも prepack のビルドログが stdout に混ざる＝末尾の "filename" を正規表現で拾う（JSON.parse直は不可）
const tarName = [...packOut.matchAll(/"filename":\s*"([^"]+)"/g)].at(-1)?.[1];
if (!tarName) fail("npm pack の出力から filename を特定できない");
const tarball = path.join(APP, tarName);
const WORK = path.join(os.tmpdir(), `oj-npm-verify-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
execFileSync("tar", ["xzf", tarball, "-C", WORK]);
const PKG = path.join(WORK, "package");

for (const f of ["dist/lib/ortho-japan.js", "dist/lib/ortho-japan.css", "dist/lib/ortho-japan.d.ts",
	"assets/plateau-sets.json", "assets/ai/citycodes.json", "sdk/example.html", "sdk/skill/ortho-earth-sdk/SKILL.md",
	"README.md", "LICENSE", "package.json"]) {
	if (!existsSync(path.join(PKG, f))) fail(`tarball に ${f} が無い`);
}
if (existsSync(path.join(PKG, "dist/lib/ortho-japan.js.map"))) console.warn("  ⚠ sourcemap が同梱されている（サイズ注意・実害なし）");
const meta = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8"));
if (Object.keys(meta.dependencies || {}).length) fail(`dependencies が空でない＝ワークスペース私有名で install が壊れる: ${Object.keys(meta.dependencies).join(",")}`);
console.log(`ok:tarball（${path.basename(tarball)}・中身検査PASS・runtime deps ゼロ）`);

// ② 実走：展開したパッケージを「利用者のサイト」に見立てて配信（/lib/ /assets/ ＝README の作法どおり）
const host = `<!doctype html><meta charset="utf-8"><title>npm-embed</title>
<link rel="stylesheet" href="/lib/ortho-japan.css">
<div id="here" style="width:480px;height:320px"></div>
<script type="module">
import orthoJapan from "/lib/ortho-japan.js";
orthoJapan({ target: "#here", assetBase: "/assets/", plateau: false }).then(() => { document.title = "PASS npm-embed"; });
</script>`;
const read = promisify(readFile);
const requests = [];
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	const file = p === "/" ? null
		: p.startsWith("/lib/") ? path.join(PKG, "dist/lib", p.slice(5))
		: p.startsWith("/assets/") ? path.join(PKG, "assets", p.slice(8)) : null;
	try {
		const body = file ? await read(file) : host;
		requests.push("200 " + p);
		res.writeHead(200, { "Content-Type": file ? (MIME[path.extname(file)] || "application/octet-stream") : "text/html" });
		res.end(body);
	} catch { requests.push("404 " + p); res.writeHead(404); res.end("nf"); }
}).listen(PORT);

const dom = await new Promise(resolve => {
	const c = spawn(CHROME, ["--headless=new", `--user-data-dir=/tmp/oj-npm-${process.pid}`, "--disable-gpu",
		"--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--virtual-time-budget=25000", "--dump-dom",
		`http://localhost:${PORT}/`], { timeout: 90000 });
	let out = ""; c.stdout.on("data", d => out += d); c.on("close", () => resolve(out));
});
server.close();
rmSync(WORK, { recursive: true, force: true });
if (!dom.includes("PASS npm-embed")) fail("実走: orthoJapan() が resolve しない（tarball 消費で起動失敗）");
if (!/<canvas id="c"/.test(dom)) fail("実走: 描画canvas不在");
const notFound = requests.filter(r => r.startsWith("404 ") && !r.includes("favicon"));
if (notFound.length) fail(`実走: 404が${notFound.length}件＝${[...new Set(notFound)].slice(0, 5).join(" / ")}`);
if (!requests.some(r => r.includes("/lib/assets/renderworker-"))) fail("実走: render worker が相対で引かれていない");
console.log(`ok:embed（tarball消費で起動・worker相対解決・404ゼロ / 要求${requests.length}件）`);
console.log("✓ npm 配布物の検定PASS");
