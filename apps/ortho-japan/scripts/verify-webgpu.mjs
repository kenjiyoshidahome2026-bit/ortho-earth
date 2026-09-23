#!/usr/bin/env node
// WebGPU バックエンド（?gpu=1）の実時間スモーク：tests/t-webgpu.html を CDP で開き title の PASS/FAIL を見る。
// verify-ui.mjs（--virtual-time-budget）に載せない理由：仮想時間は WebGPU の実時間 async init（adapter/device の
// GPU IPC）と両立しない——ページ側の仮想時計が先に燃え尽き、worker の rAF/タイマーが凍った後に device が
// 届く＝「実機では健全なのに CI だけ frame1 が来ない」偽陽性になる（2026-08-01 実測）。ここは実時間で回す。
// 使い方: apps/ortho-japan で `npm run verify:webgpu`。要ローカルChrome（パスは環境変数 CHROME で上書き可）。
// ★頁ごとに Chrome を立て直す（別ポート・別プロファイル・kill の exit を待つ）＝verify-ui の実時間ページと同じ作法。
// 旧＝Chrome 1個・プロファイル1個を全頁で使い回していた＝前の頁の IDB／localStorage／GPU の後始末が次の頁へ漏れ、
// 並び順で結果が変わっていた（2026-09-24 実測：t-backfill は t-gintlayers の後だと NG:frontFilled ほか・単独なら PASS／
// t-gndfaces も 2 番手以降で NG:boot2d(no fills within 30s)。頁の側は無実で、関門の作りが犯人だった。t-backfill が
// 自衛で idbClear() を呼んでいるのが傍証）。
// WebGPU の無い環境では WebGL2 フォールバックで PASS（このテストの主眼は「gpu 旗でどの環境でも起動が壊れない」）。
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VWG_PORT || 5238, CDP_BASE = +process.env.VWG_CDP || 9335;   // VWG_PORT／VWG_CDP＝別の検定や取り残しの vite がポートを掴んでいる時の逃げ道（CDP は頁ごとに CDP_BASE から散らす）
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";


// 起動時に前回までの per-pid プロファイル（同じ接頭辞・別 pid）を掃く＝exit 時の削除は Chrome の後書きで残ることがある（/tmp 満杯の轍・2026-09-15）
const sweepProfiles = prefix => { try { for (const d of fsSync.readdirSync("/tmp")) if (d.startsWith(prefix) && !d.startsWith(`${prefix}${process.pid}-`)) fsSync.rmSync(`/tmp/${d}`, { recursive: true, force: true }); } catch { /* 無害 */ } };
sweepProfiles("oj-webgpu-profile-");
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: APP, stdio: "ignore" });
let liveChrome = null;   // 今の頁の Chrome（異常終了で置き去りにしない）
process.on("exit", () => { vite.kill(); try { liveChrome?.kill(); } catch { /* もう居ない */ } });

// kill の完了を待つ＝次の Chrome が終了途中の古い個体（同じポート/プロファイル）に取り付かない（verify-ui と同じ手当て）
const waitExit = (proc, ms = 5000) => new Promise(res => {
	if (proc.exitCode != null || proc.signalCode != null) return res();
	const t1 = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* もう居ない */ } }, 2000);
	const t2 = setTimeout(res, ms);
	proc.once("exit", () => { clearTimeout(t1); clearTimeout(t2); res(); });
});

// 1 頁＝1 Chrome（別ポート・別プロファイル）。戻り値は document.title（PASS…／FAIL…／起動できなければ理由つき FAIL 文字列）。
let seq = 0;
async function runPage(page) {
	const n = ++seq, cdp = CDP_BASE + ((process.pid * 7 + n * 13) % 200), dir = `/tmp/oj-webgpu-profile-${process.pid}-${n}`;
	const chrome = spawn(CHROME, [
		"--headless=new", `--remote-debugging-port=${cdp}`, "--enable-unsafe-webgpu",
		"--no-first-run", `--user-data-dir=${dir}`, "about:blank",
	], { stdio: "ignore" });
	liveChrome = chrome;
	let ws = null;
	try {
		for (let i = 0; ; i++) {   // chrome devtools 起動待ち
			try { await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json(); break; } catch { /* まだ */ }
			if (i > 60) return "FAIL chrome devtools が起動しない";
			await sleep(250);
		}
		const url = `http://localhost:${PORT}/japan/tests/${page.replace(/(\?|$)/, ".html$1")}`;
		let target = null, why = "";
		for (let k = 0; k < 2 && !target; k++) {   // タブ作成＝失敗は本文（文字列）を理由にして 1 回だけ作り直す（JSON.parse で落とさない・verify-ui と同じ）
			const r = await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: "PUT" }).catch(e => ({ ok: false, text: async () => String(e.message) }));
			const t = await r.text();
			try { if (r.ok) target = JSON.parse(t); else why = t; } catch { why = t; }
			if (!target) await sleep(500);
		}
		if (!target?.webSocketDebuggerUrl) return "FAIL chrome: タブを作れない（" + String(why).slice(0, 80) + "）";
		ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map();
		const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 5000); });   // 返らない口で止まらない（Chrome が落ちた時）
		ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
		await send("Page.enable"); await send("Runtime.enable");
		await send("Page.navigate", { url });   // json/new の url は効かない個体がある＝明示遷移（CDP 台の轍）
		let title = "";
		// 実マウスでのドラッグ駆動：ページが window.__dragGo を立てている間だけ pointermove を流す（t-baselane）。
		// setTimeout から __cam() を叩く方式では「入力→rAF」というブラウザのフレーム内順序を再現できず、
		// render() より後に描画要求が飛んで opts が後勝ちする＝実機と違う結果になる（実測で判明 2026-09-03）。
		(async () => {
			const at = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
			let down = false, i = 0;
			while (!/^(PASS|FAIL)/.test(title)) {
				const go = (await send("Runtime.evaluate", { expression: "!!window.__dragGo", returnByValue: true }))?.result?.value;
				if (go && !down) { await at("mousePressed", 400, 300, { buttons: 1 }); down = true; }
				if (go && down) { await at("mouseMoved", 400 + (i % 8) - 4, 300 + ((i >> 1) % 6) - 3, { buttons: 1 }); i++; await sleep(16); continue; }
				if (!go && down) { await at("mouseReleased", 400, 300, { buttons: 0 }); down = false; }
				await sleep(100);
			}
			if (down) await at("mouseReleased", 400, 300, { buttons: 0 });
		})().catch(() => { /* ページ終了で evaluate が失敗するのは正常 */ });
		const t0 = Date.now();
		while (Date.now() - t0 < 90000) {   // 健全なら数秒（t-baselane だけは実ドラッグ観測で数十秒）
			await sleep(1000);
			const r = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
			title = r?.result?.value || "";
			if (/^(PASS|FAIL)/.test(title)) break;
		}
		if (process.env.SHOT) { const r = await send("Page.captureScreenshot", { format: "png" }); if (r?.data) (await import("node:fs")).writeFileSync(process.env.SHOT, Buffer.from(r.data, "base64")); }
		return title;
	} finally {
		try { ws && ws.close(); } catch { /* 次頁へ */ }
		chrome.kill(); await waitExit(chrome); liveChrome = null;   // 終わるまで待ってからプロファイルを消す
		await rm(dir, { recursive: true, force: true }).catch(() => { /* 掃除失敗は無害 */ });
	}
}

let fail = 1;
try {
	for (let i = 0; ; i++) {   // vite 起動待ち
		try { if ((await fetch(`http://localhost:${PORT}/japan/`)).ok) break; } catch { /* まだ */ }
		if (i > 60) throw new Error(`vite が起動しない（port ${PORT} が塞がっている？）`);
		await sleep(250);
	}
	fail = 0;
	const ALL = ["t-webgpu", "t-extrude-drape?gl2=1&bottom=4000", "t-extrude-drape?gl2=1&bottom=drape", "t-extrude-drape?gl2=1&v=%2310/36.3/137.6", "t-aatrans", "t-gintgpu", "t-gintgpu?gintsb=0", "t-gintmulti", "t-gintlayers", "t-gintlayers?gl2=1", "t-meshfs", "t-baselane", "t-backfill", "t-anchorfill", "t-rectlook", "t-zoomfill", "t-bld?gl2=1", "t-mesh?gl2=1&loadmax=1", "t-raster", "t-gndfaces", "t-spotlight", "t-spotlight?globe=1"];   // t-raster＝画像タイル層の WGSL 経路（配列 UBO の dynamic offset・per-tile bind group）
	// japan（地域パック）に依る頁＝これ以外は globe の関門（LAYERS.md 段階 2 S5）。--globe / --japan で集合を選ぶ（頁名の引数はそのまま）
	const JP_PAGES = new Set(["t-meshfs", "t-baselane", "t-bld", "t-mesh", "t-raster"]);   // PLATEAU の OPFS・基図の車線・建物・台帳・画像タイル台帳
	const LAYER = process.argv.includes("--globe") ? "globe" : process.argv.includes("--japan") ? "japan" : null;
	const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
	const PAGES = ARGS.length ? ARGS : LAYER ? ALL.filter(p => JP_PAGES.has(p.split("?")[0]) === (LAYER === "japan")) : ALL;   // 引数＝ページ名（?query 付き可＝t-rectlook の視点差し替え等）。SHOT=path で最後のページの画面を PNG に
	for (const page of PAGES) {   // t-backfill＝gint 塗り扇の球体カリング（裏半球のゴースト/跨ぎ面）＝WGSL 側の実 GPU 検分   // t-aatrans＝遷移時AA（実GPUの実時間必須）。t-meshfs＝OPFS 実I/O（同期ハンドル）＝実時間必須（仮想時間はタイマー先燃えで偽陽性）。t-gintgpu は storage/テクスチャ両経路
		const title = await runPage(page);
		const bad = title.startsWith("PASS") ? 0 : 1;
		fail += bad;
		console.log(`${bad ? "FAIL" : "PASS"}  ${page.padEnd(18)} ${title.replace(/^(PASS|FAIL) ?/, "") || "（titleがPASS/FAILにならない＝起動不能）"}`);
	}
} catch (e) {
	console.error("FAIL  verify-webgpu  ", e.message);
	fail = fail || 1;
} finally {
	vite.kill();   // Chrome とプロファイルは runPage が頁ごとに片付ける
}
process.exit(fail);
