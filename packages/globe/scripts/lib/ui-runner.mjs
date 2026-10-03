// UI 検定の走らせ方（globe と japan で共有する仕掛け・2026-09-24 に apps/ortho-japan/scripts/verify-ui.mjs から抽出）。
// 頁の一覧と器（vite の root・base）は呼ぶ側が持ち、ここは「どう走らせるか」だけを持つ＝複製を作らない。
//   ・既定は仮想時間（CDP で仮想時計を刻む＝速い・決定的。旧の --virtual-time-budget --dump-dom は VG_VIRTUAL=dump）
//   ・realtime の頁だけ実時間で CDP 越しに見る（render worker 内の動的 import・WebGPU async init は仮想時計と両立しない）
//   ・実時間は**頁ごとに Chrome を立て直す**（別ポート・別プロファイル・kill の exit を待つ）＝前の頁の
//     IDB/localStorage/GPU が次へ漏れない（9/24 に verify-webgpu 側で踏んだ轍と同じ手当て）
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import { CHROME, SWIFTSHADER, REALGPU, waitExit, launchChrome, newTab, connect } from "./cdp.mjs";

export { CHROME, SWIFTSHADER, REALGPU, waitExit };   // 2026-09-27 に cdp.mjs へ移した＝ここからも従来どおり取れる
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 口に既に誰か居るか。vite の localhost は macOS では ::1 に立つが、よその鯖は 127.0.0.1 のことがある＝両方叩く
const portTaken = port => Promise.all(["127.0.0.1", "::1"].map(host => new Promise(res => {
	const s = net.connect({ port, host });
	s.once("connect", () => { s.destroy(); res(true); });
	s.once("error", () => res(false));
	s.setTimeout(1000, () => { s.destroy(); res(false); });
}))).then(r => r.some(Boolean));

// 口を握っている者（lsof があれば pid と cwd＝どの checkout か）。無ければ空＝手掛かりが減るだけ
const holderOf = port => new Promise(res => execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (e, out) => {
	const pid = String(out || "").trim().split("\n")[0];
	if (!pid) return res("");
	execFile("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], (e2, o2) => {
		const dir = /^n(.*)$/m.exec(String(o2 || ""))?.[1];
		res(`（pid ${pid}${dir ? ` cwd ${dir}` : ""}）`);
	});
}));

// vite を起こして「配れる」まで待つ。返り＝止める関数。portEnv＝呼び手の口の環境変数名（エラーで逃がし方を示す）。
// 「応答が返った」だけでは自分の vite とは限らない（2026-09-27：5245 を別 worktree の vite が握っていた＝こちらの vite は
// --strictPort で即死、fetch はよその鯖に通り、別の checkout の頁を検定して no-title）。だから
//   ・起こす前に口が空いているかを見る（塞がっていれば握り主を名指しして止まる）
//   ・自分の vite が "ready in" を刻むまで準備完了と見なさない（--strictPort＝この口で立った証し。同時起動の競り負けも拾う）
//   ・起動前に落ちたら出力の末尾を添えて止まる
export async function startVite({ cwd, port, readyUrl, env = null, portEnv = "", args = [] }) {   // args＝vite へ足す引数（例：["--config", 別の設定]）
	const hint = `＝よその鯖に繋ぐと別の checkout を検定してしまう。握り主を止めるか、${portEnv || "呼び手の *_PORT"}=<空き port> で逃がす`;
	if (await portTaken(port)) throw new Error(`port ${port} が既に使われている${await holderOf(port)}${hint}`);
	const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
	let log = "", ready = false, gone = "";
	const eat = b => { log = (log + b).slice(-4000); ready ||= /ready in/.test(log); };   // 読み続ける＝pipe を詰まらせない（中身は捨てる）
	vite.stdout.on("data", eat); vite.stderr.on("data", eat);
	vite.once("exit", (code, sig) => { gone ||= sig || `exit ${code}`; });
	vite.once("error", e => { gone ||= e.message; });
	process.on("exit", () => vite.kill());
	const tail = () => log.trim().split("\n").slice(-6).map(l => "  | " + l).join("\n");
	for (let i = 0; ; i++) {
		if (gone) throw new Error(`vite が立つ前に落ちた（${gone}・port ${port}${await holderOf(port)}）${hint}\n${tail()}`);
		if (ready) { try { await fetch(readyUrl); break; } catch { /* まだ＝接続できない。応答さえ返れば（404 でも）器は立っている */ } }
		if (i > 60) { vite.kill(); throw new Error(`vite が起動しない（port ${port}・${ready ? "ready は刻んだが応答しない" : "ready を刻まない"}）\n${tail()}`); }
		await sleep(250);
	}
	return () => vite.kill();
}

// 実時間 1 頁＝1 Chrome（別ポート＝Chrome が選ぶ・別プロファイル・kill の exit を待つ）。呼び手の cdpBase は旧来の名残＝無視。戻り＝document.title（PASS…／FAIL…）。
// drag:true＝ページが window.__dragGo を立てている間だけ実マウスの pointermove を流す（入力→rAF のフレーム内順序は
// setTimeout から __cam() を叩く方式では再現できない＝実機と違う結果になる・2026-09-03 実測）。
// backends：配列を渡すと globe.js の起動ログ "[boot] frame1 received backend=…" の値を積む（runPages の backend 検め・T1）。
// worlds：配列を渡すと起動ログ "[geo] world=…" から "ellipsoid"／"sphere" を積む（runPages の世界の検め・#43 段 0）。
export async function runRealtime(url, { limitS = 60, profilePrefix = "oj-vui", seq = 1, flags = SWIFTSHADER, drag = false, shot = null, backends = null, worlds = null } = {}) {
	// Chrome の起動・タブ・WebSocket は cdp.mjs（port は Chrome が選ぶ・頁ごとに別プロファイル・kill の exit を待つ）
	let ch = null;
	try {
		try { ch = await launchChrome({ flags, profilePrefix, seq }); } catch (e) { return "FAIL " + e.message; }
		let target;
		try { target = await newTab(ch.port); } catch (e) { return "FAIL chrome: " + e.message; }
		const cdp = await connect(target.webSocketDebuggerUrl);
		const send = (m, p = {}) => cdp.send(m, p);   // 結果（時間切れ 5 秒・切断は null）
		if (backends || worlds) cdp.on(m => {
			if (m.method !== "Runtime.consoleAPICalled") return;
			const line = m.params?.args?.[0]?.value || "";
			const b = /^\[boot\] frame1 received backend=(\w+)/.exec(line)?.[1];
			if (b && backends) backends.push(b);
			const w = /^\[geo\] world=(\S+)/.exec(line)?.[1];
			if (w && worlds) worlds.push(/^WGS84/.test(w) ? "ellipsoid" : "sphere");
		});
		// タブが死ぬ（GPU プロセス落ち・OOM）と WebSocket が閉じ、以後の send は全部 5 秒のタイムアウト＝limitS×2 回で最悪 55 分「固まる」（bench-perf で 2 回実測 2026-09-27）
		// ＝閉じたら即 FAIL・待ちは壁時計 limitS で必ず切る
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
		const tWall = Date.now();
		while (!/^(PASS|FAIL)/.test(title)) {
			if (cdp.dead()) { title = "FAIL chrome: WebSocket closed（タブが死んだ＝GPU プロセス落ち/OOM の疑い）"; break; }
			if (Date.now() - tWall > limitS * 1000) break;   // 壁時計で切る（send のタイムアウトが積み重なっても limitS 秒で出る）
			await sleep(500);
			title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
		}
		if (shot) { const r = await send("Page.captureScreenshot", { format: "png" }); if (r?.data) (await import("node:fs")).writeFileSync(shot, Buffer.from(r.data, "base64")); }
		cdp.close();
		return /^(PASS|FAIL)/.test(title) ? title : `FAIL no-title(realtime ${limitS}s): ` + title;
	} catch (e) {
		return "FAIL chrome: " + String(e?.message || e).slice(0, 120);
	} finally {
		if (ch) await ch.close();
	}
}

// 仮想時間＝CDP で仮想時計を刻む（2026-10-03・関門の最適化 段 3）。
// 旧＝`--virtual-time-budget=75000 --dump-dom`（budget を使い切ってから <title> を読む）。クラウドの Chromium（Playwright 1194）では
//   vite の worker の script（?worker_file）の取得が「未完の fetch」として残り、仮想時計が止まったまま budget が尽きず、90 秒の timeout で
//   no-title＝japan の verify:ui で main でも 7 頁が落ちていた（2026-10-03 実測）。dump-dom は表題が PASS に変わっても budget の終わりまで待つ＝遅い。
// ここは
//   ・policy "advance" で STEP ms ずつ budget を与える＝未完の fetch があっても時計は進む。ただし刻む前に**自分で**網の静けさを待つ
//     （Network の requestWillBeSent／loadingFinished を頁と worker の全 session で数え、飛んでいる要求が無くなるまで・最長 IDLE ms）
//     ＝iframe・JSON・タイルの到着は実時間で待ち、頁の timer/rAF は仮想時計で一気に進む（旧と同じ 75 秒ぶんまで）。
//     ?worker_file の要求は Chrome が「終わった」と言わない（上の轍）＝数えない。外の鯖へ出て返らない要求は IDLE ms で見切る。
//   ・表題が PASS/FAIL になった瞬間に返す（budget の残りは待たない）＝t-opts 4 秒・t-demo 10〜60 秒（旧＝頁ごとに 90 秒）
//   ・壁時計 limitS で必ず切る（刻みが進まない・タブが死んだ時）。旧の dump-dom は VG_VIRTUAL=dump で残す（比べる時に）
// 旗は旧と同じ（ソフトウェア GL）。頁ごとに別プロファイル・kill の exit 待ちは cdp.mjs の作法のまま。
const VIRTUAL_BUDGET_MS = 75000, VIRTUAL_STEP_MS = +process.env.VG_VSTEP || 500, VIRTUAL_IDLE_MS = +process.env.VG_VIDLE || 1500;
const runVirtualDump = url => new Promise(res => execFile(CHROME,
	["--headless=new", ...SWIFTSHADER, "--virtual-time-budget=" + VIRTUAL_BUDGET_MS, "--dump-dom", url],
	{ timeout: 90000, maxBuffer: 64 * 1024 * 1024 },
	(e, out) => res(e && !out ? `FAIL chrome: ${e.message}` : (String(out).match(/<title>([^<]*)<\/title>/) || [, "FAIL no-title"])[1])));
export async function runVirtual(url, { limitS = 90, profilePrefix = "oe-virt", seq = 1 } = {}) {
	if (process.env.VG_VIRTUAL === "dump") return runVirtualDump(url);
	let ch = null;
	try {
		try { ch = await launchChrome({ flags: SWIFTSHADER, profilePrefix, seq }); } catch (e) { return "FAIL " + e.message; }
		let target;
		try { target = await newTab(ch.port); } catch (e) { return "FAIL chrome: " + e.message; }
		const cdp = await connect(ch.browserWs);   // browser の WebSocket＝flat session で頁にも worker にも話せる
		const { sessionId: page } = await cdp.call("Target.attachToTarget", { targetId: target.id, flatten: true });
		let expired = 0;
		const pending = new Map();   // requestId → url（頁・worker の全 session）
		cdp.on(m => {
			if (m.method === "Emulation.virtualTimeBudgetExpired") expired++;
			else if (m.method === "Network.requestWillBeSent") { const r = m.params; if (r.requestId !== r.loaderId && !/[?&]worker_file\b/.test(r.request.url)) pending.set(r.requestId, r.request.url); }   // 主文書（requestId＝loaderId）と vite の worker_file は数えない
			else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") pending.delete(m.params.requestId);
			else if (m.method === "Target.attachedToTarget") { const s = m.params.sessionId; cdp.send("Network.enable", {}, { session: s }); cdp.send("Runtime.runIfWaitingForDebugger", {}, { session: s }); }
		});
		const P = { session: page };
		await cdp.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, P);   // worker の fetch も数える
		await cdp.call("Network.enable", {}, P); await cdp.call("Page.enable", {}, P); await cdp.call("Runtime.enable", {}, P);
		await cdp.call("Emulation.setVirtualTimePolicy", { policy: "pause" }, P);   // 遷移の前に止める＝頁の最初の timer から仮想時計
		await cdp.call("Page.navigate", { url }, P);
		const tWall = Date.now();
		let title = "", used = 0;
		while (used < VIRTUAL_BUDGET_MS) {
			if (cdp.dead()) { title = "FAIL chrome: WebSocket closed（タブが死んだ＝GPU プロセス落ち/OOM の疑い）"; break; }
			if (Date.now() - tWall > limitS * 1000) { title = `FAIL no-title(virtual ${limitS}s・${used / 1000}s 進めた): ` + title; break; }
			const tIdle = Date.now();
			while (pending.size && Date.now() - tIdle < VIRTUAL_IDLE_MS) await sleep(10);   // 網が静まるのを待つ（返らない要求は見切る）
			const want = expired + 1;
			await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: VIRTUAL_STEP_MS }, P);
			const tStep = Date.now();
			while (expired < want && !cdp.dead() && Date.now() - tStep < 5000) await sleep(5);   // 刻みが尽きるのを待つ（5 秒で諦めて次へ＝重い刻みでも止まらない）
			used += VIRTUAL_STEP_MS;
			title = (await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, { session: page, timeoutMs: 2000 }))?.result?.value || "";
			if (/^(PASS|FAIL)/.test(title)) break;
		}
		if (!/^(PASS|FAIL)/.test(title)) title = `FAIL no-title(virtual ${VIRTUAL_BUDGET_MS / 1000}s): ` + title;
		cdp.close();
		return title;
	} catch (e) {
		return "FAIL chrome: " + String(e?.message || e).slice(0, 120);
	} finally {
		if (ch) await ch.close();
	}
}

// 頁の列を回して PASS/FAIL を出す。urlOf(page,query) は呼ぶ側の器が決める。
// jobs＝同時に回す頁の数（既定＝環境変数 VG_JOBS か 1）。頁ごとに別の Chrome・別プロファイル・Chrome が選ぶ CDP の口＝並べても互いに漏れない。
//   serial＝並べると負荷で揺れる頁（色の標本・時間の測り）＝並べた分が終わってから 1 本ずつ回す（検定は緩めない）。
//   出力は頁の並び順のまま（終わった順ではない）・各行に掛かった秒数・最後に壁時計と遅い頁。
// base＝全頁に付ける既定の query。既定の gl2=1 は SwiftShader の門（verify-ui・nocoi）向け＝WebGPU の門は "lang=ja" を渡す。
// expectBackend＝"webgpu" を渡すと実時間の頁で backend を検める（T1・2026-09-25。旧＝runner が全頁に gl2=1 を付けており、
//   verify:webgpu の createGlobe/app.js 頁の多くが黙って WebGL2 で走っていた＝WebGPU 経路の回帰を見ていなかった）：
//   ・gl2=1 の無い頁は起動ログの backend が全部 webgpu、gl2=1 の頁は全部 webgl2（GL2 変種が本当に GL2 かも見る）
//   ・noBoot の頁（地球儀を起こさない＝createRenderer 直叩き・OPFS 等）は起動ログを求めない
//   ・どの頁も表題に skip／スキップ（WebGPU 不在で素通りする印）があれば FAIL
export async function runPages({ pages, urlOf, realtime, long = {}, pad = 14, flags, drag = false, profilePrefix, shotLast = process.env.SHOT || null,
	base = "gl2=1&lang=ja", expectBackend = null, noBoot = new Set(), jobs = +process.env.VG_JOBS || 1, serial = new Set() }) {
	let seq = 0;
	const t0 = Date.now();
	const one = async p => {
		const tp = Date.now();
		const [page, extra = ""] = p.split("?");
		const q = new URLSearchParams(base);
		for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);   // 同じ鍵を二度書かない＝頁側の指定が勝つ
		const url = urlOf(page, q.toString());
		const backends = expectBackend && realtime.has(page) ? [] : null;
		// 世界の検め（#43）：頁の URL に ell= があれば、起動ログの世界（[geo] world=）が全部それに合うこと。頁の中で読み直す頁（t-ellparity?g=cache）は ell を付けない
		const wantWorld = realtime.has(page) && q.has("ell") ? (q.get("ell") === "1" ? "ellipsoid" : "sphere") : null, worlds = wantWorld ? [] : null;
		const opt = { limitS: long[page] ?? 60, seq: ++seq, drag, backends, worlds, ...(flags ? { flags } : {}), ...(profilePrefix ? { profilePrefix } : {}), shot: (shotLast && p === pages[pages.length - 1]) ? shotLast : null };
		let title = realtime.has(page) ? await runRealtime(url, opt) : await runVirtual(url, { limitS: long[page] ?? 90, seq: opt.seq, ...(profilePrefix ? { profilePrefix: profilePrefix + "-v" } : {}) });
		if (backends && title.startsWith("PASS")) {
			const want = q.get("gl2") === "1" ? "webgl2" : expectBackend;
			const seen = [...new Set(backends)].join("+") || "なし";
			if (/skip|スキップ/i.test(title)) title = `FAIL 素通り（backend=${seen}）: ` + title.replace(/^PASS ?/, "");
			else if (!noBoot.has(page) && (!backends.length || backends.some(b => b !== want))) title = `FAIL backend=${seen}（期待 ${want}）: ` + title.replace(/^PASS ?/, "");
			else if (backends.length) title = title.replace(/^PASS ?/, `PASS [${seen}] `);
		}
		if (worlds && title.startsWith("PASS")) {
			const seen = [...new Set(worlds)].join("+") || "なし";
			if (!worlds.length || worlds.some(w => w !== wantWorld)) title = `FAIL world=${seen}（期待 ${wantWorld}）: ` + title.replace(/^PASS ?/, "");
			else title = title.replace(/^PASS ?/, `PASS [${seen}] `);
		}
		return { title, s: (Date.now() - tp) / 1000 };
	};
	// 並べる頁と 1 本ずつの頁に分け、結果は元の並びの番号で持つ＝出力は並び順（前の頁が終わるまで次の行は出さない）
	const res = new Array(pages.length);
	let printed = 0, fail = 0;
	const flush = () => {
		while (printed < pages.length && res[printed]) {
			const p = pages[printed], { title, s } = res[printed++], pass = title.startsWith("PASS");
			if (!pass) fail++;
			console.log(`${pass ? "PASS" : "FAIL"}  ${p.padEnd(pad)} ${title.replace(/^(PASS|FAIL) ?/, "")}  〔${s.toFixed(1)}s〕`);
		}
	};
	const isSerial = p => serial.has(p) || serial.has(p.split("?")[0]);
	const N0 = Math.max(1, jobs | 0);
	// 並べる頁は長い物から始める（上限秒 long を目安に・同じなら元の並び）＝最後に長い頁が 1 本だけ走って待つ尻尾を短くする
	const limitOf = i => long[pages[i].split("?")[0]] ?? 60;
	const par = pages.map((p, i) => i).filter(i => !isSerial(pages[i])).sort((a, b) => N0 > 1 ? limitOf(b) - limitOf(a) || a - b : a - b), ser = pages.map((p, i) => i).filter(i => isSerial(pages[i]));
	const N = Math.max(1, Math.min(N0, par.length || 1));
	if (N > 1) console.log(`（${N} 本ずつ並べる・${ser.length ? `並べない頁 ${ser.length} 本は後で 1 本ずつ` : "並べない頁なし"}）`);
	let k = 0;
	await Promise.all(Array.from({ length: N }, async () => { while (k < par.length) { const i = par[k++]; res[i] = await one(pages[i]); flush(); } }));
	for (const i of ser) { res[i] = await one(pages[i]); flush(); }
	flush();
	const slow = pages.map((p, i) => [p, res[i].s]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, s]) => `${p} ${s.toFixed(0)}s`).join("・");
	console.log(`\n壁時計 ${((Date.now() - t0) / 60000).toFixed(1)} 分（${N} 本ずつ）・遅い頁：${slow}`);
	console.log(fail ? `\n✗ ${fail}/${pages.length} ページ失敗` : `\n✓ 全${pages.length}ページ PASS`);
	return fail;
}
