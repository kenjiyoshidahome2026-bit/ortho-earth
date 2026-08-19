#!/usr/bin/env node
// WebGPU バックエンド（?gpu=1）の実時間スモーク：tests/t-webgpu.html を CDP で開き title の PASS/FAIL を見る。
// verify-ui.mjs（--virtual-time-budget）に載せない理由：仮想時間は WebGPU の実時間 async init（adapter/device の
// GPU IPC）と両立しない——ページ側の仮想時計が先に燃え尽き、worker の rAF/タイマーが凍った後に device が
// 届く＝「実機では健全なのに CI だけ frame1 が来ない」偽陽性になる（2026-08-01 実測）。ここは実時間で回す。
// 使い方: apps/ortho-japan で `npm run verify:webgpu`。要ローカルChrome（パスは環境変数 CHROME で上書き可）。
// WebGPU の無い環境では WebGL2 フォールバックで PASS（このテストの主眼は「gpu 旗でどの環境でも起動が壊れない」）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5238, CDP = 9335;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
const chrome = spawn(CHROME, [
	"--headless=new", `--remote-debugging-port=${CDP}`, "--enable-unsafe-webgpu",
	"--no-first-run", "--user-data-dir=/tmp/oj-webgpu-profile", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => { vite.kill(); chrome.kill(); });

let ws = null, fail = 1;
try {
	for (let i = 0; ; i++) {   // vite 起動待ち
		try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch { /* まだ */ }
		if (i > 60) throw new Error(`vite が起動しない（port ${PORT} が塞がっている？）`);
		await sleep(250);
	}
	for (let i = 0; ; i++) {   // chrome devtools 起動待ち
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) throw new Error("chrome devtools が起動しない");
		await sleep(250);
	}
	fail = 0;
	for (const page of ["t-webgpu", "t-aatrans", "t-gintgpu", "t-plateaufs"]) {   // t-aatrans＝遷移時AA（実GPUの実時間必須）。t-plateaufs＝OPFS 実I/O（同期ハンドル）＝実時間必須（仮想時間はタイマー先燃えで偽陽性）
		const url = `http://localhost:${PORT}/japan/tests/${page}.html`;
		const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
		ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map();
		const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
		ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
		await send("Runtime.enable");
		const t0 = Date.now();
		let title = "";
		while (Date.now() - t0 < 40000) {   // 健全なら数秒
			await sleep(1000);
			const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
			title = r?.result?.value || "";
			if (/^(PASS|FAIL)/.test(title)) break;
		}
		const bad = title.startsWith("PASS") ? 0 : 1;
		fail += bad;
		console.log(`${bad ? "FAIL" : "PASS"}  ${page.padEnd(10)} ${title.replace(/^(PASS|FAIL) ?/, "") || "（titleがPASS/FAILにならない＝起動不能）"}`);
		try { ws.close(); } catch { /* 次ページへ */ }
	}
} catch (e) {
	console.error("FAIL  verify-webgpu  ", e.message);
	fail = fail || 1;
} finally {
	try { ws && ws.close(); } catch { /* 終了時 */ }
	vite.kill(); chrome.kill();
}
process.exit(fail);
