#!/usr/bin/env node
// verify-pages: 自己判定式の頁（tests/*.html の <title> に PASS/FAIL を書くもの）を実 Chrome で回す（T2・2026-09-25）。
// 旧＝t-drop・t-cesium は「手で vite を起こして title を読む」だけで、どの門にも入っていなかった。
// 器＝このパッケージの vite（root＝パッケージ直下）＝単独リポ（ミラー）でもそのまま回る。
//   node scripts/verify-pages.mjs            … t-drop（ネット不要）
//   node scripts/verify-pages.mjs --net      … ＋ t-cesium（Cesium を jsDelivr から取る）
//   node scripts/verify-pages.mjs t-cesium   … 頁を指名
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = +process.env.VP_PORT || 5287;
const OFFLINE = ["t-drop"], NET = ["t-cesium"];
const named = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = named.length ? named : process.argv.includes("--net") ? [...OFFLINE, ...NET] : OFFLINE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
process.on("exit", () => vite.kill());
for (let i = 0; ; i++) {
	try { await fetch(`http://localhost:${PORT}/tests/`); break; } catch { /* まだ */ }
	if (i > 60) { console.error(`vite が起動しない（port ${PORT}）`); process.exit(2); }
	await sleep(250);
}
// playwright 同梱の Chromium が無い機械（版上げ直後）は手元の Google Chrome で回す
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
let fail = 0;
for (const name of PAGES) {
	const page = await browser.newPage();
	page.on("pageerror", e => console.error(`  [${name}] pageerror:`, e.message));
	await page.goto(`http://localhost:${PORT}/tests/${name}.html`);
	let title = "";
	for (let i = 0; i < 120 && !/^(PASS|FAIL)/.test(title); i++) { await sleep(500); title = await page.title().catch(() => ""); }
	if (!/^(PASS|FAIL)/.test(title)) title = "FAIL no-title(60s): " + title;
	if (!title.startsWith("PASS")) fail++;
	console.log(`${title.startsWith("PASS") ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${title.replace(/^(PASS|FAIL) ?/, "")}`);
	await page.close();
}
await browser.close();
vite.kill();
console.log(fail ? `\n✗ ${fail}/${PAGES.length} 頁失敗` : `\n✓ 全${PAGES.length}頁 PASS`);
process.exit(fail ? 1 : 0);
