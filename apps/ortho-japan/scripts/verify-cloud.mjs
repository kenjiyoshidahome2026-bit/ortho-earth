import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
// scenes エディタのクラウド保存（共通の器 gadgets/cloud.js）の実走検定：account Worker のスタブ（/me・/me/files）を :8787 に立て、
// scene.html を実時間＋CDP で駆動＝ログイン状態→一覧の絞り込み(.scenes だけ)→保存(PUT の中身)→全消去→クラウドから開く→undo。
// 実行＝ node scripts/verify-cloud.mjs（apps/ortho-japan で）。虚時間ハーネス（verify-ui）では fetch を待てないためこちら。
import { fileURLToPath } from "node:url";
import path from "node:path";
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url))), PORT = 5249, CDP = 9349;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// ---- account Worker のスタブ（/me・/me/files・PUT/GET/DELETE）＝形は workers/files.js の返りに合わせる ----
const store = new Map([["a.geopbf", { body: Buffer.from("x"), t: 1 }]]);
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const stub = createServer((req, res) => {
	const u = new URL(req.url, "http://x"); const m = req.method;
	if (u.pathname === "/me" && m === "GET") return json(res, 200, { user: { name: "stub" }, usage: { files: store.size, bytes: 1, maxBytes: 1024 ** 3 } });
	if (u.pathname === "/me/files" && m === "GET") return json(res, 200, { files: [...store].map(([name, v]) => ({ name, size: v.body.length, updated_at: v.t })) });
	const mf = /^\/me\/files\/(.+)$/.exec(u.pathname);
	if (mf) {
		const name = decodeURIComponent(mf[1]);
		if (m === "PUT") { const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => { store.set(name, { body: Buffer.concat(chunks), t: Date.now() / 1000 }); json(res, 200, { ok: true }); }); return; }
		if (m === "GET") { const v = store.get(name); if (!v) return json(res, 404, { error: "not_found" }); res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(v.body); }
		if (m === "DELETE") { store.delete(name); return json(res, 200, { ok: true }); }
	}
	json(res, 404, { error: "not_found" });
}).listen(8787);
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run", `--user-data-dir=/tmp/oj-cloud-${process.pid}`, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { vite.kill(); chrome.kill(); stub.close(); });
let fail = 0; const ok = (n, c) => { console.log((c ? "✓ " : "✗ ") + n); if (!c) fail++; };
try {
	for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch {} await sleep(250); }
	for (let i = 0; i < 80; i++) { try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch {} await sleep(250); }
	const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://localhost:${PORT}/japan/scene.html?gl2=1&lang=ja`)}`, { method: "PUT" })).json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0; const pending = new Map();
	const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
	ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; } if (m.method === "Runtime.exceptionThrown") console.log("EXC:", (m.params.exceptionDetails.exception?.description || "").split("\n")[0]); };
	await send("Runtime.enable");
	const ev = expr => send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r?.result?.value ?? r?.result?.description);
	const until = async (expr, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(expr)) return true; await sleep(250); } return false; };
	await until("!!document.getElementById('sc-shoot')"); await sleep(2000);
	await ev(`localStorage.removeItem("oj.sceneDraft"); document.querySelector('#sc-start button[data-f="16:9"]')?.click()`); await sleep(200);
	await ev(`document.getElementById('sc-title').value = "cloudtest"; document.getElementById('sc-title').dispatchEvent(new Event("input")); document.getElementById('sc-shoot').click(); document.getElementById('sc-shoot').click()`); await sleep(400);
	await ev(`document.getElementById('sc-cloud').click()`);
	ok("login state (stub /me)", await until(`/stub/.test(document.querySelector('#sc-cloud-host .oj-cloud')?.textContent || "")`));
	ok("list filters out .geopbf", await ev(`![...document.querySelectorAll('#sc-cloud-host .oj-cloud button.name')].some(b => /geopbf/.test(b.textContent))`));
	ok("default name = title.scenes", await ev(`document.querySelector('#sc-cloud-host .oj-cloud input').value`) === "cloudtest.scenes");
	await ev(`[...document.querySelectorAll('#sc-cloud-host .oj-cloud button')].find(b => b.textContent === "保存").click()`);
	ok("saved → listed", await until(`[...document.querySelectorAll('#sc-cloud-host .oj-cloud button.name')].some(b => b.textContent === "cloudtest.scenes")`));
	const saved = store.get("cloudtest.scenes");
	ok("PUT body is the .scenes JSON (2 rows, frame)", !!saved && (() => { try { const o = JSON.parse(saved.body.toString()); return o.type === "scenes" && o.scenes.length === 2 && o.frame === "16:9" && o.title === "cloudtest"; } catch { return false; } })());
	await ev(`document.getElementById('sc-clear').click()`); await sleep(100);
	ok("cleared", await ev(`document.querySelectorAll('#sc-rows .sc-row').length`) === 0);
	await ev(`[...document.querySelectorAll('#sc-cloud-host .oj-cloud button.name')].find(b => b.textContent === "cloudtest.scenes").click()`);
	ok("opened from cloud → 2 rows + note", await until(`document.querySelectorAll('#sc-rows .sc-row').length === 2 && /クラウドから開きました/.test(document.getElementById('sc-note').textContent)`));
	ok("panel closed after open", await ev(`!document.querySelector('#sc-cloud-host .oj-cloud')`));
	ok("undo restores the cleared state (open is undoable)", await ev(`(document.getElementById('sc-undo').click(), document.querySelectorAll('#sc-rows .sc-row').length === 0)`));
	ws.close();
} catch (e) { console.error("✗", e); fail++; }
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS ✓");
process.exit(fail ? 1 : 0);
