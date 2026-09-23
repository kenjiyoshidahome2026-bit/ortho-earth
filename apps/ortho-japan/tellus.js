// Tellus × ortho-earth の案内板と配線（tellus.html から遅延 import）。
// 「地図をクリック → その地点のシーン一覧 → クリックで地形の上にドレープ → ◀▶（←→）で同じ場所の別日」。
// データの読み口は gadgets/tellus-api.js（stac ガジェットと共用）、ドレープは map.gadget.cog（エンジン側の COG スロット）。
// 見せ方はデータ側（tellus-api の cogOpts）: PALSAR-2 は HH/HV の偽色合成（切替でグレー）・GCOM-C SST はカラーマップ。
// クイックルック（行のサムネイル）は COG の最粗 overview を Range 1〜2 本で描く＝サムネイル API が無くても出せる
//（Tellus の検索応答にサムネイルが無い・AVNIR-2 の thumb.png は署名 URL 要＝どのみち 1 往復）。描けたら IDB に置く＝再訪は無通信。
import { tr } from "@ortho-earth/globe/i18n.js";
import { DATASETS, defaultRange, searchScenes, getScene, cogUrl, cogOpts, renewingFetch, orbitLabel } from "@ortho-earth/globe/gadgets/tellus-api.js";
import { createFootprint } from "@ortho-earth/globe/gadgets/footprint.js";
import { openCog, lonlatTarget } from "geopbf/cog/core";   // クイックルック＝DOM 不要経路（worker 無し・最粗 overview だけ）

const t = tr();
const DESC = { palsar2: "L-band SAR, HH/HV polarisation, ortho-corrected (2016–)", palsar: "L-band SAR on ALOS (2006–2011)", avnir2: "Optical 10 m, true colour (2006–2011)", sst: "SGLI sea surface temperature, 8-day mean, global (2018–)" };

const BACK = {
	ja: [
		"衛星画像はタイル化していません。Tellus が置いている <b>Cloud Optimized GeoTIFF</b>（*_webcog.tif）を、ブラウザが <b>HTTP Range</b> で必要な部分だけ読んでいます。384 MB のシーンでも最初の表示は数百 KB です。",
		"読んだ画素はその場で経緯度に並べ直し、<b>地形（DEM10B）の上にドレープ</b>します。傾けると立体になるのはそのためです。",
		"PALSAR-2 の webcog は HH/HV の 2 偏波を持っています。既定は <b>R=HH・G=HV・B=HH−HV</b> の偽色合成（森が緑・市街が紫・水が黒）で、切替でグレー（HH）に戻せます。",
		"GCOM-C の海面水温は 8640×4320 の float32 GeoTIFF 1 枚（全球）。℃ の値をその場で 0〜32 ℃ のカラーマップに通しています。読んだタイルはメモリに残るので、◀▶ の往復は通信ゼロです。",
		"Tellus の API にはブラウザから直接触れない（CORS 無し・要トークン）ので、小さな中継（Cloudflare Worker）がトークンを付けて検索と署名 URL 発行だけを代行しています。画像のバイトは中継を素通りするだけです。",
	],
	en: [
		"Nothing is pre-tiled. The browser reads Tellus's own <b>Cloud Optimized GeoTIFF</b> (*_webcog.tif) with <b>HTTP Range</b> requests, fetching only what the view needs — a 384 MB scene first appears after a few hundred KB.",
		"Pixels are re-gridded to lon/lat on the fly and <b>draped over terrain (DEM10B)</b>, which is why tilting shows relief.",
		"The PALSAR-2 webcog carries both HH and HV. The default view is a <b>R=HH, G=HV, B=HH−HV</b> false-colour composite (forest green, built-up magenta, water black); a toggle returns to HH grey.",
		"GCOM-C sea surface temperature is one global 8640×4320 float32 GeoTIFF. Values in °C go through a 0–32 °C colour map on the fly. Fetched tiles stay in memory, so stepping ◀▶ back and forth costs no network.",
		"Tellus's API is not reachable from a browser (no CORS, token required), so a tiny relay (Cloudflare Worker) adds the token for search and signed-URL issuance only. Image bytes just pass through it.",
	],
};
const NEXT = {
	ja: [
		"署名 URL の CORS が <code>tellusxdp.com</code> 固定です。<code>Access-Control-Allow-Origin: *</code> になれば中継なしでブラウザが直接読めます。",
		"検索応答にサムネイルがありません。この画面は COG の overview から作って IDB に置いていますが、STAC の <code>assets.thumbnail</code> があれば初回から一瞬です。",
		"Traveler API は STAC にとても近い形です。<code>/stac</code> 互換の入口が一つあれば、ortho-earth に限らず既存の STAC クライアントがそのまま Tellus を引けます。",
		"「Tellus 環境でのみ利用可」のデータ（ASNARO・PALSAR-2 L2.1 など）は外から 403 です。表示だけの用途を認める区分があると、この画面にそのまま並びます。",
	],
	en: [
		"Signed URLs pin CORS to <code>tellusxdp.com</code>. With <code>Access-Control-Allow-Origin: *</code> the browser could read them directly, no relay.",
		"Search responses carry no thumbnails; this page renders them from the COG overviews and keeps them in IndexedDB. A STAC <code>assets.thumbnail</code> would make the first visit instant too.",
		"The Traveler API is already very close to STAC. A <code>/stac</code>-compatible entry point would let any STAC client, not just ortho-earth, query Tellus as-is.",
		"Datasets marked “Tellus environment only” (ASNARO, PALSAR-2 L2.1, …) return 403 from outside. A view-only tier would let them appear here unchanged.",
	],
};

const CSS = `
#side { font-size: 13px; }
#side h1 { margin: 0; padding: 14px 16px 2px; font-size: 17px; letter-spacing: .01em; }
#side h1 small { display: block; font-size: 11.5px; font-weight: 400; color: #6b7385; margin-top: 2px; }
#side .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px 16px 0; }
#side .tab { border: 1px solid #cdd3dd; background: #fff; border-radius: 9px; padding: 6px 8px; cursor: pointer; font: inherit; color: inherit; text-align: left; line-height: 1.3; min-width: 0; }
#side .tab b { display: block; font-size: 13px; }
#side .tab span { display: block; font-size: 10.5px; color: #6b7385; }
#side .tab.on { border-color: #3f4757; background: #eef1f6; }
#side .row { display: flex; gap: 6px; align-items: center; padding: 8px 16px 0; flex-wrap: wrap; }
#side .row label { color: #6b7385; font-size: 11.5px; }
#side .row[hidden] { display: none; }
#side input[type=date] { flex: 1; min-width: 0; font: 12px system-ui; color: inherit; border: 1px solid #cdd3dd; border-radius: 6px; padding: 3px 5px; background: #fff; }
#side .seg { border: 1px solid #cdd3dd; background: #fff; border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 11.5px; color: inherit; }
#side .seg.on { border-color: #3f4757; background: #eef1f6; }
#side .hint { padding: 8px 16px 0; color: #6b7385; font-size: 12px; }
#side .status { padding: 6px 16px 0; color: #8a93a3; min-height: 1.4em; font-size: 12px; }
#side .list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 6px; }
#side .scene { display: flex; gap: 10px; align-items: center; width: 100%; border: 0; background: none; text-align: left; padding: 6px; border-radius: 10px; cursor: pointer; font: inherit; color: inherit; }
#side .scene:hover { background: #eef1f6; }
#side .scene.on { background: #e2ecff; }
#side .scene canvas { width: 56px; height: 56px; border-radius: 8px; background: #dfe3ea; flex: none; object-fit: cover; }
#side .scene .d { font-weight: 600; }
#side .scene .c { color: #8a93a3; font-size: 11.5px; }
#side .nav { display: flex; gap: 6px; align-items: center; padding: 8px 16px; border-top: 1px solid #eef0f4; }
#side .nav button, #side .foot button, #side .share { border: 1px solid #cdd3dd; background: #fff; border-radius: 8px; padding: 5px 10px; cursor: pointer; font: inherit; font-size: 12px; color: inherit; }
#side .nav button:disabled { opacity: .4; cursor: default; }
#side .nav .n { flex: 1; text-align: center; color: #6b7385; font-size: 12px; }
#side .opac { display: flex; gap: 8px; align-items: center; padding: 0 16px 8px; color: #6b7385; font-size: 11.5px; }
#side .opac input { flex: 1; }
#side details { border-top: 1px solid #eef0f4; padding: 6px 16px; font-size: 12px; }
#side details summary { cursor: pointer; font-weight: 600; color: #3f4757; padding: 4px 0; }
#side details ul { margin: 4px 0 6px; padding-left: 18px; color: #4b5364; }
#side details li { margin: 3px 0; }
#side details code { font-size: 11px; background: #f2f4f8; padding: 1px 4px; border-radius: 4px; }
#side .metrics { font: 11px ui-monospace, Menlo, monospace; color: #6b7385; padding: 2px 0 4px; }
#side .foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 16px 12px; border-top: 1px solid #eef0f4; color: #8a93a3; font-size: 11px; }
#side .toast { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); background: #2b3242; color: #fff; border-radius: 8px; padding: 6px 12px; font-size: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; }
#side .toast.on { opacity: 1; }`;

// クイックルックの置き場（IDB・鍵＝データセット/シーン/見せ方・値＝{w,h,rgba}＝56×56×4 以下）。失敗は全て null＝無かったことに
const quickDb = (() => {
	let p = null;
	const open = () => p ??= new Promise((res, rej) => {
		if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
		const rq = indexedDB.open("tellus-quicklook", 1);
		rq.onupgradeneeded = () => rq.result.createObjectStore("q");
		rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
	});
	const run = async (mode, f) => { try { const db = await open(); return await new Promise((res, rej) => { const r = f(db.transaction("q", mode).objectStore("q")); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); } catch { return null; } };
	return { get: (k) => run("readonly", st => st.get(k)), set: (k, v) => run("readwrite", st => st.put(v, k)) };
})();

export async function mountTellus(map, side) {
	const lang = document.documentElement.lang === "en" ? "en" : "ja";
	const mapEl = map.mapEl;
	const st = document.createElement("style"); st.textContent = CSS; side.append(st);
	const q = new URLSearchParams(location.search);
	let src = DATASETS[q.get("ds")] || DATASETS.palsar2;   // 主役＝PALSAR-2（L バンド SAR を地形に載せる珍しさ）
	let pol = q.get("pol") === "gray" ? "gray" : "color";   // PALSAR-2 の見せ方（偽色 HH·HV／HH グレー）＝共有 URL に乗る

	side.insertAdjacentHTML("beforeend", `
		<h1>Tellus × ortho-earth<small>${t("Satellite data on a 3D globe, with no server")}</small></h1>
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
		<details><summary>${t("How this works")}</summary><ul>${BACK[lang].map(x => `<li>${x}</li>`).join("")}</ul><div class="metrics" id="tl-metrics"></div></details>
		<details><summary>${t("Next steps (asks for Tellus)")}</summary><ul>${NEXT[lang].map(x => `<li>${x}</li>`).join("")}</ul></details>
		<div class="foot"><span id="tl-credit"></span><span><button class="share" id="tl-share">${t("Copy share link")}</button> <button id="tl-clear">${t("Remove imagery")}</button></span></div>
		<div class="toast" id="tl-toast"></div>`);
	const $ = (id) => side.querySelector(id);
	const status = (s) => { $("#tl-status").textContent = s; };
	const toast = (s) => { const el = $("#tl-toast"); el.textContent = s; el.classList.add("on"); setTimeout(() => el.classList.remove("on"), 1400); };

	const foot = createFootprint(map, mapEl);
	let items = [], sel = -1, ac = null, cogCtl = null, lastClick = null, metricsTimer = null;
	const urls = new Map();   // scene id → {url, ts}（署名 URL は 1 時間＝50 分まで使い回す・クイックルックと本番読みで共用）
	const freshUrl = async (it) => {
		const u = urls.get(it.id);
		if (u && Date.now() - u.ts < 50 * 60e3) return u.url;
		const { url } = await cogUrl(src, it.id);
		urls.set(it.id, { url, ts: Date.now() }); return url;
	};
	const drawOpts = () => cogOpts(src, { pol });                       // 見せ方（openCog オプション）
	const drawSig = () => (src.pol ? pol : "") + (src.cog ? JSON.stringify(src.cog) : "");   // 見せ方の指紋（クイックルックの鍵）

	const applySrc = (k, { keepItems = false } = {}) => {
		src = DATASETS[k];
		side.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.k === k));
		const [a, b] = defaultRange(src); $("#tl-from").value = a; $("#tl-to").value = b;
		$("#tl-credit").textContent = src.credit;
		$("#tl-polrow").hidden = !src.pol;
		$("#tl-hint").textContent = t(src.global ? "One global sheet per date. Step ◀▶ to watch the seasons move across the sea." : "Click the map to find scenes that cover that spot.");
		applyPol(pol);
		if (!keepItems) { items = []; sel = -1; $("#tl-list").replaceChildren(); nav(); }
	};
	const applyPol = (p) => { pol = p; side.querySelectorAll(".seg").forEach(b => b.classList.toggle("on", b.dataset.pol === p)); };
	const nav = () => {
		$("#tl-prev").disabled = !(sel > 0); $("#tl-next").disabled = !(sel >= 0 && sel < items.length - 1);
		$("#tl-n").textContent = items.length ? `${sel + 1} / ${items.length} ${t("scenes")}` : "";
		$("#tl-fit").disabled = sel < 0;
	};
	// 選択＝class の付け替えだけ（⚠一覧を作り直さない＝描き終わったサムネイルの canvas を捨てない・進行中の描画が外れた canvas に向かない）
	const select = (i) => {
		sel = i;
		[...$("#tl-list").children].forEach((row, k) => row.classList.toggle("on", k === i));
		nav();
	};
	const bboxOf = (g) => {
		const ring = foot.ringOf(g); if (!ring) return null;
		let w = 1e9, s = 1e9, e = -1e9, n = -1e9;
		for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
		return [w, s, e, n];
	};

	// クイックルック＝最粗 overview を経緯度グリッドへ（幅 56px・高さは緯度で補正）。失敗しても行は残す（灰のまま）。
	// 描けたら IDB へ（鍵＝ds/scene/見せ方）＝再訪・タブ往復・偽色⇄グレーの二度目は署名 URL の発行すら要らない
	// 描けた絵は item（_thumb）にも持つ＝一覧を作り直す時（検索し直し以外では起きない）も即再描画。描く先は「今の」canvas（it._cv）
	const paint = (cv, { w, h, rgba }) => { if (!cv) return; cv.width = w; cv.height = h; cv.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0); };
	const quickLook = async (it, sig) => {
		const key = `${src.key}/${it.id}/${drawSig()}`;
		try {
			if (it._thumb?.key === key) { paint(it._cv, it._thumb); return; }
			const hit = await quickDb.get(key);
			if (hit?.rgba) { if (!sig?.aborted) { it._thumb = { key, ...hit }; paint(it._cv, it._thumb); } return; }
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
		} catch (e) { if (e?.name !== "AbortError") console.warn("[tellus] quicklook", it.id, e.message); }
	};

	const render = () => {
		const list = $("#tl-list"); list.replaceChildren();
		items.forEach((it, i) => {
			const row = document.createElement("button");
			row.className = "scene" + (i === sel ? " on" : "");
			const sub = src.cloud ? `${t("cloud")} ${it.cloud >= 0 ? Math.round(it.cloud) + "%" : "?"}` : [src.sub ? t(src.sub) : it.sub, orbitLabel(it.props, t)].filter(Boolean).join(" ");
			row.innerHTML = `<canvas width="56" height="56"></canvas><span><span class="d">${it.date}</span><br><span class="c">${sub}</span></span>`;
			row.addEventListener("mouseenter", () => { if (!src.global) foot.set(it.geometry); });   // 全球 1 枚は枠を出さない（画面全部が枠）
			row.addEventListener("mouseleave", () => foot.set(null));
			row.addEventListener("click", () => load(i, { fit: false }));
			list.append(row);
			it._cv = row.querySelector("canvas");
			if (it._thumb) paint(it._cv, it._thumb);
		});
		nav();
	};
	// クイックルックは 3 並列（署名 URL 発行 + ヘッダ + overview ＝ 1 行 3 往復・IDB 命中なら 0 往復）
	let thumbAc = null;
	const thumbs = async () => {
		thumbAc?.abort(); thumbAc = new AbortController();
		const sig = thumbAc.signal, queue = items.slice();
		await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length && !sig.aborted) { const it = queue.shift(); await quickLook(it, sig); } }));
	};

	const search = async (ll, { autoLoad = true, fit = false } = {}) => {
		lastClick = ll;
		ac?.abort(); ac = new AbortController();
		status(t("Searching…")); items = []; sel = -1; render();
		try {
			items = (await searchScenes(src, { c: ll, from: $("#tl-from").value, to: $("#tl-to").value, signal: ac.signal })).slice(0, 12);
			status(items.length ? "" : t("No scenes found (widen the period or click elsewhere)"));
			render();
			if (items.length && autoLoad) load(0, { fit });
			thumbs();
		} catch (e) { if (e?.name !== "AbortError") { console.warn("[tellus] search", e); status(t("Search failed")); } }
	};

	const load = async (i, { fit = false } = {}) => {
		if (!items[i]) return;
		select(i); status(t("Loading…"));
		const it = items[i];
		try {
			const url = await freshUrl(it);
			const renew = renewingFetch(url, async () => { urls.delete(it.id); return freshUrl(it); });
			// cacheKey＝データセット/シーン＝生タイルのメモリキャッシュの鍵（署名 URL は発行ごとに変わる＝URL では鍵にならない）
			cogCtl = await map.gadget.cog(url, { fit, fetch: renew, cacheKey: `${src.key}/${it.id}`, ...drawOpts() });
			if (sel !== i) return;   // 読んでいる間に別の行へ移った＝古い方の後始末はしない（新しい load が上書き済み）
			status(""); shareUrl(it);
			if (!metricsTimer) metricsTimer = setInterval(showMetrics, 1000);
			showMetrics();
		} catch (e) { if (sel === i) status(t("Search failed") + ": " + e.message); }
	};
	const showMetrics = () => {
		const m = cogCtl?.metrics?.(); if (!m) return;
		$("#tl-metrics").textContent = `${t("Range requests")} ${m.rangeRequests}・${t("Received")} ${(m.bytesFetched / 1e6).toFixed(1)} MB・${t("Header")} ${Math.round(m.ttfhMs)} ms・${t("cache")} ${m.cacheHits}/${((m.rawCacheBytes || 0) / 1e6).toFixed(0)} MB`;
	};
	const shareUrl = (it) => {
		const u = new URL(location.href); u.searchParams.set("ds", src.key); u.searchParams.set("scene", it.id);
		if (src.pol && pol === "gray") u.searchParams.set("pol", "gray"); else u.searchParams.delete("pol");
		u.searchParams.delete("tellusapi");
		const h = location.hash || map.view?.hash || "";   // 視点の hash はエンジン（urlHash）がカメラ移動のたびに書く＝動かす前は view.hash から
		history.replaceState(null, "", u.pathname + u.search + h);
	};

	// ---- 配線 ----
	side.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => { if (b.dataset.k === src.key) return; applySrc(b.dataset.k); if (lastClick) search(lastClick); }));
	side.querySelectorAll(".seg").forEach(b => b.addEventListener("click", () => {   // 偽色⇄グレー＝同じシーンを見せ方だけ変えて載せ直す（生タイルはキャッシュ済＝通信なし）
		if (b.dataset.pol === pol) return;
		applyPol(b.dataset.pol);
		if (sel >= 0) load(sel, { fit: false });
		thumbs();
	}));
	const step = (d) => { const i = sel + d; if (items[i]) load(i, { fit: false }); };
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
	$("#tl-opac").addEventListener("input", e => map.setOpacity?.({ base: (+e.target.value) / 100 }));
	map.setOpacity?.({ base: 0.55 });   // 衛星画像を主役に＝基図の線は少し引く（スライダーで戻せる）
	$("#tl-share").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText(location.href); toast(t("Copied")); } catch { prompt("URL", location.href); }
	});
	side.querySelectorAll("#tl-from, #tl-to").forEach(el => el.addEventListener("change", () => { if (lastClick) search(lastClick); }));
	// 地図クリック＝その地点で検索（エンジンのクリック横取り＝4px のドラッグ弁別は済んでいる）
	map.setEditClick((x, y) => { const ll = map.unprojectXY(x, y); if (ll) search(ll); });

	// ---- 起動 ----
	applySrc(src.key);
	const sceneId = q.get("scene");
	if (sceneId) {   // 共有 URL＝そのシーンを復元（視点は hash が持つ＝寄せない。hash 無しなら寄せる）
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
	return { search, load, get items() { return items; }, get selected() { return sel; }, get pol() { return pol; }, setPol: (p) => { applyPol(p); if (sel >= 0) load(sel, { fit: false }); thumbs(); } };
}
