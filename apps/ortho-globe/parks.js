// アメリカ合衆国の国立公園 63 の showcase（parks.html から遅延 import）＝/japan/parks（apps/ortho-japan/parks.js）と同型の器を世界側に。
// 骨格：器＝parks.html／一覧・飛行・配線＝ここ／描画＝エンジンの addGint（外周）＋ spotlight（選択）＋ outline（ホバー）。
//
// 台帳＝public/parks-us.json（scripts/parks-ledger で組む・名前 26 言語＝Wikidata／写真＝Wikimedia Commons／指定日・面積・来訪者・州＝NPS（英語版 Wikipedia の一覧経由））。
// 外周＝public/parks-us.geopbf（NPS Land Resources Division の境界・パブリックドメイン・公園 63＋付属の保護区（Preserve）7＝70 面・0.14MB）
// ＝全公園を薄い緑で常時描き（Preserve はさらに薄く）、選んだ公園は spotlight（周りを暗く・その形だけ素の地図）で指す。
// 写真と Wikipedia の本文は実行時に直読み（直接取れる物は置かない方針）。Wikipedia の記事＝頁の上の iframe（共通の芯 @ortho-earth/globe/wiki.js）。
// 「他の NPS ユニット」＝国立公園以外の 380（国定記念物・史跡・海岸・保養地…）を public/nps-units.geopbf（0.11MB）から押した時だけ読む（日本版の地種区分と同じ口）。
// ?p=<id> で起動時に選ぶ（共有）。←/→ で隣の公園・Esc で一覧へ。
import { tr, getLang, LANGUAGES } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない。辞書は startPage（page.js）が足す
import { createWikiFrame, summaryIn, langChain, pickTitle, wikiUrl as wikiHref, DEFAULT_FALLBACK as WIKI_FALLBACK } from "@ortho-earth/globe/wiki.js";   // Wikipedia＝枠・冒頭・URL の共通の芯
const t = tr();

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// 地域＝NPS の 7 地方のうち国立公園を持つ 6（首都圏 NCR には無い）。並び＝西から東（台帳の順も同じ）
const REGIONS = ["alaska", "pacific-west", "intermountain", "midwest", "southeast", "northeast"];
// 地域の名＝訳のキーを**リテラルで** t() に渡す（i18n の走査器は t("…") の文字列だけ読む）＝mount 時に一度引く
const regionNames = () => ({ alaska: t("Alaska"), "pacific-west": t("Pacific West"), intermountain: t("Intermountain"), midwest: t("Midwest"), southeast: t("Southeast"), northeast: t("Northeast") });
// 他の NPS ユニットの種別（nps-units.geopbf の属性 group）＝色は性格ごと。国立公園本体の緑とは別の色相
const UNITS = [["monument", "#c98a2b", 0.45], ["historic", "#b05a7a", 0.40], ["shore", "#3a8fd0", 0.45], ["recreation", "#7a9a3a", 0.40], ["preserve", "#6a8a5a", 0.35], ["trail", "#8a6ad0", 0.40], ["other", "#9e9e9e", 0.35]];
const unitNames = () => ({ monument: t("National monuments"), historic: t("Historic sites, memorials & battlefields"), shore: t("Seashores, lakeshores & rivers"), recreation: t("Recreation areas"), preserve: t("Preserves & reserves"), trail: t("Trails & parkways"), other: t("Other designations") });
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountParks(map, geopbf, { catalog, boundary, units, panelHost } = {}) {
	document.title = t("National Parks of the United States — ortho-globe");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("All 63 national parks of the United States on a 3D globe — photos, the National Park Service's boundaries, facts and Wikipedia links in 26 languages."));
	const mapEl = map.mapEl;
	const lang = getLang();
	const RN = regionNames(), UN = unitNames();
	const L = v => (v && typeof v === "object") ? (v[lang] ?? v.en ?? v.ja ?? Object.values(v)[0] ?? "") : (v ?? "");
	const fmtN = n => Number(n).toLocaleString(lang);
	const fmtDate = s => { try { return new Date(s + "T00:00:00Z").toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }); } catch { return s; } };
	const km2 = v => fmtN(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);   // 小さな公園（Gateway Arch 0.8 km²）は小数 1 桁

	// 台帳
	const doc = typeof catalog === "string" ? await (await fetch(catalog, { credentials: "omit" })).json() : catalog;
	const parks = doc.parks ?? [], SN = doc.stateNames ?? {};
	const stateName = c => L(SN[c]) || c;
	const byId = new Map(parks.map(p => [p.id, p]));
	const nameOf = p => L(p.name);
	const WIKI_LANGS = langChain(lang, WIKI_FALLBACK);   // 自分の言語 → 英語 → 日本語
	const wikiOf = p => pickTitle(p.wiki, WIKI_LANGS);
	const wikiUrl = w => w ? wikiHref(w.title, w.lang) : null;
	// 写真＝台帳の URL をそのまま使う（thumb＝一覧用・src＝詳細用の 1280px）。⚠ 幅を URL で差し替えてはいけない＝Commons は API で生成された幅しか配信しない

	// ── パネル（japan の parks と同じ意匠＝暗いガラス・写真の格子）──
	const panel = document.createElement("div");
	panel.className = "parks-panel";
	panel.innerHTML = `
<style>
.parks-panel{position:absolute;top:12px;inset-inline-start:12px;z-index:30;width:420px;max-width:calc(100% - 24px);max-height:calc(100% - 24px);display:flex;flex-direction:column;
 box-sizing:border-box;border-radius:14px;background:rgba(10,15,28,.84);color:#e9eef7;overflow:hidden;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
 font:12.5px/1.55 system-ui,"Segoe UI",Roboto,"Noto Sans","Noto Sans JP",sans-serif;box-shadow:0 10px 36px rgba(0,0,0,.45)}
.parks-panel *{box-sizing:border-box}
.parks-panel .head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:14px 16px 0}
.parks-panel h1{font-size:17px;margin:0;font-weight:700;letter-spacing:.02em;line-height:1.3}
.parks-panel h1 small{display:block;font-size:11px;color:#8fd3a7;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-bottom:2px}
.parks-panel .lang{flex:none;max-width:120px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e9eef7;padding:4px 6px;font:inherit;font-size:11.5px;outline:none}
.parks-panel .lang option{color:#000}
.parks-panel .units{flex:none;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#cfd8e8;padding:5px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.parks-panel .units.on{background:#8fd3a7;border-color:#8fd3a7;color:#0b1021;font-weight:700}
.parks-panel .units[aria-busy="true"]{opacity:.6;cursor:progress}
.parks-panel .legend{display:none;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:#cfd8e8}
.parks-panel .legend.on{display:flex}
.parks-panel .legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-inline-end:4px;border:1px solid rgba(255,255,255,.25)}
.parks-panel .ustatus{color:#9aa6bd;font-size:11px}
.parks-panel .ustatus:empty{display:none}
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
.parks-panel .card .yr{position:absolute;top:6px;inset-inline-end:6px;border-radius:6px;background:rgba(5,8,16,.6);color:#dfe7f3;font-size:10.5px;padding:1px 6px;letter-spacing:.04em}
.parks-panel .card .txt{position:absolute;left:8px;right:8px;bottom:7px}
.parks-panel .card b{display:block;font-size:12.5px;line-height:1.3;text-shadow:0 1px 2px rgba(0,0,0,.6);overflow-wrap:anywhere}
.parks-panel .card small{display:block;color:#b9c7dc;font-size:10.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.parks-panel .empty{color:#8793aa;text-align:center;padding:24px 0}
/* 詳細 */
.parks-panel .detail{display:flex;flex-direction:column;gap:10px;animation:parks-in .22s ease}
@keyframes parks-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.parks-panel .detail{animation:none}.parks-panel .card,.parks-panel .card img{transition:none}}
.parks-panel .nav{display:flex;align-items:center;justify-content:space-between;gap:6px}
.parks-panel .nav button{border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e9eef7;font:inherit;padding:4px 10px;cursor:pointer}
.parks-panel .nav button:hover{background:rgba(255,255,255,.14)}
.parks-panel .hero{position:relative;border-radius:12px;overflow:hidden;aspect-ratio:16/10;background:#1a2236;border:1px solid rgba(255,255,255,.08)}
.parks-panel .hero img{width:100%;height:100%;object-fit:cover;display:block}
.parks-panel .hero .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 45%,rgba(5,8,16,.88) 100%)}
.parks-panel .hero .ttl{position:absolute;left:14px;right:14px;bottom:12px}
.parks-panel .hero h2{margin:0;font-size:19px;line-height:1.25;text-shadow:0 1px 3px rgba(0,0,0,.7);overflow-wrap:anywhere}
.parks-panel .hero .en{color:#c9d4e6;font-size:12px;margin-top:2px;text-shadow:0 1px 2px rgba(0,0,0,.7)}
.parks-panel .facts{display:grid;grid-template-columns:1.45fr 1fr 1fr;gap:6px}
.parks-panel .fact{border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);padding:8px 10px;min-width:0}
.parks-panel .fact small{display:block;color:#8fd3a7;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.parks-panel .fact b{display:block;font-size:13px;line-height:1.3;overflow-wrap:anywhere}
.parks-panel .fact b span{display:block;color:#9aa6bd;font-size:10.5px;font-weight:400}
.parks-panel .fact.wide{grid-column:1 / -1}
.parks-panel .fact .st{display:inline-block;margin:3px 4px 0 0;border-radius:6px;background:rgba(143,211,167,.14);color:#dff5e3;padding:1px 7px;font-size:11.5px;font-weight:500}
.parks-panel .fact .st.rg{background:rgba(255,255,255,.08);color:#cfd8e8}
.parks-panel .extract{color:#d4dceb;font-size:12.5px;line-height:1.65;min-height:3em}
.parks-panel .extract.wait{color:#8793aa}
.parks-panel .links{display:flex;flex-wrap:wrap;gap:6px 8px}
.parks-panel .links a{display:inline-flex;align-items:center;gap:6px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#e9eef7;text-decoration:none;padding:6px 12px;font-weight:600;cursor:pointer}
.parks-panel .links a:hover{background:rgba(255,255,255,.18)}
.parks-panel .links a.wp{border-color:#8fd3a7;background:rgba(143,211,167,.16)}
.parks-panel .credit{color:#8793aa;font-size:10.5px;line-height:1.5}
.parks-panel .credit a{color:#9cc4ff}
.parks-panel .note{color:#8793aa;font-size:10.5px;line-height:1.5;padding-top:8px;border-top:1px solid rgba(255,255,255,.1)}
.parks-panel .note a{color:#9cc4ff}
.oe-wiki.parks-wiki{inset-inline-start:444px;top:12px;bottom:12px;width:min(640px,calc(100% - 456px));z-index:30}
@media (max-width:640px){.parks-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:56%}.parks-panel .grid{grid-template-columns:1fr 1fr}.parks-panel .facts{grid-template-columns:1fr 1fr}
 .oe-wiki.parks-wiki{left:8px;right:8px;top:8px;bottom:8px;width:auto;z-index:31}}
</style>
<div class="head"><h1><small>${t("United States")}</small>${t("National Parks of the United States")}</h1><span class="row"><select class="lang" data-k="lang" aria-label="${t("Language")}">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></span></div>
<div class="sub">${t("$1 parks. Click one to fly there — the boundaries are the National Park Service's official park areas.", fmtN(parks.length))}</div>
<div class="tools">
	<div class="row"><input type="search" data-k="q" placeholder="${t("Search parks…")}" aria-label="${t("Search parks…")}">
		<select data-k="sort" aria-label="${t("Sort")}"><option value="west">${t("West to east")}</option><option value="name">${t("Name")}</option><option value="year">${t("Year established")}</option><option value="area">${t("Area")}</option><option value="visitors">${t("Visitors")}</option></select></div>
	<div class="row"><button type="button" class="units" data-k="units" aria-pressed="false">${t("Other NPS units")}</button><span class="ustatus" data-k="ustatus"></span></div>
	<div class="legend" data-k="legend">${UNITS.map(([k, c, a]) => `<span><i style="background:${rgba(c, Math.min(1, a + 0.3))}"></i>${esc(UN[k])}</span>`).join("")}</div>
	<div class="chips" data-k="chips"><button type="button" class="chip on" data-r="">${t("All")}</button>${REGIONS.map(r => `<button type="button" class="chip" data-r="${r}">${RN[r]}</button>`).join("")}</div>
</div>
<div class="body"><div data-k="list"></div><div class="note">${t("Boundaries: National Park Service (public domain). Facts: NPS, via Wikipedia's list of national parks. Names and links: Wikidata. Photos: Wikimedia Commons, each with its own licence.")}</div></div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	// Wikipedia の枠（記事は m. 版・↗ で別タブ・✕/Esc で閉じる）。公園を替える・一覧へ戻る＝閉じる
	const wikiFrame = createWikiFrame({ host: mapEl, className: "parks-wiki", labels: { newTab: t("Open in a new tab"), close: t("Close") } });
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);
	$("lang").addEventListener("change", e => { try { const u = new URL(location.href); u.searchParams.set("lang", e.target.value); location.replace(u.href); } catch { /* 埋め込み先 */ } });

	// ── 一覧（検索・地域・並び）──
	let region = "", query = "", sort = "west", cur = null;
	const visible = () => {
		const q = query.trim().toLowerCase();
		let list = parks.filter(p => (!region || p.region === region) && (!q || [p.name.en, nameOf(p), p.key, p.id, ...p.states.map(stateName)].some(s => String(s ?? "").toLowerCase().includes(q))));
		if (sort === "name") list = [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b), lang));
		else if (sort === "year") list = [...list].sort((a, b) => a.established.localeCompare(b.established));
		else if (sort === "area") list = [...list].sort((a, b) => b.areaKm2 - a.areaKm2);
		else if (sort === "visitors") list = [...list].sort((a, b) => (b.visitors ?? 0) - (a.visitors ?? 0));
		return list;   // "west"＝台帳の順（地域ごとに西から東）
	};
	const renderList = () => {
		const list = visible();
		$("list").innerHTML = !list.length ? `<div class="empty">${t("No park matches.")}</div>` : `<div class="grid">${list.map(p => `<button type="button" class="card${p.id === cur?.id ? " on" : ""}" data-id="${esc(p.id)}" aria-label="${esc(nameOf(p))}">
			${p.photo?.src ? `<img src="${esc(p.photo.thumb || p.photo.src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}
			<span class="shade"></span><span class="yr">${p.established.slice(0, 4)}</span>
			<span class="txt"><b>${esc(nameOf(p))}</b><small>${esc(p.states.map(stateName).join(" · "))}</small></span></button>`).join("")}</div>`;
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

	// ── 外周（parks-us.geopbf）＝全公園を薄い緑で常時（Preserve は薄く）・名前のラベル・ホバー/クリック ──
	let unitsLayer = null, unitsOn = false, unitsLoading = null;
	const BOUNDARY_PAINT = { "fill-color": ["match", ["get", "kind"], "preserve", "rgba(90,200,130,0.10)", "rgba(90,200,130,0.22)"], "line-color": "#8fd3a7", "line-width": ["match", ["get", "kind"], "preserve", 0.7, 1.1] };
	let pbf = null, layer = null;
	const shapes = new Map();   // id → FeatureCollection（spotlight / outline に渡す形・初回に組む）
	const shapeOf = id => { if (shapes.has(id)) return shapes.get(id); if (!pbf) return null;
		const feats = []; for (let i = 0; i < pbf.length; i++) { let pr = null; try { pr = pbf.getProperties(i); } catch { /* 壊れ feature */ } if (pr?.id === id) feats.push(pbf.getFeature(i)); }
		const fc = feats.length ? { type: "FeatureCollection", features: feats } : null; shapes.set(id, fc); return fc; };
	(async () => {
		try {
			if (!boundary || !geopbf || !map.addGint) return;
			pbf = await geopbf(boundary, { name: "parks-us-boundary", gint: true });
			layer = map.addGint(pbf, { order: -4, interactive: true, minZoom: 2,
				label: { field: pr => { const p = byId.get(pr?.id); return p && pr?.kind !== "preserve" ? nameOf(p) : ""; }, size: 12, color: "#dff5e3", halo: "#0b1021", haloW: 2, minZoom: 4.5 } });
			await layer?.ready;
			await layer?.setPaint?.(BOUNDARY_PAINT);
			layer?.on?.("click", e => { const id = e?.properties?.id; if (id && byId.has(id)) show(id); });
			layer?.on?.("hover", e => { const id = e?.properties?.id ?? null; for (const b of panel.querySelectorAll(".card")) b.classList.toggle("hov", b.dataset.id === id); });
			if (cur) applySpot(cur);   // 外周が後から届いた＝選択済みの公園にスポットライトを当て直す
		} catch (e) { console.warn("[parks] boundary", e); }
	})();
	// ── 他の NPS ユニット（押した時だけ nps-units.geopbf を読む・2 回目からは IDB）＝種別ごとの色で薄く重ねる ──
	const setUnits = async on => {
		unitsOn = on;
		$("units").classList.toggle("on", on); $("units").setAttribute("aria-pressed", String(on)); $("legend").classList.toggle("on", on);
		if (on && !unitsLayer && units && geopbf && map.addGint) {
			if (!unitsLoading) unitsLoading = (async () => {
				$("units").setAttribute("aria-busy", "true"); $("ustatus").textContent = t("Loading…");
				try {
					const z = await geopbf(units, { name: "nps-units", gint: true });
					const h = map.addGint(z, { order: -3, interactive: false, minZoom: 3 });
					await h?.ready;
					await h?.setPaint?.({ "fill-color": ["match", ["get", "group"], ...UNITS.flatMap(([k, c, a]) => [k, rgba(c, a)]), "rgba(0,0,0,0)"], "line-color": "rgba(255,255,255,0.35)", "line-width": 0.4 });
					unitsLayer = h;
				} catch (e) { console.warn("[parks] units", e); $("ustatus").textContent = t("Failed to load: $1", String(e?.message || e)); }
				finally { $("units").removeAttribute("aria-busy"); unitsLoading = null; }
			})();
			await unitsLoading;
			if (unitsLayer) $("ustatus").textContent = "";
		}
		unitsLayer?.setVisible?.(unitsOn);
		map.requestDraw?.();
	};
	$("units").addEventListener("click", () => setUnits(!unitsOn));
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
				<div class="ttl"><h2>${esc(nameOf(p))}</h2>${lang !== "en" ? `<div class="en">${esc(p.name.en)}</div>` : ""}</div></div>
			<div class="facts">
				<div class="fact"><small>${t("Established")}</small><b>${esc(fmtDate(p.established))}</b></div>
				<div class="fact"><small>${t("Area")}</small><b>${t("$1 km²", km2(p.areaKm2))}<span>${t("$1 acres", fmtN(Math.round(p.areaAcres)))}</span></b></div>
				<div class="fact"><small>${t("Visitors")}</small><b>${p.visitors != null ? fmtN(p.visitors) : "–"}<span>2025</span></b></div>
				<div class="fact wide"><small>${t("States")}</small><span class="st rg">${RN[p.region]}</span>${p.states.map(c => `<span class="st">${esc(stateName(c))}</span>`).join("")}</div>
			</div>
			<div class="extract wait" data-k="extract">${t("Loading…")}</div>
			<div class="links">${url ? `<a class="wp">${t("Read on Wikipedia")}</a>` : ""}${p.site ? `<a href="${esc(p.site)}" target="_blank" rel="noopener">${t("Official site")} ↗</a>` : ""}</div>
			${p.photo?.src ? `<div class="credit">${t("Photo: $1 ($2)", esc(p.photo.artist || "Wikimedia Commons"), p.photo.licenseUrl ? `<a href="${esc(p.photo.licenseUrl)}" target="_blank" rel="noopener">${esc(p.photo.license || "")}</a>` : esc(p.photo.license || ""))}${p.photo.page ? ` · <a href="${esc(p.photo.page)}" target="_blank" rel="noopener">Wikimedia Commons</a>` : ""}</div>` : ""}
		</div>`;
		body.scrollTop = 0;
		const wp = $("list").querySelector(".wp"); if (wp) wikiFrame.link(wp, url, nameOf(p));   // 枠で開く（修飾キー・非対応ブラウザ＝ブラウザの既定＝別タブ）
		// Wikipedia の冒頭＝REST summary（共通の芯・IDB 30 日）。自分の言語 → 英語 → 日本語。取れない時は台帳の一文（英語）
		const el = $("extract");
		const s = await summaryIn(p.wiki, WIKI_LANGS).catch(() => null);
		if (my !== seq) return;
		el.textContent = s?.extract || p.desc || ""; el.classList.remove("wait");
	};
	function show(id, { fly = true } = {}) {
		const p = byId.get(id); if (!p) return;
		cur = p; hover(null); wikiFrame.close();
		renderDetail(p);
		applySpot(p);
		if (fly) {
			// 寄り先＝外周の矩形。少し傾けて眺める（山岳公園は地形が立つ）＝傾きの分だけ一段引く。大きな公園（Wrangell–St. Elias）も収まる
			const bb = p.bbox, z = Math.min(11, map.fitZoomForBbox(bb) - 0.35);
			map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, z, 42, 0);
		}
		try { const u = new URL(location.href); u.searchParams.set("p", id); history.replaceState(null, "", u); } catch { /* 埋め込み先で URL を触れない */ }
	}
	function back() {
		cur = null; seq++; wikiFrame.close();
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
		if (e.key === "Escape" && wikiFrame.isOpen) return;   // 記事が開いている＝Esc は枠が閉じる（一覧へは戻らない）
		if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "Escape") back(); else return; e.preventDefault(); };
	window.addEventListener("keydown", onKey);

	renderList();
	const first = new URLSearchParams(location.search).get("p");
	if (first && byId.has(first)) show(first);

	return {
		parks, show, back,
		get current() { return cur; },
		get layer() { return layer; },
		get units() { return unitsLayer; }, setUnits,
		destroy() { seq++; window.removeEventListener("keydown", onKey); map.gadget.spotlight(null); map.gadget.outline(null); layer?.remove?.(); unitsLayer?.remove?.(); wikiFrame.remove(); panel.remove(); },
	};
}
