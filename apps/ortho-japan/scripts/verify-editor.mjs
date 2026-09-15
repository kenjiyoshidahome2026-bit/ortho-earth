#!/usr/bin/env node
// geoedit ガジェットの対話回帰（実時間＋CDP）：tests/t-editor.html（クリック選択・共有arc頂点ドラッグ・undo/redo・吸着作図・削除・ダイアログ・自動復元…）。
// verify-ui（虚時間）に載せない理由＝gint の bake worker が実時間で並走し、仮想時計だけ先に燃え尽きる偽FAILが出る（旧 apps/geoedit の verify:ui と同じ）。
// virtual-time でなく**実時間＋CDP**で title を見張る（verify-webgpu.mjs と同型）。理由＝エンジン起動は
// render/bake/model の worker 群が実時間で並走し、仮想時計だけ先に燃え尽きる偽FAILが出る（t-gintswap と同族）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fsSync from "node:fs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = process.argv[2] || "t-editor";   // 省略＝t-editor。同型の実時間ページ（t-backfill 等）を引数で回せる
const SHOT = process.env.SHOT || "";          // 判定後の画面を PNG で残す（目視の手すり・任意）
const PORT = 5244, CDP = 9344;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";


// 起動時に前回までの per-pid プロファイル（同じ接頭辞・別 pid）を掃く＝exit 時の削除は Chrome の後書きで残ることがある（/tmp 満杯の轍・2026-09-15）
const sweepProfiles = prefix => { try { for (const d of fsSync.readdirSync("/tmp")) if (d.startsWith(prefix) && d !== `${prefix}${process.pid}`) fsSync.rmSync(`/tmp/${d}`, { recursive: true, force: true }); } catch { /* 無害 */ } };
sweepProfiles("oj-veditor-");
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
const chrome = spawn(CHROME, [
	"--headless=new", `--remote-debugging-port=${CDP}`,
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
	"--no-first-run", `--user-data-dir=/tmp/oj-veditor-${process.pid}`, "about:blank",
], { stdio: "ignore" });
const PROFILE = `/tmp/oj-veditor-${process.pid}`;
process.on("exit", () => { vite.kill(); chrome.kill(); try { fsSync.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 掃除失敗は無害 */ } });   // per-pid プロファイル（~500MB）を残さない＝289 個で /tmp が満杯になった（2026-09-15）

let fail = 1;
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
	const url = `http://localhost:${PORT}/japan/tests/${PAGE.replace(/(\?|$)/, ".html$1")}${PAGE.includes("?") ? "&" : "?"}gl2=1&lang=ja`;   // ページ名に ?query を付けられる（t-rectlook の視点差し替え等）
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
	if (SHOT) { const r = await send("Page.captureScreenshot", { format: "png" }); if (r?.data) (await import("node:fs")).writeFileSync(SHOT, Buffer.from(r.data, "base64")); }
	ws.close();
	const pass = title.startsWith("PASS");
	fail = pass ? 0 : 1;
	console.log(`${pass ? "PASS" : "FAIL"}  ${PAGE}  ${(title || "（title未確定＝タイムアウト）").replace(/^(PASS|FAIL) ?/, "")}`);
} catch (e) {
	console.error("✗", e.message || e);
}
process.exit(fail);
