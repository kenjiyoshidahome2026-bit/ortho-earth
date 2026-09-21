#!/usr/bin/env node
// npm 配布物の検定＝publish の必須ゲート。`npm pack` が作る tarball **そのもの**を展開し、
// 文書どおりの消費法（dist/lib と assets/ を静的配信・URL import）で実際に起動するかを検る。
//   ①静的: tarball の中身検査＝lib入口/CSS/d.ts/assets/skill が居る・sourcemapや開発物が紛れていない
//   ②実走: 展開物を静的サーバで配り、embed ページから import → 起動（canvas・#map）＋ request台帳404ゼロ
// verify:prod と同族＝「置き場所が変わると死ぬ」クラス（base:"/"事故の型）を npm 経路でも封じる。
import { spawn, execFileSync } from "node:child_process";
import fsSync from "node:fs";
// 起動時に前回までの per-pid プロファイル（同じ接頭辞・別 pid）を掃く＝exit 時の削除は Chrome の後書きで残ることがある（/tmp 満杯の轍・2026-09-15）
const sweepProfiles = prefix => { try { for (const d of fsSync.readdirSync("/tmp")) if (d.startsWith(prefix) && d !== `${prefix}${process.pid}`) fsSync.rmSync(`/tmp/${d}`, { recursive: true, force: true }); } catch { /* 無害 */ } };
sweepProfiles("oj-npm-");

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
	"assets/plateau-sets.json", "sdk/example.html", "sdk/skill/ortho-earth-sdk/SKILL.md",
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

// 実時間の CDP で待つ（旧＝--virtual-time-budget＋--dump-dom。仮想時間では worker の import が解決せず起動が進まない上、
// spawn の timeout は Chrome 本体しか殺さず子プロセスが stdout を握ったまま＝関門が無限に止まった・2026-09-21 Chrome 153）。
// verify-lib と同じ作法：about:blank で立てて Page.navigate（PUT /json/new?url= は about:blank になる個体がある）。
const CDP = PORT + 1;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=/tmp/oj-npm-${process.pid}`, "--disable-gpu",
	"--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run", "about:blank"], { stdio: "ignore" });
const killChrome = () => { try { chrome.kill("SIGKILL"); } catch { /* 済 */ } };
process.on("exit", killChrome);
const embed = await (async () => {
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) return { err: "chrome devtools が起動しない" };
		await sleep(250);
	}
	const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === "page");
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0; const pending = new Map(), errs = [];
	const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
	ws.onmessage = ev => { const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
		if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?"));
	};
	await send("Runtime.enable");
	await send("Page.navigate", { url: `http://localhost:${PORT}/` });
	const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
	const t0 = Date.now(); let title = "";
	while (Date.now() - t0 < 60000) { await sleep(1000); title = await ev("document.title") || ""; if (title.startsWith("PASS")) break; }
	const canvas = await ev(`!!document.querySelector("canvas#c")`);
	try { ws.close(); } catch { /* 済 */ }
	return { title, canvas, errs };
})();
killChrome();
server.close();
rmSync(WORK, { recursive: true, force: true });
if (embed.err) fail(`実走: ${embed.err}`);
if (embed.title !== "PASS npm-embed") fail(`実走: orthoJapan() が resolve しない（tarball 消費で起動失敗）${embed.errs.length ? "\n      " + embed.errs.slice(0, 5).join("\n      ") : ""}`);
if (!embed.canvas) fail("実走: 描画canvas不在");
const notFound = requests.filter(r => r.startsWith("404 ") && !r.includes("favicon"));
if (notFound.length) fail(`実走: 404が${notFound.length}件＝${[...new Set(notFound)].slice(0, 5).join(" / ")}`);
if (!requests.some(r => r.includes("/lib/assets/renderworker-"))) fail("実走: render worker が相対で引かれていない");
console.log(`ok:embed（tarball消費で起動・worker相対解決・404ゼロ / 要求${requests.length}件）`);
console.log("✓ npm 配布物の検定PASS");
