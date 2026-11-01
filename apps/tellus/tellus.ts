// Tellus × ortho-earth の案内板と配線（tellus.html から遅延 import）。
// 「地図をクリック → その地点のシーン一覧 → クリックで地形の上にドレープ → ◀▶（←→）で同じ場所の別日」。
// データの読み口は gadgets/tellus-api.js（stac ガジェットと共用）、ドレープは map.gadget.cog（エンジン側の COG スロット）。
// 見せ方はデータ側（tellus-api の cogOpts）: PALSAR-2 は HH/HV の偽色合成（切替でグレー）・GCOM-C SST はカラーマップ。
// クイックルック（行のサムネイル）は COG の最粗 overview を Range 1〜2 本で描く＝サムネイル API が無くても出せる
//（Tellus の検索応答にサムネイルが無い・AVNIR-2 の thumb.png は署名 URL 要＝どのみち 1 往復）。描けたら IDB に置く＝再訪は無通信。
import { tr, getLang, LANGUAGES } from "@ortho-earth/globe/i18n.js";
import { DATASETS, defaultRange, searchScenes, getScene, cogUrl, cogOpts, renewingFetch, orbitLabel } from "@ortho-earth/globe/gadgets/tellus-api.js";
import { createFootprint } from "@ortho-earth/globe/gadgets/footprint.js";
import { openCog, lonlatTarget } from "geopbf/cog/core";   // クイックルック＝DOM 不要経路（worker 無し・最粗 overview だけ）
import type { Dataset, Scene } from "@ortho-earth/globe/gadgets/tellus-api.js";
import type { FootprintGeometry } from "@ortho-earth/globe/gadgets/footprint.js";
import type { GlobeMap, CogHandle, Bbox } from "@ortho-earth/globe";
// クイックルックの絵（56px 以下・RGBA）と、それを持つ一覧の行（_thumb＝描けた絵・_cv＝今の行の canvas）
type Thumb = { key: string; w: number; h: number; rgba: Uint8ClampedArray };
type Item = Scene & { _thumb?: Thumb; _cv?: HTMLCanvasElement | null };
type Fit = boolean | "small";   // load の fit："small"＝シーンが画面に比べて小さい時だけ寄る

const t = tr();
const DESC: Record<string, string> = { palsar2: "L-band SAR, HH/HV polarisation, ortho-corrected (2016–)", palsar: "L-band SAR on ALOS (2006–2011)", avnir2: "Optical 10 m, true colour (2006–2011)", sst: "SGLI sea surface temperature, 8-day mean, global (2018–)" };

// 案内板の長文（英語キー）＝訳は頁の辞書 i18n/pages/tellus.json（26 言語・tellus.html が startPage の page で足す）
const BACK = [
	"Nothing is pre-tiled. The browser reads Tellus's own <b>Cloud Optimized GeoTIFF</b> (*_webcog.tif) with <b>HTTP Range</b> requests, fetching only what the view needs — a 384 MB scene first appears after a few hundred KB.",
	"Pixels are re-gridded to lon/lat on the fly and <b>draped over terrain (DEM10B)</b>, which is why tilting shows relief.",
	"The PALSAR-2 webcog carries both HH and HV. The default view is a <b>R=HH, G=HV, B=HH−HV</b> false-colour composite (forest green, built-up magenta, water black); a toggle returns to HH grey.",
	"GCOM-C sea surface temperature is one global 8640×4320 float32 GeoTIFF. Values in °C go through a 0–32 °C colour map on the fly. Fetched tiles stay in memory, so stepping ◀▶ back and forth costs no network.",
	"Tellus's API is not reachable from a browser (no CORS, token required), so a tiny relay (Cloudflare Worker) adds the token for search and signed-URL issuance only. Image bytes just pass through it.",
];
const NEXT = [
	"Signed URLs pin CORS to <code>tellusxdp.com</code>. With <code>Access-Control-Allow-Origin: *</code> the browser could read them directly, no relay.",
	"Search responses carry no thumbnails; this page renders them from the COG overviews and keeps them in IndexedDB. A STAC <code>assets.thumbnail</code> would make the first visit instant too.",
	"The Traveler API is already very close to STAC. A <code>/stac</code>-compatible entry point would let any STAC client, not just ortho-earth, query Tellus as-is.",
	"Datasets marked “Tellus environment only” (ASNARO, PALSAR-2 L2.1, …) return 403 from outside. A view-only tier would let them appear here unchanged.",
];

// 見どころ（ワンタップで「その場所・その日付」へ）＝初めて開いた人（Tellus の方々を含む）に、何が見えるかを最初の 1 押しで見せる。
// ids＝並べる順（古い→新しい）。2 枚の見どころは見比べ（左右に分けて境を動かす）で開く。view＝[lon, lat, zoom, 傾き]。シーンは 2026-10-27 に Traveler API で実在と描画を確かめた物。
// 仙台＝AVNIR-2 の同じパス 67・フレーム 2830（震災前 2011-02-23 雲 6.5%／後 2011-04-10 雲 1%）。
// 富士山＝PALSAR-2 2025-10-15 上昇 フレーム 750（山頂が枠の端に掛からない方）。西之島＝2020-09-21 下降（2019–20 噴火の後）。海面水温＝2025 年 2 月と 8 月の下降。
const SHOWS = [
	{ k: "sendai", ds: "avnir2", label: "2011 tsunami, Sendai", note: "AVNIR-2 optical, two weeks before (left) and one month after (right) 11 March 2011. Drag the divider: the farmland behind the coast turns dark where the tsunami flooded it.", ids: ["01c632a6-0085-440b-840f-c2a1a86f6d41", "8af6df5d-0c4a-472c-b73e-706e5f018561"], view: [140.96, 38.21, 11.8, 35] },
	{ k: "fuji", ds: "palsar2", label: "Mt Fuji in radar", note: "PALSAR-2 radar draped on the terrain: it sees through cloud and works at night. Forest is green, towns magenta, lakes black. Drag to tilt.", ids: ["2ee1f996-ae81-4892-882c-703e4ad0b990"], view: [138.73, 35.3, 11.8, 55] },
	{ k: "nishinoshima", ds: "palsar2", label: "Nishinoshima volcano", note: "A volcanic island 940 km south of Tokyo, after its 2019–2020 eruption. Radar sees the island through the ash plume.", ids: ["95e05818-4199-4d51-a2ad-d6dde0e87506"], view: [140.876, 27.247, 13.6, 40] },
	{ k: "sst", ds: "sst", label: "Sea temperature, winter → summer", note: "GCOM-C 8-day mean sea surface temperature, February (left) and August (right) 2025. Drag the divider to watch the warm water spread north.", ids: ["b7526483-b342-491f-bab2-e6dafe0d91f2", "f6fe599f-206a-4d33-880f-3d4c9d55073c"], view: [138, 33, 4.6, 0] },
];

const CSS = `
/* 黒地・白文字（本人指摘 2026-10-14・choju の案内板と同じ色づかい）。板全体が 1 本でスクロール（一覧だけの内側スクロールだと、解説を開くと下が切れて届かなかった） */
#side { font-size: 13px; color: #f1f3f6; background: #0b0d12; border-color: rgba(255,255,255,.14); overflow-y: auto; overscroll-behavior: contain; color-scheme: dark; }
#side .head { display: flex; gap: 8px; align-items: flex-start; padding: 14px 16px 2px; }
#side .head .lang { flex: none; max-width: 110px; font-size: 12px; padding: 2px 4px; margin-top: 2px; background: #1b1f26; color: inherit; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; }
#side h1 { flex: 1; min-width: 0; margin: 0; font-size: 17px; letter-spacing: .01em; color: #fff; }
#side h1 small { display: block; font-size: 11.5px; font-weight: 400; color: rgba(255,255,255,.62); margin-top: 2px; }
#side .shows { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px 16px 0; }
#side .shows > span { color: rgba(255,255,255,.62); font-size: 11.5px; margin-inline-end: 2px; }
#side .show { border: 1px solid rgba(255,255,255,.22); background: #151920; border-radius: 999px; padding: 4px 11px; cursor: pointer; font: inherit; font-size: 12px; color: inherit; }
#side .show.on { border-color: #ffd36a; background: #3a3220; }
#side .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px 16px 0; }
#side .tab { border: 1px solid rgba(255,255,255,.22); background: #151920; border-radius: 9px; padding: 6px 8px; cursor: pointer; font: inherit; color: inherit; text-align: left; line-height: 1.3; min-width: 0; }
#side .tab b { display: block; font-size: 13px; }
#side .tab span { display: block; font-size: 10.5px; color: rgba(255,255,255,.62); }
#side .tab.on { border-color: #fff; background: #2a303b; }
#side .row { display: flex; gap: 6px; align-items: center; padding: 8px 16px 0; flex-wrap: wrap; }
#side .row label { color: rgba(255,255,255,.62); font-size: 11.5px; }
#side .row[hidden] { display: none; }
#side input[type=date] { flex: 1; min-width: 0; font: 12px system-ui; color: inherit; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; padding: 3px 5px; background: #1b1f26; }
#side .seg { border: 1px solid rgba(255,255,255,.22); background: #151920; border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 11.5px; color: inherit; }
#side .seg.on { border-color: #fff; background: #2a303b; }
#side .hint { padding: 8px 16px 0; color: rgba(255,255,255,.62); font-size: 12px; }
#side .status { padding: 6px 16px 0; color: rgba(255,255,255,.5); min-height: 1.4em; font-size: 12px; }
#side .list { flex: none; padding: 4px 10px 6px; }
#side .scene { display: flex; gap: 10px; align-items: center; width: 100%; border: 0; background: none; text-align: left; padding: 6px; border-radius: 10px; cursor: pointer; font: inherit; color: inherit; }
#side .scene:hover { background: rgba(255,255,255,.08); }
#side .scene.on { background: rgba(120,160,255,.22); }
#side .scene canvas { width: 56px; height: 56px; border-radius: 8px; background: #20252e; flex: none; object-fit: cover; }
#side .scene .d { font-weight: 600; }
#side .scene .c { color: rgba(255,255,255,.5); font-size: 11.5px; }
#side .nav { position: sticky; bottom: 0; z-index: 1; display: flex; gap: 6px; align-items: center; padding: 8px 16px; border-top: 1px solid rgba(255,255,255,.12); background: #0b0d12; }
#side .nav button, #side .foot button, #side .share { border: 1px solid rgba(255,255,255,.22); background: #151920; border-radius: 8px; padding: 5px 10px; cursor: pointer; font: inherit; font-size: 12px; color: inherit; }
#side .nav button:disabled { opacity: .4; cursor: default; }
#side .nav .n { flex: 1; text-align: center; color: rgba(255,255,255,.62); font-size: 12px; }
#side .opac { display: flex; gap: 8px; align-items: center; padding: 8px 16px; color: rgba(255,255,255,.62); font-size: 11.5px; }
#side .opac input { flex: 1; }
#side details { border-top: 1px solid rgba(255,255,255,.12); padding: 6px 16px; font-size: 12px; }
#side details summary { cursor: pointer; font-weight: 600; color: #fff; padding: 4px 0; }
#side details ul { margin: 4px 0 6px; padding-inline-start: 18px; color: rgba(255,255,255,.78); }
#side details li { margin: 3px 0; }
#side details b { color: #fff; }
#side details code { font-size: 11px; background: rgba(255,255,255,.1); padding: 1px 4px; border-radius: 4px; }
#side .metrics { font: 11px ui-monospace, Menlo, monospace; color: rgba(255,255,255,.62); padding: 2px 0 4px; }
#side .foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 16px 12px; border-top: 1px solid rgba(255,255,255,.12); color: rgba(255,255,255,.5); font-size: 11px; }
#side .scene.vs { background: rgba(255,211,106,.2); }
#side .nav #tl-cmp.on { border-color: #ffd36a; background: #3a3220; }
.tl-knob { position: absolute; z-index: 5; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 0; cursor: ew-resize; touch-action: none; user-select: none; font: 600 12px system-ui, sans-serif; filter: drop-shadow(0 1px 3px rgba(0,0,0,.5)); }
.tl-knob[hidden] { display: none; }
.tl-load { position: absolute; z-index: 6; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 9px 16px 9px 12px; border-radius: 999px; background: rgba(11,13,18,.86); color: #fff; font: 600 14px system-ui, sans-serif; white-space: nowrap; pointer-events: none; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
.tl-load[hidden] { display: none; }
.tl-load i { width: 18px; height: 18px; border: 3px solid rgba(255,255,255,.25); border-top-color: #ffd36a; border-radius: 50%; animation: tl-spin .8s linear infinite; }
@keyframes tl-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tl-load i { animation-duration: 2.4s; } }
.tl-knob span { padding: 4px 8px; color: #fff; white-space: nowrap; }
.tl-knob .l { background: rgba(70,110,220,.92); border-radius: 999px 0 0 999px; }
.tl-knob .r { background: rgba(190,140,20,.95); border-radius: 0 999px 999px 0; }
.tl-knob b { width: 30px; height: 30px; margin: 0 -4px; border-radius: 50%; background: #fff; color: #0b0d12; display: grid; place-items: center; z-index: 1; font-size: 13px; }
#side .toast { position: sticky; bottom: 56px; margin: 0 auto; width: max-content; max-width: 90%; background: #fff; color: #0b0d12; border-radius: 8px; padding: 6px 12px; font-size: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; }
#side .toast.on { opacity: 1; }`;

// クイックルックの置き場（IDB・鍵＝データセット/シーン/見せ方・値＝{w,h,rgba}＝56×56×4 以下）。失敗は全て null＝無かったことに
const quickDb = (() => {
	let p: Promise<IDBDatabase> | null = null;
	const open = () => p ??= new Promise<IDBDatabase>((res, rej) => {
		if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
		const rq = indexedDB.open("tellus-quicklook", 1);
		rq.onupgradeneeded = () => rq.result.createObjectStore("q");
		rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
	});
	const run = async (mode: IDBTransactionMode, f: (st: IDBObjectStore) => IDBRequest) => { try { const db = await open(); return await new Promise<any>((res, rej) => { const r = f(db.transaction("q", mode).objectStore("q")); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); } catch { return null; } };
	return { get: (k: string) => run("readonly", st => st.get(k)), set: (k: string, v: unknown) => run("readwrite", st => st.put(v, k)) };
})();

export async function mountTellus(map: GlobeMap, side: HTMLElement) {
	const lang = getLang();
	const mapEl = map.mapEl;
	const st = document.createElement("style"); st.textContent = CSS; side.append(st);
	const q = new URLSearchParams(location.search);
	let src: Dataset = DATASETS[q.get("ds") as keyof typeof DATASETS] || DATASETS.palsar2;   // 主役＝PALSAR-2（L バンド SAR を地形に載せる珍しさ）
	let pol: "color" | "gray" = q.get("pol") === "gray" ? "gray" : "color";   // PALSAR-2 の見せ方（偽色 HH·HV／HH グレー）＝共有 URL に乗る

	side.insertAdjacentHTML("beforeend", `
		<div class="head"><h1>Tellus × ortho-earth<small>${t("Satellite data on a 3D globe, with no server")}</small></h1><select class="lang" aria-label="Language">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${l.name}</option>`).join("")}</select></div>
		<div class="shows"><span>${t("Highlights")}</span>${SHOWS.map(s => `<button class="show" data-k="${s.k}">${t(s.label)}</button>`).join("")}</div>
		<div class="tabs">${Object.values(DATASETS).map(d => `<button class="tab" data-k="${d.key}"><b>${d.label}</b><span>${t(DESC[d.key])}</span></button>`).join("")}</div>
		<div class="row"><label>${t("Period")}</label><input type="date" id="tl-from"><span>–</span><input type="date" id="tl-to"></div>
		<div class="row" id="tl-polrow"><label>${t("Render")}</label><button class="seg" data-pol="color">${t("False colour HH·HV")}</button><button class="seg" data-pol="gray">${t("HH grey")}</button></div>
		<div class="hint" id="tl-hint"></div>
		<div class="status" id="tl-status"></div>
		<div class="list" id="tl-list"></div>
		<div class="nav">
			<button id="tl-prev" title="${t("Previous date")} (←)" aria-label="${t("Previous date")}">◀</button>
			<span class="n" id="tl-n"></span>
			<button id="tl-next" title="${t("Next date")} (→)" aria-label="${t("Next date")}">▶</button>
			<button id="tl-cmp" title="${t("Drag to move the divider")}">${t("Compare")}</button>
			<button id="tl-fit">${t("Zoom to scene")}</button>
		</div>
		<div class="opac"><span>${t("Map lines")}</span><input type="range" id="tl-opac" min="0" max="100" value="55"></div>
		<details><summary>${t("How this works")}</summary><ul>${BACK.map(x => `<li>${t(x)}</li>`).join("")}</ul><div class="metrics" id="tl-metrics"></div></details>
		<details><summary>${t("Next steps (asks for Tellus)")}</summary><ul>${NEXT.map(x => `<li>${t(x)}</li>`).join("")}</ul></details>
		<div class="foot"><span id="tl-credit"></span><span><button class="share" id="tl-share">${t("Copy share link")}</button> <button id="tl-clear">${t("Remove imagery")}</button></span></div>
		<div class="toast" id="tl-toast"></div>`);
	const $ = <E extends HTMLElement = HTMLElement>(id: string) => side.querySelector(id) as E;
	// 地図の上のローダー（くるくる＋何をしているか＋届いた MB）＝案内板の小さな文字だけでは「止まった」と見えるので（Kenji 2026-10-27）。
	// 出る条件＝検索・読込の最中（status の spin）か、COG の Range 読みが 1 本でも走っている間（ズームでの精細化・見比べの 2 枚目も含む）。
	// 速く終わる読み（キャッシュ当たり）でちらつかないよう 250 ms 待ってから出し、終わったら 300 ms 置いて消す。
	const loader = document.createElement("div");
	loader.className = "tl-load"; loader.hidden = true; loader.setAttribute("role", "status"); loader.setAttribute("aria-live", "polite");
	loader.innerHTML = `<i></i><span></span>`;
	(mapEl.parentElement || mapEl).append(loader);
	let task = "", inflight = 0, burst = 0, showT: ReturnType<typeof setTimeout> | undefined, hideT: ReturnType<typeof setTimeout> | undefined;
	const paintLoad = () => {
		const on = !!task || inflight > 0;
		if (!on) { clearTimeout(showT); showT = undefined; hideT ??= setTimeout(() => { hideT = undefined; loader.hidden = true; burst = 0; }, 300); return; }
		clearTimeout(hideT); hideT = undefined;
		loader.querySelector("span")!.textContent = (task || t("Loading…")) + (burst > 0 ? ` ${(burst / 1e6).toFixed(1)} MB` : "");
		loader.style.left = `${mapEl.offsetLeft + mapEl.clientWidth / 2}px`; loader.style.top = `${mapEl.offsetTop + 16}px`;
		if (loader.hidden) showT ??= setTimeout(() => { showT = undefined; if (task || inflight > 0) loader.hidden = false; }, 250);
	};
	// 読み口を包んで、本文が流れてくる量を数える（ヘッダが届いた時点ではなく本文を読み終えた時点で「読込中」を外す）
	const track = (f: (u: unknown, init?: RequestInit) => Promise<Response>) => async (u: unknown, init?: RequestInit): Promise<Response> => {
		inflight++; paintLoad();
		let fin = false;
		const end = () => { if (!fin) { fin = true; inflight--; paintLoad(); } };
		let r: Response;
		try { r = await f(u, init); } catch (e) { end(); throw e; }
		if (!r.body) { end(); return r; }
		init?.signal?.addEventListener("abort", end, { once: true });
		setTimeout(end, 60_000);   // 読み手が本文を捨てた時の保険（ローダーが出っぱなしにならない）
		const body = r.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) { burst += c.byteLength; paintLoad(); ctl.enqueue(c); }, flush: end }));
		return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
	};
	// spin＝検索・読込の最中（地図の上のローダーにも同じ文を出す）。spin なしの文（結果・失敗）はローダーを外す
	const status = (s: string, spin = false) => { $("#tl-status").textContent = s; task = spin ? s : ""; paintLoad(); };
	const toast = (s: string) => { const el = $("#tl-toast"); el.textContent = s; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1400); };

	const foot = createFootprint(map, mapEl);
	let show: (typeof SHOWS)[number] | null = null;   // 今見ている見どころ（地図クリックやタブで検索し直したら外れる）
	let items: Item[] = [], sel = -1, ac: AbortController | null = null, cogCtl: CogHandle | null = null, lastClick: number[] | null = null, metricsTimer: ReturnType<typeof setInterval> | null = null;
	let other = -1;   // 見比べの右（東）の行＝-1 は見比べなし。左（西）は sel
	const urls = new Map<string, { url: string; ts: number }>();   // scene id → {url, ts}（署名 URL は 1 時間＝50 分まで使い回す・クイックルックと本番読みで共用）
	// fit＝"small"：シーンが画面の幅の 4 割より小さい時だけ寄る（AVNIR-2 の 70 km 四方を、東京の広い初期画面で探した時など）
	const smallInView = (it: Item) => {
		const xs: number[] = [];
		const walk = (c: unknown): void => { if (Array.isArray(c)) { if (typeof c[0] === "number") xs.push(c[0]); else c.forEach(walk); } };
		walk((it.geometry as { coordinates?: unknown } | null)?.coordinates);
		const H = mapEl.clientHeight / 2, a = map.unprojectXY(0, H), b = map.unprojectXY(mapEl.clientWidth, H);
		if (!xs.length) return false;
		if (!a || !b) return true;   // 画面の端が地球の外＝地球全体が見えるほど引いている＝どのシーンも小さい
		return Math.max(...xs) - Math.min(...xs) < Math.abs(b[0] - a[0]) * 0.4;
	};
	// シーンの範囲（＋周り 15%）へ寄る＝「この場所に寄る」ボタンとタブ切替の小さいシーン
	const flyToScene = (it: Item) => {
		const bb = bboxOf(it.geometry); if (!bb) return;
		const z = map.fitZoomForBbox([bb[0] - (bb[2] - bb[0]) * .15, bb[1] - (bb[3] - bb[1]) * .15, bb[2] + (bb[2] - bb[0]) * .15, bb[3] + (bb[3] - bb[1]) * .15]);
		map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(1.2, Math.min(17, z)), 0, 0);
	};
	const freshUrl = async (it: Item, ds: Dataset = src) => {
		const u = urls.get(it.id);
		if (u && Date.now() - u.ts < 50 * 60e3) return u.url;
		const { url } = await cogUrl(ds, it.id);
		urls.set(it.id, { url, ts: Date.now() }); return url;
	};
	// シーンの読み口。先頭の Range（IFD＝ヘッダ 64 KB）は端末（IDB）に置き、2 回目からは署名 URL の発行もヘッダの読みも撃たない
	//（タイル本体は cog ガジェットの IDB 保管が持つ＝全部当たれば開き直しは通信ゼロ）。署名 URL は本当に読む時に初めて取る。
	// ds は作った時のデータセットで固定（読んでいる途中でタブを替えても別のデータセットの URL を取らない）。
	const sceneFetch = (it: Item) => {
		const ds = src, key = `head:${ds.key}/${it.id}`;
		let net: ((u: unknown, init?: RequestInit) => Promise<Response>) | null = null;
		const go = async (u: unknown, init?: RequestInit) => {
			net ??= renewingFetch(await freshUrl(it, ds), async () => { urls.delete(it.id); return freshUrl(it, ds); });
			return net(u, init);
		};
		return async (u: unknown, init?: RequestInit): Promise<Response> => {
			const range = new Headers(init?.headers).get("range") || "";
			if (!/^bytes=0-\d+$/.test(range)) return go(u, init);
			const hit = await quickDb.get(`${key}:${range}`) as { b: Uint8Array; cr: string } | null;
			if (hit?.b && hit.cr) return new Response(hit.b as Uint8Array<ArrayBuffer>, { status: 206, headers: { "content-range": hit.cr, "content-length": String(hit.b.byteLength) } });
			const r = await go(u, init);
			const cr = r.headers.get("content-range");
			if (r.status !== 206 || !cr) return r;
			const b = new Uint8Array(await r.arrayBuffer());
			quickDb.set(`${key}:${range}`, { b, cr });
			return new Response(b, { status: 206, statusText: r.statusText, headers: r.headers });
		};
	};
	const drawOpts = () => cogOpts(src, { pol });                       // 見せ方（openCog オプション）
	const drawSig = () => (src.pol ? pol : "") + (src.cog ? JSON.stringify(src.cog) : "");   // 見せ方の指紋（クイックルックの鍵）

	const applySrc = (k: string, { keepItems = false } = {}) => {
		src = DATASETS[k as keyof typeof DATASETS];
		side.querySelectorAll<HTMLElement>(".tab").forEach(b => b.classList.toggle("on", b.dataset.k === k));
		const [a, b] = defaultRange(src); $<HTMLInputElement>("#tl-from").value = a; $<HTMLInputElement>("#tl-to").value = b;
		$("#tl-credit").textContent = src.credit;
		$("#tl-polrow").hidden = !src.pol;
		markShow(null);
		$("#tl-hint").textContent = t(src.global ? "One global sheet per date. Step ◀▶ to watch the seasons move across the sea." : "Click the map to find scenes that cover that spot.");
		applyPol(pol);
		if (!keepItems) { endCompare(); items = []; sel = -1; $("#tl-list").replaceChildren(); nav(); }
	};
	const markShow = (s: (typeof SHOWS)[number] | null) => {
		show = s;
		side.querySelectorAll<HTMLElement>(".show").forEach(b => b.classList.toggle("on", b.dataset.k === s?.k));
		if (s) $("#tl-hint").textContent = t(s.note);
	};
	const applyPol = (p: "color" | "gray") => { pol = p; side.querySelectorAll<HTMLElement>(".seg").forEach(b => b.classList.toggle("on", b.dataset.pol === p)); };
	const nav = () => {
		$<HTMLButtonElement>("#tl-prev").disabled = !(sel > 0); $<HTMLButtonElement>("#tl-next").disabled = !(sel >= 0 && sel < items.length - 1);
		$("#tl-n").textContent = items.length ? `${sel + 1} / ${items.length} ${t("scenes")}` : "";
		$<HTMLButtonElement>("#tl-fit").disabled = sel < 0;
		$<HTMLButtonElement>("#tl-cmp").disabled = items.length < 2 || sel < 0;
		$("#tl-cmp").classList.toggle("on", other >= 0);
		if (other >= 0) {   // 見比べ中の ◀▶＝右の行を動かす（左は据え置き）
			$<HTMLButtonElement>("#tl-prev").disabled = !items.some((_, k) => k < other && k !== sel);
			$<HTMLButtonElement>("#tl-next").disabled = !items.some((_, k) => k > other && k !== sel);
		}
	};
	// 選択＝class の付け替えだけ（⚠一覧を作り直さない＝描き終わったサムネイルの canvas を捨てない・進行中の描画が外れた canvas に向かない）
	const select = (i: number) => {
		sel = i;
		[...$("#tl-list").children].forEach((row, k) => { row.classList.toggle("on", k === i); row.classList.toggle("vs", k === other); });
		nav();
	};
	const bboxOf = (g: unknown): Bbox | null => {
		const ring = foot.ringOf(g as FootprintGeometry); if (!ring) return null;
		let w = 1e9, s = 1e9, e = -1e9, n = -1e9;
		for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
		return [w, s, e, n];
	};

	// クイックルック＝最粗 overview を経緯度グリッドへ（幅 56px・高さは緯度で補正）。失敗しても行は残す（灰のまま）。
	// 描けたら IDB へ（鍵＝ds/scene/見せ方）＝再訪・タブ往復・偽色⇄グレーの二度目は署名 URL の発行すら要らない
	// 描けた絵は item（_thumb）にも持つ＝一覧を作り直す時（検索し直し以外では起きない）も即再描画。描く先は「今の」canvas（it._cv）
	const paint = (cv: HTMLCanvasElement | null | undefined, { w, h, rgba }: Thumb) => { if (!cv) return; cv.width = w; cv.height = h; cv.getContext("2d")!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0); };
	const quickLook = async (it: Item, sig: AbortSignal) => {
		const key = `${src.key}/${it.id}/${drawSig()}`;
		try {
			if (it._thumb?.key === key) { paint(it._cv, it._thumb); return; }
			const hit = await quickDb.get(key);
			if (hit?.rgba) { if (!sig?.aborted) { it._thumb = { key, ...hit }; paint(it._cv, it._thumb!); } return; }
			const url = await freshUrl(it);
			const cog = await openCog(url, { signal: sig, ...drawOpts() });
			const [w, s, e, n] = cog.bboxLL, cy = (s + n) / 2;
			const W = 56, H = Math.max(16, Math.min(56, Math.round(W * (n - s) / Math.max((e - w) * Math.cos(cy * Math.PI / 180), 1e-9))));
			const rgba = await cog.render(lonlatTarget([w, s, e, n], W, H), { signal: sig });
			cog.close?.();
			if (!rgba || sig?.aborted) return;
			it._thumb = { key, w: W, h: H, rgba };
			paint(it._cv, it._thumb);
			quickDb.set(key, { w: W, h: H, rgba });
		} catch (e) { if ((e as Error)?.name !== "AbortError") console.warn("[tellus] quicklook", it.id, (e as Error).message); }
	};

	const render = () => {
		const list = $("#tl-list"); list.replaceChildren();
		items.forEach((it, i) => {
			const row = document.createElement("button");
			row.className = "scene" + (i === sel ? " on" : "");
			const sub = src.cloud ? `${t("cloud")} ${it.cloud >= 0 ? Math.round(it.cloud) + "%" : "?"}` : [src.sub ? t(src.sub) : it.sub, orbitLabel(it.props, t)].filter(Boolean).join(" ");
			row.innerHTML = `<canvas width="56" height="56"></canvas><span><span class="d">${it.date}</span><br><span class="c">${sub}</span></span>`;
			row.addEventListener("mouseenter", () => { if (!src.global) foot.set(it.geometry as FootprintGeometry); });   // 全球 1 枚は枠を出さない（画面全部が枠）
			row.addEventListener("mouseleave", () => foot.set(null));
			row.addEventListener("click", () => pick(i));
			list.append(row);
			it._cv = row.querySelector("canvas");
			if (it._thumb) paint(it._cv, it._thumb);
		});
		nav();
	};
	// クイックルックは 3 並列（署名 URL 発行 + ヘッダ + overview ＝ 1 行 3 往復・IDB 命中なら 0 往復）
	let thumbAc: AbortController | null = null;
	const thumbs = async () => {
		thumbAc?.abort(); thumbAc = new AbortController();
		const sig = thumbAc.signal, queue = items.slice();
		await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length && !sig.aborted) { const it = queue.shift()!; await quickLook(it, sig); } }));
	};

	// 同じ日・同じ軌道の隣り合うフレーム（帯の上下の 2 枚）は 1 行に＝クリック点が枠の中央に近い方を残す（一覧の並びは保つ）
	const dedupe = (list: Item[], ll: number[]) => {
		const m = new Map<string, { it: Item; d: number }>();
		for (const it of list) {
			const p = it.props, k = [it.date, p["sat:orbit_state"], p["sat:relative_orbit"]].join("/");
			const bb = bboxOf(it.geometry), d = bb ? Math.hypot((bb[0] + bb[2]) / 2 - ll[0], (bb[1] + bb[3]) / 2 - ll[1]) : 1e9;
			const o = m.get(k); if (!o || d < o.d) m.set(k, { it, d });
		}
		return [...m.values()].map(v => v.it);
	};
	const search = async (ll: number[], { autoLoad = true, fit = false as Fit } = {}) => {
		lastClick = ll;
		if (show) applySrc(src.key, { keepItems: true });   // 見どころから地図クリックへ移った＝案内文を元へ
		ac?.abort(); ac = new AbortController(); endCompare();
		status(t("Searching…"), true); items = []; sel = -1; render();
		try {
			items = dedupe(await searchScenes(src, { c: ll, from: $<HTMLInputElement>("#tl-from").value, to: $<HTMLInputElement>("#tl-to").value, signal: ac.signal }), ll).slice(0, 12);
			status(items.length ? "" : t("No scenes found (widen the period or click elsewhere)"));
			render();
			if (items.length && autoLoad) load(0, { fit });
			thumbs();
		} catch (e) { if ((e as Error)?.name !== "AbortError") { console.warn("[tellus] search", e); status(t("Search failed")); } }
	};

	const load = async (i: number, { fit: fit0 = false as Fit } = {}) => {
		if (!items[i]) return;
		select(i); status(t("Loading…"), true);
		const it = items[i];
		// "small"＝小さい時だけ、読む前に「この場所に寄る」と同じ枠へ飛ぶ（先に寄る＝粗い段を読まずに済む・エンジンの fit より枠が安定）
		if (fit0 === "small" && smallInView(it)) flyToScene(it);
		const fit = fit0 === true;
		try {
			// 読込の進み具合＝届いた量を地図の上のローダーに出す（最初の 1 枚が出るまで数秒〜十数秒かかる回線でも「止まっていない」と分かる）
			const counted = track(sceneFetch(it));
			// cacheKey＝データセット/シーン＝生タイルのキャッシュの鍵（署名 URL は発行ごとに変わる＝URL では鍵にならない）。
			// src は読み口が URL を見ない（sceneFetch が差し替える）ので名札だけ
			cogCtl = await map.gadget.cog(`tellus:${src.key}/${it.id}`, { fit, fetch: counted, cacheKey: `${src.key}/${it.id}`, ...drawOpts() });
			if (sel !== i) return;   // 読んでいる間に別の行へ移った＝古い方の後始末はしない（新しい load が上書き済み）
			status(""); shareUrl(it);
			if (!metricsTimer) metricsTimer = setInterval(showMetrics, 1000);
			showMetrics();
		} catch (e) { if (sel === i) status(t("Search failed") + ": " + (e as Error).message); }
	};
	const showMetrics = () => {
		const m = cogCtl?.metrics?.() as Record<string, number> | null | undefined; if (!m) return;
		$("#tl-metrics").textContent = `${t("Range requests")} ${m.rangeRequests}・${t("Received")} ${(m.bytesFetched / 1e6).toFixed(1)} MB・${t("Header")} ${Math.round(m.ttfhMs)} ms・${t("cache")} ${m.cacheHits}/${((m.rawCacheBytes || 0) / 1e6).toFixed(0)} MB`;
	};
	const shareUrl = (it: Item) => {
		const u = new URL(location.href); u.searchParams.set("ds", src.key); u.searchParams.set("scene", it.id);
		if (src.pol && pol === "gray") u.searchParams.set("pol", "gray"); else u.searchParams.delete("pol");
		u.searchParams.delete("tellusapi");
		if (show) u.searchParams.set("show", show.k); else u.searchParams.delete("show");
		if (other >= 0 && items[other]) u.searchParams.set("vs", items[other].id); else u.searchParams.delete("vs");
		const h = location.hash || map.view?.hash || "";   // 視点の hash はエンジン（urlHash）がカメラ移動のたびに書く＝動かす前は view.hash から
		history.replaceState(null, "", u.pathname + u.search + h);
	};

	// ---- 見比べ（2 日付を左右に・境はつまみで動かす）----
	// 左（西）＝古い日付・右（東）＝新しい日付。左は load（本番の 1 枚目）、右は cogCtl.compare（同じ窓の 2 枚目）。
	// 境＝つまみの画面 x を、画面の縦の中ほどで経度へ引き直した線（地面に引く南北の線＝真北向きなら画面の縦線）。
	const knob = document.createElement("div");
	knob.className = "tl-knob"; knob.hidden = true; knob.setAttribute("role", "slider"); knob.setAttribute("aria-label", t("Drag to move the divider"));
	knob.innerHTML = `<span class="l"></span><b>⇔</b><span class="r"></span>`;
	(mapEl.parentElement || mapEl).append(knob);
	let kx = 0.5, kRaf = 0;
	const kY = () => mapEl.clientHeight * 0.55;
	const placeKnob = () => {
		kRaf = 0;
		if (other < 0) return;
		const x = kx * mapEl.clientWidth, ll = map.unprojectXY(x, kY());
		knob.style.left = `${mapEl.offsetLeft + x}px`; knob.style.top = `${mapEl.offsetTop + kY()}px`;
		cogCtl?.split(ll ? ll[0] : null);
	};
	const queueKnob = () => { if (!kRaf) kRaf = requestAnimationFrame(placeKnob); };
	map.on("move", queueKnob);
	window.addEventListener("resize", queueKnob);
	knob.addEventListener("pointerdown", e => {
		e.preventDefault(); e.stopPropagation(); knob.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => { const r = mapEl.getBoundingClientRect(); kx = Math.min(0.97, Math.max(0.03, (ev.clientX - r.left) / r.width)); queueKnob(); };
		const up = () => { knob.removeEventListener("pointermove", move); knob.removeEventListener("pointerup", up); knob.removeEventListener("pointercancel", up); };
		knob.addEventListener("pointermove", move); knob.addEventListener("pointerup", up); knob.addEventListener("pointercancel", up);
	});
	knob.addEventListener("keydown", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { kx = Math.min(0.97, Math.max(0.03, kx + (e.key === "ArrowLeft" ? -0.05 : 0.05))); queueKnob(); e.preventDefault(); e.stopPropagation(); } });
	knob.tabIndex = 0;
	let cmpSeq = 0;
	const endCompare = () => {
		if (other < 0) return;
		other = -1; cmpSeq++; knob.hidden = true;
		cogCtl?.compare(null).catch(() => {}); cogCtl?.split(null);
		select(sel);
	};
	const runCompare = async (i: number, j: number) => {
		if (!items[i] || !items[j] || i === j) return;
		const [l, r] = items[i].date <= items[j].date ? [i, j] : [j, i];
		const seq = ++cmpSeq; other = r;
		await load(l, { fit: false });
		if (seq !== cmpSeq || sel !== l || !cogCtl) return;   // 待つ間に別の操作が来た
		const it = items[r];
		try {
			status(t("Loading…"), true);
			await cogCtl.compare(`tellus:${src.key}/${it.id}`, { fetch: track(sceneFetch(it)), cacheKey: `${src.key}/${it.id}`, ...drawOpts() });
			if (seq !== cmpSeq) return;
			status("");
			(knob.querySelector(".l") as HTMLElement).textContent = items[l].date;
			(knob.querySelector(".r") as HTMLElement).textContent = it.date;
			knob.hidden = false; select(l); placeKnob(); shareUrl(items[l]);
		} catch (e) { if (seq === cmpSeq) { status(t("Search failed") + ": " + (e as Error).message); endCompare(); } }
	};
	// 行・◀▶ の行き先＝見比べ中は右の行を差し替え、そうでなければその行を載せる
	const pick = (i: number) => {
		if (other < 0) return load(i, { fit: false });
		if (i === sel) return;
		return runCompare(sel, i);
	};

	// 見どころ＝データセットを切り替え、決めたシーンを並べて、決めた視点へ飛び、先頭を載せる（2 枚なら見比べで開く）
	const runShow = async (k: string, { fly = true, at = 0 } = {}) => {
		const s = SHOWS.find(x => x.k === k); if (!s) return;
		ac?.abort(); ac = new AbortController(); const sig = ac.signal;
		applySrc(s.ds); markShow(s); lastClick = null;
		status(t("Loading…"), true);
		if (fly) { const [lon, lat, z, tilt] = s.view; map.flyTo(lon, lat, z, tilt, 0); }
		try {
			items = await Promise.all(s.ids.map(id => getScene(src, id, { signal: sig })));
			if (sig.aborted) return;
			render(); thumbs();
			if (items.length === 2) runCompare(0, 1); else load(Math.min(Math.max(at, 0), items.length - 1), { fit: false });
		} catch (e) { if ((e as Error)?.name !== "AbortError") { console.warn("[tellus] show", e); status(t("Search failed")); } }
	};

	// ---- 配線 ----
	side.querySelectorAll<HTMLElement>(".show").forEach(b => b.addEventListener("click", () => runShow(b.dataset.k!)));
	$(".lang").addEventListener("change", e => { const u = new URL(location.href); u.searchParams.set("lang", (e.target as HTMLSelectElement).value); location.assign(u); });   // 言語＝読み直す（視点・シーンは URL に残る）
	// 探す地点＝最後にクリックした所、無ければ（見どころの後・まだ押していない）画面の真ん中＝タブを押せば必ず何か出る
	const here = () => lastClick || map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2);
	side.querySelectorAll<HTMLElement>(".tab").forEach(b => b.addEventListener("click", () => { if (b.dataset.k === src.key) return; applySrc(b.dataset.k!); const ll = here(); if (!ll) return;
		if (src.global && map.getZoom() > 6.5) map.flyTo(ll[0], ll[1], 5, 0, 0);   // 全球 1 枚（SST 4.6 km）＝寄ったままでは陸しか見えない＝海が入る高さへ引く
		search(ll, { fit: "small" });   // 小さいシーン（AVNIR-2）は画面の片隅に小さく載るだけ＝写った範囲へ寄る
	}));
	side.querySelectorAll<HTMLElement>(".seg").forEach(b => b.addEventListener("click", () => {   // 偽色⇄グレー＝同じシーンを見せ方だけ変えて載せ直す（生タイルはキャッシュ済＝通信なし）
		if (b.dataset.pol === pol) return;
		applyPol(b.dataset.pol as "color" | "gray");
		if (other >= 0) runCompare(sel, other); else if (sel >= 0) load(sel, { fit: false });
		thumbs();
	}));
	const step = (d: number) => {
		if (other < 0) { const i = sel + d; if (items[i]) load(i, { fit: false }); return; }
		let j = other + d; if (j === sel) j += d;   // 見比べ中＝右の行を前後へ（左の行は飛ばす）
		if (items[j]) runCompare(sel, j);
	};
	$("#tl-cmp").addEventListener("click", () => {
		if (other >= 0) return endCompare();
		const j = items[sel + 1] ? sel + 1 : sel - 1;   // 隣の日付と並べる
		if (sel >= 0 && items[j]) runCompare(sel, j);
	});
	$("#tl-prev").addEventListener("click", () => step(-1));
	$("#tl-next").addEventListener("click", () => step(+1));
	window.addEventListener("keydown", (e) => {   // ←→＝前後の日付（入力欄にフォーカスがある時は触らない）
		if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
		if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); } else if (e.key === "ArrowRight") { step(+1); e.preventDefault(); }
	});
	$("#tl-fit").addEventListener("click", () => { if (items[sel]) flyToScene(items[sel]); });
	$("#tl-clear").addEventListener("click", () => { endCompare(); cogCtl?.clear(); select(-1); });
	$("#tl-opac").addEventListener("input", e => map.setOpacity?.({ base: (+(e.target as HTMLInputElement).value) / 100 }));
	map.setOpacity?.({ base: 0.55 });   // 衛星画像を主役に＝基図の線は少し引く（スライダーで戻せる）
	$("#tl-share").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText(location.href); toast(t("Copied")); } catch { prompt("URL", location.href); }
	});
	side.querySelectorAll("#tl-from, #tl-to").forEach(el => el.addEventListener("change", () => { const ll = here(); if (ll) search(ll); }));
	// 地図クリック＝その地点で検索（エンジンのクリック横取り＝4px のドラッグ弁別は済んでいる）
	map.setEditClick((x, y) => { const ll = map.unprojectXY(x, y); if (ll) search(ll); });

	// ---- 起動 ----
	applySrc(src.key);
	const sceneId = q.get("scene"), showK = q.get("show");
	if (showK && SHOWS.some(s => s.k === showK)) {   // 共有 URL の見どころ＝並びごと復元（視点は hash があればそれ）
		const s = SHOWS.find(x => x.k === showK)!;
		await runShow(showK, { fly: !location.hash, at: sceneId ? s.ids.indexOf(sceneId) : 0 });
	} else if (sceneId) {   // 共有 URL＝そのシーンを復元（視点は hash が持つ＝寄せない。hash 無しなら寄せる）
		try {
			const vs = q.get("vs");   // 見比べの共有 URL＝2 枚並べて見比べで開く
			items = await Promise.all([getScene(src, sceneId), ...(vs ? [getScene(src, vs)] : [])]); render(); lastClick = null;
			if (items.length === 2) { if (!location.hash) { const bb = bboxOf(items[0].geometry); if (bb) map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.min(17, map.fitZoomForBbox(bb)), 0, 0); } await runCompare(0, 1); }
			else await load(0, { fit: !location.hash });
			thumbs();
		} catch (e) { console.warn("[tellus] share restore", e); status(t("Search failed")); }
	} else {   // 初回＝画面中心（東京）で検索し、最新のシーンをそのまま載せる（視点は据え置き＝傾けた初期視点のまま立体で見せる）
		const c = map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2) || [139.75, 35.68];
		search(c, { autoLoad: true, fit: false });
	}
	return { search, load, runShow, compare: runCompare, endCompare, get other() { return other; }, get items() { return items; }, get selected() { return sel; }, get pol() { return pol; }, setPol: (p: "color" | "gray") => { applyPol(p); if (sel >= 0) load(sel, { fit: false }); thumbs(); } };
}
