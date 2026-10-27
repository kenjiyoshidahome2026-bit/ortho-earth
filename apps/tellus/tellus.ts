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
// ids＝並べる順（古い→新しい＝▶ で時間が進む）。view＝[lon, lat, zoom, 傾き]。シーンは 2026-10-27 に Traveler API で実在と描画を確かめた物。
// 仙台＝AVNIR-2 の同じパス 67・フレーム 2830（震災前 2011-02-23 雲 6.5%／後 2011-04-10 雲 1%）。
// 富士山＝PALSAR-2 2025-10-15 上昇 フレーム 750（山頂が枠の端に掛からない方）。西之島＝2020-09-21 下降（2019–20 噴火の後）。海面水温＝2025 年 2 月と 8 月の下降。
const SHOWS = [
	{ k: "sendai", ds: "avnir2", label: "2011 tsunami, Sendai", note: "AVNIR-2 optical, two weeks before and one month after 11 March 2011. Press ▶: the farmland behind the coast turns dark where the tsunami flooded it.", ids: ["01c632a6-0085-440b-840f-c2a1a86f6d41", "8af6df5d-0c4a-472c-b73e-706e5f018561"], view: [140.96, 38.21, 11.8, 35] },
	{ k: "fuji", ds: "palsar2", label: "Mt Fuji in radar", note: "PALSAR-2 radar draped on the terrain: it sees through cloud and works at night. Forest is green, towns magenta, lakes black. Drag to tilt.", ids: ["2ee1f996-ae81-4892-882c-703e4ad0b990"], view: [138.73, 35.3, 11.8, 55] },
	{ k: "nishinoshima", ds: "palsar2", label: "Nishinoshima volcano", note: "A volcanic island 940 km south of Tokyo, after its 2019–2020 eruption. Radar sees the island through the ash plume.", ids: ["95e05818-4199-4d51-a2ad-d6dde0e87506"], view: [140.876, 27.247, 13.6, 40] },
	{ k: "sst", ds: "sst", label: "Sea temperature, winter → summer", note: "GCOM-C 8-day mean sea surface temperature, February and August 2025. Press ▶ to watch the warm water spread north.", ids: ["b7526483-b342-491f-bab2-e6dafe0d91f2", "f6fe599f-206a-4d33-880f-3d4c9d55073c"], view: [138, 33, 4.6, 0] },
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
			<button id="tl-fit">${t("Zoom to scene")}</button>
		</div>
		<div class="opac"><span>${t("Map lines")}</span><input type="range" id="tl-opac" min="0" max="100" value="55"></div>
		<details><summary>${t("How this works")}</summary><ul>${BACK.map(x => `<li>${t(x)}</li>`).join("")}</ul><div class="metrics" id="tl-metrics"></div></details>
		<details><summary>${t("Next steps (asks for Tellus)")}</summary><ul>${NEXT.map(x => `<li>${t(x)}</li>`).join("")}</ul></details>
		<div class="foot"><span id="tl-credit"></span><span><button class="share" id="tl-share">${t("Copy share link")}</button> <button id="tl-clear">${t("Remove imagery")}</button></span></div>
		<div class="toast" id="tl-toast"></div>`);
	const $ = <E extends HTMLElement = HTMLElement>(id: string) => side.querySelector(id) as E;
	const status = (s: string) => { $("#tl-status").textContent = s; };
	const toast = (s: string) => { const el = $("#tl-toast"); el.textContent = s; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1400); };

	const foot = createFootprint(map, mapEl);
	let show: (typeof SHOWS)[number] | null = null;   // 今見ている見どころ（地図クリックやタブで検索し直したら外れる）
	let items: Item[] = [], sel = -1, ac: AbortController | null = null, cogCtl: CogHandle | null = null, lastClick: number[] | null = null, metricsTimer: ReturnType<typeof setInterval> | null = null;
	const urls = new Map<string, { url: string; ts: number }>();   // scene id → {url, ts}（署名 URL は 1 時間＝50 分まで使い回す・クイックルックと本番読みで共用）
	const freshUrl = async (it: Item) => {
		const u = urls.get(it.id);
		if (u && Date.now() - u.ts < 50 * 60e3) return u.url;
		const { url } = await cogUrl(src, it.id);
		urls.set(it.id, { url, ts: Date.now() }); return url;
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
		if (!keepItems) { items = []; sel = -1; $("#tl-list").replaceChildren(); nav(); }
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
	};
	// 選択＝class の付け替えだけ（⚠一覧を作り直さない＝描き終わったサムネイルの canvas を捨てない・進行中の描画が外れた canvas に向かない）
	const select = (i: number) => {
		sel = i;
		[...$("#tl-list").children].forEach((row, k) => row.classList.toggle("on", k === i));
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
			row.addEventListener("click", () => load(i, { fit: false }));
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
	const search = async (ll: number[], { autoLoad = true, fit = false } = {}) => {
		lastClick = ll;
		if (show) applySrc(src.key, { keepItems: true });   // 見どころから地図クリックへ移った＝案内文を元へ
		ac?.abort(); ac = new AbortController();
		status(t("Searching…")); items = []; sel = -1; render();
		try {
			items = dedupe(await searchScenes(src, { c: ll, from: $<HTMLInputElement>("#tl-from").value, to: $<HTMLInputElement>("#tl-to").value, signal: ac.signal }), ll).slice(0, 12);
			status(items.length ? "" : t("No scenes found (widen the period or click elsewhere)"));
			render();
			if (items.length && autoLoad) load(0, { fit });
			thumbs();
		} catch (e) { if ((e as Error)?.name !== "AbortError") { console.warn("[tellus] search", e); status(t("Search failed")); } }
	};

	const load = async (i: number, { fit = false } = {}) => {
		if (!items[i]) return;
		select(i); status(t("Loading…"));
		const it = items[i];
		try {
			const url = await freshUrl(it);
			const renew = renewingFetch(url, async () => { urls.delete(it.id); return freshUrl(it); });
			// 読込の進み具合＝届いた Range の量を数えて出す（最初の 1 枚が出るまで数秒〜十数秒かかる回線でも「止まっていない」と分かる）
			let got = 0, done = false;
			const counted = async (u: unknown, init?: RequestInit) => {
				const r = await renew(u, init);
				got += +(r.headers.get("content-length") || 0);
				if (!done && sel === i) status(`${t("Loading…")} ${(got / 1e6).toFixed(1)} MB`);
				return r;
			};
			// cacheKey＝データセット/シーン＝生タイルのメモリキャッシュの鍵（署名 URL は発行ごとに変わる＝URL では鍵にならない）
			cogCtl = await map.gadget.cog(url, { fit, fetch: counted, cacheKey: `${src.key}/${it.id}`, ...drawOpts() });
			done = true;
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
		const h = location.hash || map.view?.hash || "";   // 視点の hash はエンジン（urlHash）がカメラ移動のたびに書く＝動かす前は view.hash から
		history.replaceState(null, "", u.pathname + u.search + h);
	};

	// 見どころ＝データセットを切り替え、決めたシーンを並べて、決めた視点へ飛び、先頭を載せる（◀▶ で前後）
	const runShow = async (k: string, { fly = true, at = 0 } = {}) => {
		const s = SHOWS.find(x => x.k === k); if (!s) return;
		ac?.abort(); ac = new AbortController(); const sig = ac.signal;
		applySrc(s.ds); markShow(s); lastClick = null;
		status(t("Loading…"));
		if (fly) { const [lon, lat, z, tilt] = s.view; map.flyTo(lon, lat, z, tilt, 0); }
		try {
			items = await Promise.all(s.ids.map(id => getScene(src, id, { signal: sig })));
			if (sig.aborted) return;
			render(); load(Math.min(Math.max(at, 0), items.length - 1), { fit: false }); thumbs();
		} catch (e) { if ((e as Error)?.name !== "AbortError") { console.warn("[tellus] show", e); status(t("Search failed")); } }
	};

	// ---- 配線 ----
	side.querySelectorAll<HTMLElement>(".show").forEach(b => b.addEventListener("click", () => runShow(b.dataset.k!)));
	$(".lang").addEventListener("change", e => { const u = new URL(location.href); u.searchParams.set("lang", (e.target as HTMLSelectElement).value); location.assign(u); });   // 言語＝読み直す（視点・シーンは URL に残る）
	side.querySelectorAll<HTMLElement>(".tab").forEach(b => b.addEventListener("click", () => { if (b.dataset.k === src.key) return; applySrc(b.dataset.k!); if (lastClick) search(lastClick); }));
	side.querySelectorAll<HTMLElement>(".seg").forEach(b => b.addEventListener("click", () => {   // 偽色⇄グレー＝同じシーンを見せ方だけ変えて載せ直す（生タイルはキャッシュ済＝通信なし）
		if (b.dataset.pol === pol) return;
		applyPol(b.dataset.pol as "color" | "gray");
		if (sel >= 0) load(sel, { fit: false });
		thumbs();
	}));
	const step = (d: number) => { const i = sel + d; if (items[i]) load(i, { fit: false }); };
	$("#tl-prev").addEventListener("click", () => step(-1));
	$("#tl-next").addEventListener("click", () => step(+1));
	window.addEventListener("keydown", (e) => {   // ←→＝前後の日付（入力欄にフォーカスがある時は触らない）
		if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
		if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); } else if (e.key === "ArrowRight") { step(+1); e.preventDefault(); }
	});
	$("#tl-fit").addEventListener("click", () => {
		const bb = items[sel] && bboxOf(items[sel].geometry); if (!bb) return;
		const z = map.fitZoomForBbox([bb[0] - (bb[2] - bb[0]) * .15, bb[1] - (bb[3] - bb[1]) * .15, bb[2] + (bb[2] - bb[0]) * .15, bb[3] + (bb[3] - bb[1]) * .15]);
		map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(1.2, Math.min(17, z)), 0, 0);
	});
	$("#tl-clear").addEventListener("click", () => { cogCtl?.clear(); select(-1); });
	$("#tl-opac").addEventListener("input", e => map.setOpacity?.({ base: (+(e.target as HTMLInputElement).value) / 100 }));
	map.setOpacity?.({ base: 0.55 });   // 衛星画像を主役に＝基図の線は少し引く（スライダーで戻せる）
	$("#tl-share").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText(location.href); toast(t("Copied")); } catch { prompt("URL", location.href); }
	});
	side.querySelectorAll("#tl-from, #tl-to").forEach(el => el.addEventListener("change", () => { if (lastClick) search(lastClick); }));
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
			const it = await getScene(src, sceneId);
			items = [it]; render(); lastClick = null;
			await load(0, { fit: !location.hash });
			thumbs();
		} catch (e) { console.warn("[tellus] share restore", e); status(t("Search failed")); }
	} else {   // 初回＝画面中心（東京）で検索し、最新のシーンをそのまま載せる（視点は据え置き＝傾けた初期視点のまま立体で見せる）
		const c = map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2) || [139.75, 35.68];
		search(c, { autoLoad: true, fit: false });
	}
	return { search, load, runShow, get items() { return items; }, get selected() { return sel; }, get pol() { return pol; }, setPol: (p: "color" | "gray") => { applyPol(p); if (sel >= 0) load(sel, { fit: false }); thumbs(); } };
}
