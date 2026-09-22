#!/usr/bin/env node
// デモの画像（public/thumbs/<id>.webp・640×400）を本番の頁から撮る＝`npm run thumbs -w www`。
//   既定＝画像がまだ無いデモだけ（サンプルが増えたら足した分だけ撮れる）。`--only a,b` で撮り直し・`--all` で全部。
//   demos.json の各デモに任意の shot: { url（既定＝https://www.ortho-earth.com + href）, wait（秒・既定 12）, from（既存画像から切り出す）,
//     eval（撮る直前に頁で走らせる JS＝一時的な通知を隠す・最初のダイアログを閉じる等）, after（eval の後に待つ秒・既定 1.5）}
// 生 CDP（依存は node 標準の fetch / WebSocket と sharp だけ）。使い捨てのプロファイル（本人の Chrome の保存データには触れない）。
// ⚠ GPU で描く頁が多い＝サンドボックス外で走らせる（--use-angle=metal）。ポートは空きを取る（他セッションの CDP 台と衝突しない）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { APP } from "./keys.mjs";

const ORIGIN = "https://www.ortho-earth.com";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1280, H = 800, OUT_W = 640, OUT_H = 400;
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const all = args.includes("--all");
const outDir = path.join(APP, "public/thumbs");
fs.mkdirSync(outDir, { recursive: true });
const { demos } = JSON.parse(fs.readFileSync(path.join(APP, "demos.json"), "utf8"));
const todo = demos.filter(d => only.length ? only.includes(d.id) : all || !fs.existsSync(path.join(outDir, `${d.id}.webp`)));
if (!todo.length) { console.log("thumbs: nothing to do (all demos have an image; use --only=id or --all)"); process.exit(0); }

const save = async (input, id) => {
	const file = path.join(outDir, `${id}.webp`);
	await sharp(input).resize(OUT_W, OUT_H, { fit: "cover", position: "centre" }).webp({ quality: 72, effort: 6 }).toFile(file);
	console.log(`✓ ${id}.webp ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
};
// 既存画像から切り出すだけのもの（例：japan＝ヒーロー写真）
for (const d of todo.filter(d => d.shot?.from)) await save(path.join(APP, d.shot.from), d.id);
const live = todo.filter(d => !d.shot?.from);
if (!live.length) process.exit(0);

const port = await new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "www-thumbs-"));
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`,
	"--use-angle=metal", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist", "--hide-scrollbars", "--mute-audio", "--lang=en-US", "--no-first-run", "--no-default-browser-check"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup); process.on("SIGINT", () => process.exit(130));
let tabs;
for (let i = 0; i < 50 && !tabs; i++) { await new Promise(r => setTimeout(r, 200)); tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => null); }
const page = tabs?.find(t => t.type === "page");
if (!page) { console.error("✗ Chrome did not start"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let seq = 0; const waiting = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const cdp = (method, params = {}) => new Promise(r => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Page.enable"); await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
for (const d of live) {
	const u = new URL(d.shot?.url ?? d.href, ORIGIN);
	if (!u.searchParams.has("lang")) u.searchParams.set("lang", "en");   // 画像の中の文字は英語に揃える（頁の既定言語が端末任せのため）
	await cdp("Page.navigate", { url: u.href });
	await new Promise(r => setTimeout(r, (d.shot?.wait ?? 12) * 1000));
	if (d.shot?.eval) { await cdp("Runtime.evaluate", { expression: d.shot.eval }); await new Promise(r => setTimeout(r, (d.shot.after ?? 1.5) * 1000)); }
	const shot = await cdp("Page.captureScreenshot", { format: "png" });
	if (!shot.result?.data) { console.error(`✗ ${d.id}: capture failed`); continue; }
	await save(Buffer.from(shot.result.data, "base64"), d.id);
}
ws.close(); process.exit(0);
