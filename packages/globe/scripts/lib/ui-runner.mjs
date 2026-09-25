// UI 検定の走らせ方（globe と japan で共有する仕掛け・2026-09-24 に apps/ortho-japan/scripts/verify-ui.mjs から抽出）。
// 頁の一覧と器（vite の root・base）は呼ぶ側が持ち、ここは「どう走らせるか」だけを持つ＝複製を作らない。
//   ・既定は仮想時間（--virtual-time-budget＝速い・決定的）
//   ・realtime の頁だけ実時間で CDP 越しに見る（render worker 内の動的 import・WebGPU async init は仮想時計と両立しない）
//   ・実時間は**頁ごとに Chrome を立て直す**（別ポート・別プロファイル・kill の exit を待つ）＝前の頁の
//     IDB/localStorage/GPU が次へ漏れない（9/24 に verify-webgpu 側で踏んだ轍と同じ手当て）
import { spawn, execFile } from "node:child_process";
import { rm, readFile } from "node:fs/promises";

export const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const waitExit = (proc, ms = 5000) => new Promise(res => {
	if (proc.exitCode != null || proc.signalCode != null) return res();
	const t1 = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* もう居ない */ } }, 2000);
	const t2 = setTimeout(res, ms);
	proc.once("exit", () => { clearTimeout(t1); clearTimeout(t2); res(); });
});

// vite を起こして「配れる」まで待つ。返り＝止める関数。
export async function startVite({ cwd, port, readyUrl, env = null }) {
	const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd, stdio: "ignore", ...(env ? { env: { ...process.env, ...env } } : {}) });
	process.on("exit", () => vite.kill());
	for (let i = 0; ; i++) {
		try { await fetch(readyUrl); break; } catch { /* まだ＝接続できない。応答さえ返れば（404 でも）器は立っている */ }
		if (i > 60) { vite.kill(); throw new Error(`vite が起動しない（port ${port} が塞がっている？）`); }
		await sleep(250);
	}
	return () => vite.kill();
}

// ソフトウェア GL（仮想時間と両立しない頁）＝既定の旗
export const SWIFTSHADER = ["--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// 実 GPU（WebGPU バックエンドの検分）＝WebGPU の async init は仮想時間と両立しない＝ここも実時間
export const REALGPU = ["--enable-unsafe-webgpu"];

// 実時間 1 頁＝1 Chrome（別ポート＝Chrome が選ぶ・別プロファイル・kill の exit を待つ）。呼び手の cdpBase は旧来の名残＝無視。戻り＝document.title（PASS…／FAIL…）。
// drag:true＝ページが window.__dragGo を立てている間だけ実マウスの pointermove を流す（入力→rAF のフレーム内順序は
// setTimeout から __cam() を叩く方式では再現できない＝実機と違う結果になる・2026-09-03 実測）。
// backends：配列を渡すと globe.js の起動ログ "[boot] frame1 received backend=…" の値を積む（runPages の backend 検め・T1）。
export async function runRealtime(url, { limitS = 60, profilePrefix = "oj-vui", seq = 1, flags = SWIFTSHADER, drag = false, shot = null, backends = null } = {}) {
	// CDP の port は Chrome 自身に空きを選ばせる（port 0 → プロファイルの DevToolsActivePort に書く）。旧＝pid と seq から
	// 決め打ち＝置き去りの headless Chrome が同じ port に居ると、よその Chrome に繋いで頁が進まず「no-title」（2026-09-25）
	const dir = `/tmp/${profilePrefix}-${process.pid}-${seq}`;
	await rm(dir, { recursive: true, force: true }).catch(() => { /* 無ければよい */ });   // 前回の DevToolsActivePort を読まない
	const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", ...flags,
		"--no-first-run", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
	let CDP = 0;
	try {
		for (let i = 0; ; i++) {
			if (!CDP) CDP = +(await readFile(`${dir}/DevToolsActivePort`, "utf8").catch(() => "")).split("\n")[0] || 0;
			if (CDP) { try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { /* まだ */ } }
			if (i > 60) return "FAIL chrome devtools が起動しない";
			await sleep(250);
		}
		let target = null, why = "";
		for (let k = 0; k < 2 && !target; k++) {   // タブ作成＝失敗は本文を理由にして 1 回だけ作り直す（JSON.parse で落とさない）
			const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" }).catch(e => ({ ok: false, text: async () => String(e.message) }));
			const body = await r.text();
			try { if (r.ok) target = JSON.parse(body); else why = body; } catch { why = body; }
			if (!target) await sleep(500);
		}
		if (!target?.webSocketDebuggerUrl) return "FAIL chrome: タブを作れない（" + String(why).slice(0, 80) + "）";
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
		let id = 0; const pending = new Map();
		const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); res(null); } }, 5000); });
		ws.onmessage = ev => {
			const m = JSON.parse(ev.data);
			if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
			else if (backends && m.method === "Runtime.consoleAPICalled") {
				const b = /^\[boot\] frame1 received backend=(\w+)/.exec(m.params?.args?.[0]?.value || "")?.[1];
				if (b) backends.push(b);
			}
		};
		await send("Page.enable"); await send("Runtime.enable");
		await send("Page.navigate", { url });   // json/new の url は効かない個体がある＝明示遷移（CDP 台の轍）
		let title = "";
		if (drag) (async () => {
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
		for (let i = 0; i < limitS * 2 && !/^(PASS|FAIL)/.test(title); i++) {
			await sleep(500);
			title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
		}
		if (shot) { const r = await send("Page.captureScreenshot", { format: "png" }); if (r?.data) (await import("node:fs")).writeFileSync(shot, Buffer.from(r.data, "base64")); }
		ws.close();
		return /^(PASS|FAIL)/.test(title) ? title : `FAIL no-title(realtime ${limitS}s): ` + title;
	} catch (e) {
		return "FAIL chrome: " + String(e?.message || e).slice(0, 120);
	} finally {
		chrome.kill(); await waitExit(chrome);
		await rm(dir, { recursive: true, force: true }).catch(() => { /* 掃除失敗は無害 */ });
	}
}

// 仮想時間＝--dump-dom の <title> を読むだけ（速い・決定的）
export const runVirtual = url => new Promise(res => execFile(CHROME,
	["--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--virtual-time-budget=75000", "--dump-dom", url],
	{ timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
	(e, out) => res(e && !out ? `FAIL chrome: ${e.message}` : (String(out).match(/<title>([^<]*)<\/title>/) || [, "FAIL no-title"])[1])));

// 頁の列を順に回して PASS/FAIL を出す。urlOf(page,query) は呼ぶ側の器が決める。
// base＝全頁に付ける既定の query。既定の gl2=1 は SwiftShader の門（verify-ui・nocoi）向け＝WebGPU の門は "lang=ja" を渡す。
// expectBackend＝"webgpu" を渡すと実時間の頁で backend を検める（T1・2026-09-25。旧＝runner が全頁に gl2=1 を付けており、
//   verify:webgpu の createGlobe/app.js 頁の多くが黙って WebGL2 で走っていた＝WebGPU 経路の回帰を見ていなかった）：
//   ・gl2=1 の無い頁は起動ログの backend が全部 webgpu、gl2=1 の頁は全部 webgl2（GL2 変種が本当に GL2 かも見る）
//   ・noBoot の頁（地球儀を起こさない＝createRenderer 直叩き・OPFS 等）は起動ログを求めない
//   ・どの頁も表題に skip／スキップ（WebGPU 不在で素通りする印）があれば FAIL
export async function runPages({ pages, urlOf, realtime, long = {}, pad = 14, flags, drag = false, profilePrefix, shotLast = process.env.SHOT || null,
	base = "gl2=1&lang=ja", expectBackend = null, noBoot = new Set() }) {
	let fail = 0, seq = 0;
	for (const p of pages) {
		const [page, extra = ""] = p.split("?");
		const q = new URLSearchParams(base);
		for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);   // 同じ鍵を二度書かない＝頁側の指定が勝つ
		const url = urlOf(page, q.toString());
		const backends = expectBackend && realtime.has(page) ? [] : null;
		const opt = { limitS: long[page] ?? 60, seq: ++seq, drag, backends, ...(flags ? { flags } : {}), ...(profilePrefix ? { profilePrefix } : {}), shot: (shotLast && p === pages[pages.length - 1]) ? shotLast : null };
		let title = realtime.has(page) ? await runRealtime(url, opt) : await runVirtual(url);
		if (backends && title.startsWith("PASS")) {
			const want = q.get("gl2") === "1" ? "webgl2" : expectBackend;
			const seen = [...new Set(backends)].join("+") || "なし";
			if (/skip|スキップ/i.test(title)) title = `FAIL 素通り（backend=${seen}）: ` + title.replace(/^PASS ?/, "");
			else if (!noBoot.has(page) && (!backends.length || backends.some(b => b !== want))) title = `FAIL backend=${seen}（期待 ${want}）: ` + title.replace(/^PASS ?/, "");
			else if (backends.length) title = title.replace(/^PASS ?/, `PASS [${seen}] `);
		}
		const pass = title.startsWith("PASS");
		if (!pass) fail++;
		console.log(`${pass ? "PASS" : "FAIL"}  ${p.padEnd(pad)} ${title.replace(/^(PASS|FAIL) ?/, "")}`);
	}
	console.log(fail ? `\n✗ ${fail}/${pages.length} ページ失敗` : `\n✓ 全${pages.length}ページ PASS`);
	return fail;
}
