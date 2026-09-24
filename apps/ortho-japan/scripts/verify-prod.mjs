#!/usr/bin/env node
// 本番組立（SDK二重構成）の検定：build:prod で組んだ dist/site を「本番の形のまま」検査する。
//   背景＝dev はソース直・本番は SDK（/japan/lib/）という二重構成（site.js 冒頭の分岐）。
//   dev で全緑でも本番だけ壊れる事故（worker data:URL 事件の型）をデプロイ前に必ず捕まえるのがこの関門。
//   deploy スクリプトはこの検定を通らないと wrangler に到達しない（必須ゲート）。
// 検査項目：
//   ①静的: index の入口チャンクが lib のURLを import し、エンジンを再バンドルしていない（サイズ上限＝DCEの証明）
//   ②静的: dist/site/japan/lib/ に SDK 実体（ortho-japan.js/.css）が居る
//   ③実走: dist/site を素の静的サーバ（COOP/COEP付き＝本番Workerと同じ頭）で配り、headless Chrome で
//          起動→チップ点灯まで確認（ja）。vite を挟まない＝出荷物そのものを食う
//   ④実クリック: 遅延ロードのガジェット（qr/print/measure/profile/shot/palette/hint/plateau）を生CDPで実際に押し、
//          動的importチャンクの疎通と console エラーゼロを確認（QR/print が押した瞬間に死ぬ事故クラス・2026-08-20）
import { spawn, execFileSync } from "node:child_process";
import fsSync from "node:fs";
// 起動時に前回までの per-pid プロファイル（同じ接頭辞・別 pid）を掃く＝exit 時の削除は Chrome の後書きで残ることがある（/tmp 満杯の轍・2026-09-15）
const sweepProfiles = prefix => { try { for (const d of fsSync.readdirSync("/tmp")) if (d.startsWith(prefix) && d !== `${prefix}${process.pid}`) fsSync.rmSync(`/tmp/${d}`, { recursive: true, force: true }); } catch { /* 無害 */ } };
for (const k of ["scene", "geoedit", "click"]) sweepProfiles(`oj-vprod-${k}-`);

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(APP, "dist/site");
const PORT = 5241, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".webp": "image/webp" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… build:prod");
execFileSync("npm", ["run", "build:prod"], { cwd: APP, stdio: "inherit" });

// ① 入口チャンク＝lib参照・エンジン非同梱（100KB上限＝app.js本体(330KB+)が紛れたら即破裂する閾値）
const html = readFileSync(path.join(SITE, "japan/index.html"), "utf8");
const entry = html.match(/<script type="module"[^>]*src="([^"]+\.js)"/)?.[1];
if (!entry) fail("index.html に module script が見つからない");
const entryPath = path.join(SITE, "japan", entry.replace(/^\/japan\//, ""));
const entrySrc = readFileSync(entryPath, "utf8");
if (!entrySrc.includes("/japan/lib/ortho-japan.js")) fail(`入口チャンク ${entry} が lib を import していない（devのソース直が紛れた疑い）`);
const entryKB = statSync(entryPath).size / 1024;
if (entryKB > 100) fail(`入口チャンクが ${entryKB.toFixed(0)}KB＝エンジンが再バンドルされている疑い（DCE失敗）`);
console.log(`ok:entry（${entry} ${entryKB.toFixed(1)}KB・lib参照）`);
// 全サイトチャンク＝エンジン指紋なし（scene.html含むどのページもエンジンをソース直で再バンドルしていない証明。
// 指紋＝エンジンの console 文字列＝minifyでも生き残り、訳の表には載らない（console は英語＝i18n 対象外）。
// ⚠ UI 文字列を指紋にすると、サイト側のページが i18n の言語表（assets/ja-*.js 等）を持っただけで偽陽性になる（2026-09-19 quakes で踏んだ）
for (const f of readdirSync(path.join(SITE, "japan/assets")).filter(f => f.endsWith(".js"))) {
	if (readFileSync(path.join(SITE, "japan/assets", f), "utf8").includes("[boot] frame1 received backend="))
		fail(`assets/${f} にエンジンが再バンドルされている（index/sceneのどちらかがソース直参照に戻った疑い）`);
}
console.log("ok:fingerprint（全サイトチャンクにエンジン指紋なし）");

// ② SDK実体
for (const f of ["japan/lib/ortho-japan.js", "japan/lib/ortho-japan.css", "japan/lib/ortho-japan.d.ts", "japan/llms.txt"]) {   // d.ts＝build:lib が複写（CDN の 404 根治 2026-09-10）・llms.txt＝AI 正典（public/）
	if (!existsSync(path.join(SITE, f))) fail(`${f} が無い（build:prod の複写漏れ）`);
}
console.log("ok:lib（ortho-japan.js/.css/.d.ts・llms.txt 同梱）");
// ②b worker の役が中身を持つ（2026-09-24）：package.json の "sideEffects": false が副作用だけの import（gintbakeworker.js →
// @ortho-earth/core/workers/gintbake）を木揺すりで捨て、gintbake の chunk が消えた＝geoedit の図形が描けない（本番だけ・dev は無事）。
// 役の脚本は「自分で onmessage を張る」だけ＝chunk に onmessage が無ければ空振り
for (const role of ["gintbakeworker"]) {
	const dir = path.join(SITE, "japan/lib/assets"), f = readdirSync(dir).find(n => n.startsWith(role + "-") && n.endsWith(".js"));
	if (!f) fail(`lib/assets に ${role} の chunk が無い（sideEffects の宣言で脚本が捨てられた疑い＝ortho-core の package.json を確認）`);
	if (!readFileSync(path.join(dir, f), "utf8").includes("onmessage")) fail(`${f} に onmessage が無い（役の脚本が空＝sideEffects の宣言を確認）`);
}
console.log("ok:roles（gintbake の脚本が中身を持つ）");

// ③ 実走：素の静的サーバ（COOP/COEP＝本番 deploy-worker と同じ頭・SAB経路も点火）
//    request 台帳＝DOMに出ない故障（worker 404＝黒地図）を捕まえる。base:"/" 事故（2026-08-20）＝
//    workerがドメイン直下/assets/を指して本番のSPAフォールバックHTMLを掴み静かに死んだ、の再発防止。
const read = promisify(readFile);
const requests = [];
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	const file = path.join(SITE, p.endsWith("/") ? p + "index.html" : p);
	try {
		const body = await read(file);
		requests.push("200 " + p);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
			"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
		res.end(body);
	} catch { requests.push("404 " + p); res.writeHead(404); res.end("not found"); }
}).listen(PORT);

// ③ 実走＝3 ページ（/japan/・scene.html・geoedit.html）を **1 つの Chrome で並行**に開き、DOM の証拠が出た時点で終える（実時間・CDP）。
//    旧＝--virtual-time-budget=30000 --dump-dom を 3 回直列。仮想時間では worker の import() が解決せず予算が尽きない個体があり、
//    spawn の timeout（90 s）まで待ってから通っていた（2026-09-20 実測＝scene が 90 s・全体 234 s）。証拠が出れば数秒で済む。
const CDP0 = 9351;
const pages = [
	{ name: "boot", url: `http://localhost:${PORT}/japan/?gl2=1&lang=ja`, ready: `document.title.includes("ortho-japan") && !!document.getElementById("chips") && document.documentElement.outerHTML.includes("地名") && !!document.querySelector("canvas#c")`,
		fails: [[`document.title.includes("ortho-japan")`, "実走: タイトル不在＝ページが立っていない"], [`!!document.getElementById("chips") && document.documentElement.outerHTML.includes("地名")`, "実走: チップ列が出ていない＝エンジン起動失敗の疑い"], [`!!document.querySelector("canvas#c")`, "実走: 描画canvas不在"]] },
	{ name: "scene", url: `http://localhost:${PORT}/japan/scene.html?gl2=1&lang=ja`, ready: `!!document.querySelector("canvas#c") && !!document.getElementById("sc-shoot")`,
		fails: [[`!!document.querySelector("canvas#c")`, "scene実走: 描画canvas不在（SDK経由の起動失敗）"], [`!!document.getElementById("sc-shoot")`, "scene実走: エディタUI不在（editor.jsチャンク疎通の疑い）"]] },
	{ name: "geoedit", url: `http://localhost:${PORT}/japan/geoedit.html?gl2=1&lang=ja`, ready: `!!document.querySelector("canvas#c") && !!document.getElementById("ge-toolbar")`,
		fails: [[`!!document.querySelector("canvas#c")`, "geoedit実走: 描画canvas不在（SDK経由の起動失敗）"], [`!!document.getElementById("ge-toolbar")`, "geoedit実走: エディタUI不在（gadget geoedit の遅延chunk疎通の疑い）"]] },
];
{
	const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP0}`, "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
		"--no-first-run", `--user-data-dir=/tmp/oj-vprod-pages-${process.pid}`, "about:blank"], { stdio: "ignore" });
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP0}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) fail("実走: chrome devtools が起動しない");
		await sleep(250);
	}
	const openTarget = async url => {
		const target = await (await fetch(`http://127.0.0.1:${CDP0}/json/new?about:blank`, { method: "PUT" })).json();
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map();
		const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 5000); });
		ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
		await send("Page.enable"); await send("Runtime.enable");
		await send("Page.navigate", { url });   // json/new の url は効かない個体がある＝明示遷移
		const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
		return { ev, close: () => { try { ws.close(); } catch { /* 終了時 */ } } };
	};
	const results = await Promise.all(pages.map(async pg => {
		const t = await openTarget(pg.url);
		let ok = false;
		for (let i = 0; i < 120 && !ok; i++) { await sleep(500); ok = (await t.ev(pg.ready)) === true; }   // 最長 60 s（健全なら数秒）
		const missing = ok ? [] : (await Promise.all(pg.fails.map(async ([expr, msg]) => (await t.ev(expr)) === true ? null : msg))).filter(Boolean);
		t.close();
		return { name: pg.name, ok, missing };
	}));
	chrome.kill();
	for (const r of results) if (!r.ok) fail(r.missing[0] || `${r.name}実走: 60 s で証拠が出ない`);
	const got = requests.join("\n");
	if (!got.includes("/japan/lib/assets/renderworker-")) { console.error("  台帳:\n  " + requests.join("\n  ")); fail("実走: render worker が /japan/lib/assets/ から取得されていない（base相対の事故＝本番SPAフォールバックHTMLを掴む型）"); }
	console.log(`ok:boot（SDK経由で起動・チップ点灯・canvas生成・worker取得実観測 / 要求${requests.length}件）`);
	console.log("ok:scene（エディタページもSDK経由で起動・editor UI点灯）");
	console.log("ok:geoedit（GeoPBF エディタページも SDK 経由で起動・ツールバー点灯）");
}

// ④ ガジェット実クリック（生CDP・実時間）：遅延ロード系＝押した瞬間に動的importが走るボタンを実際に押す。
//    合否＝例外/console.errorゼロ＋QR/printのDOM証拠＋（この間の404も後段の台帳検査が拾う）。
{
	const CDP = 9353;
	const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--disable-gpu",
		"--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run",
		`--user-data-dir=/tmp/oj-vprod-click-${process.pid}`, "about:blank"], { stdio: "ignore" });
	process.on("exit", () => chrome.kill());
	for (let i = 0; ; i++) {
		try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
		if (i > 60) fail("実クリック: chrome devtools が起動しない");
		await sleep(250);
	}
	const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://localhost:${PORT}/japan/?gl2=1&lang=ja`)}`, { method: "PUT" })).json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0; const pending = new Map(), errs = [];
	const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p }));
		setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 5000); });
	ws.onmessage = ev => { const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
		if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "?").slice(0, 200));
		if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")
			errs.push("ERR " + (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
	};
	await send("Runtime.enable");
	// 起動待ち＝ボタン列が出るまで（実時間・最大60秒）
	let up = false;
	for (let i = 0; i < 240 && !up; i++) {   // 250 ms 刻み（旧 1 s）＝出た瞬間に進む
		await sleep(250);
		up = (await send("Runtime.evaluate", { expression: `!!document.querySelector("#qr-btn") && !!document.querySelector("#print-btn")`, returnByValue: true }))?.result?.value === true;
	}
	if (!up) { chrome.kill(); server.close(); fail("実クリック: ガジェットボタンが60秒で出ない"); }
	const CLICKS = [
		["#measure-btn", null],
		["#profile-btn", `!!document.getElementById("profile-lines")`],   // 断面図＝本体チャンク到着の証拠（経路線canvasは本体が作る）
		["#shot-btn", null],
		["#palette-btn", null],
		["#hint-btn", null],
		["#plateau-btn", `!!document.getElementById("pdb")`],
		["#qr-btn", `!!document.querySelector("#qr-pop, [id^=qr] canvas")`],
		["#print-btn", `!!document.getElementById("print")`],
	];
	for (const [sel, evidence] of CLICKS) {
		await send("Runtime.evaluate", { expression: `document.querySelector("${sel}")?.click()` });
		if (evidence) {   // 証拠が出るまで（最長 5 s・200 ms 刻み）＝旧の固定 5 s 待ち × 8 ボタン＝40 s を数秒へ
			let okDom = false;
			for (let i = 0; i < 25 && !okDom; i++) { await sleep(200); okDom = (await send("Runtime.evaluate", { expression: evidence, returnByValue: true }))?.result?.value === true; }
			if (!okDom) { errs.forEach(e => console.error("      " + e)); chrome.kill(); server.close(); fail(`実クリック: ${sel} のDOM証拠が出ない（動的importチャンク疎通の疑い）`); }
		} else await sleep(1200);   // 証拠のないボタン＝動的 import と描画の一拍
		await send("Runtime.evaluate", { expression: `document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))` });
		await sleep(300);
	}
	try { ws.close(); } catch { /* 終了時 */ }
	chrome.kill();
	if (errs.length) { errs.slice(0, 8).forEach(e => console.error("      " + e)); fail(`実クリック: 例外/console.error ${errs.length}件`); }
	console.log(`ok:click（${CLICKS.length}ガジェット実クリック・例外/エラーゼロ・QR/print/plateau DOM証拠）`);
}

server.close();
const notFound = requests.filter(r => r.startsWith("404 ") && !r.includes("/favicon.svg"));   // ルートfaviconはwwwの持ち物＝検定対象外
if (notFound.length) fail(`実走: 404が${notFound.length}件＝${[...new Set(notFound)].slice(0, 5).join(" / ")}`);
console.log(`ok:ledger（クリック中の動的importチャンク含め404ゼロ / 総要求${requests.length}件）`);
console.log("✓ 本番組立の検定PASS（入口=SDK・エンジン非再バンドル・実走OK・ガジェット実クリックOK）");

// per-pid の Chrome プロファイル（scene/geoedit/click＝各 ~500MB）は終了時に掃除（/tmp 満杯の轍・2026-09-15）
process.on("exit", () => { for (const k of ["pages", "scene", "geoedit", "click"]) { try { fsSync.rmSync(`/tmp/oj-vprod-${k}-${process.pid}`, { recursive: true, force: true }); } catch { /* 無害 */ } } });
