#!/usr/bin/env node
// gint WebGPU storage buffer 経路の実シェーダ A/B（tests/t-gintsbperf.html を両経路で回して比較）。
// 回帰検定ではない＝verify には載せない。使い方: apps/ortho-japan で `node scripts/bench-gintsb.mjs`。
// 実 Metal GPU で回る（headless Chrome + --enable-unsafe-webgpu＝この Mac では実 GPU）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5239, CDP = 9336;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
const chrome = spawn(CHROME, [
	"--headless=new", `--remote-debugging-port=${CDP}`, "--enable-unsafe-webgpu",
	"--no-first-run", "--user-data-dir=/tmp/oj-gintsb-profile", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { vite.kill(); chrome.kill(); });

let ws = null, fail = 1;
const results = {};
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch { /* まだ */ }
		if (i > 60) throw new Error(`vite が起動しない（port ${PORT} が塞がっている？）`);
		await sleep(250);
	}
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) throw new Error("chrome devtools が起動しない");
		await sleep(250);
	}
	fail = 0;
	for (const [label, q] of [["storage", ""], ["texture", "?gintsb=0"]]) {
		const url = `http://localhost:${PORT}/japan/tests/t-gintsbperf.html${q}`;
		const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
		ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map();
		const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
		ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
		await send("Runtime.enable");
		let title = "";
		const t0 = Date.now();
		while (Date.now() - t0 < 120000) {
			await sleep(1000);
			title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
			if (title.startsWith("DONE")) break;
		}
		if (!title.startsWith("DONE ")) { console.error(`FAIL ${label}: ${title || "timeout"}`); fail = 1; }
		else {
			try { results[label] = JSON.parse(title.slice(5)); } catch { console.error(`FAIL ${label}: ${title}`); fail = 1; }
		}
		try { ws.close(); } catch { /* 次へ */ }
	}
	if (!fail) {
		console.log("scene   texture(ms)  storage(ms)  ratio  edges(tex/sb)  tierW");
		for (const k of Object.keys(results.storage)) {
			const sbR = results.storage[k], txR = results.texture[k];
			const ratio = txR.gint > 0.01 ? (sbR.gint / txR.gint).toFixed(2) : "-";
			console.log(`${k.padEnd(7)} ${String(txR.gint).padStart(10)} ${String(sbR.gint).padStart(12)}  ${String(ratio).padStart(5)}  ${txR.edges}/${sbR.edges}  ${txR.tierW}/${sbR.tierW}`);
		}
		console.log("(gint=可視−非可視の差分ms/フレーム。ratio<1 ＝ storage が速い)");
	}
} catch (e) {
	console.error("FAIL bench-gintsb ", e.message);
	fail = fail || 1;
} finally {
	try { ws && ws.close(); } catch { /* 終了時 */ }
	vite.kill(); chrome.kill();
}
process.exit(fail);
