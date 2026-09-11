#!/usr/bin/env node
// ortho-world npm 配布物の検定＝publish の必須ゲート（geopbf / ortho-japan の関門と同型）。
//   tarball → 使い捨ての vite 消費アプリに install → 実ビルド → headless で実走。
//   「モノレポでは動くが、npm から入れると動かない」型（依存の焼き込み漏れ・CSS の同梱漏れ・
//   exports の書き損じ）は、ここでしか捕まらない。
// 検査項目:
//   ① tarball の中身＝lib 実体・CSS・型定義・example が入っている／.map は入っていない
//   ② 出荷 CSS が body/html に触っていない（部品がページを汚さない）
//   ③ 消費アプリの vite build が通る（import "ortho-world" と "ortho-world/ortho-world.css" が解決する）
//   ④ 実走: 渡した div の中に 262 枚描かれる
//   ⑤ 箱の掟: URL を書かない・window を汚さない・body 直下に痕跡を残さない・destroy() で綺麗に消える
//   ⑥ 出入口: 外→world の hover(iso3) が効き、world→外 の map/select 合図が飛ぶ
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import os from "node:os";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5248, CDP = 9348;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".map": "application/json" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… npm pack");
const packOut = execFileSync("npm", ["pack", "--json"], { cwd: APP, encoding: "utf8" });
const tarName = [...packOut.matchAll(/"filename":\s*"([^"]+)"/g)].at(-1)?.[1];
if (!tarName) fail("npm pack の出力から filename を特定できない");
const tarball = path.join(APP, tarName);
const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").map(s => s.replace(/^package\//, "")).filter(Boolean);

// ── ① 同梱物 ─────────────────────────────────────────────────────────────
for (const f of ["dist/lib/ortho-world.js", "dist/lib/ortho-world.css", "sdk/ortho-world.d.ts", "example.html", "README.md", "LICENSE"]) {
	if (!entries.includes(f)) fail(`tarball に ${f} が無い（files / prepack の漏れ）\n  中身: ${entries.join(" ")}`);
}
const maps = entries.filter(f => f.endsWith(".map"));
if (maps.length) fail(`tarball に sourcemap が混ざっている（${maps.join(" ")}）`);
console.log(`ok:pack（${entries.length}ファイル・lib/CSS/型/example 同梱・map 非同梱）`);

// ── ② 出荷 CSS が外を汚さない ────────────────────────────────────────────
{
	const css = execFileSync("tar", ["-xzOf", tarball, "package/dist/lib/ortho-world.css"], { encoding: "utf8" });
	const bad = css.match(/(^|[},])\s*(html|body)[\s,{[.:]/g);
	if (bad) fail(`出荷 CSS が body/html に触っている（${[...new Set(bad)].join(" ")}）＝埋め込み先のページを汚す`);
	if (!css.includes(".ortho-world")) fail("出荷 CSS に .ortho-world が無い（意匠が入っていない）");
	console.log(`ok:css（${(css.length / 1024).toFixed(1)}KB・body/html に触れていない）`);
}

// ── ③ 使い捨ての消費アプリで実ビルド ─────────────────────────────────────
const WORK = path.join(os.tmpdir(), `ortho-world-npm-verify-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(path.join(WORK, "src"), { recursive: true });
writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 1));
writeFileSync(path.join(WORK, "index.html"), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>consumer</title>
<style>html,body{margin:0;height:100%;background:#123}#box{position:absolute;left:10px;top:10px;width:900px;height:600px}</style>
</head><body><div id="box"></div><script type="module" src="/src/main.js"></script></body></html>`);
// 消費側は **top-level await を使わない**書き方にする（vite の既定 target は es2020＝TLA を許さない）。
// ここで .then() を通しておけば「普通の設定の普通のアプリ」で動くことの証明になる。
writeFileSync(path.join(WORK, "src/main.js"), `import world from "ortho-world";
import "ortho-world/ortho-world.css";
window.__log = [];
world({ target: "#box", lang: "en" }).then(w => {
	["map", "select", "hover"].forEach(k => w.on(k, e => window.__log.push([k, e && (e.iso2 || e.key)])));
	window.__w = w;
});
`);
console.log("… npm install（tarball＋vite）");
execFileSync("npm", ["install", tarball, "vite@^6", "--no-audit", "--no-fund", "--silent"], { cwd: WORK, stdio: "inherit" });
console.log("… vite build（消費者バンドラ実通し）");
execFileSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: WORK, stdio: "inherit" });

// ── 素の静的サーバで出荷物を配る ─────────────────────────────────────────
const read = promisify(readFile);
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	const file = path.join(WORK, "dist", p.endsWith("/") ? p + "index.html" : p);
	try { const body = await read(file); res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(body); }
	catch { res.writeHead(404); res.end("nf"); }
}).listen(PORT);

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--disable-gpu", "--no-first-run",
	`--user-data-dir=${WORK}/chrome`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
const bye = () => { try { chrome.kill(); } catch { } try { server.close(); } catch { } rmSync(tarball, { force: true }); };
process.on("exit", bye);
for (let i = 0; ; i++) {
	try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
	if (i > 60) { bye(); fail("chrome devtools が起動しない"); }
	await sleep(250);
}
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map(); const errs = [];
ws.onmessage = e => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
	if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "").slice(0, 200));
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push("ERR " + m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
};
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 8000); });
const ev = async x => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: `http://localhost:${PORT}/` });

// ── ④ 実走 ───────────────────────────────────────────────────────────────
let cards = 0;
for (let i = 0; i < 240; i++) { cards = await ev(`document.querySelectorAll("#box div.nation").length`); if (cards > 0) break; await sleep(250); }
if (cards < 200) { errs.slice(0, 5).forEach(e => console.error("      " + e)); bye(); fail(`実走: 箱の中に ${cards} 枚しか描かれない（期待 200+）`); }
console.log(`ok:run（npm から入れた部品が div の中に ${cards} 枚描いた）`);

// ── ⑤ 箱の掟 ─────────────────────────────────────────────────────────────
{
	const box = JSON.parse(await ev(`JSON.stringify({
		url: location.search + location.hash,
		globals: ["nations","model","state","Sound"].filter(k => k in window),
		bodyKids: [...document.body.children].map(c => c.tagName + (c.id ? "#" + c.id : "")),
		tipInside: !!document.querySelector("#box .overlap-tooltip") || !document.querySelector(".overlap-tooltip"),
		cls: document.getElementById("box").className })`));
	if (box.url) { bye(); fail(`箱の掟: URL を書き換えている（${box.url}）`); }
	if (box.globals.length) { bye(); fail(`箱の掟: window を汚している（${box.globals.join(" ")}）`); }
	if (box.bodyKids.some(t => !/^DIV#box$|^SCRIPT$/.test(t))) { bye(); fail(`箱の掟: body 直下に痕跡（${box.bodyKids.join(" ")}）`); }
	if (!box.tipInside) { bye(); fail("箱の掟: ツールチップが箱の外に生まれている"); }
	if (!/ortho-world/.test(box.cls)) { bye(); fail("箱の掟: コンテナに .ortho-world が付いていない"); }
	console.log(`ok:box（URL 無汚染・window 無汚染・body 直下は ${box.bodyKids.join("/")} だけ・tooltip も箱の中）`);
}

// ── ⑥ 出入口 ─────────────────────────────────────────────────────────────
{
	await ev(`__w.hover("FRA");1`); await sleep(600);
	const hit = await ev(`(() => { const n = document.querySelector("#box .remote-hover"); return n ? n.textContent.slice(0, 12) : null; })()`);
	if (!hit || !/France/.test(hit)) { bye(); fail(`出入口: hover("FRA") が効かない（${hit}）`); }
	await ev(`__w.clear();1`);
	if (await ev(`document.querySelectorAll("#box .remote-hover").length`)) { bye(); fail("出入口: clear() で解除されない"); }
	await ev(`document.querySelector("#box div.nation img.mapopen").click();1`); await sleep(400);
	await ev(`document.querySelector("#box div.nation img.hover").click();1`); await sleep(1000);
	const log = await ev(`JSON.stringify(window.__log.map(t => t[0]))`);
	for (const want of ["map", "select"]) if (!JSON.parse(log).includes(want)) { bye(); fail(`出入口: on("${want}") が飛んでいない（${log}）`); }
	console.log(`ok:signals（hover/clear と map/select の往復＝${log}）`);
	// destroy
	await ev(`document.querySelector("#box [name=modal] [name=close]")?.click();1`); await sleep(500);
	await ev(`__w.destroy();1`); await sleep(400);
	const left = JSON.parse(await ev(`JSON.stringify({ kids: document.getElementById("box").children.length, cls: document.getElementById("box").className })`));
	if (left.kids || left.cls.includes("ortho-world")) { bye(); fail(`destroy: 片付いていない（子${left.kids} / class "${left.cls}"）`); }
	console.log("ok:destroy（箱が空になり class も外れる）");
}

if (errs.length) { errs.slice(0, 8).forEach(e => console.error("      " + e)); bye(); fail(`コンソール: 例外/error ${errs.length}件`); }
bye();
await sleep(500);   // chrome が user-data-dir を離すのを待つ
try { rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 後片付けの失敗で検定を落とさない */ }
console.log("✓ ortho-world npm 配布物の検定PASS（同梱物・CSS の作法・実ビルド・実走・箱の掟・出入口）");
