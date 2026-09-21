#!/usr/bin/env node
// UI回帰の常設ハーネス：tests/*.html（判定はページ内・結果は<title>のPASS/FAIL）を headless Chrome で順に開く。
// 使い方: apps/ortho-japan で `npm run verify:ui`。要ローカルChrome（パスは環境変数 CHROME で上書き可）。
// 固定している掟：ガジェットスタック（搭載順・上詰め・二重搭載・リスト追随・透明帯素通し・aria）／
// 起動opts（選択的表示・未知キー警告・plateauスイッチ）／destroy・再起動／タッチ2本指（ピンチ・チルトロック・ひねり）／狭画面。
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5237;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ALL_PAGES = ["t-gadgets", "t-newgadgets", "t-providers", "t-raster", "t-gndfaces", "t-measure", "t-profile", "t-shot", "t-palette-live", "t-demo", "t-scene", "t-print", "t-qr", "t-opts", "t-input", "t-narrow", "t-gintlod", "t-gintembed", "t-gintmultigl", "t-gintswap", "t-anno", "t-gintdepth", "t-rtl", "t-rtl?lang=ar", "t-model"];
const PAGES = process.argv.length > 2 ? ALL_PAGES.filter(p => process.argv.slice(2).includes(p)) : ALL_PAGES;   // 引数＝ページ名の絞り込み（例 node scripts/verify-ui.mjs t-scene）
// t-plateaufs は verify:webgpu（実時間）側：OPFS の実 I/O は virtual-time と両立しない（t-webgpu と同じ轍）。

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
process.on("exit", () => vite.kill());
for (let i = 0; ; i++) {   // 起動待ち＝base(/japan/)が200を返すまでポーリング
	try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch { /* まだ */ }
	if (i > 60) { console.error(`vite が起動しない（port ${PORT} が塞がっている？）`); process.exit(1); }
	await new Promise(r => setTimeout(r, 250));
}
// 実時間で回すページ＝レンダーワーカー内の動的 import（map.overlay のモジュール）に依る検定。--virtual-time-budget 下では worker の
// import() が永久に解決しない（2026-09-20 実測：stage=importing のまま・実時間＋同じ swiftshader なら 0.5 秒で PASS）＝WebGPU async init と同じ轍。
// CDP で開き、<title> が PASS/FAIL になるまで実時間で待つ（最長 60 秒）。
const REALTIME = new Set(["t-anno", "t-model", "t-raster", "t-gndfaces"]);   // t-gndfaces＝gint 面の地面アトラス焼き（標高の到着＝実時間）   // t-raster＝画像タイル層（MessagePort プロバイダ＝worker→worker のタイル・ラスタ PMTiles＝実時間の fetch）   // t-model＝model-worker 内の loaders.gl 動的 import（glb 直読み）
// 実時間ページごとに Chrome を立て直す。⚠旧＝同じ CDP ポート・同じ user-data-dir を使い回し、kill の終了を待たずに次を起動していた
// ＝次の Chrome が終了途中の古い Chrome（同じプロファイルのロック・同じポート）に取り付き、/json/new が「Could not create new page」を
// 返して JSON.parse で検定全体が落ちた（2 本目の実時間ページ＝通しの 5 本目・2026-09-22 に変更前でも再現）。
// 根治＝起動ごとに別ポート・別プロファイル／kill 後は exit を待つ（2 秒で SIGKILL）＋プロファイルを消す／タブが作れなければ 1 回作り直し→理由つき FAIL。
let rtSeq = 0;
const waitExit = (proc, ms = 5000) => new Promise(res => {
	if (proc.exitCode != null || proc.signalCode != null) return res();
	const t1 = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* もう居ない */ } }, 2000);
	const t2 = setTimeout(res, ms);
	proc.once("exit", () => { clearTimeout(t1); clearTimeout(t2); res(); });
});
async function runRealtime(url) {
	const n = ++rtSeq, CDP = 9600 + ((process.pid * 7 + n * 13) % 300), dir = `/tmp/oj-vui-${process.pid}-${n}`;
	const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
		"--no-first-run", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
	try {
		for (let i = 0; ; i++) {
			try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ }
			if (i > 60) return "FAIL chrome devtools が起動しない";
			await new Promise(r => setTimeout(r, 250));
		}
		let target = null, why = "";
		for (let k = 0; k < 2 && !target; k++) {   // タブ作成＝失敗は本文（文字列）を理由にして 1 回だけ作り直す（JSON.parse で落とさない）
			const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" }).catch(e => ({ ok: false, text: async () => String(e.message) }));
			const body = await r.text();
			try { if (r.ok) target = JSON.parse(body); else why = body; } catch { why = body; }
			if (!target) await new Promise(res => setTimeout(res, 500));
		}
		if (!target?.webSocketDebuggerUrl) return "FAIL chrome: タブを作れない（" + String(why).slice(0, 80) + "）";
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map();
		const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 5000); });
		ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
		await send("Page.enable"); await send("Runtime.enable");
		await send("Page.navigate", { url });   // json/new の url は効かない個体がある＝明示遷移（CDP 台の轍）
		let title = "";
		for (let i = 0; i < 120 && !/^(PASS|FAIL)/.test(title); i++) {
			await new Promise(r => setTimeout(r, 500));
			title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
		}
		ws.close();
		return /^(PASS|FAIL)/.test(title) ? title : "FAIL no-title(realtime 60s): " + title;
	} catch (e) {
		return "FAIL chrome: " + String(e?.message || e).slice(0, 120);
	} finally {
		chrome.kill();
		await waitExit(chrome);   // 終わるまで待つ＝次の起動が古い Chrome に取り付かない
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

let fail = 0;
for (const p of PAGES) {
	// ページ名は "t-rtl?lang=ar" の形も受ける＝既定（gl2=1&lang=ja）に後から上書きする（同じ鍵を二度書かない＝get は先勝ち）
	const [page, extra = ""] = p.split("?");
	const q = new URLSearchParams("gl2=1&lang=ja");
	for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
	const title = REALTIME.has(page) ? await runRealtime(`http://localhost:${PORT}/japan/tests/${page}.html?${q}`) : await new Promise(res => execFile(CHROME,
		["--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
			"--virtual-time-budget=75000", "--dump-dom", `http://localhost:${PORT}/japan/tests/${page}.html?${q}`],   // lang=ja固定＝headlessは英語ブラウザ（i18n自動判定でenに流れて日本語assertが割れるのを封じる）   // 75s＝t-demoのフライト実尺（glide/z1着地×9s＋自動上演の着地後計時＝仮想20s＋scene-player API回帰）を収める
			// ?gl2=1＝WebGPU既定化(2026-08-02)後も虚時間ハーネスはGL2固定（WebGPU async init×virtual-time の轍＝t-webgpu を PAGES に載せない理由と同じ）
		{ timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
		(e, out) => res(e && !out ? `FAIL chrome: ${e.message}` : (String(out).match(/<title>([^<]*)<\/title>/) || [, "FAIL no-title"])[1])));
	const pass = title.startsWith("PASS");
	if (!pass) fail++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${p.padEnd(14)} ${title.replace(/^(PASS|FAIL) ?/, "")}`);
}
console.log(fail ? `\n✗ ${fail}/${PAGES.length} ページ失敗` : `\n✓ 全${PAGES.length}ページ PASS`);
process.exit(fail ? 1 : 0);
