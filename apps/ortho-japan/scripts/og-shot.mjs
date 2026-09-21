#!/usr/bin/env node
// SNS 共有カードの絵（1200×630）を実描画から撮る。生 CDP・実時間（headless の仮想時間は実 I/O と噛み合わない＝solar と同じ轍）。
// 前提：dev サーバが動いていること（npm run dev）。使い方：node scripts/og-shot.mjs [ページ名…]
//   出力＝public/og/<page>.jpg（head の og:image が指す先＝/japan/og/<page>.jpg）。トップ（index）は別撮りの public/ogp.jpg を使う
// ⚠撮る前に UI（パネル・計器・ガジェット）を伏せる＝地球だけの一枚にする。ページごとの「待ち条件」は下の表。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.OG_BASE || "http://localhost:5188/japan";
const PORT = 9493;
// ready＝この式が真になったら撮れる（データが載った合図）。view＝撮る視点（URL ハッシュ）
const PAGES = {
	quakes:  { url: "/quakes.html",   view: "#2.3/18/165",         ready: "window.__quakes && window.__quakes.count > 1000", wait: 9000 },
	sats:    { url: "/sats.html",     view: "#1.4/25/140",         ready: "window.__sats && window.__sats.count > 1000", wait: 9000 },
	models:  { url: "/models.html", view: "", pick: "tokyo-tower", ready: "window.__models && window.__models.stats", wait: 10000 },
	tellus:  { url: "/tellus.html",   view: "",                    ready: "!!document.querySelector('#map canvas')", wait: 14000 },
	geoedit: { url: "/geoedit.html",  view: "",                    ready: "!!document.querySelector('#map canvas')", wait: 12000 },
};
const HIDE = `for (const s of ["#sky-clock",".quakes-panel",".sats-panel",".models-panel",".quakes-clock","#gadgets","#chips","#pos","#scale","#attr","#layers-btn","#side",".qm-attr","#hint","#dock","#cloudPanel"])
	document.querySelectorAll(s).forEach(e => e.style.display = "none");
document.querySelectorAll(".sats-tag,.quakes-tag,.sats-tip,.quakes-info").forEach(e => e.style.display = "none");
const app = document.getElementById("app"); if (app) app.style.gridTemplateColumns = "1fr";   // Tellus＝左の案内板を伏せたら地図を全幅へ（格子が 352px の列を残す）
window.dispatchEvent(new Event("resize")); 1`;

const want = process.argv.slice(2).filter(a => !a.startsWith("--"));
const pages = Object.keys(PAGES).filter(p => !want.length || want.includes(p));
fs.mkdirSync(path.join(APP, "public/og"), { recursive: true });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1200,630",
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
		await send("Page.navigate", { url: `${BASE}${c.url}${c.url.includes("?") ? "" : "?"}lang=en${c.view}` });
		if (c.pick) {   // カードを押して模型を立てる（?v= で HTTP キャッシュの古い glb を避ける）
			for (let i = 0; i < 60; i++) { await sleep(1000); if (await ev("!!document.querySelector('.models-panel .card')")) break; }
			await sleep(3000);
			await ev(`(()=>{const v=Date.now(); for(const m of window.__models.models) m.url="https://api.ortho-earth.com/bucket/GIS/models/"+m.id+".glb?v="+v; return 1;})()`);
			await ev(`document.querySelector('.models-panel .card[data-id=${c.pick}]').click(); 1`);
		}
		let ok = false;
		for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev(c.ready)) { ok = true; break; } }
		await sleep(c.wait);
		await ev(HIDE);
		await sleep(1200);
		const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
		const f = path.join(APP, `public/og/${p}.jpg`);
		fs.writeFileSync(f, Buffer.from(shot.data, "base64"));
		console.log(`${ok ? "✓" : "…"} ${p}.jpg  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
	}
	ws.close();
} finally { chrome.kill(); }
