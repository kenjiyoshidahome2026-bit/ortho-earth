#!/usr/bin/env node
// SDK 契約のスモーク：dist/lib（ライブラリビルド）を「第三者のページ」へ埋め込み、約束を守れているか検定する。
//   ① ホストの体裁（html背景/body余白/overflow/文字色/書体/visibility/スクロール）を一切変えない
//   ② 地図は預かった div の中だけ（全画面を乗っ取らない）
//   ③ ホストの window を汚さない（__cam 等のデバッグ手は target 指定時は生えない）
//   ④ destroy で綺麗に剥がれ、ホストは元のまま
// 使い方: apps/ortho-japan で `npm run verify:lib`（内部で build:lib を実行）。要ローカルChrome（環境変数 CHROME）。
// COOP/COEP は敢えて刻まない＝埋め込み先に COI を要求しない設計の確認も兼ねる（fallback-ladder.md §3.5）。
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5240, CDP = 9337;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".map": "application/json", ".json": "application/json" };

console.log("… build:lib");
execFileSync("npx", ["vite", "build", "--config", "vite.lib.config.js", "--logLevel", "warn"], { cwd: APP, stdio: "inherit" });

// 素の静的サーバ（vite を挟まない＝出荷物そのものを配る。ホストのバンドラ差を持ち込まない）
const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	const file = url.pathname === "/" ? path.join(APP, "tests/embed-host.html")
		: url.pathname.startsWith("/lib/") ? path.join(APP, "dist/lib", url.pathname.slice(5))
		: null;
	try {
		if (!file) throw new Error("404");
		const body = await readFile(file);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
		res.end(body);
	} catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT);

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`,
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
	"--no-first-run", "--user-data-dir=/tmp/oj-lib-profile", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { server.close(); chrome.kill(); });

let ws = null, fail = 1;
try {
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) throw new Error("chrome devtools が起動しない");
		await sleep(250);
	}
	const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://localhost:${PORT}/`)}`, { method: "PUT" })).json();
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0; const pending = new Map(), errs = [];
	const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
	ws.onmessage = ev => { const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
		if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?"));
		if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") errs.push("ERR " + (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "));
	};
	await send("Runtime.enable");
	const t0 = Date.now(); let title = "";
	while (Date.now() - t0 < 60000) {
		await sleep(1000);
		title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
		if (/^(PASS|FAIL)/.test(title)) break;
	}
	fail = title.startsWith("PASS") ? 0 : 1;
	console.log(`${fail ? "FAIL" : "PASS"}  embed-host  ${title.replace(/^(PASS|FAIL) ?/, "") || "（titleがPASS/FAILにならない＝起動不能）"}`);
	if (fail && errs.length) errs.slice(0, 8).forEach(e => console.log(`      ${e.slice(0, 240)}`));
} catch (e) {
	console.error("FAIL  verify-lib  ", e.message);
} finally {
	try { ws && ws.close(); } catch { /* 終了時 */ }
	server.close(); chrome.kill();
}
console.log(fail ? "\n✗ SDK 契約に破れがある" : "\n✓ SDK 契約を満たす（ホスト無汚染・箱内描画・window 無汚染・剥がせる）");
process.exit(fail ? 1 : 0);
