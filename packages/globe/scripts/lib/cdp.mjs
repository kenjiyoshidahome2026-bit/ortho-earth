// Chrome を 1 本立てて CDP で話す部品（2026-09-27 に ui-runner.mjs の runRealtime から切り出し＝公式例の門と共有）。
// 作法は runRealtime で踏んだ轍のまま：
//   ・CDP の port は Chrome 自身に選ばせる（port 0 → プロファイルの DevToolsActivePort）＝置き去りの headless Chrome に繋がない
//   ・頁ごとに別プロファイル・kill の exit を待つ＝前の頁の IDB/localStorage/GPU が次へ漏れない
//   ・WebSocket が閉じたら（タブ/GPU プロセスが死んだ）以後の send は即 null＝待ちが積み重ならない
// connect は browser の WebSocket（flat session＝sessionId つきで worker にも話せる）にも頁の WebSocket にも使える。
import { spawn } from "node:child_process";
import { rm, readFile } from "node:fs/promises";

export const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// ソフトウェア GL（仮想時間と両立しない頁）＝既定の旗
export const SWIFTSHADER = ["--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// 実 GPU（WebGPU バックエンドの検分）＝WebGPU の async init は仮想時間と両立しない＝ここも実時間
export const REALGPU = ["--enable-unsafe-webgpu"];

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const waitExit = (proc, ms = 5000) => new Promise(res => {
	if (proc.exitCode != null || proc.signalCode != null) return res();
	const t1 = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* もう居ない */ } }, 2000);
	const t2 = setTimeout(res, ms);
	proc.once("exit", () => { clearTimeout(t1); clearTimeout(t2); res(); });
});

// 生きている Chrome（走らせ台が止められた時に残さない＝2026-09-27 に置き去りを実測）。exit で殺す・SIGINT/SIGTERM は exit へ
const alive = new Set();
let reaper = false;
const armReaper = () => {
	if (reaper) return; reaper = true;
	process.on("exit", () => { for (const c of alive) { try { c.kill("SIGKILL"); } catch { /* もう居ない */ } } });
	for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => process.exit(128 + (sig === "SIGINT" ? 2 : 15)));
};

// Chrome を立てて devtools が応答するまで待つ。戻り＝{ port, browserWs, close }（close＝kill→exit 待ち→プロファイル掃除）
export async function launchChrome({ flags = SWIFTSHADER, profilePrefix = "oe-cdp", seq = 1, extraArgs = [] } = {}) {
	const dir = `/tmp/${profilePrefix}-${process.pid}-${seq}`;
	await rm(dir, { recursive: true, force: true }).catch(() => { /* 無ければよい */ });   // 前回の DevToolsActivePort を読まない
	const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", ...flags, ...extraArgs,
		"--no-first-run", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
	armReaper(); alive.add(chrome);
	const close = async () => {
		chrome.kill(); await waitExit(chrome); alive.delete(chrome);
		await rm(dir, { recursive: true, force: true }).catch(() => { /* 掃除失敗は無害 */ });
	};
	let port = 0;
	for (let i = 0; ; i++) {
		if (!port) port = +(await readFile(`${dir}/DevToolsActivePort`, "utf8").catch(() => "")).split("\n")[0] || 0;
		if (port) {
			try {
				const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
				return { port, browserWs: v.webSocketDebuggerUrl, close };
			} catch { /* まだ */ }
		}
		if (i > 60) { await close(); throw new Error("chrome devtools が起動しない"); }
		await sleep(250);
	}
}

// 新しいタブ（/json/new）。失敗は本文を理由にして 1 回だけ作り直す（JSON.parse で落とさない）。戻り＝target（webSocketDebuggerUrl つき）
export async function newTab(port) {
	let why = "";
	for (let k = 0; k < 2; k++) {
		const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).catch(e => ({ ok: false, text: async () => String(e.message) }));
		const body = await r.text();
		try { if (r.ok) { const t = JSON.parse(body); if (t?.webSocketDebuggerUrl) return t; } else why = body; } catch { why = body; }
		await sleep(500);
	}
	throw new Error("タブを作れない（" + String(why).slice(0, 80) + "）");
}

// WebSocket 1 本の CDP。send＝結果（エラーは undefined・時間切れと切断は null＝runRealtime の既定の意味）／
// call＝エラーと時間切れを投げる（門の走らせ台はこちら）。session＝flat session の sessionId（browser の WebSocket で使う）
export async function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0, dead = false;
	const pending = new Map(), subs = new Set();
	ws.onmessage = ev => {
		const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t); p.done(m); }
		else for (const f of subs) { try { f(m); } catch (e) { console.error("[cdp] listener", e); } }
	};
	const die = () => { dead = true; for (const p of pending.values()) { clearTimeout(p.t); p.done(null); } pending.clear(); };
	ws.onclose = die; ws.onerror = die;
	const raw = (method, params, session, timeoutMs) => new Promise(res => {
		if (dead) return res(null);
		const i = ++id;
		const t = setTimeout(() => { if (pending.delete(i)) res(null); }, timeoutMs);
		pending.set(i, { done: res, t });
		ws.send(JSON.stringify({ id: i, method, params, ...(session ? { sessionId: session } : {}) }));
	});
	return {
		send: async (method, params = {}, { session = null, timeoutMs = 5000 } = {}) => {
			const m = await raw(method, params, session, timeoutMs);
			return m === null ? null : m.result;
		},
		call: async (method, params = {}, { session = null, timeoutMs = 15000 } = {}) => {
			const m = await raw(method, params, session, timeoutMs);
			if (m === null) throw new Error(`${method}: ${dead ? "WebSocket closed" : `timeout ${timeoutMs}ms`}`);
			if (m.error) throw new Error(`${method}: ${m.error.message}`);
			return m.result;
		},
		on: fn => { subs.add(fn); return () => subs.delete(fn); },
		dead: () => dead,
		close: () => { try { ws.close(); } catch { /* もう閉じている */ } },
	};
}
