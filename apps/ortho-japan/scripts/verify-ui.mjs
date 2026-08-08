#!/usr/bin/env node
// UI回帰の常設ハーネス：tests/*.html（判定はページ内・結果は<title>のPASS/FAIL）を headless Chrome で順に開く。
// 使い方: apps/ortho-japan で `npm run verify:ui`。要ローカルChrome（パスは環境変数 CHROME で上書き可）。
// 固定している掟：ガジェットスタック（搭載順・上詰め・二重搭載・リスト追随・透明帯素通し・aria）／
// 起動opts（選択的表示・未知キー警告・plateauスイッチ）／destroy・再起動／タッチ2本指（ピンチ・チルトロック・ひねり）／狭画面。
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5237;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES = ["t-gadgets", "t-newgadgets", "t-providers", "t-measure", "t-shot", "t-palette-live", "t-demo", "t-scene", "t-print", "t-qr", "t-opts", "t-input", "t-narrow", "t-gintlod", "t-gintembed", "t-gintswap", "t-gintdepth", "t-ai"];
// t-plateaufs は verify:webgpu（実時間）側：OPFS の実 I/O は virtual-time と両立しない（t-webgpu と同じ轍）。

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
process.on("exit", () => vite.kill());
for (let i = 0; ; i++) {   // 起動待ち＝base(/japan/)が200を返すまでポーリング
	try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch { /* まだ */ }
	if (i > 60) { console.error(`vite が起動しない（port ${PORT} が塞がっている？）`); process.exit(1); }
	await new Promise(r => setTimeout(r, 250));
}
let fail = 0;
for (const p of PAGES) {
	const title = await new Promise(res => execFile(CHROME,
		["--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
			"--virtual-time-budget=75000", "--dump-dom", `http://localhost:${PORT}/japan/tests/${p}.html?gl2=1`],   // 75s＝t-demoのフライト実尺（glide/z1着地×9s＋自動上演の着地後計時＝仮想20s＋scene-player API回帰）を収める
			// ?gl2=1＝WebGPU既定化(2026-08-02)後も虚時間ハーネスはGL2固定（WebGPU async init×virtual-time の轍＝t-webgpu を PAGES に載せない理由と同じ）
		{ timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
		(e, out) => res(e && !out ? `FAIL chrome: ${e.message}` : (String(out).match(/<title>([^<]*)<\/title>/) || [, "FAIL no-title"])[1])));
	const pass = title.startsWith("PASS");
	if (!pass) fail++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${p.padEnd(10)} ${title.replace(/^(PASS|FAIL) ?/, "")}`);
}
console.log(fail ? `\n✗ ${fail}/${PAGES.length} ページ失敗` : `\n✓ 全${PAGES.length}ページ PASS`);
process.exit(fail ? 1 : 0);
