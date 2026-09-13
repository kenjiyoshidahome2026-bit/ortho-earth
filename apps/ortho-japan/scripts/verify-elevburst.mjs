#!/usr/bin/env node
// 大量点×チルトの投影バースト＝renderer が落ちない（elevOf 有界化）の検定。実時間＋生CDP（verify-nocoi.mjs と同型）。
// 使い方: apps/ortho-japan で `npm run verify:elevburst`。要ローカルChrome（環境変数 CHROME で上書き可）。
// 落ちた場合＝Runtime.evaluate が返らない／title が PASS/FAIL にならない＝FAIL（Target.targetCrashed も拾って理由に残す）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5241, CDP = 9338;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES = [["t-elevburst", ""]];

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--user-data-dir=/tmp/oj-elevburst-profile",
	"--window-size=640,480", "--enable-unsafe-swiftshader", "--disable-gpu-vsync", "--no-first-run", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { vite.kill(); chrome.kill(); });
let fail = 1, ws;
try {
	for (let i = 0; ; i++) { try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch {} if (i > 60) throw new Error(`vite が起動しない（port ${PORT}）`); await sleep(250); }
	for (let i = 0; ; i++) { try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch {} if (i > 60) throw new Error("chrome devtools が起動しない"); await sleep(250); }
	// ブラウザ端点＝targetCrashed（renderer の死）を理由つきで拾う
	const bws = new WebSocket((await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()).webSocketDebuggerUrl);
	await new Promise(r => bws.onopen = r); let crashed = null;
	bws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.method === "Target.targetCrashed") crashed = m.params; };
	bws.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
	fail = 0;
	for (const [page, query] of PAGES) {
		const url = `http://localhost:${PORT}/japan/tests/${page}.html${query}`;
		const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
		ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map(), errs = [];
		const send = (method, params = {}) => Promise.race([new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }), sleep(8000).then(() => null)]);
		ws.onmessage = ev => { const m = JSON.parse(ev.data);
			if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
			if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?"));
			if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") errs.push("ERR " + (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "));
		};
		await send("Runtime.enable");
		const t0 = Date.now(); let title = "", dead = false;
		while (Date.now() - t0 < 90000) {
			await sleep(1000);
			const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
			if (r === null || crashed) { dead = true; break; }   // evaluate が返らない／targetCrashed＝renderer が死んだ
			title = r?.result?.value || "";
			if (/^(PASS|FAIL)/.test(title)) break;
		}
		const bad = !dead && title.startsWith("PASS") ? 0 : 1;
		fail += bad;
		console.log(`${bad ? "FAIL" : "PASS"}  ${page.padEnd(12)} ${dead ? `renderer が死んだ${crashed ? " (" + JSON.stringify(crashed) + ")" : ""}` : (title.replace(/^(PASS|FAIL) ?/, "") || "（titleがPASS/FAILにならない）")}`);
		for (const e of errs.slice(0, 8)) console.log("      " + e.slice(0, 200));
		ws.close();
	}
	console.log(fail ? `✗ ${fail} ページ FAIL` : "✓ 大量点×チルトの投影バーストで renderer が生きている（elevOf 有界化）");
} catch (e) { console.error("verify-elevburst:", e.message); fail = 1; }
finally { vite.kill(); chrome.kill(); process.exit(fail ? 1 : 0); }
