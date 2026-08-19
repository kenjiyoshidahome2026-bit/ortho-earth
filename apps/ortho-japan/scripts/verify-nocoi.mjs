#!/usr/bin/env node
// COI 無し（COOP/COEP を刻まない）世界のスモーク：SDK 化の前提確認。
// 埋め込み先のページに COEP を要求することは実質できない（COEP はホスト側の他の埋め込みを軒並み壊す）ので、
// 「crossOriginIsolated が立たなくても全機能が動く」ことを実測で押さえる。逃げ道は geopbf setGintBUF の
// SAB フォールバック（SAB 不在なら通常 ArrayBuffer＝コピー1回）＝Safari は元からこの世界で動いている。
// 使い方: apps/ortho-japan で `npm run verify:nocoi`。要ローカルChrome（環境変数 CHROME で上書き可）。
// verify-ui.mjs（仮想時間）でなく実時間で回す：worker 連鎖（geopbf encoder→gint decoder）は仮想時計が
// 先に燃え尽きて偽陽性になるため（t-webgpu と同じ轍）。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5239, CDP = 9336;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// t-nocoi＝COI非成立とSAB不在を自分で検定する的（ここが緑でないと以下は無意味）。
// 以降は SAB 経路に触る層＝gint の描画・LOD・差し替え・深度、起動opts、ガジェット。?gl2=1＝headless の決定性優先。
const PAGES = [
	["t-nocoi", "?nocoi=1"],
	["t-gintembed", "?gl2=1"], ["t-gintlod", "?gl2=1"], ["t-gintswap", "?gl2=1"], ["t-gintdepth", "?gl2=1"],
	["t-opts", "?gl2=1"], ["t-gadgets", "?gl2=1"],
];

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore", env: { ...process.env, NOCOI: "1" } });
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`,
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
	"--no-first-run", "--user-data-dir=/tmp/oj-nocoi-profile", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { vite.kill(); chrome.kill(); });

let ws = null, fail = 1;
try {
	for (let i = 0; ; i++) {
		try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch { /* まだ */ }
		if (i > 60) throw new Error(`vite が起動しない（port ${PORT} が塞がっている？）`);
		await sleep(250);
	}
	// COI ヘッダが本当に消えているかを門前で確認（NOCOI の効きが壊れたら以下は全部偽の緑になる）
	const h = (await fetch(`http://localhost:${PORT}/japan/`)).headers;
	if (h.get("cross-origin-embedder-policy") || h.get("cross-origin-opener-policy"))
		throw new Error("NOCOI=1 なのに COOP/COEP が刻まれている＝vite.config.js の門が壊れている");
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) throw new Error("chrome devtools が起動しない");
		await sleep(250);
	}
	fail = 0;
	for (const [page, query] of PAGES) {
		const url = `http://localhost:${PORT}/japan/tests/${page}.html${query}`;
		const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
		ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map(), errs = [];
		const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
		ws.onmessage = ev => { const m = JSON.parse(ev.data);
			if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
			// 落ちた時に「なぜ」が残るように console/例外を拾う（titleだけでは診断できない轍）
			if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?"));
			if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") errs.push("ERR " + (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "));
		};
		await send("Runtime.enable");
		const t0 = Date.now();
		let title = "";
		while (Date.now() - t0 < 60000) {
			await sleep(1000);
			const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
			title = r?.result?.value || "";
			if (/^(PASS|FAIL)/.test(title)) break;
		}
		const bad = title.startsWith("PASS") ? 0 : 1;
		fail += bad;
		console.log(`${bad ? "FAIL" : "PASS"}  ${page.padEnd(12)} ${title.replace(/^(PASS|FAIL) ?/, "") || "（titleがPASS/FAILにならない＝起動不能）"}`);
		if (bad && errs.length) errs.slice(0, 6).forEach(e => console.log(`      ${e.slice(0, 220)}`));
		try { ws.close(); } catch { /* 次ページへ */ }
	}
} catch (e) {
	console.error("FAIL  verify-nocoi  ", e.message);
	fail = fail || 1;
} finally {
	try { ws && ws.close(); } catch { /* 終了時 */ }
	vite.kill(); chrome.kill();
}
console.log(fail ? `\n✗ ${fail}/${PAGES.length} ページ失敗（COI 無しでは動かない箇所がある）` : `\n✓ 全${PAGES.length}ページ PASS（crossOriginIsolated 無しでも動く）`);
process.exit(fail ? 1 : 0);
