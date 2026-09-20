#!/usr/bin/env node
// 名所カードのサムネを作る：アプリ自身の描画を実時間 CDP で撮り、bucket GIS/models/thumbs/<id>.jpg へ置く元を出す。
//   node scripts/models-thumbs.mjs <ページURL> <出力ディレクトリ> <台帳 models.json>
// 例）node scripts/models-thumbs.mjs http://localhost:5188/japan/models.html out/thumbs public/models.json
// ⚠カードを押す前に glb の URL へ ?v= を付ける＝HTTP キャッシュの古い glb（テクスチャ無し）で撮らないため（2026-09-21 に二度踏んだ）。
// 名所カードのサムネ＝アプリ自身の描画から撮る（実時間 CDP）。パネルを隠し、画面中央を 16:9 で切って jpeg へ。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const base = process.argv[2], outDir = process.argv[3];
const ids = JSON.parse(fs.readFileSync(process.argv[4], "utf8")).models.map(m => m.id);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9479;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--window-size=1280,800",
	"--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--force-device-scale-factor=1",
	"--user-data-dir=" + os.tmpdir() + "/ortho-thumbs-" + Date.now(), "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
	let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (list.length) break; } catch { } await sleep(250); }
	const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
	await new Promise(r => ws.onopen = r);
	let id = 0; const pend = new Map();
	ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
	const send = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
	const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
	await send("Page.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	for (const mid of ids) {
		// ?m= の起動時ロードだとテクスチャが乗らないことがある（起動直後の setMesh・実測 2026-09-21）＝頁が落ち着いてからカードを押す
		await send("Page.navigate", { url: `${base}?gl2=1&lang=ja` });
		for (let i = 0; i < 60; i++) { await sleep(1000); if (await ev("!!document.querySelector('.models-panel .card')")) break; }
		await sleep(4000);
		await ev(`(()=>{const v=Date.now(); for(const m of window.__models.models) m.url="https://api.ortho-earth.com/bucket/GIS/models/"+m.id+".glb?v="+v; return 1;})()`);
		await ev(`document.querySelector(".models-panel .card[data-id=${mid}]").click(); 1`);
		let ok = false;
		for (let i = 0; i < 90; i++) { await sleep(1000); const st = await ev("window.__models && JSON.stringify(window.__models.stats)"); if (st && st !== "null") { ok = true; break; } }
		if (!ok) { console.log(`- ${mid}: no model`); continue; }
		console.log("   ", await ev("(()=>{const s=window.__models.stats; return `tris ${s.triangles} tex ${s.textures}/${s.materials}`;})()"));
		await sleep(9000);   // 基図・地形・注記が出揃うまで（視点は台帳のまま＝名所が画面中央）
		await ev("document.querySelector('.models-panel')?.style.setProperty('display','none'); document.querySelectorAll('#attr,.qm-attr,#pos,#scale').forEach(e=>e.style.display='none'); 1");
		await sleep(1200);
		const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 86, clip: { x: 420, y: 200, width: 460, height: 259, scale: 1.05 } });
		fs.writeFileSync(path.join(outDir, `${mid}.jpg`), Buffer.from(shot.data, "base64"));
		console.log(`✓ ${mid}.jpg`);
	}
	ws.close();
} finally { chrome.kill(); }
