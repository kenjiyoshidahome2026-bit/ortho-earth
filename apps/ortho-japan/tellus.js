// Tellus × ortho-earth の案内板と配線（tellus.html から遅延 import）。
// 「地図をクリック → その地点のシーン一覧 → クリックで地形の上にドレープ → ◀▶ で同じ場所の別日」。
// データの読み口は gadgets/tellus-api.js（stac ガジェットと共用）、ドレープは map.gadget.cog（エンジン側の COG スロット）。
// クイックルック（行のサムネイル）は COG の最粗 overview を Range 1〜2 本で描く＝サムネイル API が無くても出せる
//（Tellus の検索応答にサムネイルが無い・AVNIR-2 の thumb.png は署名 URL 要＝どのみち 1 往復）。
import { tr } from "./i18n.js";
import { DATASETS, defaultRange, searchScenes, getScene, cogUrl, renewingFetch, orbitLabel } from "./gadgets/tellus-api.js";
import { createFootprint } from "./gadgets/footprint.js";
import { openCog, lonlatTarget } from "geopbf/cog/core";   // クイックルック＝DOM 不要経路（worker 無し・最粗 overview だけ）

const t = tr({
	"衛星データを、サーバなしで地球儀へ": "Satellite data on a 3D globe, with no server",
	"地図をクリックすると、その地点が写っているシーンを探します。": "Click the map to find scenes that cover that spot.",
	"期間": "Period",
	"検索中…": "Searching…",
	"シーンが見つかりません（期間を広げるか、別の地点をクリック）": "No scenes found (widen the period or click elsewhere)",
	"検索に失敗しました": "Search failed",
	"読込中…": "Loading…",
	"件": "scenes",
	"前の日付": "Previous date", "次の日付": "Next date",
	"この場所に寄る": "Zoom to scene",
	"画像を消す": "Remove imagery",
	"地図の線": "Map lines",
	"共有リンクをコピー": "Copy share link",
	"コピーしました": "Copied",
	"この画面の裏側": "How this works",
	"次のステップ（Tellus へのお願い）": "Next steps (asks for Tellus)",
	"雲": "cloud", "上昇": "asc", "下降": "desc",
	"L バンド SAR・HH 偏波・オルソ補正済（2016〜）": "L-band SAR, HH polarisation, ortho-corrected (2016–)",
	"光学 10 m・真色（2006〜2011）": "Optical 10 m, true colour (2006–2011)",
	"背景": "How",
	"Range 要求": "Range requests", "受信": "Received", "ヘッダ": "Header",
});

const BACK = {
	ja: [
		"衛星画像はタイル化していません。Tellus が置いている <b>Cloud Optimized GeoTIFF</b>（*_webcog.tif）を、ブラウザが <b>HTTP Range</b> で必要な部分だけ読んでいます。384 MB のシーンでも最初の表示は数百 KB です。",
		"読んだ画素はその場で経緯度に並べ直し、<b>地形（DEM10B）の上にドレープ</b>します。傾けると立体になるのはそのためです。",
		"Tellus の API にはブラウザから直接触れない（CORS 無し・要トークン）ので、小さな中継（Cloudflare Worker）がトークンを付けて検索と署名 URL 発行だけを代行しています。画像のバイトは中継を素通りするだけです。",
	],
	en: [
		"Nothing is pre-tiled. The browser reads Tellus's own <b>Cloud Optimized GeoTIFF</b> (*_webcog.tif) with <b>HTTP Range</b> requests, fetching only what the view needs — a 384 MB scene first appears after a few hundred KB.",
		"Pixels are re-gridded to lon/lat on the fly and <b>draped over terrain (DEM10B)</b>, which is why tilting shows relief.",
		"Tellus's API is not reachable from a browser (no CORS, token required), so a tiny relay (Cloudflare Worker) adds the token for search and signed-URL issuance only. Image bytes just pass through it.",
	],
};
const NEXT = {
	ja: [
		"署名 URL の CORS が <code>tellusxdp.com</code> 固定です。<code>Access-Control-Allow-Origin: *</code> になれば中継なしでブラウザが直接読めます。",
		"検索応答にサムネイルがありません。この画面は COG の overview から作っていますが、STAC の <code>assets.thumbnail</code> があれば一覧が一瞬で出ます。",
		"Traveler API は STAC にとても近い形です。<code>/stac</code> 互換の入口が一つあれば、ortho-earth に限らず既存の STAC クライアントがそのまま Tellus を引けます。",
		"「Tellus 環境でのみ利用可」のデータ（ASNARO・PALSAR-2 L2.1 など）は外から 403 です。表示だけの用途を認める区分があると、この画面にそのまま並びます。",
	],
	en: [
		"Signed URLs pin CORS to <code>tellusxdp.com</code>. With <code>Access-Control-Allow-Origin: *</code> the browser could read them directly, no relay.",
		"Search responses carry no thumbnails; this page renders them from the COG overviews. A STAC <code>assets.thumbnail</code> would make the list instant.",
		"The Traveler API is already very close to STAC. A <code>/stac</code>-compatible entry point would let any STAC client, not just ortho-earth, query Tellus as-is.",
		"Datasets marked “Tellus environment only” (ASNARO, PALSAR-2 L2.1, …) return 403 from outside. A view-only tier would let them appear here unchanged.",
	],
};

const CSS = `
#side { font-size: 13px; }
#side h1 { margin: 0; padding: 14px 16px 2px; font-size: 17px; letter-spacing: .01em; }
#side h1 small { display: block; font-size: 11.5px; font-weight: 400; color: #6b7385; margin-top: 2px; }
#side .tabs { display: flex; gap: 6px; padding: 10px 16px 0; }
#side .tab { flex: 1; border: 1px solid #cdd3dd; background: #fff; border-radius: 9px; padding: 7px 8px; cursor: pointer; font: inherit; color: inherit; text-align: left; line-height: 1.3; }
#side .tab b { display: block; font-size: 13px; }
#side .tab span { display: block; font-size: 10.5px; color: #6b7385; }
#side .tab.on { border-color: #3f4757; background: #eef1f6; }
#side .row { display: flex; gap: 6px; align-items: center; padding: 8px 16px 0; flex-wrap: wrap; }
#side .row label { color: #6b7385; font-size: 11.5px; }
#side input[type=date] { flex: 1; min-width: 0; font: 12px system-ui; color: inherit; border: 1px solid #cdd3dd; border-radius: 6px; padding: 3px 5px; background: #fff; }
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

export async function mountTellus(map, side) {
	const lang = document.documentElement.lang === "en" ? "en" : "ja";
	const mapEl = map.mapEl;
	const st = document.createElement("style"); st.textContent = CSS; side.append(st);
	const q = new URLSearchParams(location.search);
	let src = DATASETS[q.get("ds")] || DATASETS.palsar2;   // 主役＝PALSAR-2（L バンド SAR を地形に載せる珍しさ）

	side.insertAdjacentHTML("beforeend", `
		<h1>Tellus × ortho-earth<small>${t("衛星データを、サーバなしで地球儀へ")}</small></h1>
		<div class="tabs">
			<button class="tab" data-k="palsar2"><b>PALSAR-2</b><span>${t("L バンド SAR・HH 偏波・オルソ補正済（2016〜）")}</span></button>
			<button class="tab" data-k="avnir2"><b>AVNIR-2</b><span>${t("光学 10 m・真色（2006〜2011）")}</span></button>
		</div>
		<div class="row"><label>${t("期間")}</label><input type="date" id="tl-from"><span>–</span><input type="date" id="tl-to"></div>
		<div class="hint">${t("地図をクリックすると、その地点が写っているシーンを探します。")}</div>
		<div class="status" id="tl-status"></div>
		<div class="list" id="tl-list"></div>
		<div class="nav">
			<button id="tl-prev" title="${t("前の日付")}" aria-label="${t("前の日付")}">◀</button>
			<span class="n" id="tl-n"></span>
			<button id="tl-next" title="${t("次の日付")}" aria-label="${t("次の日付")}">▶</button>
			<button id="tl-fit">${t("この場所に寄る")}</button>
		</div>
		<div class="opac"><span>${t("地図の線")}</span><input type="range" id="tl-opac" min="0" max="100" value="55"></div>
		<details><summary>${t("この画面の裏側")}</summary><ul>${BACK[lang].map(x => `<li>${x}</li>`).join("")}</ul><div class="metrics" id="tl-metrics"></div></details>
		<details><summary>${t("次のステップ（Tellus へのお願い）")}</summary><ul>${NEXT[lang].map(x => `<li>${x}</li>`).join("")}</ul></details>
		<div class="foot"><span id="tl-credit"></span><span><button class="share" id="tl-share">${t("共有リンクをコピー")}</button> <button id="tl-clear">${t("画像を消す")}</button></span></div>
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

	const applySrc = (k, { keepItems = false } = {}) => {
		src = DATASETS[k];
		side.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.k === k));
		const [a, b] = defaultRange(src); $("#tl-from").value = a; $("#tl-to").value = b;
		$("#tl-credit").textContent = src.credit;
		if (!keepItems) { items = []; sel = -1; $("#tl-list").replaceChildren(); nav(); }
	};
	const nav = () => {
		$("#tl-prev").disabled = !(sel > 0); $("#tl-next").disabled = !(sel >= 0 && sel < items.length - 1);
		$("#tl-n").textContent = items.length ? `${sel + 1} / ${items.length} ${t("件")}` : "";
		$("#tl-fit").disabled = sel < 0;
	};
	const bboxOf = (g) => {
		const ring = foot.ringOf(g); if (!ring) return null;
		let w = 1e9, s = 1e9, e = -1e9, n = -1e9;
		for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
		return [w, s, e, n];
	};

	// クイックルック＝最粗 overview を経緯度グリッドへ（幅 56px・高さは緯度で補正）。失敗しても行は残す（灰のまま）
	const quickLook = async (it, cv, sig) => {
		try {
			const url = await freshUrl(it);
			const cog = await openCog(url, { signal: sig });
			const [w, s, e, n] = cog.bboxLL, cy = (s + n) / 2;
			const W = 56, H = Math.max(16, Math.min(56, Math.round(W * (n - s) / Math.max((e - w) * Math.cos(cy * Math.PI / 180), 1e-9))));
			const rgba = await cog.render(lonlatTarget([w, s, e, n], W, H), { signal: sig });
			cog.close?.();
			if (!rgba || sig?.aborted) return;
			cv.width = W; cv.height = H;
			cv.getContext("2d").putImageData(new ImageData(rgba, W, H), 0, 0);
		} catch (e) { if (e?.name !== "AbortError") console.warn("[tellus] quicklook", it.id, e.message); }
	};

	const render = () => {
		const list = $("#tl-list"); list.replaceChildren();
		items.forEach((it, i) => {
			const row = document.createElement("button");
			row.className = "scene" + (i === sel ? " on" : "");
			const sub = src.cloud ? `${t("雲")} ${it.cloud >= 0 ? Math.round(it.cloud) + "%" : "?"}` : [it.sub, orbitLabel(it.props, t)].filter(Boolean).join(" ");
			row.innerHTML = `<canvas width="56" height="56"></canvas><span><span class="d">${it.date}</span><br><span class="c">${sub}</span></span>`;
			row.addEventListener("mouseenter", () => foot.set(it.geometry));
			row.addEventListener("mouseleave", () => foot.set(null));
			row.addEventListener("click", () => load(i, { fit: false }));
			list.append(row);
			it._cv = row.querySelector("canvas");
		});
		nav();
	};
	// クイックルックは 3 並列（署名 URL 発行 + ヘッダ + overview ＝ 1 行 3 往復）
	const thumbs = async (sig) => {
		const queue = items.slice();
		await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length && !sig.aborted) { const it = queue.shift(); await quickLook(it, it._cv, sig); } }));
	};

	const search = async (ll, { autoLoad = true, fit = false } = {}) => {
		lastClick = ll;
		ac?.abort(); ac = new AbortController();
		status(t("検索中…")); items = []; sel = -1; render();
		try {
			items = (await searchScenes(src, { c: ll, from: $("#tl-from").value, to: $("#tl-to").value, signal: ac.signal })).slice(0, 12);
			status(items.length ? "" : t("シーンが見つかりません（期間を広げるか、別の地点をクリック）"));
			render();
			if (items.length && autoLoad) load(0, { fit });
			thumbs(ac.signal);
		} catch (e) { if (e?.name !== "AbortError") { console.warn("[tellus] search", e); status(t("検索に失敗しました")); } }
	};

	const load = async (i, { fit = false } = {}) => {
		if (!items[i]) return;
		sel = i; render(); status(t("読込中…"));
		const it = items[i];
		try {
			const url = await freshUrl(it);
			const renew = renewingFetch(url, async () => { urls.delete(it.id); return freshUrl(it); });
			cogCtl = await map.gadget.cog(url, { fit, fetch: renew });
			status(""); shareUrl(it);
			if (!metricsTimer) metricsTimer = setInterval(showMetrics, 1000);
			showMetrics();
		} catch (e) { status(t("検索に失敗しました") + ": " + e.message); }
	};
	const showMetrics = () => {
		const m = cogCtl?.metrics?.(); if (!m) return;
		$("#tl-metrics").textContent = `${t("Range 要求")} ${m.rangeRequests}・${t("受信")} ${(m.bytesFetched / 1e6).toFixed(1)} MB・${t("ヘッダ")} ${Math.round(m.ttfhMs)} ms`;
	};
	const shareUrl = (it) => {
		const u = new URL(location.href); u.searchParams.set("ds", src.key); u.searchParams.set("scene", it.id);
		u.searchParams.delete("tellusapi");
		const h = location.hash || map.view?.hash || "";   // 視点の hash はエンジン（urlHash）がカメラ移動のたびに書く＝動かす前は view.hash から
		history.replaceState(null, "", u.pathname + u.search + h);
	};

	// ---- 配線 ----
	side.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => { applySrc(b.dataset.k); if (lastClick) search(lastClick); }));
	$("#tl-prev").addEventListener("click", () => load(sel - 1, { fit: false }));
	$("#tl-next").addEventListener("click", () => load(sel + 1, { fit: false }));
	$("#tl-fit").addEventListener("click", () => {
		const bb = items[sel] && bboxOf(items[sel].geometry); if (!bb) return;
		const z = map.fitZoomForBbox([bb[0] - (bb[2] - bb[0]) * .15, bb[1] - (bb[3] - bb[1]) * .15, bb[2] + (bb[2] - bb[0]) * .15, bb[3] + (bb[3] - bb[1]) * .15]);
		map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(3, Math.min(17, z)), 0, 0);
	});
	$("#tl-clear").addEventListener("click", () => { cogCtl?.clear(); sel = -1; render(); });
	$("#tl-opac").addEventListener("input", e => map.setOpacity?.({ base: (+e.target.value) / 100 }));
	map.setOpacity?.({ base: 0.55 });   // 衛星画像を主役に＝基図の線は少し引く（スライダーで戻せる）
	$("#tl-share").addEventListener("click", async () => {
		try { await navigator.clipboard.writeText(location.href); toast(t("コピーしました")); } catch { prompt("URL", location.href); }
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
			thumbs(new AbortController().signal);
		} catch (e) { console.warn("[tellus] share restore", e); status(t("検索に失敗しました")); }
	} else {   // 初回＝画面中心（東京）で検索し、最新のシーンをそのまま載せる（視点は据え置き＝傾けた初期視点のまま立体で見せる）
		const c = map.unprojectXY(mapEl.clientWidth / 2, mapEl.clientHeight / 2) || [139.75, 35.68];
		search(c, { autoLoad: true, fit: false });
	}
	return { search, load, get items() { return items; }, get selected() { return sel; } };
}
