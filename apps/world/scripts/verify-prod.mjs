#!/usr/bin/env node
// world 本番出荷物の検定＝deploy の必須ゲート（ortho-japan の verify-prod と同型）。
//   背景＝world は「手で deploy するだけ」で門番が無く、2026-09-12 に 4 コミット分が未反映のまま溜まり、
//   出した瞬間に本番が白画面になった（下の④）。以後ここが門番。
//   vite preview を挟まず dist/site を素の静的サーバで配る＝出荷物そのものを食う。
// 検査項目:
//   ① 静的: d3 が混ざっていない（common/dom へ移した後の逆戻り検知＝xlink 名前空間はd3-selection固有の指紋）
//   ② 実走: 起動→カード262枚→旗/サムネの実描画→tip→検索+highlight→一覧表→国旗モーダル（resumeShow）
//   ③ コンソール: **自分のオリジンの全ターゲット**に接続して例外/error を数える（worker や同一オリジン iframe を
//      将来足しても取りこぼさない）。Wikipedia の iframe は別オリジン＝別ターゲットで、数に入れず落とした件数だけ出す
//      （ja/fr/ko の skin-theme-description は MediaWiki 側の既知の parse error＝こちらの責任ではない）
//   ④ 復旧: 古い版の形の IDB から起動しても自力で直る（v1 CityDB は nation が文字列・v2 は配列）。
//      この経路が壊れると「一度訪れた人だけ二度と開けない」という最悪の壊れ方をする
// ⚠ スクショ判定をするなら画像の読み込み完了を待つこと。コールドキャッシュで撮ると「旗が全部消えた」と誤診する。
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(APP, "dist/site");
const PORT = 5246, CDP = 9346;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".map": "application/json" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… build");
execFileSync("npm", ["run", "build"], { cwd: APP, stdio: "inherit" });

// ── ① 静的: d3 の逆戻り検知 ───────────────────────────────────────────────
{
	const dir = path.join(SITE, "world/assets");
	const js = readdirSync(dir).filter(f => f.endsWith(".js"));
	if (!js.length) fail("assets に JS が無い");
	for (const f of js) {
		// xlink 名前空間は d3-selection の namespaces 表にだけ在る＝common/dom には無い（minify でも文字列は残る）
		if (readFileSync(path.join(dir, f), "utf8").includes("http://www.w3.org/1999/xlink"))
			fail(`assets/${f} に d3-selection の指紋（xlink）＝d3 依存が戻っている`);
	}
	console.log(`ok:static（d3 非同梱 / チャンク ${js.length}本）`);
}

// ── 素の静的サーバ（出荷物そのもの）────────────────────────────────────────
const read = promisify(readFile);
const requests = [];
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	const file = path.join(SITE, p.endsWith("/") ? p + "index.html" : p);
	try {
		const body = await read(file);
		requests.push("200 " + p);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
		res.end(body);
	} catch { requests.push("404 " + p); res.writeHead(404); res.end("not found"); }
}).listen(PORT);
const URL_ = `http://localhost:${PORT}/world/`;

// ── CDP（生）: 自分のオリジンの全ターゲットに自動接続 ───────────────────────
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--disable-gpu", "--no-first-run",
	`--user-data-dir=/tmp/world-vprod-${process.pid}`, "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
const bye = () => { try { chrome.kill(); } catch { } try { server.close(); } catch { } };
process.on("exit", bye);
for (let i = 0; ; i++) {
	try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
	if (i > 60) { bye(); fail("chrome devtools が起動しない"); }
	await sleep(250);
}
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pending = new Map();
const ctxOrigin = new Map();     // executionContextId → origin
const sessionOrigin = new Map(); // CDP sessionId → そのターゲットの URL
let errs = [], foreign = 0;      // errs=自分のオリジン / foreign=他所（Wikipedia 等）で落とした数
const mine = u => !u || u.startsWith(`http://localhost:${PORT}`) || u === "about:blank";

const send = (method, params = {}, sessionId) => new Promise(res => {
	const i = ++id; pending.set(i, res);
	ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
	setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 8000);
});
const note = (kind, text, url, sessionId) => {
	const from = sessionId ? sessionOrigin.get(sessionId) : URL_;
	if (!mine(from) || !mine(url)) { foreign++; return; }   // 別オリジン（Wikipedia の iframe 等）は数に入れない
	errs.push(`${kind} ${String(text).slice(0, 200)}`);
};
ws.onmessage = ev => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
	// 子ターゲット（worker・iframe）に自動接続＝自分のオリジンなら Runtime を開いて拾う
	if (m.method === "Target.attachedToTarget") {
		const { sessionId, targetInfo } = m.params;
		sessionOrigin.set(sessionId, targetInfo.url);
		if (mine(targetInfo.url)) send("Runtime.enable", {}, sessionId);
	}
	if (m.method === "Runtime.executionContextCreated") ctxOrigin.set(m.params.context.id, m.params.context.origin);
	if (m.method === "Runtime.exceptionThrown") {
		const d = m.params.exceptionDetails;
		note("EXC", d?.exception?.description || d?.text || "?", d?.url || ctxOrigin.get(d?.executionContextId), m.sessionId);
	}
	if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
		note("ERR", (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "),
			m.params.stackTrace?.callFrames?.[0]?.url || ctxOrigin.get(m.params.executionContextId), m.sessionId);
	}
};
await send("Page.enable"); await send("Runtime.enable");
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

const ev = async (expr, sessionId) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId))?.result?.value;
const goto = async (url = URL_) => {
	await send("Page.navigate", { url });
	for (let i = 0; i < 240; i++) { if (await ev("document.querySelectorAll('div.nation').length > 0")) return true; await sleep(250); }
	return false;
};
// 画面内の画像が出揃うまで（コールドキャッシュで判定すると誤診する）
const imagesReady = async () => {
	for (let i = 0; i < 120; i++) {
		const v = await ev(`(() => { const a = [...document.images].filter(im => { const r = im.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
			return a.length + ':' + a.filter(im => im.complete && im.naturalWidth > 0).length; })()`);
		const [t, done] = String(v).split(":").map(Number);
		if (t > 0 && t === done) return t;
		await sleep(250);
	}
	return 0;
};

// ── ② 実走 ───────────────────────────────────────────────────────────────
if (!await goto()) { bye(); fail("実走: カードが出ない＝起動失敗"); }
const cards = await ev("document.querySelectorAll('div.nation').length");
if (cards < 200) { bye(); fail(`実走: カードが ${cards} 枚しかない（DB 欠損の疑い・期待 200+）`); }
const shown = await imagesReady();
if (!shown) { bye(); fail("実走: 画面内の画像が出揃わない（旗/サムネの取得失敗）"); }
for (const [sel, label] of [["[name=head] select option", "言語/地域 select"], ["[name=sorts] button", "ソートボタン"]]) {
	if (!await ev(`document.querySelectorAll('${sel}').length > 0`)) { bye(); fail(`実走: ${label} が出ていない`); }
}
console.log(`ok:boot（カード${cards}枚・画面内の画像${shown}枚が実描画・ヘッダ部品あり）`);

// tip（common/dom の .tip＝ホバーで .overlap-tooltip に中身が入る）
await ev(`(() => { const el = document.querySelector('div.nation img.hover');
	el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
	el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300, pageX: 300, pageY: 300 })); })()`);
await sleep(400);
await ev(`document.querySelector('div.nation img.hover').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 300, pageX: 300, pageY: 300 }))`);
await sleep(200);
const tip = await ev(`(() => { const t = document.querySelector('.overlap-tooltip');
	return t && !t.classList.contains('hidden') && t.textContent.trim() ? t.textContent.trim().slice(0, 40) : null; })()`);
if (!tip) { bye(); fail("実走: tip が出ない（common/dom の .tip 疎通）"); }
console.log(`ok:tip（"${tip}"）`);

// 検索＋highlight（common/dom の .highlight）
await ev(`(() => { const i = document.querySelector('[name=search] input'); i.value = 'japan'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(1200);
const hit = await ev("document.querySelectorAll('div.nation').length");
const hl = await ev("document.querySelectorAll('span.highlight').length");
if (!hit || !hl) { bye(); fail(`実走: 検索が効かない（該当${hit}件・highlight${hl}件）`); }
await ev(`(() => { const i = document.querySelector('[name=search] input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(1200);
console.log(`ok:search（該当${hit}件・highlight${hl}箇所）`);

// 一覧表（静的 enter でのテーブル生成）
await ev(`document.querySelectorAll('[name=display] button')[1].click()`);
await sleep(1200);
const rows = await ev("document.querySelectorAll('.list table tbody tr').length");
const cols = await ev("document.querySelectorAll('.list table thead tr:first-child th').length");
if (rows < 200 || cols < 10) { bye(); fail(`実走: 一覧表が組めていない（${rows}行 × ${cols}列）`); }
console.log(`ok:table（${rows}行 × ${cols}列）`);

// 国旗モーダル（resumeShow＝Web Animations の覆い。終わって覆いが片付くことまで見る）
await ev(`document.querySelectorAll('[name=display] button')[0].click()`);
await sleep(1200);
await ev(`document.querySelector('div.nation img.hover').click()`);
await sleep(1500);
if (!await ev(`(() => { const m = document.querySelector('[name=modal]'); return !!m && !m.classList.contains('hidden'); })()`)) { bye(); fail("実走: 国旗モーダルが開かない"); }
if (!await ev(`!!document.querySelector('[name=modal] [name=flag] img')`)) { bye(); fail("実走: モーダルに旗が無い"); }
const covers = await ev(`document.querySelectorAll('.overlay-fullbody').length`);
if (covers) { bye(); fail(`実走: resumeShow の覆いが ${covers} 枚残っている（アニメ終了後の後片付け漏れ）`); }
console.log("ok:modal（国旗モーダル・覆いの後片付けまで）");

// ── ④ 復旧: 古い版の形の IDB から起動しても自力で直る ─────────────────────
{
	const mutated = await ev(`(async () => {
		const db = await new Promise((res, rej) => { const q = indexedDB.open('world'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
		const get = k => new Promise((res, rej) => { const t = db.transaction('files', 'readonly').objectStore('files').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
		const put = (v, k) => new Promise((res, rej) => { const t = db.transaction('files', 'readwrite').objectStore('files').put(v, k); t.onsuccess = () => res(1); t.onerror = () => rej(t.error); });
		const rec = await get('CityDB'); if (!rec) return 0;
		const items = rec.v.items || rec.v;
		items.forEach(c => c.nation = '南アフリカ');   // v1 の形＝日本語の国名文字列（v2 は ["CI"] の配列）
		await put(rec, 'CityDB');
		return items.length;
	})()`);
	if (!mutated) { bye(); fail("復旧: IDB に CityDB が無い（温起動の経路が壊れている疑い）"); }
	errs = [];
	if (!await goto()) { errs.slice(0, 5).forEach(e => console.error("      " + e)); bye(); fail("復旧: 古い形の IDB から起動できない＝一度訪れた人が二度と開けない壊れ方"); }
	const healed = await ev(`(async () => {
		const db = await new Promise(r => { const q = indexedDB.open('world'); q.onsuccess = () => r(q.result); });
		const rec = await new Promise(r => { const t = db.transaction('files', 'readonly').objectStore('files').get('CityDB'); t.onsuccess = () => r(t.result); });
		const items = rec.v.items || rec.v; return Array.isArray(items[0].nation); })()`);
	if (!healed) { bye(); fail("復旧: 起動はしたが IDB が直っていない（次回もまた冷やし直しになる）"); }
	console.log(`ok:recover（v1形の IDB ${mutated}件から自力復帰・IDB も修復）`);
}

// ── ③ コンソール・台帳 ───────────────────────────────────────────────────
if (errs.length) { errs.slice(0, 8).forEach(e => console.error("      " + e)); bye(); fail(`コンソール: 例外/error ${errs.length}件`); }
const notFound = requests.filter(r => r.startsWith("404 ") && !/favicon/.test(r));
if (notFound.length) { bye(); fail(`台帳: 404が${notFound.length}件＝${[...new Set(notFound)].slice(0, 5).join(" / ")}`); }
console.log(`ok:console（自オリジンの例外/error ゼロ・別オリジン由来 ${foreign} 件は対象外 / 404ゼロ・総要求${requests.length}件）`);

bye();
console.log("✓ world 本番出荷物の検定PASS（d3非同梱・実走OK・古い IDB からの復旧OK）");
