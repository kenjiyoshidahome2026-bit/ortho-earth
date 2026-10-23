#!/usr/bin/env node
// SNS 共有カードの絵（1200×630）を実描画から撮る＝ortho-japan/scripts/og-shot.mjs と同じ作り（生 CDP・実時間）。
// 前提：dev サーバが動いていること（npm run dev・port 5186）。使い方：node scripts/og-shot.mjs [ページ名…]（省くと表の全頁）
//   出力＝public/og/<page>.jpg（head の og:image が指す先＝/globe/og/<page>.jpg）
// ⚠撮る前に UI（パネル・計器・ガジェット）を伏せる＝地球だけの一枚にする。ページごとの「待ち条件」は下の表。
//   容器（GPU 無し・網無し）では撮れない＝Kenji の Mac で（2026-10-21）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome } from "@ortho-earth/globe/scripts/lib/chrome.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.OG_BASE || "http://localhost:5186/globe";
const PORT = 9494;
// ready＝この式が真になったら撮れる（データが載った合図）。view＝撮る視点（URL ハッシュ）。wait＝ready の後に待つ ms（細かいタイルが置き換わるまで）
const PAGES = {
	splat: { url: "/splat", view: "", ready: "window.__splat && window.__splat.ready && window.__splat.tiles.shown >= 2", wait: 12000 },
	voxel: { url: "/voxel", view: "", ready: "window.__voxel && window.__voxel.ready && window.__voxel.n > 0 && !!window.__voxel.backend", wait: 8000 },   // 富士山の上の雲（volume）
   // 東京駅前の 2 シーン（タイルの八分木が細かくなるまで待つ）
};
const HIDE = `for (const s of [".splat-panel",".splat-drop","#gadgets","#chips","#pos","#scale","#attr","#hint","#dock",".qm-attr"])
	document.querySelectorAll(s).forEach(e => e.style.display = "none");
1`;

const want = process.argv.slice(2).filter(a => !a.startsWith("--"));
const pages = Object.keys(PAGES).filter(p => !want.length || want.includes(p));
for (const p of want) if (!PAGES[p]) { console.error(`unknown page: ${p}（${Object.keys(PAGES).join("・")}）`); process.exit(2); }
fs.mkdirSync(path.join(APP, "public/og"), { recursive: true });
const chrome = spawn(await resolveChrome(), ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,630",
	"--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--force-device-scale-factor=1",
	"--user-data-dir=" + os.tmpdir() + "/ortho-og-" + Date.now(), "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
	let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (list.length) break; } catch { } await sleep(250); }
	const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
	await new Promise(r => ws.onopen = r);
	let id = 0; const pend = new Map();
	ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
	const send = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
	const ev = async x => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
	await send("Page.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
	for (const p of pages) {
		const c = PAGES[p];
		await send("Page.navigate", { url: `${BASE}${c.url}${c.url.includes("?") ? "&" : "?"}lang=en${c.view}` });
		let ok = false;
		for (let i = 0; i < 120; i++) { await sleep(1000); if (await ev(c.ready)) { ok = true; break; } }
		await sleep(c.wait);
		await ev(HIDE);
		await sleep(1200);
		const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
		const f = path.join(APP, `public/og/${p}.jpg`);
		fs.writeFileSync(f, Buffer.from(shot.data, "base64"));
		console.log(`${ok ? "✓" : "…（ready にならず＝そのまま撮った）"} ${p}.jpg  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
	}
	ws.close();
} finally { chrome.kill(); }
