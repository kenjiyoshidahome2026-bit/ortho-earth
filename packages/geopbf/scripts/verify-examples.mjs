#!/usr/bin/env node
// verify-examples: examples/*.html（maplibre・leaflet・openlayers・deckgl・cesium）を実 Chrome で開き、コンソールの error / pageerror /
// 失敗した要求を数える煙試験（改良点 17・2026-10-12）。旧＝例は誰も開かず、API の改名で壊れても気づけなかった。
//   例は "https://esm.sh/geopbf@<版>/<入口>" を自分の配布物として import する。これを package.json の exports に従って
//   手元の src/ に差し替えて回す＝公開前の src を例で検定する。地図ライブラリ本体（maplibre-gl・leaflet・ol・deck.gl・Cesium）と
//   基図タイルは CDN からそのまま取る＝ネットが要る（器＝外部網の閉じた環境では回らない）。
//   node scripts/verify-examples.mjs               … 全 5 頁
//   node scripts/verify-examples.mjs maplibre      … 頁を指名（拡張子なし）
//   VE_WAIT=20000 で頁ごとの待ち（ms・既定 15000）。CHROME=/path/to/chrome で実行ファイルを指名。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = +process.env.VE_PORT || 5288;
const WAIT = +process.env.VE_WAIT || 15000;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const named = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = named.length ? named : readdirSync(`${ROOT}examples`).filter(f => f.endsWith(".html")).map(f => f.slice(0, -5)).sort();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// exports の入口 → src のパス（"./maplibre" → "./src/maplibre.js"）。esm.sh の URL "…/geopbf@1.1.0/maplibre" を手元に向ける。
export function localEntry(exportsMap, sub) {
	const key = sub ? `./${sub}` : ".";
	const v = exportsMap[key];
	if (!v) return null;
	return typeof v === "string" ? v : v.default ?? v.import ?? null;
}

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
process.on("exit", () => vite.kill());
for (let i = 0; ; i++) {
	try { await fetch(`http://localhost:${PORT}/examples/`); break; } catch { /* まだ */ }
	if (i > 60) { console.error(`vite が起動しない（port ${PORT}）`); process.exit(2); }
	await sleep(250);
}
// Playwright 同梱の Chromium → $CHROME（実行ファイル）→ 手元の Google Chrome の順に試す（verify-npm と同じ）
const browser = await chromium.launch().catch(() => process.env.CHROME ? chromium.launch({ executablePath: process.env.CHROME }) : Promise.reject()).catch(() => chromium.launch({ channel: "chrome" }));
let fail = 0;
for (const name of PAGES) {
	const page = await browser.newPage();
	const errs = [];
	page.on("pageerror", e => errs.push(`pageerror: ${e.message}`));
	page.on("console", m => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });
	// ERR_ABORTED は vite の依存最適化後の再読み込みや頁を閉じた時に飛行中の要求が切られたもの＝頁の失敗ではない
	page.on("requestfailed", r => { const t = r.failure()?.errorText || ""; if (!/favicon/.test(r.url()) && !/ERR_ABORTED/.test(t)) errs.push(`request: ${r.url()} ${t}`); });
	page.on("response", r => {
		if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push(`response ${r.status()}: ${r.url()}`);
		if (r.ok() && /\.geopbf(\?|$)|\/bucket\//.test(r.url())) dataOk = true;
	});
	let routed = 0, dataOk = false;   // 自分の配布物を差し替えた本数・データ本体（.geopbf か配信バケット）が 200 で届いたか
	// 自分の配布物＝手元の src に差し替え（版は問わない）。ソースの相対 import は vite が解く。
	await page.route(/^https:\/\/esm\.sh\/geopbf@[^/]+(\/.*)?$/, (route, req) => {
		routed++;
		const sub = (new URL(req.url()).pathname.split("/").slice(2).join("/")) || "";
		const local = localEntry(pkg.exports, sub);
		if (!local) { errs.push(`exports に無い入口: ${sub || "."}`); return route.abort(); }
		return route.fulfill({ status: 200, contentType: "text/javascript", body: `export * from "http://localhost:${PORT}/${local.replace(/^\.\//, "")}";` });
	});
	await page.goto(`http://localhost:${PORT}/examples/${name}.html`, { waitUntil: "load" }).catch(e => errs.push(`goto: ${e.message}`));
	await page.waitForLoadState("networkidle", { timeout: WAIT }).catch(() => {});   // 地図ライブラリとデータが届くまで（上限 WAIT）
	await sleep(Math.min(WAIT, 3000));                                                 // 届いた後の描画・デコードで出る例外を拾う
	await page.close();
	if (!dataOk) errs.push("データ本体（.geopbf／配信バケット）が 200 で届いていない＝例が何も描いていない");
	if (!routed) errs.push("geopbf の import が 1 本も差し替わっていない（例が esm.sh/geopbf@… を import していない？）");
	if (errs.length) fail++;
	console.log(`${errs.length ? "FAIL" : "PASS"}  ${name.padEnd(10)}${errs.length ? "\n" + errs.map(e => "  " + e).join("\n") : ""}`);
}
await browser.close();
vite.kill();
console.log(fail ? `\n✗ ${fail}/${PAGES.length} 頁失敗` : `\n✓ 全${PAGES.length}頁 PASS`);
process.exit(fail ? 1 : 0);
