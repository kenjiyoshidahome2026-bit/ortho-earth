#!/usr/bin/env node
// ortho-japan SDK — 自己判定ページの実時間検証の雛形（依存ゼロ・Node 22+ の組み込み WebSocket と fetch だけ）。
// Real-time (NOT --virtual-time-budget) headless Chrome check over the DevTools protocol. The engine boots workers and
// WebGPU/WebGL asynchronously; virtual time burns its budget before they answer (false FAIL). Poll <title> in real time.
//
// 使い方 / usage:
//   node verify-example.mjs http://127.0.0.1:4174/ 9555          # url, devtools port (pick one no other process uses)
//   CHROME=/path/to/chrome OUT_DIR=./out SHOT_DELAY_MS=8000 TIMEOUT_MS=120000 node verify-example.mjs …
// ページ側の約束 / page contract: set document.title to "PASS …" when the map is up and your data is painted,
//   or "FAIL: reason" on any error (window 'error' / 'unhandledrejection' handlers installed BEFORE the module script).
// 出力 / prints: title + elapsed, screenshot (shot-loaded.png), responses with status>=400, hosts touched, console lines.
// exit 0 = PASS. ⚠ worker-internal fetches do not always appear in the page's Network events — also read your server log.
// ⚠ 静的サーバは `npx serve` か Node の小さなサーバを推奨 / prefer `npx serve` or a small Node server: on one Mac `python3 -m http.server`
//   stalled ~50 s before its first response (client reverse-DNS wait suspected), which looks like a slow engine boot but is not.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:4174/";
const PORT = Number(process.argv[3] || 9555);
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";   // Linux: /usr/bin/google-chrome
const OUT = process.env.OUT_DIR || process.cwd();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prof = mkdtempSync(join(tmpdir(), "oj-verify-"));
const chrome = spawn(CHROME, [
	"--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
	"--window-size=1280,800", "--enable-unsafe-swiftshader", "--disable-gpu-vsync", "--no-first-run", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });   // --enable-unsafe-swiftshader＝GPU の無い CI でも WebGL/WebGPU をソフトウェアで点火。
   // --disable-gpu-vsync＝headless で rAF が vsync 待ちで止まらないように（無いと初回フレームが ~50s 遅れた実測 2026-09-10）
let chromeErr = ""; chrome.stderr.on("data", (d) => { chromeErr += d; });
process.on("exit", () => chrome.kill("SIGTERM"));

async function wsUrl() {
	for (let i = 0; i < 50; i++) {
		try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === "page"); if (t) return t.webSocketDebuggerUrl; } catch { /* not up yet */ }
		await sleep(200);
	}
	throw new Error("no devtools endpoint\n" + chromeErr);
}
const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const responses = [], consoleMsgs = []; const T0 = Date.now();
ws.addEventListener("message", (m) => {
	const j = JSON.parse(m.data);
	if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); return; }
	if (j.method === "Network.responseReceived") responses.push(j.params.response);
	if (j.method === "Runtime.consoleAPICalled") consoleMsgs.push(`+${((Date.now() - T0) / 1000).toFixed(1)}s ${j.params.type}: ` + j.params.args.map((a) => a.value ?? a.description ?? "").join(" "));   // 経過秒＝どこで待ったかが読める
	if (j.method === "Runtime.exceptionThrown") consoleMsgs.push("EXCEPTION: " + (j.params.exceptionDetails.exception?.description || JSON.stringify(j.params.exceptionDetails)));
});
const send = (method, params = {}) => new Promise((res, rej) => {
	const i = ++id; pending.set(i, (j) => j.error ? rej(new Error(method + ": " + JSON.stringify(j.error))) : res(j.result));
	ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
	const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
	return r.result.value;
};

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
console.log("navigate:", URL_);
await send("Page.navigate", { url: URL_ });
const t0 = Date.now(); let title = "";
while (Date.now() - t0 < TIMEOUT_MS) {   // 実時間ポーリング / real-time poll
	title = await evalJs("document.title");
	if (/^(PASS|FAIL)/.test(title)) break;
	await sleep(500);
}
console.log(`title after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(title)}`);
await sleep(Number(process.env.SHOT_DELAY_MS || 3000));   // タイルの着地を待ってから撮る（全球ビューの世界層は +5s 程度＝SHOT_DELAY_MS=8000）/ let tiles settle before the screenshot
const png = Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
writeFileSync(join(OUT, "shot-loaded.png"), png); console.log("screenshot:", join(OUT, "shot-loaded.png"));

const bad = responses.filter((r) => r.status >= 400);
console.log(`network: ${responses.length} responses, ${bad.length} with status>=400`);
for (const r of bad) console.log("  BAD", r.status, r.url);
const hosts = {}; for (const r of responses) { const h = new URL(r.url).host || "(blob/data)"; hosts[h] = (hosts[h] || 0) + 1; }
console.log("hosts:", JSON.stringify(hosts));   // 自サイト＋タイル/API 以外のホストが居たら「エンジン再同梱/CDN 直参照」を疑う
console.log("console (first 40):"); for (const c of consoleMsgs.slice(0, 40)) console.log("  " + c);
ws.close(); chrome.kill("SIGTERM");
process.exit(/^PASS/.test(title) ? 0 : 1);
