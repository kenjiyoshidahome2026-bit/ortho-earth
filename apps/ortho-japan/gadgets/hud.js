// ガジェット：状態盤HUD（?hud=1／?hud=0）。左上スタックの「計測器」ボタンで右下（出典の上）の状態テーブルを開閉する。
// 用途＝実機で「落ちる」の切り分け＝どの端末が（Device：navigator の RAM/コア/DPR/回線/UA）、どう描いていて（Render：
// backend が WebGPU か WebGL2 か・FPS・frame ms・動的解像度）、メモリのどこが太って落ちたか（Memory 台帳：合計/ピーク/予算残・
// 過渡＝コールド落ちの主役）を一望する。数値は app.js が注入する snapshot() から取る＝この層はレイアウトと更新だけ（三戒：独立/抽象アクセス）。
// 本体は hud= 指定時だけ import される（app.js 側で遅延）＝通常ユーザーの初期バンドルには乗らない。
import { gadgetStack } from "./stack.js";

const mb = b => (b / 1048576).toFixed(0);                                   // バイト→MB（整数）
const esc = s => String(s).replace(/[<&]/g, c => (c === "<" ? "&lt;" : "&amp;"));   // 畳んだ値を innerHTML へ入れる前の最小サニタイズ

// navigator.userAgent から OS版・ブラウザ版だけを取り出す＝生UAは長すぎ、落ちた端末の識別に要る芯だけ残す（汎用・どのUAでも）。
// {os, browser} で返し、表示側が別行に置く。iOS は実機種がUAに出ない＝OS版で十分。iPad デスクトップ表示は macOS を名乗る既知の穴（実用上許容）。
function deviceInfo(ua) {
	if (!ua) return { os: "?", browser: "?" };
	let os = "", m;
	if (/iPhone|iPod/.test(ua)) { m = ua.match(/ OS (\d+)/); os = "iOS" + (m ? " " + m[1] : ""); }
	else if (/iPad/.test(ua)) { m = ua.match(/ OS (\d+)/); os = "iPadOS" + (m ? " " + m[1] : ""); }
	else if (/Android/.test(ua)) { m = ua.match(/Android (\d+)/); os = "Android" + (m ? " " + m[1] : ""); }
	else if (/Windows NT/.test(ua)) os = "Windows";
	else if (/Mac OS X/.test(ua)) os = "macOS";
	else if (/CrOS/.test(ua)) os = "ChromeOS";
	else if (/Linux/.test(ua)) os = "Linux";
	let br = "", v;   // Chromium系は Edge/Opera/Samsung を Chrome より先に拾う（いずれも Chrome/ を含むため）。Safari は最後（Chrome UA も Safari/ を持つ）
	if ((v = ua.match(/Edg(?:iOS|A)?\/(\d+)/))) br = "Edge " + v[1];
	else if ((v = ua.match(/OPR\/(\d+)/))) br = "Opera " + v[1];
	else if ((v = ua.match(/SamsungBrowser\/(\d+)/))) br = "Samsung " + v[1];
	else if ((v = ua.match(/Firefox\/(\d+)/))) br = "Firefox " + v[1];
	else if ((v = ua.match(/(?:CriOS|Chrome)\/(\d+)/))) br = "Chrome " + v[1];
	else if ((v = ua.match(/Version\/(\d+)[.\d]* (?:Mobile\/\w+ )?Safari/))) br = "Safari " + v[1];
	else if (/Safari/.test(ua)) br = "Safari";
	return { os: os || "?", browser: br || "?" };
}

// GPU名（WebGL RENDERER / WebGPU adapter）も ANGLE ラッパ等で冗長＝実チップ名だけへ畳む。ANGLE は "(vendor, renderer, backend)"＝
// カンマ区切りの中間＝renderer を取り、Direct3D/vs_ps 等の注記を落とす（"Intel(R)" の括弧に釣られない split 方式）。
function gpuLabel(name) {
	if (!name) return "";
	let s = String(name).trim();
	if (s.startsWith("ANGLE (") && s.endsWith(")")) {
		const parts = s.slice(7, -1).split(", ");
		s = parts.length >= 3 ? parts.slice(1, -1).join(", ") : parts.join(", ");   // vendor と backend を落として renderer だけ
	}
	s = s.replace(/ANGLE \w+ Renderer:\s*/i, "").replace(/\s+(?:Direct3D|OpenGL ES|OpenGL|vs_\d|ps_\d).*$/i, "").trim();
	return s.length > 42 ? s.slice(0, 41) + "…" : s;
}

export function hud(opts = {}) {
	const mapEl = this.mapEl;
	const snapshot = opts.snapshot;
	if (!snapshot || mapEl.querySelector("#hud-btn")) return;   // データ源なし／二重搭載は無害
	const openInit = opts.open !== false;                       // hud=1（既定）＝最初から開く／hud=0＝ボタンのみ（畳んで搭載）

	// 計測器ボタン（ゲージ＝270°ダイヤル：弧＋5目盛り＋針＋軸）。他ガジェットと同じ 34px 硝子（意匠は quiet-mono #hud-btn）。
	// stroke/fill は #3f4757 直書き＝夜テーマの明インク反転（quiet-mono の属性セレクタ）に乗せる。
	const btn = document.createElement("button");
	btn.id = "hud-btn"; btn.dataset.tip = "Diagnostics HUD";
	btn.setAttribute("aria-label", "Toggle diagnostics HUD"); btn.setAttribute("aria-pressed", "false");
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M6.34 17.66A8 8 0 1 1 17.66 17.66"/>
			<path d="M6.34 17.66l1.28-1.28M4.61 8.94l1.66.69M12 4v1.8M19.39 8.94l-1.66.69M17.66 17.66l-1.28-1.28"/>
			<path d="M12 12 7.82 7.02"/>
			<circle cx="12" cy="12" r="1.4" fill="#3f4757" stroke="none"/></svg>`;
	gadgetStack(mapEl).append(btn);

	// 状態テーブル（右下・出典の上）。既定は display:none（意匠は quiet-mono #hud）。開いた時だけ更新タイマを回す。
	const panel = document.createElement("div");
	panel.id = "hud"; panel.setAttribute("aria-hidden", "true");
	mapEl.append(panel);

	// #attr（出典）の実高さぶん持ち上げる＝行数（言語/画面幅）が変わっても常に出典の上に載る。無ければ下辺から少しだけ浮かす。
	const place = () => { const a = mapEl.querySelector("#attr"); panel.style.bottom = `calc(${(a ? a.getBoundingClientRect().height : 0) + 12}px + var(--qm-safe-b))`; };
	const roTarget = mapEl.querySelector("#attr");
	const ro = roTarget && typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
	ro && ro.observe(roTarget);

	const row = (label, value, cls) => `<tr><th>${label}</th><td${cls ? ` class="${cls}"` : ""}>${value}</td></tr>`;
	const sec = title => `<tr class="sec"><th colspan="2">${title}</th></tr>`;
	const note = s => ` <span class="note">${s}</span>`;
	const det = v => `<tr class="det"><td colspan="2">${v}</td></tr>`;   // 内訳を次行の薄い行へ逃がす＝本体行が横に伸びない（GPU/過渡）
	const beName = b => (b === "webgpu" ? "WebGPU" : b === "webgl2" ? "WebGL2" : "…");

	function render() {
		const s = snapshot();
		if (!s || !s.plateau) return;
		const d = s.device || {}, dpr = d.dpr || 1, dev = deviceInfo(d.ua);
		const tight = s.budget - s.peak < 150 * 1048576;   // ピークが予算(≈4GB機のタブ枠900MB)まで残 <150MB＝jetsam 圏＝合計を赤で警告
		const beNote = s.backend === "webgl2" && "gpu" in navigator ? note("fallback") : "";   // WebGPU可の環境でGL2＝フォールバック中＝落ち診断の勘所
		const gpu = gpuLabel(s.gpuName);
		const ram = d.ram ? (d.ram >= 8 ? "≥8 GB" : d.ram + " GB") : "n/a";   // navigator.deviceMemory＝搭載メモリ（8で頭打ち・Chrome系のみ・Safari等は n/a）
		panel.innerHTML = "<table>" +
			sec("Device") +
			row("OS", esc(dev.os)) +
			row("browser", esc(dev.browser)) +
			row("RAM", ram) +
			row("cores", d.cores || "?") +
			(gpu ? row("GPU", esc(gpu)) : "") +
			row("viewport", `${d.vw}×${d.vh}` + note(`(@${dpr}×)`)) +
			row("network", d.net ? `${d.net}${d.down ? " · " + d.down + " Mbps" : ""}` : "–") +
			sec("Render") +
			row("backend", beName(s.backend) + beNote, "val") +
			row("FPS", s.fps ?? "–") +
			row("frame", `${(s.frameMs || 0).toFixed(1)} ms` + note(`(×${(s.res ?? 1).toFixed(2)})`)) +   // フレーム時間と動的解像度を1行に
			sec("Memory · MB") +
			row("tiles", `${mb(s.tiles.bytes)} / ${mb(s.tiles.budget)}`) +
			row("terrain", mb(s.terrain)) +
			row("CityGML", mb(s.plateau.bytes) + note(s.plateau.regions + " zones")) +   // PLATEAU＝汎用名（CityGML）で。数値の出所は snapshot.plateau のまま
			(s.heap ? row("JS heap", mb(s.heap)) : "") +
			(s.gpuBytes ? row("GPU resident", mb(s.gpuBytes)) + (s.gpu ? det(`atlas ${mb(s.gpu.atlas)} · mesh ${mb(s.gpu.mesh)} · msaa ${mb(s.gpu.msaa)}`) : "") : "") +
			row("transient", mb(s.transient.bytes)) + det(`cache ${mb(s.transient.cache)} · loading ${mb(s.transient.live)}`) +
			row("total", mb(s.total) + note(`peak ${mb(s.peak)} (+ Draco)`), tight ? "val warn" : "val") +   // (+ Draco)＝解凍中間バッファは台帳外＝実ピークはこれより上
			(s.tier ? row("low-mem tier", `${s.tier.active} zones · ${s.tier.residentGB.toFixed(1)}GB · ${s.tier.workers}w`, "warn") : "") +
			"</table>";
	}

	let timer = null, on = false;
	const start = () => { if (!timer) { render(); timer = setInterval(render, 500); } };
	const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
	const show = () => { on = true; panel.classList.add("on"); panel.setAttribute("aria-hidden", "false"); btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); place(); start(); };
	const hide = () => { on = false; panel.classList.remove("on"); panel.setAttribute("aria-hidden", "true"); btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); stop(); };
	const toggle = () => (on ? hide() : show());

	const stub = new AbortController();   // destroy 時にリスナー・タイマ・ROを一括退場
	btn.addEventListener("click", toggle, { signal: stub.signal });
	opts.signal && opts.signal.addEventListener("abort", () => { stub.abort(); stop(); ro && ro.disconnect(); btn.remove(); panel.remove(); }, { once: true });

	if (openInit) show();   // hud=1＝最初から開く（畳むのは計測器ボタン）／hud=0＝ボタンのみ（落ちそうな時にボタンで開く）
	return { open: show, close: hide, toggle, el: panel };
}
