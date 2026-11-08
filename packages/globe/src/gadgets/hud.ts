// ガジェット：状態盤HUD（?hud=1／?hud=0）。左上スタックの「計測器」ボタンで右下（出典の上）の状態テーブルを開閉する。
// 用途＝実機で「落ちる」の切り分け＝どの端末が（Device：navigator の RAM/コア/DPR/回線/UA）、どう描いていて（Render：
// backend が WebGPU か WebGL2 か・FPS・frame ms・動的解像度）、メモリのどこが太って落ちたか（Memory 台帳：合計/ピーク/予算残・
// 過渡＝コールド落ちの主役）を一望する。数値は app.js が注入する snapshot() から取る＝この層はレイアウトと更新だけ（三戒：独立/抽象アクセス）。
// 本体は hud= 指定時だけ import される（app.js 側で遅延）＝通常ユーザーの初期バンドルには乗らない。
import { gadgetStack } from "./stack.ts";
import type { GlobeMap } from "../types/map.ts";

/** 状態の写し（globe.js の hudSnapshot が組む・数値の単位はバイト／ms） */
export interface HudSnapshot {
	device?: { dpr?: number; ua?: string; ram?: number; cores?: number; vw?: number; vh?: number; net?: string; down?: number };
	budget: number; peak: number; total: number; backend?: string | null; gpuName?: string | null;
	fps?: number | null; frameMs?: number; res?: number; shed?: number; lite?: boolean;
	/** 建物メッシュの束の描画（直近フレーム・render worker）：総数／描いた／視野外／LOD 0／伏せた区・三角形・前パス・輪郭・間引きの下限高さ m */
	meshDraw?: { of: number; drawn: number; cull: number; lod0: number; hidden: number; tris: number; pre: number; sil: number; shed: number; fs?: number } | null;
	/** render worker の JS 時間（描いたフレームの部位別 EMA・ms）と窓内の最長 */
	cpu?: { up: number; terr: number; map: number; gint: number; lab: number; ov: number; total: number; max: number } | null;
	/** 注記（labels2d）の直近の描画：draw 全体の EMA・衝突判定・描いた注記と字の数 */
	lab?: { ms: number; collideMs: number; labels: number; glyphs: number; baked?: number; restored?: number } | null;   // baked／restored＝この起動で焼いた字・保存（?glyphdb=1）から写した字
	/** 起動の時間割（頁の起点からの ms・1 行）＝globe.ts の bootReport */
	boot?: string | null;
	/** main スレッドの rAF 間隔（EMA と窓内の最長・ms） */
	main?: { ms: number; max: number; long?: Array<{ key: string; ms: number; n: number }> } | null;
	shadow?: { active: boolean; gpuMs?: number; halfM?: number; N?: number; texelM: number; terrTris?: number; bldTris?: number; meshBatches?: number; meshTris?: number; passes?: number; skipped?: number } | null;
	vt?: { shown: number; bytes: number; rttMs: number; decodeMs: number; buildMs: number; mergeMs: number; pending?: boolean; fsMs?: number | null } | null;
	/** 基図タイルの計器 e（必要→画面・主層のみ）の分位 [med, p90, max]（ms）と main merge の要求→着地（ms・-1＝未着）＝copy 30s log の行 */
	tileLat?: { all: TileLatQ; recent: TileLatQ; merges: Array<{ n: number; reqAt: number; ms: number }> } | null;
	/** 最初の idle がまだ来ていないとき、塞いでいる材料の名前（globe.ts idleBlockers）。null＝idle 済み */
	idleBlock?: string[] | null;
	/** 最初の idle までに塞いだ材料の時間加重の帳（"cover 3.1 s" …・main が止まっていた分は "main stalled"）と、最初の idle の時刻（ms since navigation・null＝まだ） */
	idleHist?: string[]; idleAt?: number | null;
	/** render worker の遅いフレーム（>300 ms・最初の 12 枚・ms since navigation・部位別 ms・そのフレームで頼んだパイプライン）と frame1 の後に作ったパイプライン（globe.ts wslow） */
	wslow?: { frames: Array<{ at: number; ms: number; up: number; terr: number; map: number; gint: number; lab: number; ov: number; pipes: string[] }>; pipes: Array<{ label: string; ms: number; at: number }> } | null;
	/** 建物メッシュの時間割（ms since navigation）：main（wake/manager/catalog/spawn）・区ごとの段・render worker の受け口（globe.ts meshTlSnap） */
	meshTl?: { main: Array<[string, number, string]>; wards: Array<{ name: string; ev: Array<[string, number, string]> }>; rx: { n: number; firstRecv: number; applied: number; firstApply: number; acked: number; lastAck: number; pumpMs: number; inbox: number; applyMs?: number; applyMax?: number; applyMaxAt?: number; applyMaxKey?: string; applyMaxBytes?: number; applySlow?: number; applyBytes?: number; inFrame?: number; inTimer?: number; starveMs?: number } | null } | null;
	tiles: { bytes: number; budget: number }; terrain: number; mesh?: { bytes: number; regions: number } | null;
	heap?: number | null; gpuBytes?: number | null; gpu?: { atlas: number; mesh: number; msaa: number; pool?: number } | null; raster?: number | null;
	transient: { bytes: number; cache: number; live: number };
	tier?: { active: number; residentGB: number; workers: number } | null;
}
export interface TileLatQ { n: number; total: [number, number, number]; ready: [number, number, number]; wait: [number, number, number]; fetch: [number, number, number]; build: [number, number, number] }
/** HUD の手綱 */
export interface HudHandle { open(): void; close(): void; toggle(): void; el: HTMLDivElement }

const mb = (b: number) => (b / 1048576).toFixed(0);                                   // バイト→MB（整数）
const esc = (s: unknown) => String(s).replace(/[<&]/g, c => (c === "<" ? "&lt;" : "&amp;"));   // 畳んだ値を innerHTML へ入れる前の最小サニタイズ

// navigator.userAgent から OS版・ブラウザ版だけを取り出す＝生UAは長すぎ、落ちた端末の識別に要る芯だけ残す（汎用・どのUAでも）。
// {os, browser} で返し、表示側が別行に置く。iOS は実機種がUAに出ない＝OS版で十分。iPad デスクトップ表示は macOS を名乗る既知の穴（実用上許容）。
function deviceInfo(ua: string | undefined): { os: string; browser: string } {
	if (!ua) return { os: "?", browser: "?" };
	let os = "", m: RegExpMatchArray | null;
	if (/iPhone|iPod/.test(ua)) { m = ua.match(/ OS (\d+)/); os = "iOS" + (m ? " " + m[1] : ""); }
	else if (/iPad/.test(ua)) { m = ua.match(/ OS (\d+)/); os = "iPadOS" + (m ? " " + m[1] : ""); }
	else if (/Android/.test(ua)) { m = ua.match(/Android (\d+)/); os = "Android" + (m ? " " + m[1] : ""); }
	else if (/Windows NT/.test(ua)) os = "Windows";
	else if (/Mac OS X/.test(ua)) os = "macOS";
	else if (/CrOS/.test(ua)) os = "ChromeOS";
	else if (/Linux/.test(ua)) os = "Linux";
	let br = "", v: RegExpMatchArray | null;   // Chromium系は Edge/Opera/Samsung を Chrome より先に拾う（いずれも Chrome/ を含むため）。Safari は最後（Chrome UA も Safari/ を持つ）
	if ((v = ua.match(/Edg(?:iOS|A)?\/(\d+)/))) br = "Edge " + v[1];
	else if ((v = ua.match(/OPR\/(\d+)/))) br = "Opera " + v[1];
	else if ((v = ua.match(/SamsungBrowser\/(\d+)/))) br = "Samsung " + v[1];
	else if ((v = ua.match(/Firefox\/(\d+)/))) br = "Firefox " + v[1];
	else if ((v = ua.match(/(?:CriOS|Chrome)\/(\d+)/))) br = "Chrome " + v[1];
	else if ((v = ua.match(/Version\/(\d+)(?:\.[.\d]*)? (?:Mobile\/\w+ )?Safari/))) br = "Safari " + v[1];   // 旧 (\d+)[.\d]*＝数字が二つの量化子に重なる（多項式の後戻り）＝同じ答えの重ならない形
	else if (/Safari/.test(ua)) br = "Safari";
	return { os: os || "?", browser: br || "?" };
}

// GPU名（WebGL RENDERER / WebGPU adapter）も ANGLE ラッパ等で冗長＝実チップ名だけへ畳む。ANGLE は "(vendor, renderer, backend)"＝
// カンマ区切りの中間＝renderer を取り、Direct3D/vs_ps 等の注記を落とす（"Intel(R)" の括弧に釣られない split 方式）。
// 名前の後ろの API の注記（" Direct3D11 vs_5_0 ps_5_0"・" OpenGL ES 3.2" …）から末尾までを落とす＝旧 /\s+(?:Direct3D|OpenGL ES|OpenGL|vs_\d|ps_\d).*$/i と同じ答え。
// 正規表現は空白の連なりで多項式の後戻りをする（CodeQL）＝空白の連なりごとに一度だけ見る走査へ。鍵の英字は大小を問わない（ASCII だけ＝/i と同じ）・# は数字 1 字・鍵から末尾まで改行が無いこと（.*$）
const API_TAIL = ["direct3d", "opengl es", "opengl", "vs_#", "ps_#"];
const isSpace = (c: string) => /\s/.test(c);
const isLineEnd = (c: string) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
const tailAt = (s: string, b: number) => API_TAIL.some(k => {
	if (b + k.length > s.length) return false;
	for (let i = 0; i < k.length; i++) {
		const c = s[b + i], q = k[i];
		if (q === "#" ? !(c >= "0" && c <= "9") : q >= "a" && q <= "z" ? c !== q && c !== q.toUpperCase() : c !== q) return false;
	}
	return true;
});
function stripApiTail(s: string): string {
	for (let i = 0, a = -1; i < s.length; i++) {
		if (isSpace(s[i])) { if (a < 0) a = i; continue; }
		if (a >= 0 && tailAt(s, i)) {
			let j = i;
			while (j < s.length && !isLineEnd(s[j])) j++;
			if (j === s.length) return s.slice(0, a);
		}
		a = -1;
	}
	return s;
}

function gpuLabel(name: string | null | undefined): string {
	if (!name) return "";
	let s = String(name).trim();
	if (s.startsWith("ANGLE (") && s.endsWith(")")) {
		const parts = s.slice(7, -1).split(", ");
		s = parts.length >= 3 ? parts.slice(1, -1).join(", ") : parts.join(", ");   // vendor と backend を落として renderer だけ
	}
	s = stripApiTail(s.replace(/ANGLE \w+ Renderer:\s*/i, "")).trim();
	return s.length > 42 ? s.slice(0, 41) + "…" : s;
}

/** 状態盤 HUD（snapshot＝状態の写しの口・open:false＝畳んで搭載）。データ源が無い・二重搭載は undefined */
export function hud(this: GlobeMap, opts: { snapshot?: () => HudSnapshot | null; open?: boolean; signal?: AbortSignal } = {}): HudHandle | undefined {
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
	// 表（500ms ごとに描き直す）とコピーのボタン（描き直さない＝押せる）を分ける
	const tbl = document.createElement("div");
	const copyBtn = document.createElement("button");
	copyBtn.type = "button"; copyBtn.className = "hud-copy"; copyBtn.textContent = "copy 30s log";
	panel.append(tbl, copyBtn);
	mapEl.append(panel);

	// #attr（出典）の実高さぶん持ち上げる＝行数（言語/画面幅）が変わっても常に出典の上に載る。無ければ下辺から少しだけ浮かす。
	const place = () => { const a = mapEl.querySelector<HTMLElement>("#attr"); panel.style.bottom = `calc(${(a ? a.getBoundingClientRect().height : 0) + 12}px + var(--qm-safe-b))`; };
	const roTarget = mapEl.querySelector("#attr");
	const ro = roTarget && typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
	ro && ro.observe(roTarget!);

	const row = (label: string, value: string | number, cls?: string) => `<tr><th>${label}</th><td${cls ? ` class="${cls}"` : ""}>${value}</td></tr>`;
	const sec = (title: string) => `<tr class="sec"><th colspan="2">${title}</th></tr>`;
	const note = (s: string) => ` <span class="note">${s}</span>`;
	const det = (v: string) => `<tr class="det"><td colspan="2">${v}</td></tr>`;   // 内訳を次行の薄い行へ逃がす＝本体行が横に伸びない（GPU/過渡）
	const beName = (b: string | null | undefined) => (b === "webgpu" ? "WebGPU" : b === "webgl2" ? "WebGL2" : "…");

	function render() {
		const s = snapshot!();   // 無ければ上で搭載していない
		if (!s || !s.mesh) return;
		const d: NonNullable<HudSnapshot["device"]> = s.device || {}, dpr = d.dpr || 1, dev = deviceInfo(d.ua);
		const tight = s.budget - s.peak < 150 * 1048576;   // ピークが予算(≈4GB機のタブ枠900MB)まで残 <150MB＝jetsam 圏＝合計を赤で警告
		const beNote = s.backend === "webgl2" && "gpu" in navigator ? note("fallback") : "";   // WebGPU可の環境でGL2＝フォールバック中＝落ち診断の勘所
		const gpu = gpuLabel(s.gpuName);
		const ram = d.ram ? (d.ram >= 8 ? "≥8 GB" : d.ram + " GB") : "n/a";   // navigator.deviceMemory＝搭載メモリ（8で頭打ち・Chrome系のみ・Safari等は n/a）
		record(s);
		tbl.innerHTML = "<table>" +
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
			row("frame", `${(s.frameMs || 0).toFixed(1)} ms` + note(`(×${(s.res ?? 1).toFixed(2)}${(s.shed ?? 0) > 0 ? ` shed ≥${s.shed}m` : ""}${s.lite ? " lite" : ""}${s.meshDraw?.fs ? " fs" : ""})`)) +   // フレーム時間と動的解像度を1行に
			(s.cpu ? row("worker CPU", `${s.cpu.total.toFixed(1)} ms` + note(`max ${s.cpu.max.toFixed(0)}`)) +   // 描画 worker の JS 時間（frame との差＝描画以外の仕事・メッセージ処理など）
				det(`upload ${s.cpu.up.toFixed(1)} · terrain ${s.cpu.terr.toFixed(1)} · map ${s.cpu.map.toFixed(1)} · lines ${s.cpu.gint.toFixed(1)} · labels ${s.cpu.lab.toFixed(1)} · overlays ${s.cpu.ov.toFixed(1)}`) : "") +
			(s.lab ? row("labels", `${(s.lab.ms || 0).toFixed(1)} ms` + note(`collide ${(s.lab.collideMs || 0).toFixed(1)} · ${s.lab.labels || 0} labels · ${s.lab.glyphs || 0} glyphs` + (s.lab.baked != null ? ` · baked ${s.lab.baked} · kept ${s.lab.restored || 0}` : ""))) : "") +   // 注記の描画＝字を焼く時間が入る（起動時・?glyphms= で分ける）
			(s.boot ? det(`boot: ${esc(s.boot)}`) : "") +   // 起動の時間割（頁の起点からの ms）＝どこで秒が消えたか
			(s.main ? row("main thread", `${s.main.ms.toFixed(1)} ms` + note(`max ${s.main.max.toFixed(0)}`)) +
				(s.main.long?.length ? det(s.main.long.map(l => `${l.ms.toFixed(0)} ms ×${l.n} ${esc(l.key)}`).join("<br>")) : "") : "") +   // 直近 15 秒の長い仕事の犯人（関数@ファイル:位置）   // main の rAF 間隔＝カメラを動かす側の詰まり
			(s.shadow ? row("shadow", s.shadow.active ? `${(s.shadow.gpuMs || 0).toFixed(2)} ms` + note(s.shadow.halfM ? `${s.shadow.N}² · ${(s.shadow.halfM * 2 / 1000).toFixed(1)} km · ${s.shadow.texelM.toFixed(1)} m/texel` : "") : "off" + note("(z<13 or sun down)")) +
				(s.shadow.halfM ? det(`casters: terrain ${Math.round(s.shadow.terrTris || 0).toLocaleString()} tris · buildings ${Math.round(s.shadow.bldTris || 0).toLocaleString()} tris · meshes ${s.shadow.meshBatches || 0} (${Math.round(s.shadow.meshTris || 0).toLocaleString()} tris) · passes ${s.shadow.passes} drawn / ${s.shadow.skipped} reused`) : "") : "") +   // 影の深度パス（#112 段 0）＝GPU 時間（描いたパスの EMA）・窓・落とした物・描いた/使い回した回数
			(s.vt ? row("vector layers", `${s.vt.shown} tiles` + note(`${mb(s.vt.bytes)} MB`)) +   // vector の描く層（#109 段 4）＝直近の組み立て（worker の往復＝解読＋組み立て）・結合（CPU）・状態の反映（set/removeFeatureState→描く側へ渡すまで）
				det(`build ${s.vt.rttMs.toFixed(1)} ms (decode ${s.vt.decodeMs.toFixed(1)} · build ${s.vt.buildMs.toFixed(1)}) · merge ${s.vt.mergeMs.toFixed(1)} ms · state→drawn ${s.vt.pending ? "…" : s.vt.fsMs == null ? "–" : s.vt.fsMs.toFixed(0) + " ms"}`) : "") +
			sec("Memory · MB") +
			row("tiles", `${mb(s.tiles.bytes)} / ${mb(s.tiles.budget)}`) +
			row("terrain", mb(s.terrain)) +
			row("CityGML", mb(s.mesh.bytes) + note(s.mesh.regions + " zones")) +   // PLATEAU＝汎用名（CityGML）で。数値の出所は snapshot.mesh
			(s.heap ? row("JS heap", mb(s.heap)) : "") +
			(s.gpuBytes ? row("GPU resident", mb(s.gpuBytes)) + (s.gpu ? det(`atlas ${mb(s.gpu.atlas)} · mesh ${mb(s.gpu.mesh)} · msaa ${mb(s.gpu.msaa)}${s.gpu.pool ? ` · tile pool ${mb(s.gpu.pool)}` : ""}${s.raster ? ` · raster ${mb(s.raster)}` : ""}`) : "") : "") +   // raster＝画像タイル層（テクスチャ＋格子メッシュ）
			row("transient", mb(s.transient.bytes)) + det(`cache ${mb(s.transient.cache)} · loading ${mb(s.transient.live)}`) +
			row("total", mb(s.total) + note(`peak ${mb(s.peak)} (+ Draco)`), tight ? "val warn" : "val") +   // (+ Draco)＝解凍中間バッファは台帳外＝実ピークはこれより上
			(s.tier ? row("low-mem tier", `${s.tier.active} zones · ${s.tier.residentGB.toFixed(1)}GB · ${s.tier.workers}w`, "warn") : "") +
			"</table>";
	}

	// 記録（2026-11-04）：実機のスクショは撮りにくい＝直近 30 秒の数字を 1 秒ごとに溜め、ボタンで文字としてクリップボードへ（チャットに貼る用）
	const LOG_S = 30, log: string[] = [];
	let lastRec = 0, lastSnap: HudSnapshot | null = null;
	function record(s: HudSnapshot): void {
		lastSnap = s;
		const now = performance.now(); if (now - lastRec < 950) return; lastRec = now;
		const c = s.cpu, m = s.main;
		log.push(`${new Date().toISOString().slice(11, 19)} fps ${s.fps ?? "-"} frame ${(s.frameMs || 0).toFixed(0)} res ${(s.res ?? 1).toFixed(2)} shed ${s.shed ?? 0}m${s.lite ? " lite" : ""}${s.meshDraw?.fs ? " fs" : ""} mesh ${s.meshDraw ? `${s.meshDraw.drawn}/${s.meshDraw.of} (cull ${s.meshDraw.cull} lod0 ${s.meshDraw.lod0}) ${(s.meshDraw.tris / 1e6).toFixed(2)}Mtri${s.meshDraw.pre ? ` pre ${s.meshDraw.pre}` : ""}${s.meshDraw.sil ? ` sil ${s.meshDraw.sil}` : ""}` : "-"} wcpu ${c ? c.total.toFixed(1) : "-"} (up ${c ? c.up.toFixed(1) : "-"} terr ${c ? c.terr.toFixed(1) : "-"} map ${c ? c.map.toFixed(1) : "-"} gint ${c ? c.gint.toFixed(1) : "-"} lab ${c ? c.lab.toFixed(1) : "-"} ov ${c ? c.ov.toFixed(1) : "-"}) main ${m ? m.ms.toFixed(0) + "/" + m.max.toFixed(0) : "-"} tiles ${mb(s.tiles.bytes)}/${mb(s.tiles.budget)} city ${s.mesh ? mb(s.mesh.bytes) + "/" + s.mesh.regions + "z" : "-"} gpu ${s.gpuBytes ? mb(s.gpuBytes) : "-"} total ${mb(s.total)}`);
		if (log.length > LOG_S) log.shift();
	}
	function logText(): string {
		const s = lastSnap, d = s?.device || {}, dev = deviceInfo(d.ua);
		const head = [`hud log ${new Date().toISOString()} ${location.href}`,
			`device ${dev.os} / ${dev.browser} / RAM ${d.ram ?? "?"} / cores ${d.cores ?? "?"} / GPU ${gpuLabel(s?.gpuName) || "?"} / ${d.vw}x${d.vh}@${d.dpr ?? 1} / backend ${s?.backend ?? "?"}${s?.tier ? ` / low-mem ${s.tier.active}z` : ""}`];
		const boot = s?.boot ? [`boot (ms since navigation): ${s.boot}`] : [];
		const hist = bootHistLines();   // 直近の起動の boot 行（globe.ts bootHistSave・?hud 無しの起動も含む）＝1 本のログで決めない
		const long = s?.main?.long?.length ? ["main long (15s):", ...s.main.long.map(l => `  ${l.ms.toFixed(0)} ms x${l.n} ${l.key}`)] : [];
		const ih = s?.idleHist?.length ? ` · blocked before that by: ${s.idleHist.join(" · ")}` : "";
		const idle = s?.idleBlock ? [`idle: not reached yet — blocked by: ${s.idleBlock.join(" · ") || "(nothing — waiting the 100 ms of quiet)"}${ih}`] : s?.idleAt != null ? [`idle: reached at ${(s.idleAt / 1000).toFixed(1)} s${ih}`] : [];   // present の検証が frame1+8 s の予備タイマーに落ちる原因
		return [...head, ...boot, ...hist, ...log, ...long, ...slowLines(s?.wslow), ...tileLatLines(s?.tileLat), ...meshTlLines(s?.meshTl), ...idle].join("\n");
	}
	// render worker の遅いフレーム：部位別（up/terr/map/gint/lab/ov・残り＝other＝部位の外＝submit 等の GPU 待ち）と、そのフレームで頼んだパイプライン＝
	// 「frame1 の後に 4〜5 s 止まる」が lab の中（字のパイプライン・字の焼き）か、GPU プロセスのコンパイル待ちかを 1 本のログで切り分ける（2026-11-07 Galaxy）
	function slowLines(w: HudSnapshot["wslow"]): string[] {
		if (!w || (!w.frames.length && !w.pipes.length)) return [];
		const sec = (ms: number) => (ms / 1000).toFixed(1);
		const out: string[] = [];
		if (w.frames.length) {
			out.push("worker slow frames (>300 ms, first 12; part ms · other = outside the parts = GPU wait):");
			for (const f of w.frames) { const other = f.ms - (f.up + f.terr + f.map + f.gint + f.lab + f.ov); out.push(`  @${sec(f.at)} s ${f.ms.toFixed(0)} ms (up ${f.up.toFixed(0)} · terr ${f.terr.toFixed(0)} · map ${f.map.toFixed(0)} · gint ${f.gint.toFixed(0)} · lab ${f.lab.toFixed(0)} · ov ${f.ov.toFixed(0)} · other ${other.toFixed(0)})${f.pipes.length ? ` · pipelines made in this frame: ${f.pipes.join(", ")}` : ""}`); }
		}
		out.push(`pipelines made after frame1: ${w.pipes.length}${w.pipes.length ? " · " + w.pipes.map(e => `${e.label} @${sec(e.at)} s${e.ms >= 1 ? ` ${e.ms.toFixed(0)} ms` : ""}`).join(" · ") : ""}`);
		return out;
	}
	// 建物メッシュの時間割：起こす→登録簿→worker→区の段（start/recv/fs/meta/…/done/ack）→render worker の受け口（受けた・当てた・ack・pump）＝idle を塞ぐ 6〜11 s がどの段で消えるか（2026-11-06 Galaxy）
	function meshTlLines(m: HudSnapshot["meshTl"]): string[] {
		if (!m || (!m.main.length && !m.wards.length)) return [];
		const sec = (ms: number) => (ms / 1000).toFixed(1);
		const ev = (a: Array<[string, number, string]>) => a.map(([e, t, x]) => `${e} ${sec(t)}${x ? ` (${x})` : ""}`).join(" · ");
		const out = ["mesh timeline (s since navigation):", `  ${ev(m.main) || "(not woken)"}`];
		for (const w of m.wards) out.push(`  ${w.name}: ${ev(w.ev)}`);
		const r = m.rx;
		if (r && r.n) out.push(`  render: ${r.n} pieces received (first ${sec(r.firstRecv)}) · ${r.applied} applied (first ${sec(r.firstApply)}) · ${r.acked} acked (last ${sec(r.lastAck)}) · pump ${sec(r.pumpMs)} s · inbox ${r.inbox}`);
		if (r && r.applied) out.push(`  render apply: set() ${sec(r.applyMs || 0)} s total · max ${Math.round(r.applyMax || 0)} ms${r.applyMaxAt ? ` @${sec(r.applyMaxAt)} s (${r.applyMaxKey || "?"} · ${((r.applyMaxBytes || 0) / 1048576).toFixed(1)} MB)` : ""} · >100 ms ×${r.applySlow || 0} · ${((r.applyBytes || 0) / 1048576).toFixed(0)} MB · drained in ${r.inFrame || 0} frames + ${r.inTimer || 0} timer ticks · starved (inbox empty, waiting for sender) ${sec(r.starveMs || 0)} s`);
		return out;
	}
	// 基図タイルの計器 e（必要→画面）と main merge（要求→着地）：タイルが揃った後の沈黙が「取得／組み立て／キュー待ち／結合待ち」のどれかを 1 本のログで切り分ける（2026-11-06）
	function tileLatLines(t: HudSnapshot["tileLat"]): string[] {
		if (!t || (!t.all.n && !t.merges.length)) return [];
		const tri = (v: [number, number, number]) => `${v[0].toFixed(0)}/${v[1].toFixed(0)}/${v[2].toFixed(0)}`;
		const row = (name: string, qv: TileLatQ) => `  ${name}: ${qv.n} tiles · need→screen ${tri(qv.total)} · need→built ${tri(qv.ready)} · wait ${tri(qv.wait)} · fetch ${tri(qv.fetch)} · build ${tri(qv.build)}`;
		return ["basemap tiles (ms, med/p90/max; wait = queue + transfer outside the worker):", row("since boot", t.all), row("last 15 s", t.recent),
			`  main merges (req→ack ms, oldest first): ${t.merges.map(m => `${m.n} tiles @${(m.reqAt / 1000).toFixed(1)}s ${m.ms < 0 ? "pending" : m.ms + " ms"}`).join(" · ") || "none"}`];
	}
	// 起動の履歴（localStorage oj.boothist）：この起動を含む直近 10 回・古い順。gap＝前の起動からの分（大きい＝冷えた端末）。q＝その起動の URL の ?以降
	function bootHistLines(): string[] {
		try {
			const a = JSON.parse(localStorage.getItem("oj.boothist") || "[]") as Array<{ at: string; q: string; stage: string; gapMin: number | null; line: string }>;
			if (a.length < 2) return [];
			const gap = (m: number | null) => m == null ? "first" : m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`;
			return [`boot history (last ${a.length} loads, oldest first; gap = since previous load):`, ...a.map(e => `  ${e.at.slice(0, 19)}Z gap ${gap(e.gapMin)} ${e.q || "(no query)"} @${e.stage}: ${e.line}`)];
		} catch { return []; }
	}
	async function copyLog(): Promise<void> {
		const text = logText();
		let ok = false;
		try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 古い口へ */ }
		if (!ok) {
			const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select();
			try { ok = document.execCommand("copy"); } catch { ok = false; }
			ta.remove();
		}
		copyBtn.textContent = ok ? `copied ${log.length}s ✓` : "copy failed";
		setTimeout(() => { copyBtn.textContent = "copy 30s log"; }, 2000);
	}

	let timer: ReturnType<typeof setInterval> | null = null, on = false;
	const start = () => { if (!timer) { render(); timer = setInterval(render, 500); } };
	const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
	const show = () => { on = true; panel.classList.add("on"); panel.setAttribute("aria-hidden", "false"); btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); place(); start(); };
	const hide = () => { on = false; panel.classList.remove("on"); panel.setAttribute("aria-hidden", "true"); btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); stop(); };
	const toggle = () => (on ? hide() : show());

	const stub = new AbortController();   // destroy 時にリスナー・タイマ・ROを一括退場
	btn.addEventListener("click", toggle, { signal: stub.signal });
	copyBtn.addEventListener("click", () => { void copyLog(); }, { signal: stub.signal });
	opts.signal && opts.signal.addEventListener("abort", () => { stub.abort(); stop(); ro && ro.disconnect(); btn.remove(); panel.remove(); }, { once: true });

	if (openInit) show();   // hud=1＝最初から開く（畳むのは計測器ボタン）／hud=0＝ボタンのみ（落ちそうな時にボタンで開く）
	return { open: show, close: hide, toggle, el: panel };
}
