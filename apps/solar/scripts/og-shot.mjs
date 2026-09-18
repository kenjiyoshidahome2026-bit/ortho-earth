#!/usr/bin/env node
// OGP 用の 1200×630（public/ogp.jpg）を実描画から撮る。生 CDP・実時間（headless の仮想時間は実 I/O と噛み合わない）。
// 前提：solar の dev サーバが 5199 で動いていること（npm run dev）。使い方: npm run og [-- <url> <出力>]
// ⚠ デバッグポートは 9471 固定＝他の CDP 台（9333 など）と取り合わない。GPU が要る＝サンドボックス下の端末では WebGL2 が立たない
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
const APP = new URL("..", import.meta.url).pathname;
const url = process.argv[2] ?? "http://localhost:5199/?lang=en#t=2032-06-01T09%3A00&f=saturn&d=0.0024&yaw=-62.5&pit=52&s=0";
const out = process.argv[3] ?? APP + "public/ogp.jpg";
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--remote-debugging-port=9471", "--window-size=1200,630",
	"--use-angle=metal", "--ignore-gpu-blocklist", "--hide-scrollbars", "--force-device-scale-factor=1", "--user-data-dir=" + os.tmpdir() + "/ortho-solar-og", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
	let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch("http://127.0.0.1:9471/json")).json(); if (list.length) break; } catch { } await sleep(250); }
	const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
	await new Promise(r => ws.onopen = r);
	let id = 0; const pend = new Map();
	ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
	const send = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
	await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url });
	await sleep(9000);
	await send("Runtime.evaluate", { expression: `for (const c of ["bottom","hint","attr","stack","info","labels","title","scale"]) document.querySelector(".ortho-solar .os-" + c).style.display="none"; window.dispatchEvent(new Event("resize"));` });
	await sleep(1500);
	const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
	fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
	console.log("saved", out, fs.statSync(out).size);
	ws.close();
} finally { chrome.kill(); }
