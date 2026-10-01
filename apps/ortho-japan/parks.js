// 日本の国立公園 35 の showcase（parks.html から遅延 import）。
// models（名所 3D 模型）と同じ骨格：器＝parks.html／一覧・飛行・配線＝ここ／描画＝エンジンの addGint（外周）＋ spotlight（選択）＋ outline（ホバー）。
//
// 台帳＝public/parks.json（scripts/parks-ledger で組む・名前 26 言語＝Wikidata／写真＝Wikimedia Commons／面積・指定日・都道府県＝環境省）。
// 外周＝public/parks.geopbf（環境省 nps_all の地種区分 1.1 万面を公園ごとに溶かした 35 面・0.2MB）＝全公園を薄い緑で常時描き、
// 選んだ公園は spotlight（周りを暗く・その形だけ素の地図）で指す。写真と Wikipedia の本文は実行時に直読み（bucket に置かない＝直接取れる物は置かない方針）。
// 一覧のカード＝写真そのもの（Commons のサムネ）。クリック＝①視点へ飛ぶ ②spotlight ③詳細（写真大・指定日・面積・都道府県・Wikipedia の冒頭・リンク）。
// ?p=<id> で起動時に選ぶ（共有）。←/→ で隣の公園・Esc で一覧へ。
import { tr, setLang, getLang, loadPage } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない
const t = tr();

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const REGIONS = ["hokkaido", "tohoku", "kanto", "chubu", "kinki", "chugoku-shikoku", "kyushu-okinawa"];   // 並び＝北から南
// 地方の名＝訳のキーを**リテラルで** t() に渡す（i18n の走査器は t("…") の文字列だけ読む）＝mount 時に一度引く
const regionNames = () => ({ hokkaido: t("Hokkaidō"), tohoku: t("Tōhoku"), kanto: t("Kantō"), chubu: t("Chūbu"), kinki: t("Kinki"), "chugoku-shikoku": t("Chūgoku & Shikoku"), "kyushu-okinawa": t("Kyūshū & Okinawa") });
const WIKI_FALLBACK = ["en", "ja"];   // 本文・リンクの言語が無い時の順（英語→日本語）

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountParks(map, geopbf, { catalog, boundary, panelHost } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/parks/${c}.json`));   // 訳を用意してから UI を組む（ページの辞書＝i18n/pages/parks.json）
	document.title = t("National Parks of Japan — ortho-japan");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Japan's 35 national parks on a 3D globe — photos, official boundaries, facts and Wikipedia links in 26 languages."));
	const mapEl = map.mapEl;
	const lang = getLang();
	const RN = regionNames();
	const L = v => (v && typeof v === "object") ? (v[lang] ?? v.en ?? v.ja ?? Object.values(v)[0] ?? "") : (v ?? "");
	const fmtN = n => Number(n).toLocaleString(lang);
	const fmtDate = s => { try { return new Date(s + "T00:00:00Z").toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }); } catch { return s; } };
	const km2 = ha => fmtN(Math.round(ha / 100));   // 陸域 ha → km²（整数）

	// 台帳
	const doc = typeof catalog === "string" ? await (await fetch(catalog, { credentials: "omit" })).json() : catalog;
	const parks = doc.parks ?? [], PN = doc.prefNames ?? {};
	const prefName = c => L(PN[c]) || c;
	const byId = new Map(parks.map(p => [p.id, p]));
	const nameOf = p => L(p.name);
	const wikiOf = p => { for (const l of [lang, ...WIKI_FALLBACK]) if (p.wiki?.[l]) return { lang: l, title: p.wiki[l] }; return null; };
	const wikiUrl = w => w ? `https://${w.lang}.wikipedia.org/wiki/${encodeURIComponent(w.title.replace(/ /g, "_"))}` : null;
	// 写真＝台帳の URL をそのまま使う（thumb＝一覧用の 960px・src＝詳細用の 1280px）。⚠ 幅を URL で差し替えてはいけない＝Commons は API で生成された幅しか配信しない（任意幅は 400・2026-10 実測）

	// ── パネル（models/quakes/sats と同じ意匠＝暗いガラス・写真の格子）──
	const panel = document.createElement("div");
	panel.className = "parks-panel";
	panel.innerHTML = `
<style>
.parks-panel{position:absolute;top:12px;left:12px;z-index:30;width:420px;max-width:calc(100% - 24px);max-height:calc(100% - 24px);display:flex;flex-direction:column;
 box-sizing:border-box;border-radius:14px;background:rgba(10,15,28,.84);color:#e9eef7;overflow:hidden;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 10px 36px rgba(0,0,0,.45)}
.parks-panel *{box-sizing:border-box}
.parks-panel .head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:14px 16px 0}
.parks-panel h1{font-size:17px;margin:0;font-weight:700;letter-spacing:.02em;line-height:1.3}
.parks-panel h1 small{display:block;font-size:11px;color:#8fd3a7;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-bottom:2px}
.parks-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e9eef7;font-size:14px;line-height:1;cursor:pointer}
.parks-panel.min .body,.parks-panel.min .sub,.parks-panel.min .tools{display:none}
.parks-panel.min{padding-bottom:12px}
.parks-panel .sub{color:#9aa6bd;font-size:11.5px;padding:4px 16px 0}
.parks-panel .tools{padding:10px 16px 8px;display:flex;flex-direction:column;gap:8px}
.parks-panel .row{display:flex;gap:6px;align-items:center}
.parks-panel input[type=search]{flex:1;min-width:0;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#fff;padding:6px 10px;font:inherit;outline:none}
.parks-panel input[type=search]:focus{border-color:#8fd3a7}
.parks-panel select{border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#fff;padding:6px 8px;font:inherit;outline:none}
.parks-panel select option{color:#000}
.parks-panel .chips{display:flex;gap:5px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.parks-panel .chips::-webkit-scrollbar{display:none}
.parks-panel .chip{flex:none;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#cfd8e8;padding:3px 10px;font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.parks-panel .chip.on{background:#8fd3a7;border-color:#8fd3a7;color:#0b1021;font-weight:700}
.parks-panel .body{overflow:auto;padding:0 16px 14px;flex:1;min-height:0;scrollbar-width:thin}
.parks-panel .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.parks-panel .card{position:relative;display:block;aspect-ratio:4/3;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:#1a2236;cursor:pointer;padding:0;font:inherit;color:inherit;text-align:start;
 transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.parks-panel .card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s ease}
.parks-panel .card:hover{transform:translateY(-1px);border-color:rgba(143,211,167,.7);box-shadow:0 6px 18px rgba(0,0,0,.4)}
.parks-panel .card:hover img{transform:scale(1.05)}
.parks-panel .card.hov{border-color:rgba(255,255,255,.75)}
.parks-panel .card.on{border-color:#8fd3a7;box-shadow:0 0 0 2px rgba(143,211,167,.5)}
.parks-panel .card .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 35%,rgba(5,8,16,.86) 100%)}
.parks-panel .card .yr{position:absolute;top:6px;right:6px;border-radius:6px;background:rgba(5,8,16,.6);color:#dfe7f3;font-size:10.5px;padding:1px 6px;letter-spacing:.04em}
.parks-panel .card .txt{position:absolute;left:8px;right:8px;bottom:7px}
.parks-panel .card b{display:block;font-size:12.5px;line-height:1.3;text-shadow:0 1px 2px rgba(0,0,0,.6);overflow-wrap:anywhere}
.parks-panel .card small{display:block;color:#b9c7dc;font-size:10.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.parks-panel .empty{color:#8793aa;text-align:center;padding:24px 0}
/* 詳細 */
.parks-panel .detail{display:flex;flex-direction:column;gap:10px;animation:parks-in .22s ease}
@keyframes parks-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.parks-panel .nav{display:flex;align-items:center;justify-content:space-between;gap:6px}
.parks-panel .nav button{border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e9eef7;font:inherit;padding:4px 10px;cursor:pointer}
.parks-panel .nav button:hover{background:rgba(255,255,255,.14)}
.parks-panel .hero{position:relative;border-radius:12px;overflow:hidden;aspect-ratio:16/10;background:#1a2236;border:1px solid rgba(255,255,255,.08)}
.parks-panel .hero img{width:100%;height:100%;object-fit:cover;display:block}
.parks-panel .hero .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 45%,rgba(5,8,16,.88) 100%)}
.parks-panel .hero .ttl{position:absolute;left:14px;right:14px;bottom:12px}
.parks-panel .hero h2{margin:0;font-size:19px;line-height:1.25;text-shadow:0 1px 3px rgba(0,0,0,.7);overflow-wrap:anywhere}
.parks-panel .hero .ja{color:#c9d4e6;font-size:12px;margin-top:2px;text-shadow:0 1px 2px rgba(0,0,0,.7)}
.parks-panel .facts{display:grid;grid-template-columns:1.45fr 1fr 1fr;gap:6px}
.parks-panel .fact{border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);padding:8px 10px;min-width:0}
.parks-panel .fact small{display:block;color:#8fd3a7;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.parks-panel .fact b{display:block;font-size:13px;line-height:1.3;overflow-wrap:anywhere}
.parks-panel .fact.wide{grid-column:1 / -1}
.parks-panel .fact .pref{display:inline-block;margin:3px 4px 0 0;border-radius:6px;background:rgba(143,211,167,.14);color:#dff5e3;padding:1px 7px;font-size:11.5px;font-weight:500}
.parks-panel .extract{color:#d4dceb;font-size:12.5px;line-height:1.65;min-height:3em}
.parks-panel .extract.wait{color:#8793aa}
.parks-panel .links{display:flex;flex-wrap:wrap;gap:6px 8px}
.parks-panel .links a{display:inline-flex;align-items:center;gap:6px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#e9eef7;text-decoration:none;padding:6px 12px;font-weight:600}
.parks-panel .links a:hover{background:rgba(255,255,255,.18)}
.parks-panel .links a.wp{border-color:#8fd3a7;background:rgba(143,211,167,.16)}
.parks-panel .credit{color:#8793aa;font-size:10.5px;line-height:1.5}
.parks-panel .credit a{color:#9cc4ff}
.parks-panel .note{color:#8793aa;font-size:10.5px;line-height:1.5;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)}
.parks-panel .note a{color:#9cc4ff}
@media (max-width:640px){.parks-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:56%}.parks-panel .grid{grid-template-columns:1fr 1fr}.parks-panel .facts{grid-template-columns:1fr 1fr}}
</style>
<div class="head"><h1><small>${t("Japan")}</small>${t("National Parks of Japan")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub">${t("$1 parks. Click one to fly there — the boundaries are the Ministry of the Environment's official park areas.", fmtN(parks.length))}</div>
<div class="tools">
	<div class="row"><input type="search" data-k="q" placeholder="${t("Search parks…")}" aria-label="${t("Search parks…")}">
		<select data-k="sort" aria-label="${t("Sort")}"><option value="north">${t("North to south")}</option><option value="name">${t("Name")}</option><option value="year">${t("Year designated")}</option><option value="area">${t("Area")}</option></select></div>
	<div class="chips" data-k="chips"><button type="button" class="chip on" data-r="">${t("All")}</button>${REGIONS.map(r => `<button type="button" class="chip" data-r="${r}">${RN[r]}</button>`).join("")}</div>
</div>
<div class="body"><div data-k="list"></div><div class="note">${t("Boundaries: Ministry of the Environment, Japan (national park areas). Names and links: Wikidata. Photos: Wikimedia Commons, each with its own licence.")}</div></div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);

	// ── 一覧（検索・地方・並び）──
	let region = "", query = "", sort = "north", cur = null;
	const visible = () => {
		const q = query.trim().toLowerCase();
		let list = parks.filter(p => (!region || p.region === region) && (!q || [p.name.ja, p.name.en, nameOf(p), p.key, ...p.prefs.map(prefName)].some(s => String(s ?? "").toLowerCase().includes(q))));
		if (sort === "name") list = [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b), lang));
		else if (sort === "year") list = [...list].sort((a, b) => a.designated.localeCompare(b.designated));
		else if (sort === "area") list = [...list].sort((a, b) => b.areaHa - a.areaHa);
		return list;   // "north"＝台帳の順（北から南）
	};
	const renderList = () => {
		const list = visible();
		$("list").innerHTML = !list.length ? `<div class="empty">${t("No park matches.")}</div>` : `<div class="grid">${list.map(p => `<button type="button" class="card${p.id === cur?.id ? " on" : ""}" data-id="${esc(p.id)}" aria-label="${esc(nameOf(p))}">
			${p.photo?.src ? `<img src="${esc(p.photo.thumb || p.photo.src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}
			<span class="shade"></span><span class="yr">${p.designated.slice(0, 4)}</span>
			<span class="txt"><b>${esc(nameOf(p))}</b><small>${esc(p.prefs.map(c => prefName(c).replace(/ Prefecture$/, "")).join(" · "))}</small></span></button>`).join("")}</div>`;
	};
	const body = panel.querySelector(".body");
	body.addEventListener("click", e => {
		const b = e.target.closest(".card[data-id]"); if (b) { show(b.dataset.id); return; }
		const n = e.target.closest("[data-nav]"); if (!n) return;
		if (n.dataset.nav === "back") back(); else step(n.dataset.nav === "next" ? 1 : -1);
	});
	// ホバー＝球にその公園の輪郭（世界の国の地図と同じ作法＝選択はマスク・ホバーは線）
	body.addEventListener("pointerover", e => { const b = e.target.closest(".card[data-id]"); if (b) hover(b.dataset.id); });
	body.addEventListener("pointerleave", () => hover(null));
	$("q").addEventListener("input", e => { query = e.target.value; renderList(); });
	$("sort").addEventListener("change", e => { sort = e.target.value; renderList(); });
	$("chips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; region = c.dataset.r; for (const x of $("chips").children) x.classList.toggle("on", x === c); renderList(); });

	// ── 外周（parks.geopbf）＝全公園を薄い緑で常時・名前のラベル・ホバー/クリック ──
	let pbf = null, layer = null;
	const shapes = new Map();   // id → FeatureCollection（spotlight / outline に渡す形・初回に組む）
	const shapeOf = id => { if (shapes.has(id)) return shapes.get(id); if (!pbf) return null;
		const feats = []; for (let i = 0; i < pbf.length; i++) { let pr = null; try { pr = pbf.getProperties(i); } catch { /* 壊れ feature */ } if (pr?.id === id) feats.push(pbf.getFeature(i)); }
		const fc = feats.length ? { type: "FeatureCollection", features: feats } : null; shapes.set(id, fc); return fc; };
	(async () => {
		try {
			if (!boundary || !geopbf || !map.addGint) return;
			pbf = await geopbf(boundary, { name: "parks-boundary", gint: true });
			layer = map.addGint(pbf, { order: -4, interactive: true, minZoom: 2.5,
				label: { field: pr => { const p = byId.get(pr?.id); return p ? nameOf(p) : ""; }, size: 12, color: "#dff5e3", halo: "#0b1021", haloW: 2, minZoom: 5.2 } });
			await layer?.ready;
			await layer?.setPaint?.({ "fill-color": "rgba(90,200,130,0.20)", "line-color": "#8fd3a7", "line-width": 1.1 });
			layer?.on?.("click", e => { const id = e?.properties?.id; if (id && byId.has(id)) show(id); });
			layer?.on?.("hover", e => { const id = e?.properties?.id ?? null; for (const b of panel.querySelectorAll(".card")) b.classList.toggle("hov", b.dataset.id === id); });
			if (cur) applySpot(cur);   // 外周が後から届いた＝選択済みの公園にスポットライトを当て直す
		} catch (e) { console.warn("[parks] boundary", e); }
	})();
	let hovId = null;
	const hover = id => { if (id === hovId) return; hovId = id; const fc = id && shapeOf(id); map.gadget.outline(fc || null, { color: [1, 1, 1, 0.9], width: 2 }); };
	const applySpot = p => { const fc = shapeOf(p.id); if (fc) map.gadget.spotlight(fc, { fit: false, opacity: 0.5 }); };

	// ── 詳細 ──
	let seq = 0;
	const renderDetail = async p => {
		const my = ++seq, w = wikiOf(p), url = wikiUrl(w);
		$("list").innerHTML = `<div class="detail">
			<div class="nav"><button type="button" data-nav="back">← ${t("Back to list")}</button><span><button type="button" data-nav="prev" aria-label="${t("Previous park")}">‹</button> <button type="button" data-nav="next" aria-label="${t("Next park")}">›</button></span></div>
			<div class="hero">${p.photo?.src ? `<img src="${esc(p.photo.src)}" alt="${esc(nameOf(p))}" decoding="async" referrerpolicy="no-referrer">` : ""}<div class="shade"></div>
				<div class="ttl"><h2>${esc(nameOf(p))}</h2>${lang !== "ja" ? `<div class="ja">${esc(p.name.ja)}</div>` : ""}</div></div>
			<div class="facts">
				<div class="fact"><small>${t("Designated")}</small><b>${esc(fmtDate(p.designated))}</b></div>
				<div class="fact"><small>${t("Area")}</small><b>${t("$1 km²", km2(p.areaHa))}</b></div>
				<div class="fact"><small>${t("Region")}</small><b>${RN[p.region]}</b></div>
				<div class="fact wide"><small>${t("Prefectures")}</small>${p.prefs.map(c => `<span class="pref">${esc(prefName(c))}</span>`).join("")}</div>
			</div>
			<div class="extract wait" data-k="extract">${t("Loading…")}</div>
			<div class="links">${url ? `<a class="wp" href="${esc(url)}" target="_blank" rel="noopener">${t("Read on Wikipedia")} ↗</a>` : ""}${p.site ? `<a href="${esc(p.site)}" target="_blank" rel="noopener">${t("Official site")} ↗</a>` : ""}</div>
			${p.photo?.src ? `<div class="credit">${t("Photo: $1 ($2)", esc(p.photo.artist || "Wikimedia Commons"), p.photo.licenseUrl ? `<a href="${esc(p.photo.licenseUrl)}" target="_blank" rel="noopener">${esc(p.photo.license || "")}</a>` : esc(p.photo.license || ""))}${p.photo.page ? ` · <a href="${esc(p.photo.page)}" target="_blank" rel="noopener">Wikimedia Commons</a>` : ""}</div>` : ""}
		</div>`;
		body.scrollTop = 0;
		// Wikipedia の冒頭＝REST summary を直読み（CORS 可・資格情報なし）。自分の言語 → 英語 → 日本語
		const el = $("extract");
		for (const l of [...new Set([lang, ...WIKI_FALLBACK])]) {
			const title = p.wiki?.[l]; if (!title) continue;
			try {
				const r = await fetch(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, { credentials: "omit", headers: { Accept: "application/json" } });
				if (my !== seq) return;
				if (!r.ok) continue;
				const j = await r.json();
				if (my !== seq) return;
				if (j?.extract) { el.textContent = j.extract; el.classList.remove("wait"); return; }
			} catch { /* 次の言語へ */ }
		}
		if (my === seq && el) { el.textContent = ""; el.classList.remove("wait"); }
	};
	function show(id, { fly = true } = {}) {
		const p = byId.get(id); if (!p) return;
		cur = p; hover(null);
		renderDetail(p);
		applySpot(p);
		if (fly) {
			// 寄り先＝外周の矩形。少し傾けて眺める（山岳公園は地形が立つ）＝傾きの分だけ一段引く。大きな公園（瀬戸内海）も収まる
			const bb = p.bbox, z = Math.min(11, map.fitZoomForBbox(bb) - 0.35);
			map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, z, 42, 0);
		}
		try { const u = new URL(location.href); u.searchParams.set("p", id); history.replaceState(null, "", u); } catch { /* 埋め込み先で URL を触れない */ }
	}
	function back() {
		cur = null; seq++;
		map.gadget.spotlight(null);
		renderList();
		try { const u = new URL(location.href); u.searchParams.delete("p"); history.replaceState(null, "", u); } catch { /* 同上 */ }
	}
	function step(d) {
		const list = visible(); if (!list.length) return;
		const i = Math.max(0, list.findIndex(p => p.id === cur?.id));
		show(list[(i + d + list.length) % list.length].id);
	}
	const onKey = e => { if (e.target.closest?.("input,select,textarea")) return; if (!cur) return;
		if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "Escape") back(); else return; e.preventDefault(); };
	window.addEventListener("keydown", onKey);

	renderList();
	const first = new URLSearchParams(location.search).get("p");
	if (first && byId.has(first)) show(first);

	return {
		parks, show, back,
		get current() { return cur; },
		get layer() { return layer; },
		destroy() { seq++; window.removeEventListener("keydown", onKey); map.gadget.spotlight(null); map.gadget.outline(null); layer?.remove?.(); panel.remove(); },
	};
}
