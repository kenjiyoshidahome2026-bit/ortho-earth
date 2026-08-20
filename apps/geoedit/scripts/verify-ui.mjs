#!/usr/bin/env node
// 対話回帰の常設ハーネス：tests/t-editor.html（クリック選択・共有arc頂点ドラッグ・undo/redo・吸着作図・削除）。
// virtual-time でなく**実時間＋CDP**で title を見張る（verify-webgpu.mjs と同型）。理由＝エンジン起動は
// render/bake/model の worker 群が実時間で並走し、仮想時計だけ先に燃え尽きる偽FAILが出る（t-gintswap と同族）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5244, CDP = 9344;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
const chrome = spawn(CHROME, [
	"--headless=new", `--remote-debugging-port=${CDP}`,
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
	"--no-first-run", `--user-data-dir=/tmp/geoedit-vui-${process.pid}`, "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { vite.kill(); chrome.kill(); });

let fail = 1;
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(`http://localhost:${PORT}/geoedit/`)).ok) break; } catch { /* まだ */ }
		if (i > 60) throw new Error(`vite が起動しない（port ${PORT} が塞がっている？）`);
		await sleep(250);
	}
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) throw new Error("chrome devtools が起動しない");
		await sleep(250);
	}
	const url = `http://localhost:${PORT}/geoedit/tests/t-editor.html?gl2=1&lang=ja`;
	const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0; const pending = new Map();
	const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
	ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
	await send("Runtime.enable");
	const t0 = Date.now();
	let title = "";
	while (Date.now() - t0 < 90000) {   // 健全なら十数秒（コールドviteの変換込みでも収まる）
		await sleep(1000);
		const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
		title = r?.result?.value || "";
		if (title.startsWith("PASS") || title.startsWith("FAIL")) break;
	}
	ws.close();
	const pass = title.startsWith("PASS");
	fail = pass ? 0 : 1;
	console.log(`${pass ? "PASS" : "FAIL"}  t-editor  ${(title || "（title未確定＝タイムアウト）").replace(/^(PASS|FAIL) ?/, "")}`);
} catch (e) {
	console.error("✗", e.message || e);
}
process.exit(fail);
