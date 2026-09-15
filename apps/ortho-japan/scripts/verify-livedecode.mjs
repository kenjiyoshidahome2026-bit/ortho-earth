#!/usr/bin/env node
// PLATEAU ライブデコードの実走検定：dist/lib（出荷物そのもの）を tests/livedecode-host.html に埋め込み、
// **焼き（R2 の PLQ）を空振りさせ・デコードプールを強制（?dec=3）・新規プロファイル** で未焼き経路を必ず踏ませ、
// 区 worker → デコーダ（main 生成・MessagePort 直結）→ loaders.gl 初回 import → 16 バッチ → main の "[plateau] done" までを見る。
// 生まれた経緯：入口 1 本化（worker.js）後、区 worker からの入れ子 new Worker を vite が new Worker(self.location.href,{name}) に
// 書き換え、環境によって子が一度も走らず**未焼き区だけ永久 STALL** した（本番 c34c353e・2026-09-14）。焼き済み区は OPFS/IDB から
// 立つので通常の検定では見えない＝この関門でしか捕まらない。
// 掟：
//  - プロファイルは毎回新規（同一オリジンの OPFS/IDB に前回の完成品が残ると「12 秒で完走」の偽陽性になる）
//  - bake は存在しない URL を指す（?bake=…/nobake/）＝manifest 404 → 生経路
//  - worker のコンソールは CDP の Target.setAutoAttach（flatten）で拾う（stall 時の子の足跡が要る）
// 使い方: apps/ortho-japan で `npm run verify:livedecode`（内部で build:lib）。要ローカル Chrome（環境変数 CHROME）・要ネット
//（api.plateauview.mlit.go.jp からタイル実取得＝40 秒前後）。区は環境変数 VIEW で変更可（既定＝那覇 z15 45°）。
import { spawn, execFileSync } from "node:child_process";
import fsSync from "node:fs";
const LD_PROFILE = `/tmp/oj-livedecode-${process.pid}`;
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5251, CDP = 9339;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEW = process.env.VIEW || "#15/26.2124/127.6809/45t";   // 那覇市＝焼きが無くても 502 タイル・40 秒級で完走する規模
const LIMIT_MS = 150000;
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png" };

if (process.env.SKIP_BUILD !== "1") { console.log("… build:lib"); execFileSync("npm", ["run", "build:lib"], { cwd: APP, stdio: "inherit" }); }

// 素の静的サーバ：/ → tests/livedecode-host.html・/lib/ → dist/lib・/assets/ → public（実行時アセット）。/nobake/ は 404。
const hits = [];
const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x"); hits.push(url.pathname);
	const file = url.pathname === "/" ? path.join(APP, "tests/livedecode-host.html")
		: url.pathname.startsWith("/lib/") ? path.join(APP, "dist/lib", url.pathname.slice(5))
		: url.pathname.startsWith("/assets/") ? path.join(APP, "public", url.pathname.slice(8))
		: null;
	try {
		if (!file) throw new Error("404");
		const body = await readFile(file);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" });
		res.end(body);
	} catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
	"--no-first-run", `--user-data-dir=${LD_PROFILE}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { server.close(); chrome.kill(); });
const page = `http://127.0.0.1:${PORT}/?dec=3&bake=${encodeURIComponent(`http://127.0.0.1:${PORT}/nobake/`)}&view=${encodeURIComponent(VIEW)}`;

let ws = null, fail = 1;
try {
	for (let i = 0; ; i++) { try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ } if (i > 60) throw new Error("chrome devtools が起動しない"); await sleep(250); }
	const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" })).json();
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0; const pending = new Map(), logs = [], names = new Map();
	const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
	ws.onmessage = ev => { const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
		const who = m.sessionId ? (names.get(m.sessionId) || "worker") : "page";
		if (m.method === "Target.attachedToTarget") {   // worker（入れ子含む）にも自動アタッチ＝子の console を拾う
			const t = m.params.targetInfo; names.set(m.params.sessionId, `${t.type}:${t.title || t.url.split("/").pop()}`.slice(0, 40));
			send("Runtime.enable", {}, m.params.sessionId); send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId); return;
		}
		if (m.method === "Runtime.consoleAPICalled") { const s = (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "); if (/plateau|worker|decode|livedecode/i.test(s)) logs.push(`[${who}][${m.params.type}] ${s.slice(0, 180)}`); }
		if (m.method === "Runtime.exceptionThrown") logs.push(`[${who}] EXC ` + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?").slice(0, 240));
	};
	await send("Runtime.enable"); await send("Page.enable");
	await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	await send("Page.navigate", { url: page });
	const t0 = Date.now(); let stalledAt = null, done = false;
	while (Date.now() - t0 < LIMIT_MS) {
		await sleep(1000);
		if (stalledAt == null && logs.some(l => /stall reported/.test(l))) stalledAt = Math.round((Date.now() - t0) / 1000);
		if (logs.some(l => /\[page\].*\[plateau\] done /.test(l))) { done = true; break; }
	}
	const secs = Math.round((Date.now() - t0) / 1000);
	const poolUp = logs.some(l => /decode pool up/.test(l));
	const batches = logs.filter(l => /\[plateau\] batch \d+ /.test(l)).length;
	const bakeMiss = hits.some(h => h.startsWith("/nobake/"));
	const checks = [
		[bakeMiss, `bakeMiss(${bakeMiss ? "manifest 404＝生経路" : "焼きを引いていない？"})`],
		[poolUp, "decodePool(main 生成・port 直結)"],
		[batches > 0, `batches(${batches})`],
		[done, `done(${secs}s${stalledAt != null ? `・stall 警告@${stalledAt}s` : ""})`],
	];
	fail = checks.some(([ok]) => !ok) ? 1 : 0;
	console.log(`${fail ? "FAIL" : "PASS"}  livedecode  ${checks.map(([ok, n]) => (ok ? "ok:" : "NG:") + n).join(" ")}`);
	if (fail) logs.slice(-24).forEach(l => console.log("      " + l));
} catch (e) {
	console.error("FAIL  verify-livedecode  ", e.message);
} finally {
	try { ws && ws.close(); } catch { /* 終了時 */ }
	server.close(); chrome.kill();
}
process.exit(fail);

process.on("exit", () => { try { fsSync.rmSync(LD_PROFILE, { recursive: true, force: true }); } catch { /* 無害 */ } });   // プロファイルの掃除（2026-09-15）
