// ortho-equal：地球全体の fallback。正射（ortho）は半球しか見せられない＝その外側を Equal Earth で見せる。
// 中央経線＝画面中心の経度（横スクロールで中央経線が追従＝左右どこまでも途切れず、中心の歪みが常に最小）。
// 縮小・スクロールは画面の外に余白を出さない（画面矩形 ⊂ 外形）。チルト・回転なし。URL は ortho と同じ #zoom/lat/lon[/l=…]。
// UI は japan の作法（quiet-mono・ui-dark・#gadgets/#dock/#attr/#tip）に揃える。
// 部品（2026-09-19 本人裁定「solar/geoedit/equal は一つの div に対して生成して destroy できる構成」）：
//   const app = await createEqual({ target, lang, params, view, hash, keyboard, assetBase });
//   app.addButton({ text, title, arrow, onClick })（左上の縦並びに持ち主のボタン）・app.on("view", fn)・app.setView・app.destroy()
//   頁（index.html＋main.js）は殻＝URL を読んで置くだけ（?back= の戻り口も殻）。同じ頁に地図は 1 つ（quiet-mono の #map 規格）。
import "quiet-mono/tokens.scss";
import "quiet-mono/components.scss";
import "./style.scss";
import { createGeopbf, geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import { parseViewHash, buildViewHash } from "ortho-core/viewurl";
import { WORLD_PAL_DEFAULT } from "ortho-core/worldpal";
import { unproject, anchorView, clampView, minZoomFor, pxPerUnit } from "./equalearth.js";
import { bakeLayer, bakeGraticule } from "./bake.js";
import { createRenderer } from "./renderer.js";
import { LAYERS, GRATICULE, PALETTE } from "./layers.js";
import { loadWorldElevation, loadClimate, createNearElevation } from "./hypso.js";
import { buildChoropleth } from "./choropleth.js";
import { decodeText, joinCSV, csvPreset, buildNationIndex } from "./csvjoin.js";
import { loadNations, colorGraph, PRESETS, loadI18n, tr } from "./nations.js";
import { t, setLang, isRTL, LANGUAGES, norm } from "./i18n.js";   // UI 文言＝英語キー・26 言語（japan の辞書に相乗り＋equal 固有）
import { createLabels, countryLabels, cityLabels, F } from "./labels.js";
import { createAnno } from "../../ortho-japan/gadgets/anno.js";   // geoedit の @スタイル付き geopbf の再生＝japan と実装を共有（正典）
import { kOfLat, yOfLat } from "./equalearth.js";

const API = "https://api.ortho-earth.com";
const MAX_ZOOM = 8;   // NE 10m の縮尺の天井（本人 2026-09-18「maxZoom は 8 程度」）

// bucket 基盤は頁で一度（部品を何度作り直しても 1 回）
let geopbfReady = false;
const ensureGeopbf = () => { if (!geopbfReady) { createGeopbf(API, { bucket: nativeBucket }); geopbfReady = true; } };
const num01 = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d; };

// target＝置き場（要素か CSS セレクタ・大きさは持ち主が決める）。lang＝UI と地名の言語（省略＝params の lang → ブラウザ）。
// params＝設定（?labels ?hypso ?choro ?choroA ?year ?g ?csv と同じ書式の文字列/URLSearchParams）。view＝初期視点（"#z/lat/lon/l=…" 書式）。
// hash＝頁の URL と往復する（殻＝true・埋め込み＝false）。keyboard＝矢印/+/− を聞く。assetBase＝koppen-clim.png の置き場（既定＝この頁）
export async function createEqual({ target, lang: langOpt, params = "", view: view0, hash = false, keyboard = true, assetBase = new URL(import.meta.env.BASE_URL, location.href) } = {}) {
	const host = typeof target === "string" ? document.querySelector(target) : target;
	if (!host) throw new Error("createEqual: target not found");
	const q = params instanceof URLSearchParams ? params : new URLSearchParams(params || "");   // 殻＝location.search・埋め込み＝持ち主の指定
	ensureGeopbf();

	let lang = norm(langOpt) || norm(q.get("lang")) || norm(navigator.language) || "en";   // UI と地名の言語（26 言語・本人裁定 2026-09-18「操作系の UI も i18n」）
	await setLang(lang);   // UI を組む前に訳を揃える（japan と同じ掟＝モジュール評価時に t() を呼ばない）
	// 預かった div を生きている間だけ #map にする（quiet-mono の家具規格＝#map の中の #gadgets/#dock/#c…・japan の SDK と同じ作法）。
	// destroy で id/class/dir を返す＝同じ頁で地図は 1 つ（家具規格の前提）
	const mapEl = host, prevId = host.id, prevClass = host.className;
	mapEl.id = "map"; mapEl.classList.add("ui-dark");
	mapEl.insertAdjacentHTML("beforeend", `<canvas id="c"></canvas><canvas id="labels"></canvas>`);
	mapEl.dir = isRTL() ? "rtl" : "ltr";   // RTL（アラビア・ヘブライ・ペルシア・ウルドゥー）＝quiet-mono の論理プロパティで家具が鏡像になる
	const canvas = mapEl.querySelector("#c");
	// 後片付けの台帳：大域のイベント（signal）・監視（observers）・描画ループ（raf）・タイマー（hashTimer/noteT）
	const ac = new AbortController(), signal = ac.signal, observers = [];
	let destroyed = false;
	const handlers = {};
	const emit = (type, v) => { for (const fn of handlers[type] || []) try { fn(v); } catch (e) { console.error(e); } };
	const R = createRenderer(canvas);
	if (!R) { mapEl.insertAdjacentHTML("beforeend", `<div id="net-toast" style="display:block">${esc(t("WebGL2 is required."))}</div>`); throw new Error("WebGL2 unavailable"); }

	// ── 状態 ──
	const size = () => [canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight];
	const fromHash = parseViewHash(view0 ?? (hash ? location.hash : ""));
	let view = clampView(fromHash ? { lon: fromHash.lon, lat: fromHash.lat, zoom: fromHash.zoom } : { lon: 0, lat: 0, zoom: -Infinity }, ...size(), MAX_ZOOM);
	const settings = {
		labels: q.get("labels") !== "0",
		hypso: num01(q.get("hypso"), 1),          // 自然の層＝ハイプソと川・湖の不透明度（1 本のスライダで同時・0＝紙の白地図＝陸/海/境界だけ）
		choro: PRESETS[q.get("choro")] ? q.get("choro") : null,   // "csv"＝ドロップした CSV（URL には残らない）
		choroAlpha: num01(q.get("choroA"), 0.85),
		year: Number.isFinite(+q.get("year")) && q.get("year") ? +q.get("year") : null,   // DB 統計の年（null＝各国の最新年）
	};

	// 層：{ def, on, status: "idle"|"loading"|"ready"|"error", baked, vtx, gpu }
	const layers = LAYERS.map(def => ({ def, on: def.fixed || def.on !== false, status: "idle" }));
	layers.push({ def: GRATICULE, on: GRATICULE.on !== false, status: "ready", baked: bakeGraticule() });
	if (fromHash?.layers) for (const L of layers) if (!L.def.fixed) L.on = fromHash.layers.includes(L.def.id);
	const countries = layers.find(L => L.def.id === "countries");
	// 国＝world（NationDB）。ID バッファの値＝国番号（items の添字）・NONE＝world に無い陸（北西ハワイ諸島など＝塗らない）
	let world = null, NONE = 0, political = null, worldP = null, i18n = null, cityFeatures = [], shortEn = new Map();   // shortEn＝NE admin_1 の admin（"Afghanistan"＝DB の正式寄りの英語名より短い）
	const labelsLayer = createLabels(mapEl.querySelector("#labels"));
	const LABEL_PAL = { country: "#3a3f4a", city: "#2b3b57", halo: "rgba(255,255,255,.88)" };
	const countryName = n => i18n?.nations?.[n.key]?.name || shortEn.get(n.key) || n.name?.en || n.key;
	const cityName = p => lang === "ja" ? (F(p, "name_ja") || F(p, "name_en") || F(p, "name")) : lang === "en" ? (F(p, "name_en") || F(p, "name")) : (i18n?.cities?.[F(p, "wikidataid")]?.name || F(p, "name_en") || F(p, "name"));
	function rebuildLabels() {
		if (!world) return;
		labelsLayer.setLabels(settings.labels ? [...countryLabels(world, countryName, LABEL_PAL), ...cityLabels(cityFeatures, cityName, LABEL_PAL)] : []);
		requestDraw();
	}
	const getWorld = () => worldP ??= (async () => {   // 初回要求時に起動（UI の準備より前に走らせない）
		busy.add("World DB"); updateToast();
		try {
			[world, i18n] = await Promise.all([loadNations(), loadI18n(lang).catch(e => { console.warn("[equal] i18n", e); return null; })]);
			NONE = world.items.length; console.log(`[equal] World DB ${world.updated}: ${world.items.length} nations (lang ${lang})`);
			relabelThemes(); rebuildLabels();
		}
		catch (e) { console.error("[equal] World DB failed", e); }
		busy.delete("World DB"); updateToast(); requestDraw();
		return world;
	})();
	// world の ne-cultural＝bucket GIS/world/（本人裁定 2026-09-18）＝world の他の資産と同じ棚・開発も本番も同じ URL＝キャッシュも同じ鍵。
	// 配信用に 2 本（packages/world/build/ne-cultural.js NE_GROUPS）：base＝国（起動時）・detail＝道路/鉄道/市街地（z≥5 で初めて読む）。
	// 頂点の 7 割が detail 側＝分けることで初回の国の表示が約 1/4 に（旧＝1 本 20MB を国のために待っていた）
	const WORLD_CULTURAL = g => `https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-${g}.geopbf`;
	const culturalP = {};
	const getCultural = (g = "base") => culturalP[g] ??= (async () => {
		const label = g === "base" ? "World regions" : "Roads & rail";
		busy.add(label); updateToast();
		try { return await geopbf(WORLD_CULTURAL(g), { name: `ne-cultural-${g}.geopbf` }); }
		finally { busy.delete(label); updateToast(); }
	})();
	function countrySpec() {
		return {
			include: p => p.layer === "admin_1",   // 係争地の重ね（admin_0）・湖・市街地は国の面に数えない（巻き数と海岸/国境の判定を狂わせない）
			fill: () => 0,
			unit: p => world.byKey.get(p.key) ?? NONE,   // key は world が付与済み（ハワイの北西諸島の分離も焼き時に済み）
			outline: (pa, refs, pb) => !pb ? { cls: 0, minZoom: 0 } : pa.key === pb.key ? { cls: 2, minZoom: 4 } : { cls: 1, minZoom: 0 },
		};
	}

	// ── 読込 ──
	const busy = new Set();
	async function loadLayer(L) {
		L.status = "loading"; busy.add(L.def.label); updateToast();
		const { def } = L;
		try {
			if (L === countries && !(await getWorld())) throw new Error("World DB unavailable");
			let pbf = def.source === "world" ? await getCultural(def.group) : await geopbf(def.bucket).catch(() => null);
			if (!pbf?.unPackGint && def.zip) pbf = await geopbf(def.zip, { name: def.bucket });
			if (!pbf?.unPackGint) throw new Error("GintBUF decode failed");
			const t0 = performance.now();
			L.baked = bakeLayer(pbf, { kind: def.kind, ...(L === countries ? countrySpec() : def.spec) });
			console.log(`[equal] ${def.id}: ${pbf.length} features (source ${def.source || def.bucket}), bake ${Math.round(performance.now() - t0)}ms`);
			if (L === countries) {
				political = colorGraph(NONE, L.baked.neighbors || []); applyChoropleth();
				cityFeatures = []; shortEn = new Map();
				for (let i = 0; i < pbf.length; i++) {
					const p = pbf.getProperties(i); if (!p) continue;
					if (p.layer === "populated_places") cityFeatures.push({ properties: p, geometry: pbf.getGeometry(i) });
					else if (p.layer === "admin_1" && p.admin && !shortEn.has(p.key)) shortEn.set(p.key, p.admin);
				}
				// NE の admin は主権国名＝属領（SJ→"Norway"・PR→"United States of America"）に化ける。同じ名前が複数 key に付くものは捨てる
				{ const cnt = new Map(); for (const v of shortEn.values()) cnt.set(v, (cnt.get(v) || 0) + 1); for (const [k, v] of shortEn) if (cnt.get(v) > 1) shortEn.delete(k); }
				shortEn.set("US", "United States");   // DB "United States of America" は地図では長い
				rebuildLabels();
			}
			L.status = "ready";
		} catch (e) {
			console.error(`[equal] ${def.id} failed`, e);
			L.status = "error";
		}
		busy.delete(L.def.label); updateToast(); requestDraw();
	}

	let hypsoState = 0;   // 0=未 1=読込中 2=済
	let near = null;      // 近景 R10 窓（R90 読込後に起動）
	async function loadHypso() {
		hypsoState = 1; busy.add("Hypsometry"); updateToast();
		const clim = loadClimate(new URL("koppen-clim.png", assetBase).href)
			.then(img => { R.setClimate(img); requestDraw(); })
			.catch(e => console.warn("[hypso] climate texture failed (latitude approximation)", e));
		const maxTex = R.gl.getParameter(R.gl.MAX_TEXTURE_SIZE);
		let upT = 0;   // セル到着ごとの再アップロードは 1 フレームにまとめる
		await loadWorldElevation({ apiUrl: API, cellRes: Math.min(1024, Math.floor(maxTex / 4)),
			onUpdate: a => { cancelAnimationFrame(upT); upT = requestAnimationFrame(() => { R.setElevation(a.data, a.width, a.height); requestDraw(); }); } })
			.catch(e => console.error("[hypso] elevation failed", e));
		await clim;
		near = createNearElevation({ apiUrl: API, maxTex, onAtlas: a => { R.setNearElevation(a); requestDraw(); },
			onBusy: b => { b ? busy.add("Terrain R10") : busy.delete("Terrain R10"); updateToast(); } });
		hypsoState = 2; busy.delete("Hypsometry"); updateToast(); requestDraw();
	}

	// ── コロプレス ──
	let legendData = null;
	let csv = null;   // { ds（joinCSV の結果）, col, preset }
	const presetOf = id => id === "csv" ? csv?.preset : PRESETS[id];
	function applyChoropleth() {
		const preset = settings.choro && presetOf(settings.choro);
		if (!preset || !world || !political) { legendData = null; renderLegend(); requestDraw(); return; }
		const years = preset.years?.(world.items) || null;
		if (years && settings.year != null) settings.year = Math.max(years[0], Math.min(years[1], settings.year));
		const T = s => tr(i18n, s);
		const opts = preset.type === "political" ? { ...preset, value: (_n, i) => political[i] || null }
			: preset.type === "categorical" ? { ...preset, value: (n, i, y) => { const v = preset.value(n, i, y); return v == null ? null : T(String(v)); } }   // 地域などの値も翻訳＝凡例と吹き出しが揃う
			: { ...preset, year: years ? settings.year : null };
		const r = buildChoropleth(world.items, opts);
		R.setPaint(r.rgba, NONE + 1);   // 末尾＝NONE（a=0＝塗らない）
		legendData = { preset, label: T(preset.label), legend: r.legend, values: r.values, nodata: r.nodata, years };
		yearRow.hidden = !years;
		if (years) { yearInput.min = years[0]; yearInput.max = years[1]; yearInput.value = settings.year ?? years[1]; yearLabel.textContent = settings.year ?? "latest"; }
		renderLegend(); requestDraw();
	}

	// LOD：1 device px の面積（度²）→ rank（gint の焼きと同じ式）。正積なので画面全域で一定。
	// 段は 3 rank 刻み（=ズーム 1 段）で切り下げ＝必要より細かい側に倒す
	function lodThreshold(zoom) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const pxDeg = 360 / (256 * Math.pow(2, zoom) * dpr);
		const rank = Math.floor(1.5 * Math.log2(pxDeg * pxDeg) + 61.524);
		return Math.max(0, Math.min(63, Math.floor(rank / 3) * 3));
	}
	const vtxByXY = new WeakMap();
	function gpuTier(L, thr) {
		const b = L.baked;
		if (!L.vtx && b.xy) { L.vtx = vtxByXY.get(b.xy); if (!L.vtx) vtxByXY.set(b.xy, L.vtx = R.uploadVertices(b.xy, b.vertexCount)); }   // 同じ pbf の層は頂点テクスチャ 1 枚を共有
		if (b.kind === "point") return (L.pointsVAO ??= R.instanceVAO(b.points, 3));
		L.gpu ??= new Map();
		let t = L.gpu.get(thr);
		if (t) { L.gpu.delete(thr); L.gpu.set(thr, t); return t; }   // ヒット＝末尾へ（LRU）
		const cpu = b.tier(thr);
		t = { lines: cpu.lines ? R.instanceVAO(cpu.lines, 3) : null, fills: cpu.fills ? R.instanceVAO(cpu.fills, 4) : null };
		L.gpu.set(thr, t);
		while (L.gpu.size > 4) { const [k0, old] = L.gpu.entries().next().value; L.gpu.delete(k0); R.freeVAO(old.lines); R.freeVAO(old.fills); }   // 層あたり 4 段まで常駐（GPU メモリ）
		return t;
	}

	// ── 描画 ──
	let raf = 0, hoverFid = -1, hoverDirty = false, nearViewKey = "";
	function requestDraw() { if (!raf && !destroyed) raf = requestAnimationFrame(draw); }
	function draw() {
		raf = 0;
		if (destroyed) return;
		view = clampView(view, ...size(), MAX_ZOOM);   // リサイズで下限が変わっても余白を出さない
		for (const L of layers) if (L.on && L.status === "idle" && view.zoom >= L.def.loadZoom) loadLayer(L);
		if (settings.hypso > 0 && hypsoState === 0) loadHypso();
		if (near && settings.hypso > 0) { const [W, H] = size(), k = `${view.lon},${view.lat},${view.zoom},${W},${H}`; if (k !== nearViewKey) { nearViewKey = k; near.ensure(view, W, H, (sx, sy) => unproject(view, sx, sy)); } }

		R.beginFrame(view, PALETTE.bg);
		R.drawSea(PALETTE.sea, PALETTE.bg, PALETTE.edge);
		const thr = lodThreshold(view.zoom);
		const ops = [];
		const fade = (styles, k) => k >= 0.999 ? styles : styles.map(st => ({ ...st, color: [st.color[0], st.color[1], st.color[2], (st.color[3] ?? 1) * k] }));
		const alphaOf = def => def.water ? settings.hypso : 1;   // 川・湖はハイプソと同時に濃淡が動く（本人 2026-09-18「一つのスライダー」）
		for (const L of layers) {
			if (!L.on || L.status !== "ready") continue;
			const { def } = L, o = def.order || {};
			const t = gpuTier(L, thr);
			const k = alphaOf(def);
			if (L.baked.kind === "point") { ops.push([o.points ?? 80, () => R.drawPoints(t, def.pointStyles)]); continue; }
			if (t.fills) ops.push([o.fill ?? 10, L === countries
				? () => R.drawCountries(L.vtx, t.fills, { land: def.fillColor, hypso: hypsoState === 2 ? settings.hypso : 0, pal: WORLD_PAL_DEFAULT, choropleth: legendData ? settings.choroAlpha : 0, hover: hoverFid })
				: () => R.drawFill(L.vtx, t.fills, k >= 0.999 ? def.fillColor : [def.fillColor[0], def.fillColor[1], def.fillColor[2], (def.fillColor[3] ?? 1) * k])]);
			if (t.lines) ops.push([o.lines ?? 50, () => R.drawLines(L.vtx, t.lines, fade(def.lineStyles, k))]);
		}
		ops.sort((a, b) => a[0] - b[0]).forEach(([, fn]) => fn());

		{ const [W, H] = size(); if (labelsLayer.draw(view, W, H, Math.min(window.devicePixelRatio || 1, 2))) requestDraw(); }   // ラベル（フェード中は次のフレームも）
		for (const fn of frameSubs) fn();   // 注釈（anno）＝ラベルの上
		if (hoverDirty) { hoverDirty = false; identify(); }   // 視点が動いた直後＝描いた ID バッファで指の下を読み直す
		updatePos(); updateScale();
		scheduleHash();
	}
	// ホバー識別＝国 ID バッファ（最後の描画のもの＝視点が同じ間は有効）の 1px 直読み。
	// 国が変わった時だけ再描画する（旧＝pointermove ごとに全層を描き直していた＝マウスを動かすだけで GPU が全開）
	function identify() {
		let fid = pointer && !dragging && unproject(view, pointer.sx, pointer.sy) ? R.readFid(pointer.cx, pointer.cy) : -1;   // 外形の外は ID バッファに扇の余りが残る＝読まない
		if (fid >= NONE) fid = -1;   // world に無い陸＝識別しない
		if (fid !== hoverFid) { hoverFid = fid; requestDraw(); }
		setTip(fid >= 0 ? tipText(fid) : null);
		updatePos();
	}

	// ── UI（japan の部品と同じ id/class）──
	const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	const el = (tag, attrs = {}, html = "") => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; };
	const gadgets = el("div", { id: "gadgets" }), dock = el("div", { id: "dock" });
	mapEl.append(gadgets, dock);

	// 層＋主題パネル（#chips/#layers-btn/#layers-panel/.chip/.lp-theme）
	const chips = el("div", { id: "chips" });
	const layersBtn = el("button", { id: "layers-btn", "aria-expanded": "false", "data-tt": "Layers & themes", "data-tip": t("Layers & themes") },
		`<svg viewBox="0 0 20 20" width="18" height="18"><path d="M10 2 L18 6.5 10 11 2 6.5 Z" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linejoin="round"/><path d="M2 10.5 L10 15 18 10.5" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linejoin="round"/><path d="M2 14 L10 18.5 18 14" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
	const panel = el("div", { id: "layers-panel" }); panel.hidden = true;
	chips.append(layersBtn, panel);
	gadgets.append(chips);
	const setOpen = open => { panel.hidden = !open; layersBtn.classList.toggle("on", open); layersBtn.setAttribute("aria-expanded", String(open)); };
	layersBtn.addEventListener("click", () => setOpen(panel.hidden));
	addEventListener("keydown", e => { if (e.key === "Escape") setOpen(false); }, { signal });

	for (const L of layers) {
		if (L.def.fixed) continue;
		const b = el("button", { class: "chip" + (L.on ? " on" : ""), "data-k": L.def.accent || L.def.id, "aria-pressed": String(L.on), "data-t": L.def.label }, esc(t(L.def.label)));
		b.addEventListener("click", () => { L.on = !L.on; b.classList.toggle("on", L.on); b.setAttribute("aria-pressed", String(L.on)); requestDraw(); });
		panel.append(b);
	}
	const rangeRow = (label, value, onInput) => {
		const row = el("div", { class: "eq-row" }, `<span data-t="${esc(label)}">${esc(t(label))}</span>`);
		const input = el("input", { type: "range", min: "0", max: "100", value: String(Math.round(value * 100)) });
		input.addEventListener("input", () => onInput(input.value / 100));
		row.append(input); return row;
	};
	{	// ラベル（国名・都市）のチップと地名の言語
		const b = el("button", { class: "chip" + (settings.labels ? " on" : ""), "data-k": "place", "aria-pressed": String(settings.labels), "data-t": "Labels" }, esc(t("Labels")));
		b.addEventListener("click", () => { settings.labels = !settings.labels; b.classList.toggle("on", settings.labels); b.setAttribute("aria-pressed", String(settings.labels)); rebuildLabels(); scheduleHash(); });
		panel.append(b);
		const row = el("div", { class: "eq-row" }, `<span data-t="Names">${esc(t("Names"))}</span>`);
		const sel = el("select", { class: "eq-select" }, LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${esc(l.name)}</option>`).join(""));
		sel.addEventListener("change", () => switchLang(sel.value));   // その場で切り替える（リロードしない＝データを取り直さない）
		row.append(sel); panel.append(row);
	}
	panel.append(rangeRow("Hypso · water", settings.hypso, a => { settings.hypso = a; requestDraw(); }));
	const themeRow = el("div", { id: "theme-row" });
	const swatchOf = id => {
		if (!id) return `<span class="sw eq-none"></span>`;
		const p = PRESETS[id];
		const bg = p.type === "political" ? "linear-gradient(90deg,#f3d9b1 0 33%,#cfe0bf 33% 66%,#d7d0ea 66%)"
			: p.type === "categorical" ? "linear-gradient(90deg,#7fa7c9 0 33%,#e0a96d 33% 66%,#8fbf8a 66%)"
			: { blue: "linear-gradient(90deg,#eef4f8,#18426f)", green: "linear-gradient(90deg,#f2f6ec,#225c2b)", orange: "linear-gradient(90deg,#fbf3e8,#8a3d17)", purple: "linear-gradient(90deg,#f5f2f8,#4a2e70)" }[p.ramp || "blue"];
		return `<span class="sw" style="background:${bg}"></span>`;
	};
	const themeBtns = [];
	function selectTheme(id) {
		settings.choro = id;
		themeBtns.forEach(x => x.classList.toggle("on", x.dataset.theme === (id || "none")));
		applyChoropleth(); scheduleHash();
	}
	for (const id of [null, ...Object.keys(PRESETS)]) {
		const b = el("button", { class: "lp-theme" + (settings.choro === id ? " on" : ""), "data-theme": id || "none" }, `${swatchOf(id)}<span class="eq-theme-name"></span>`);
		b.addEventListener("click", () => selectTheme(id));
		themeBtns.push(b); themeRow.append(b);
	}
	// CSV：行＝「Open CSV…」（ドロップと同じ入口）→ 読めたらファイル名に変わり、この行で CSV の主題を選び直せる
	const csvBtn = el("button", { class: "lp-theme", "data-theme": "csv" }, `<span class="sw eq-csv"></span><span class="eq-csv-name" data-t="Open CSV…">${esc(t("Open CSV…"))}</span>`);
	const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,text/tab-separated-values", hidden: "" });
	csvBtn.addEventListener("click", () => {
		if (csv && settings.choro !== "csv") { selectTheme("csv"); return; }
		fileInput.click();
	});
	fileInput.addEventListener("change", () => { if (fileInput.files[0]) openCSV(fileInput.files[0]); fileInput.value = ""; });
	themeBtns.push(csvBtn); themeRow.append(csvBtn, fileInput);
	// 主題の名前＝地図の中身の語＝翻訳（i18n は後から届く＝貼り替える）
	function relabelThemes() {
		for (const b of themeBtns) {
			const id = b.dataset.theme, span = b.querySelector(".eq-theme-name"); if (!span) continue;
			if (id === "none") { span.textContent = t("None"); continue; }
			if (id === "csv") continue;   // ファイル名（csvBtn が自分で持つ）
			const P = PRESETS[id]; if (!P) continue;
			span.innerHTML = `${esc(tr(i18n, t(P.label)))}${P.unit ? ` <span style="opacity:.6">(${esc(P.unit)})</span>` : ""}`;
		}
	}
	relabelThemes();
	panel.append(themeRow);
	const colRow = el("div", { class: "eq-row" }, `<span>Column</span>`); colRow.hidden = true;
	const colSelect = el("select", { class: "eq-select" });
	colSelect.addEventListener("change", () => { if (!csv) return; csv.col = +colSelect.value; csv.preset = csvPreset(csv.ds, csv.col); selectTheme("csv"); });
	colRow.append(colSelect); panel.append(colRow);
	panel.append(rangeRow("Choropleth", settings.choroAlpha, a => { settings.choroAlpha = a; requestDraw(); }));
	// 年（DB の統計だけ・各国の最新年＝右端）
	const yearRow = el("div", { class: "eq-row" }, `<span><span data-t="Year">${esc(t("Year"))}</span> <b class="eq-year"></b></span>`); yearRow.hidden = true;
	const yearInput = el("input", { type: "range", min: "2000", max: "2025", step: "1", value: "2025" }), yearLabel = yearRow.querySelector(".eq-year");
	yearInput.addEventListener("input", () => { settings.year = +yearInput.value; yearLabel.textContent = yearInput.value; applyChoropleth(); scheduleHash(); });
	yearInput.addEventListener("dblclick", () => { settings.year = null; applyChoropleth(); scheduleHash(); });   // ダブルクリック＝最新年へ戻す
	yearRow.append(yearInput); panel.append(yearRow);

	// ズーム（#zoom）
	const zoomBox = el("div", { id: "zoom" },
		`<button id="zoom-in" data-tt="Zoom in" data-tip="${esc(t("Zoom in"))}" aria-label="${esc(t("Zoom in"))}">＋</button><button id="zoom-out" data-tt="Zoom out" data-tip="${esc(t("Zoom out"))}" aria-label="${esc(t("Zoom out"))}">−</button>`);
	gadgets.append(zoomBox);
	function animateZoom(sx, sy, to) {
		const from = view.zoom, t0 = performance.now(), dur = 260;
		const step = () => { const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k); zoomAround(sx, sy, from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
		requestAnimationFrame(step);
	}
	zoomBox.querySelector("#zoom-in").addEventListener("click", () => animateZoom(0, 0, Math.min(MAX_ZOOM, Math.floor(view.zoom + 1))));
	zoomBox.querySelector("#zoom-out").addEventListener("click", () => animateZoom(0, 0, Math.max(minZoomFor(size()[0]), Math.ceil(view.zoom - 1))));

	// 左下ドック：座標計器（#pos）・凡例（#legend）・読込トースト（#elev-toast）
	const pos = el("div", { id: "pos" }, `<table><thead><tr>${["Lon", "Lat", "z ##zoom", "Meridian"].map(k => `<th data-t="${esc(k)}">${esc(t(k))}</th>`).join("")}</tr></thead><tbody><tr><td></td><td></td><td></td><td></td></tr></tbody></table>`);
	const posTd = pos.querySelectorAll("td");
	const toast = el("div", { id: "elev-toast" });
	const legend = el("div", { id: "legend" }); legend.style.display = "none";
	dock.append(pos, toast, legend);
	function updateToast() { toast.style.display = busy.size ? "block" : "none"; toast.textContent = busy.size ? t("Loading $1 …", [...busy].map(s => t(s)).join(", ")) : ""; }
	function renderLegend() {
		if (!legendData) { legend.style.display = "none"; updateAttr(); return; }
		const { preset, label, legend: rows, nodata, years } = legendData;
		const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
		const yr = years ? (settings.year != null ? String(settings.year) : t("latest year")) : "";
		legend.innerHTML = `<div class="eq-title">${esc(label)}${preset.unit ? ` <span style="font-weight:400;color:#89a">(${esc(preset.unit)})</span>` : ""}${yr ? ` <span style="font-weight:400;color:#89a">${esc(yr)}</span>` : ""}</div>` + (rows.length
			? rows.map(r => `<div class="eq-li"><span class="eq-sw" style="background:${rgb(r.color)}"></span>${esc(r.label)}</div>`).join("")
			: `<div class="eq-li">${esc(t("Neighbors never share a color"))}</div>`)
			+ (nodata && preset.type !== "political" ? `<div class="eq-li"><span class="eq-sw" style="background:#f6f6f4;border:1px solid #cfd4da"></span>${esc(t("No data ($1)", nodata))}</div>` : "")
			+ (preset.csv
				? `<div style="font-size:10px;color:#89a;margin-top:4px" title="${esc(csv.ds.unmatched.slice(0, 40).join(", "))}">${esc(csv.ds.name)} · ${esc(t("$1/$2 rows matched by “$3”", csv.ds.matched, csv.ds.rows.length, csv.ds.header[csv.ds.keyCol]))}${csv.ds.unmatched.length ? ` · ${esc(t("unmatched: $1", csv.ds.unmatched.slice(0, 3).join(", ") + (csv.ds.unmatched.length > 3 ? "…" : "")))}` : ""}</div>`
				: `<div style="font-size:10px;color:#89a;margin-top:4px">${esc(preset.ref || "")} · ${esc(t("World DB"))} ${esc(world?.updated || "")}</div>`);
		legend.style.display = "block";
		updateAttr();
	}
	const fmtLL = v => v.toFixed(5);
	function updatePos() {
		const ll = pointer ? unproject(view, pointer.sx, pointer.sy) : null;
		posTd[0].textContent = ll ? fmtLL(ll[0]) : "—";
		posTd[1].textContent = ll ? fmtLL(ll[1]) : "—";
		posTd[2].textContent = view.zoom.toFixed(2);
		posTd[3].textContent = `${Math.abs(view.lon).toFixed(1)}°${view.lon >= 0 ? "E" : "W"}`;
	}

	// 出典（#attr）
	const attr = el("div", { id: "attr" },
		`${esc(t("Sources: "))}<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>・<a href="https://www.gebco.net/" target="_blank" rel="noopener">GEBCO</a>・<a href="https://www.gloh2o.org/koppen/" target="_blank" rel="noopener">Beck et al. (CC BY)</a>`);
	mapEl.append(attr);
	// 出典＝表示中の主題で変わる（コロプレス中は World DB の出所を足す）
	let attrBase = attr.innerHTML;
	function updateAttr() {
		const P = legendData?.preset;
		attr.innerHTML = attrBase + (P && !P.csv ? `・<a href="https://www.ortho-earth.com/world/" target="_blank" rel="noopener">World DB</a> (${esc(P.ref || "Wikidata")})` : "");
	}
	// 縮尺（下辺中央・japan の #scale と同じ意匠）。正積図＝縮尺は方向で変わる＝画面中心の緯線に沿った東西の距離を出す
	const scale = el("div", { id: "scale" }, `<span id="scale-txt"></span><div id="scale-bar"></div>`);
	mapEl.append(scale);
	const scaleTxt = scale.querySelector("#scale-txt"), scaleBar = scale.querySelector("#scale-bar");
	function updateScale() {
		const R_M = 6371008.8, lat = view.lat * Math.PI / 180;
		const mPerPx = R_M * Math.cos(lat) / (pxPerUnit(view.zoom) * kOfLat(view.lat));   // 緯線方向：x=dλ·k(φ)・地上は R·cosφ·dλ
		const d256 = mPerPx * 256, r = Math.pow(10, Math.floor(Math.log10(d256)));
		const val = ((d256 / r) > 5 ? 5 : (d256 / r) > 2 ? 2 : 1) * r;
		const [px, v, unit] = val >= 1000 ? [val / mPerPx, val / 1000, "km"] : [val / mPerPx, val, "m"];
		scaleBar.style.width = px.toFixed(1) + "px";
		scaleTxt.textContent = `${v.toLocaleString("en", { maximumFractionDigits: v < 10 && unit === "km" ? 1 : 0 })}${unit}`;
		scale.style.display = "block";
	}

	// ホバーの吹き出し（#tip＝japan gadgets/tip.js と同じ置き方：カーソルの右 15px・縦中央・右端で反転）
	const tip = el("div", { id: "tip" }); tip.style.display = "none"; mapEl.append(tip);
	function setTip(html) {
		if (!html || !pointer) { tip.style.display = "none"; return; }
		if (tip.innerHTML !== html) tip.innerHTML = html;
		tip.style.display = "block";
		const r = tip.getBoundingClientRect(), W = mapEl.clientWidth, H = mapEl.clientHeight;
		if (coarseTip) {   // タッチ＝指の上（japan tip.js の coarse 分岐と同じ）
			tip.style.left = Math.max(0, Math.min(W - r.width, pointer.cx - r.width / 2)) + "px"; tip.style.top = Math.max(0, pointer.cy - r.height - 30) + "px"; return;
		}
		const left = pointer.cx + 15 + r.width > W ? pointer.cx - r.width - 15 : pointer.cx + 15;
		tip.style.left = left + "px"; tip.style.top = Math.max(0, Math.min(H - r.height, pointer.cy - r.height / 2)) + "px";
	}
	function tipText(i) {
		const n = world?.items[i]; if (!n) return null;
		let s = esc(countryName(n));   // 翻訳つき（?lang=）＝旧＝英語名のまま出していた
		if (legendData && legendData.preset.type !== "political") {
			const v = legendData.values[i], P = legendData.preset;
			if (v != null) {
				const txt = typeof v === "number" ? v.toLocaleString(lang, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 3 }) : String(v);
				const yr = P.year?.(n, legendData.years ? settings.year : null);
				s += `<div style="opacity:.8">${esc(legendData.label)}: ${esc(txt)}${P.unit ? " " + esc(P.unit) : ""}${yr ? ` (${yr})` : ""}</div>`;
			}
		}
		return s;
	}

	// ── CSV ドロップ（国へ結合してコロプレス）──
	let countryIndex = null;
	const note = el("div", { id: "net-toast" }); note.style.display = "none"; mapEl.append(note);
	let noteT = 0;
	function flash(msg, ms = 4500) { note.textContent = msg; note.style.display = "block"; clearTimeout(noteT); noteT = setTimeout(() => { note.style.display = "none"; }, ms); }
	async function openCSV(file) {
		if (!/\.(csv|tsv|txt)$/i.test(file.name) && !/text\/(csv|tab-separated|plain)/.test(file.type)) { flash(t("Drop a CSV file (.csv / .tsv)")); return; }
		if (!(await getWorld())) { flash(t("World DB is unavailable")); return; }
		try {
			countryIndex ??= buildNationIndex(world);
			const ds = joinCSV(file.name, decodeText(await file.arrayBuffer()), countryIndex);
			csv = { ds, col: ds.defaultCol, preset: csvPreset(ds, ds.defaultCol) }; csvSpec = null;
			colSelect.innerHTML = ds.columns.map(c => `<option value="${c.i}"${c.i === ds.defaultCol ? " selected" : ""}>${esc(c.name)}</option>`).join("");
			colRow.hidden = ds.columns.length < 2;
			csvBtn.querySelector(".eq-csv-name").textContent = ds.name;
			csvBtn.title = "Click again to open another CSV";
			selectTheme("csv");
			console.log(`[equal] CSV ${ds.name}: key="${ds.header[ds.keyCol]}" matched ${ds.matched}/${ds.rows.length}, ${ds.columns.length} value columns`);
		} catch (e) {
			console.warn("[equal] CSV failed", e);
			flash(`${file.name}: ${e.message}`);
		}
	}
	// ── 注釈（geoedit の geopbf / GeoJSON）＝japan の anno ガジェットを 2D 投影のアダプタで動かす ──
	// map の契約：mapEl / makeProjector（lon,lat→[x,y,front]）/ unprojectXY / getZoom / requestDraw / onFrame / gadget.tip・pop
	const frameSubs = new Set();
	const annoMap = {
		mapEl, getZoom: () => view.zoom, requestDraw,
		makeProjector: () => { const [W, H] = size(), s = pxPerUnit(view.zoom), yc = yOfLat(view.lat), lon0 = view.lon; return (lon, lat) => { let d = lon - lon0; d = ((d + 180) % 360 + 360) % 360 - 180; return [W / 2 + d * Math.PI / 180 * kOfLat(lat) * s, H / 2 - (yOfLat(lat) - yc) * s, Math.abs(d) > 179.5 ? -1 : 1]; }; },   // 裏経線の際は「見えない」扱い＝縫い目を跨ぐ線がそこで切れる
		unprojectXY: (x, y) => { const [W, H] = size(); return unproject(view, x - W / 2, y - H / 2); },
		onFrame: fn => { frameSubs.add(fn); return () => frameSubs.delete(fn); },
		gadget: { tip: () => annoTip, pop: () => popGadget },
	};
	let annoTipOn = false;
	function annoTip(html) {   // 注釈の @tip＝あれば出す・無ければ国のホバー（identify）へ戻す（anno は毎 move に null を送る＝そのまま通すと国の吹き出しが消える）
		if (html) { annoTipOn = true; setTip(html); }
		else if (annoTipOn) { annoTipOn = false; identify(); }
	}
	function popGadget(html, { x, y, onClose } = {}) {   // 最小の吹き出し（japan の pop ガジェットは i18n を抱える＝ここは静かな箱だけ）
		const div = el("div", { class: "eq-pop" }, `<button class="panel-close" aria-label="close">×</button><div class="eq-pop-body">${html}</div>`);
		Object.assign(div.style, { left: Math.max(4, x + 12) + "px", top: Math.max(4, y - 12) + "px" });
		div.querySelector(".panel-close").addEventListener("click", () => { div.remove(); onClose?.(); });
		div._remove = () => div.remove();
		mapEl.append(div); return div;
	}
	const anno = createAnno(annoMap, { signal });
	let annoName = null;
	async function openGeo(file) {
		busy.add(file.name); updateToast();
		try {
			const pbf = await geopbf(file, { gint: false, nocache: true });
			if (!pbf?.length) throw new Error("no features");
			anno.set(pbf); annoName = file.name;
			attr.dataset.user = file.name;
			console.log(`[equal] annotation ${file.name}: ${pbf.length} features`);
			flash(`${file.name}: ${t("$1 features", pbf.length)}`, 2500);
		} catch (e) { console.warn("[equal] geo failed", e); flash(`${file.name}: ${e.message}`); }
		busy.delete(file.name); updateToast(); requestDraw();
	}
	// 外部 URL の門（japan の ?g= と同じ規則）：gh:user/repo[@ref]/path → GitHub raw・https 限定（開発時は localhost の http 可）
	function remoteUrl(spec) {
		const gh = /^gh:([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?\/(.+)$/.exec(spec);
		if (gh && [gh[1], gh[2], gh[3] || "", ...gh[4].split("/")].some(x => x === "." || x === "..")) return null;
		let u; try { u = new URL(gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3] || "HEAD"}/${gh[4]}` : spec, location.href); } catch { return null; }
		const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
		return u.protocol === "https:" || (u.protocol === "http:" && isLocal) ? u : null;
	}
	async function fetchAsFile(spec, kind) {
		const u = remoteUrl(spec); if (!u) { flash(`${kind}: ${t("https URL or gh:user/repo/path only")}`); return null; }
		try { const r = await fetch(u.href); if (!r.ok) throw new Error(`HTTP ${r.status}`); return new File([await r.blob()], decodeURIComponent(u.pathname.split("/").pop() || kind)); }
		catch (e) { flash(`${kind}: ${e.message}`); return null; }
	}
	const isGeoFile = f => /\.(geopbf|pbf|geojson|json|topojson|kml|kmz|gpx|zip|fgb|gpkg)$/i.test(f.name);
	const dropHint = el("div", { id: "eq-drop" }, `<div><span data-t="Drop a CSV to color countries">${esc(t("Drop a CSV to color countries"))}</span><small data-t="joined by ISO code or country name — or a geopbf / GeoJSON to draw it">${esc(t("joined by ISO code or country name — or a geopbf / GeoJSON to draw it"))}</small></div>`);
	dropHint.hidden = true; mapEl.append(dropHint);
	let dragDepth = 0;
	const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
	mapEl.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropHint.hidden = false; });
	mapEl.addEventListener("dragover", e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
	mapEl.addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; dropHint.hidden = true; } });
	mapEl.addEventListener("drop", e => {
		if (!hasFiles(e)) return;
		e.preventDefault(); dragDepth = 0; dropHint.hidden = true;
		const f = e.dataTransfer.files[0]; if (f) (isGeoFile(f) ? openGeo(f) : openCSV(f));
	});
	// ?csv=<URL>（世界銀行の CSV や GitHub の CSV をそのまま）・?g=<URL>（geoedit の geopbf・GeoJSON）＝gh:user/repo/path 短縮形可
	(async () => {
		if (q.get("g")) { const f = await fetchAsFile(q.get("g"), "g"); if (f) openGeo(f); }
		if (q.get("csv")) { await getWorld(); const f = await fetchAsFile(q.get("csv"), "csv"); if (f) { await openCSV(f); csvSpec = q.get("csv"); scheduleHash(); } }
	})();
	let csvSpec = null;

	// ── 言語の切り替え（リロードしない）──
	// 辞書（equal＋japan 共有）と world の名前テーブルを取り直し、UI の文字・ラベル・凡例・出典を貼り替えるだけ＝
	// データ（GintBUF・標高・塗り表）は触らない＝?lang= を変えても立ち上がりが起きない（本人 2026-09-18）
	async function switchLang(code) {
		const c = norm(code); if (!c || c === lang) return;
		lang = c;
		const [, table] = await Promise.all([setLang(c), loadI18n(c).catch(e => { console.warn("[equal] i18n", e); return null; })]);
		i18n = table;
		mapEl.dir = isRTL() ? "rtl" : "ltr";
		for (const n of mapEl.querySelectorAll("[data-t]")) n.textContent = t(n.dataset.t);            // 文字を持つ家具
		for (const n of mapEl.querySelectorAll("[data-tt]")) { n.dataset.tip = t(n.dataset.tt); n.setAttribute("aria-label", t(n.dataset.tt)); }   // ボタンの説明
		attrBase = attrBase.replace(/^[^<]*/, esc(t("Sources: ")));
		relabelThemes(); applyChoropleth(); rebuildLabels(); updateToast(); updatePos(); scheduleHash();
		if (csv) csvBtn.querySelector(".eq-csv-name").textContent = csv.ds.name;   // ファイル名は訳さない
	}

	// ── URL（#zoom/lat/lon/l=…）──
	let hashTimer = 0;
	function scheduleHash() {
		clearTimeout(hashTimer);
		hashTimer = setTimeout(() => {
			const l = "l=" + layers.filter(L => !L.def.fixed && L.on).map(L => L.def.id).join(".");
			const qs = new URLSearchParams(hash ? location.search : q);
			settings.choro && settings.choro !== "csv" ? qs.set("choro", settings.choro) : qs.delete("choro");
			settings.choro === "csv" && csvSpec ? qs.set("csv", csvSpec) : qs.delete("csv");   // URL 由来の CSV だけ URL に残る（手元のファイルは再現できない）
			settings.labels ? qs.delete("labels") : qs.set("labels", "0");
			lang === "en" ? qs.delete("lang") : qs.set("lang", lang);   // 言語＝URL に残す（共有した URL は同じ言葉で開く）
			legendData?.years && settings.year != null ? qs.set("year", String(settings.year)) : qs.delete("year");
			const search = qs.toString() ? "?" + qs : "";
			const vh = buildViewHash({ zoom: view.zoom, center: [view.lon, view.lat], pitch: 0, bearing: 0 }, [l]);
			if (hash) history.replaceState(null, "", location.pathname + search + vh);   // 殻だけが頁の URL を書く（埋め込みは持ち主の URL に触らない）
			emit("view", vh);
		}, 250);
	}
	if (hash) addEventListener("hashchange", () => {
		const v = parseViewHash(location.hash);
		if (v) setView({ lon: v.lon, lat: v.lat, zoom: v.zoom });
	}, { signal });

	// ── 入力：ドラッグ＝掴んだ経緯度を指の下に固定・ホイール/ピンチ/ダブルクリック＝錨つきズーム ──
	let pointer = null, dragging = false;   // pointer = { cx, cy（左上原点 CSS px）, sx, sy（中心原点）}
	const local = e => { const r = canvas.getBoundingClientRect(); const cx = e.clientX - r.left, cy = e.clientY - r.top; return { cx, cy, sx: cx - r.width / 2, sy: cy - r.height / 2 }; };
	function setView(v) { view = clampView(v, ...size(), MAX_ZOOM); hoverDirty = true; requestDraw(); }   // 地図が動けば指の下の国も変わる
	function zoomAround(sx, sy, zoom) {
		const ll = unproject(view, sx, sy);
		if (!ll) return setView({ ...view, zoom });
		setView(anchorView(ll[0], ll[1], sx, sy, Math.min(MAX_ZOOM, zoom)));
	}
	const pointers = new Map();
	let grab = null;
	function regrab() {
		const ps = [...pointers.values()];
		if (ps.length === 1) grab = { ll: unproject(view, ps[0].sx, ps[0].sy) };
		else if (ps.length >= 2) {
			const mx = (ps[0].sx + ps[1].sx) / 2, my = (ps[0].sy + ps[1].sy) / 2;
			grab = { ll: unproject(view, mx, my), dist: Math.hypot(ps[0].sx - ps[1].sx, ps[0].sy - ps[1].sy), zoom: view.zoom };
		} else grab = null;
		dragging = ps.length > 0;
	}
	canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, local(e)); regrab(); setTip(null); tapStart = [e.clientX, e.clientY, performance.now()]; coarseTip = false; });
	canvas.addEventListener("pointermove", e => {
		pointer = local(e); pos.style.display = "block";
		if (!pointers.has(e.pointerId)) { if (raf) hoverDirty = true; else identify(); return; }   // 描画待ちなら描いた後に・そうでなければ今の ID バッファで
		pointers.set(e.pointerId, pointer);
		const ps = [...pointers.values()];
		if (!grab?.ll) { regrab(); return; }
		if (ps.length === 1) setView(anchorView(grab.ll[0], grab.ll[1], ps[0].sx, ps[0].sy, view.zoom));
		else {
			const mx = (ps[0].sx + ps[1].sx) / 2, my = (ps[0].sy + ps[1].sy) / 2;
			const d = Math.hypot(ps[0].sx - ps[1].sx, ps[0].sy - ps[1].sy);
			setView(anchorView(grab.ll[0], grab.ll[1], mx, my, Math.min(MAX_ZOOM, grab.zoom + Math.log2(Math.max(1, d) / Math.max(1, grab.dist)))));
		}
	});
	const release = e => {
		const tap = e.pointerType === "touch" && pointers.size === 1 && tapStart && Math.hypot(e.clientX - tapStart[0], e.clientY - tapStart[1]) < 8 && performance.now() - tapStart[2] < 400;
		pointers.delete(e.pointerId); regrab();
		if (tap) { pointer = local(e); coarseTip = true; }   // タップ＝指の下の国を識別して吹き出し（ホバーの代わり・指の上に出す）
		if (raf) hoverDirty = true; else identify();
	};
	let tapStart = null, coarseTip = false;
	canvas.addEventListener("pointerup", release);
	canvas.addEventListener("pointercancel", release);
	canvas.addEventListener("pointerleave", () => { pointer = null; hoverFid = -1; setTip(null); requestDraw(); });
	canvas.addEventListener("wheel", e => {
		e.preventDefault();
		const k = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0025;
		const p = local(e);
		zoomAround(p.sx, p.sy, view.zoom - e.deltaY * k);
	}, { passive: false });
	canvas.addEventListener("dblclick", e => {
		const p = local(e);
		animateZoom(p.sx, p.sy, e.shiftKey ? Math.ceil(view.zoom - 1) : Math.min(MAX_ZOOM, Math.floor(view.zoom + 1)));
	});
	if (keyboard) addEventListener("keydown", e => {
		if (e.target !== document.body) return;
		const step = 80;
		const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
		if (pan) { const c = unproject(view, 0, 0); if (c) setView(anchorView(c[0], c[1], -pan[0], -pan[1], view.zoom)); }
		else if (e.key === "+" || e.key === "=") animateZoom(0, 0, Math.min(MAX_ZOOM, Math.floor(view.zoom + 1)));
		else if (e.key === "-") animateZoom(0, 0, Math.ceil(view.zoom - 1));
	}, { signal });
	{ const o = new ResizeObserver(requestDraw); o.observe(canvas); observers.push(o); }

	renderLegend();
	requestDraw();

	// ── 外から使う口（埋め込み・検証・殻）──
	return {
		el: mapEl,
		get view() { return view; }, setView,
		layers,
		hypso(opacity) { settings.hypso = Math.max(0, Math.min(1, +opacity || 0)); requestDraw(); },
		choropleth(id, opacity) { if (opacity != null) settings.choroAlpha = +opacity; selectTheme(presetOf(id) ? id : null); },
		openCSV,   // File/Blob（name 付き）を渡す＝ドロップと同じ
		openGeo, anno,
		labels: labelsLayer,
		get world() { return world; },
		get busy() { return [...busy]; },
		fidAt: (cx, cy) => R.readFid(cx, cy),
		// 持ち主のボタン（戻る・保存など）＝左上の縦並び（#gadgets）の末尾。arrow＝先頭に ←（RTL で向きを返す）
		addButton({ text = "", title = "", arrow = false, onClick } = {}) {
			const b = document.createElement("button");
			b.className = "eq-host-btn";
			if (arrow) { const i = document.createElement("i"); i.className = "eq-arrow"; i.setAttribute("aria-hidden", "true"); i.textContent = "←"; b.append(i); }
			b.append(text); if (title) { b.title = title; b.setAttribute("aria-label", title); }
			if (onClick) b.addEventListener("click", onClick);
			gadgets.append(b);
			return b;
		},
		on(type, fn) { (handlers[type] ||= new Set()).add(fn); return () => handlers[type].delete(fn); },
		// 跡形なく消す：描画ループ・監視・大域のイベント・タイマー・近景標高の待ちを止め、GL を手放し、預かった div を元の id/class へ返す
		destroy() {
			if (destroyed) return;
			destroyed = true;
			cancelAnimationFrame(raf); clearTimeout(hashTimer); clearTimeout(noteT);
			ac.abort();
			for (const o of observers) o.disconnect();
			near?.stop();
			R.gl.getExtension("WEBGL_lose_context")?.loseContext();
			mapEl.replaceChildren(); mapEl.removeAttribute("dir");
			if (prevId) mapEl.id = prevId; else mapEl.removeAttribute("id");
			mapEl.className = prevClass;
			emit("destroy");
		},
	};
}
