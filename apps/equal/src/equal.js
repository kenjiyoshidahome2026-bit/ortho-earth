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
import { parseViewHash, buildViewHash } from "@ortho-earth/core/viewurl";
import { resolveWorldPal } from "@ortho-earth/core/worldpal";
import { unproject, anchorView, clampView, minZoomFor, pxPerUnit, wrapLon } from "./equalearth.js";
import { bakeLayer, bakeGraticule } from "./bake.js";
import { createRenderer } from "./renderer.js";
import { LAYERS, GRATICULE, PALETTE } from "./layers.js";
import { THEMES, THEME_NAMES, normTheme, hex } from "./themes.js";   // 配色テーマ＝japan と同じ名前・同じ c= トークン（世界パレットは ortho-core の共有正本）
import { loadWorldElevation, loadClimate, createNearElevation } from "./hypso.js";
import { buildChoropleth } from "./choropleth.js";
import { decodeText, joinCSV, csvPreset, buildNationIndex } from "./csvjoin.js";
import { loadNations, colorGraph, PRESETS, loadI18n, loadNeCities, tr } from "./nations.js";
import { t, setLang, isRTL, LANGUAGES, norm } from "./i18n.js";   // UI 文言＝英語キー・26 言語（japan の辞書に相乗り＋equal 固有）
import { createLabels, countryLabels, cityLabels, airportLabels } from "./labels.js";
import { countryName as countryNameOf, cityName as cityNameOf, shortEnNames, culturalUrl, culturalName, WORLD_Z } from "@ortho-earth/core/worldcontent";   // 世界帯の中身の正本（名前の順・URL・出しズーム＝globe・world と共有）
import { createAnno } from "@ortho-earth/globe/gadgets/anno.js";   // geoedit の @スタイル付き geopbf の再生＝japan と実装を共有（正典）
import { kOfLat, yOfLat } from "./equalearth.js";

const API = "https://api.ortho-earth.com";
const MAX_ZOOM = 8;   // NE 10m の縮尺の天井（本人 2026-09-18「maxZoom は 8 程度」）

// bucket 基盤は頁で一度（部品を何度作り直しても 1 回）
let geopbfReady = false;
const ensureGeopbf = () => { if (!geopbfReady) { createGeopbf(API, { bucket: nativeBucket, prewarm: true }); geopbfReady = true; } };   // prewarm＝復号レーンを先に起こす（起動直後に 4 層を必ず解く＝立ち上げを DB/IDB 待ちと重ねる）
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
		theme: normTheme(q.get("c")) || "mono",   // 配色テーマ（japan と同じ c= トークン・?c=night は dark の別名）
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
	let world = null, NONE = 0, political = null, worldP = null, i18n = null, neCities = null, cityFeatures = [], markFeatures = new Map(), shortEn = new Map();   // markFeatures＝記号ラベルの材料（層 id → 地物）   // neCities＝NE 由来の都市名（言語別・小さな都市の i18n）   // shortEn＝NE admin_1 の admin（"Afghanistan"＝DB の正式寄りの英語名より短い）
	const labelsLayer = createLabels(mapEl.querySelector("#labels"));
	const LABEL_PAL = { ...THEMES.mono.labelColor };   // テーマが中身を書き換える（rebuildLabels が読み直す）
	let worldPal = resolveWorldPal(THEMES[settings.theme].world);   // 全球ハイプソの色＝ortho-core の正本（japan と共有）
	// 国名・都市名の出所の順（言語ごと）＝世界帯の中身の正本 ortho-core worldcontent（globe・world と同じ順）
	const countryName = n => countryNameOf(n, i18n, shortEn);
	const cityName = p => cityNameOf(p, lang, i18n, neCities);
	function rebuildLabels() {
		if (!world) return;
		const marks = [];
		for (const L of layers) {   // 記号ラベル（空港の✈）＝層が on の時だけ・層ごとの出しズームで
			if (!L.on || !L.def.mark || L.status !== "ready") continue;
			const feats = markFeatures.get(L.def.id); if (!feats?.length) continue;
			if (L.def.mark === "plane") marks.push(...airportLabels(feats, LABEL_PAL, { minZoom: L.def.markMinZoom ?? 5 }));
		}
		labelsLayer.setLabels(settings.labels ? [...countryLabels(world, countryName, LABEL_PAL), ...cityLabels(cityFeatures, cityName, LABEL_PAL), ...marks] : marks);
		requestDraw();
	}
	const getWorld = () => worldP ??= (async () => {   // 初回要求時に起動（UI の準備より前に走らせない）
		busy.add("World DB"); updateToast();
		try {
			[world, i18n, neCities] = await Promise.all([loadNations(), loadI18n(lang).catch(e => { console.warn("[equal] i18n", e); return null; }), loadNeCities(lang)]);
			NONE = world.items.length; console.log(`[equal] World DB ${world.updated}: ${world.items.length} nations (lang ${lang})`);
			relabelChoro(); rebuildLabels();
		}
		catch (e) { console.error("[equal] World DB failed", e); }
		busy.delete("World DB"); updateToast(); requestDraw();
		return world;
	})();
	// world の ne-cultural＝bucket GIS/world/（本人裁定 2026-09-18）＝world の他の資産と同じ棚・開発も本番も同じ URL＝キャッシュも同じ鍵。
	// 配信用に 2 本（packages/world/build/ne-cultural.js NE_GROUPS）：base＝国（起動時）・detail＝道路/鉄道/市街地（z≥5 で初めて読む）。
	// 頂点の 7 割が detail 側＝分けることで初回の国の表示が約 1/4 に（旧＝1 本 20MB を国のために待っていた）
	// URL とキャッシュ名＝正本 worldcontent（globe・world と同じ綴り＝同じ IDB の実体を共有）
	const culturalP = {};
	const getCultural = (g = "base") => culturalP[g] ??= (async () => {
		const label = g === "base" ? "World regions" : "Roads & rail";
		busy.add(label); updateToast();
		try { return await geopbf(culturalUrl(g), { name: culturalName(g) }); }
		finally { busy.delete(label); updateToast(); }
	})();
	function countrySpec() {
		return {
			include: p => p.layer === "admin_1",   // 係争地の重ね（admin_0）・湖・市街地は国の面に数えない（巻き数と海岸/国境の判定を狂わせない）
			fill: () => 0,
			unit: p => world.byKey.get(p.key) ?? NONE,   // key は world が付与済み（ハワイの北西諸島の分離も焼き時に済み）
			outline: (pa, refs, pb) => !pb ? { cls: 0, minZoom: 0 } : pa.key === pb.key ? { cls: 2, minZoom: WORLD_Z.admin1 } : { cls: 1, minZoom: 0 },
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
			if (def.mark) {   // 記号ラベル（空港の✈）の材料＝点の位置と属性をラベル層へ渡す（GL の点は描かない）
				const feats = [];
				for (let i = 0; i < pbf.length; i++) { const p = pbf.getProperties(i); if (p && (!def.markLayer || p.layer === def.markLayer)) feats.push({ properties: p, geometry: pbf.getGeometry(i) }); }   // markLayer＝同じ配信物に同居する層から自分の分だけ（world detail の airports）
				markFeatures.set(def.id, feats);
			}
			if (L === countries) {
				political = colorGraph(NONE, L.baked.neighbors || []); applyChoropleth();
				cityFeatures = [];
				for (let i = 0; i < pbf.length; i++) {
					const p = pbf.getProperties(i); if (!p) continue;
					if (p.layer === "populated_places") cityFeatures.push({ properties: p, geometry: pbf.getGeometry(i) });
				}
				shortEn = shortEnNames(pbf.length, i => pbf.getProperties(i));   // 国の短い英語名（属領が主権国名に化ける物は捨てる＝正本 worldcontent）
				rebuildLabels();
			}
			L.status = "ready"; L.readyAt = performance.now();
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
		if (years) { yearInput.min = years[0]; yearInput.max = years[1]; yearInput.value = settings.year ?? years[1]; yearLabel.textContent = settings.year ?? t("latest year"); }   // 凡例（renderLegend）と同じ語＝素の英語を残さない
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

	// ── 配色テーマ ──────────────────────────────────────────────────────────────────
	// 地図面の色は PALETTE の配列の**中身**を書き換える（配列の identity は保つ）＝層の定義が参照で掴んでいるので
	// 焼き直し（bake）も層の作り直しも要らない。ラベルだけは焼いた時の色を持つので rebuildLabels で貼り直す。
	// UI 家具＝暗い紙のテーマで #map.ui-dark（quiet-mono の夜ガラス）＋ --eq-paper/--eq-ink（凡例・スウォッチの地色）。
	function applyTheme(name) {
		const id = normTheme(name) || "mono", T = THEMES[id];
		settings.theme = id;
		const put = (key, v) => { const dst = PALETTE[key], c = Array.isArray(v) ? hex(v[0], v[1]) : hex(v); dst[0] = c[0]; dst[1] = c[1]; dst[2] = c[2]; dst[3] = c[3]; };
		for (const key in PALETTE) if (T[key] !== undefined) put(key, T[key]);
		worldPal = resolveWorldPal(T.world);
		Object.assign(LABEL_PAL, T.labelColor, { capital: T.capital, airport: Array.isArray(T.airport) ? T.airport[0] : T.airport });   // 記号（✈）の色もテーマから
		// 家具（計器・出典・ガラス）は **どのテーマでも黒硝子のまま**＝japan の「白抜き家具＝常時ON」（本人裁定 2026-08-05）と揃える。
		//   実測（2026-09-18）：ui-dark を外すと #attr/#pos の下地が明るい硝子へ転ぶのに、文字色は equal の #map{color:#cdd}
		//   （常時暗い家具を前提に書かれている）のまま＝明地に明文字で読めなくなる。テーマで動かすのは地図面と、
		//   家具のうち「紙の色を映す部分」だけ（--eq-paper/--eq-ink＝凡例のデータなし見本・主題なしのスウォッチ）。
		mapEl.classList.add("ui-dark");
		mapEl.style.setProperty("--eq-paper", Array.isArray(T.land) ? T.land[0] : T.land);
		mapEl.style.setProperty("--eq-ink", T.labelColor.country);
		themeBtns.forEach(b => b.classList.toggle("on", b.dataset.theme === id));
		rebuildLabels(); renderLegend(); requestDraw();
	}

	// ── 描画 ──
	const ID_ORDER = -1;        // 国 ID バッファ＝他の全部より先（塗りもコロプレスもホバーもこれを読む）
	const CHORO_ORDER = 10.5;   // コロプレスの重ね順＝国の塗り(10)の直後・係争地(11)/市街地(12)/湖(14) はその上
	let raf = 0, hoverFid = -1, hoverDirty = false, nearViewKey = "", firstFrame = false;
	function requestDraw() { if (!raf && !destroyed) raf = requestAnimationFrame(draw); }

	// ── 変形（japan の球 ⇄ Equal Earth）＝「ortho と Equal Earth は相性がいい」を絵にする（本人 2026-09-20・2D 実装）──
	// 球は renderer の 2D 透視（japan のチルト 0 と同じカメラ・深度なし・頂点シェーダで球の位置と Equal Earth の位置を線形補間）。変形中はフレーム
	//（国境＋経緯線）だけを描き、着いてから塗り・ハイプソ・ラベルを幕（veil）で背景色から溶かし出す。
	// 球の視点＝{ lat, zoom } は出発点で固定（経度は view.lon に追従＝球のまま横ドラッグで回る）・Equal Earth 側＝今の view。
	// 段：dir=+1（球→地図）morph→veil・dir=−1（地図→球）veil→morph→park（球のまま留まる＝戻りは morphIn）
	const MORPH_MS = 1100, VEIL_MS = 280, D2R = Math.PI / 180;
	let morph = null;   // { dir, phase: "morph"|"veil"|"park", t0, hold, sphere: { lat, zoom }, resolve }
	const frameGrat = { baked: bakeGraticule({ flat: true }) };   // 変形中のレチクル＝10° 全線（japan に合わせる）・gpuTier が初回に GPU へ載せる
	const BLACK = [0, 0, 0];
	// japan のカメラ（ortho-core cameraState・チルト 0）と同じ eye 距離：camDist = radPerDevPx·(H/2)/tan(fovy/2)・radPerDevPx = 2π/(2^z·256·dpr)
	//（dpr は約分＝CSS px の高さで計算）。fovy＝japan の既定 50°。同じ画面の高さで開く前提（受け渡しは同一画面）
	const FOVY = 50 * D2R;
	const camDistOf = zoom => (2 * Math.PI / (256 * Math.pow(2, zoom))) * (size()[1] / 2) / Math.tan(FOVY / 2);
	const labelsCanvas = mapEl.querySelector("#labels");
	labelsCanvas.style.transition = "opacity .25s";
	const fadeTop = v => { labelsCanvas.style.opacity = v; for (const c of mapEl.querySelectorAll(".eq-overlay")) c.style.opacity = v; };   // ラベルと注釈＝変形中は隠す
	const ease = k => k * k * (3 - 2 * k);
	// 変形の時間＝準備時間（本人 9/20）：押した瞬間に球のフレーム（経緯線は即・国境は着き次第フェードで）を出して開き始め、
	// 地図の本体（国・ハイプソ・層）は変形の裏で読む。着地の幕は揃ってから（最大 MORPH_WAIT_MS）開ける。
	function morphIn(from, { hold = false } = {}) {   // from＝球の視点 { lon?, lat, zoom }（省略＝留まっている球 or 今の view）。hold＝親の合図（release）まで球のまま待つ
		return new Promise(resolve => {
			const sphere = !from && morph?.sphere ? morph.sphere : { lat: from?.lat ?? view.lat, zoom: from?.zoom ?? view.zoom, dlon: from?.lon != null ? wrapLon(from.lon - view.lon) : 0 };   // from.lon＝球の中心が地図の中心と違う（japan の「この地点を中心に」）
			morph?.resolve?.();
			morph = { dir: 1, phase: "morph", t0: performance.now(), hold, sphere, resolve };
			fadeTop("0"); hoverFid = -1; setTip(null);
			syncGlobeBtn(); emit("morph", 1); requestDraw();
		});
	}
	// 球の中心経度＝地図の中心経度＋dlon（「この地点を球体へ」＝地図は動かさず、その地点が画面中心へ集まりながら球に畳まれる）。
	// 球のまま横ドラッグすると view.lon が動く＝球も回る（dlon は保つ）
	const sphereLon = () => wrapLon(view.lon + (morph?.sphere?.dlon || 0));
	function morphOut(to) {   // Equal Earth から球のフレームへ畳む。畳み終えたら park（球のまま）。to＝球の視点 { lon, lat, zoom }（省略＝今の view・倍率は維持）
		return new Promise(resolve => {
			if (morph?.phase === "park" && !to) return resolve();
			morph?.resolve?.();
			const dlon = to?.lon != null ? wrapLon(to.lon - view.lon) : 0;
			morph = { dir: -1, phase: "veil", t0: performance.now(), hold: false, sphere: { lat: to?.lat ?? view.lat, zoom: to?.zoom ?? view.zoom, dlon }, resolve };
			fadeTop("0"); hoverFid = -1; setTip(null);
			syncGlobeBtn(); emit("morph", -1); requestDraw();
		});
	}
	const releaseMorph = () => { if (morph?.hold) { morph.hold = false; morph.t0 = performance.now(); requestDraw(); } };
	const MORPH_WAIT_MS = 6000;   // 着地の幕を待つ上限（回線が遅くても地図は出す）
	const sceneReady = () => countries.status !== "loading" && countries.status !== "idle" && (!(settings.hypso > 0) || hypsoState === 2);
	function drawMorph() {
		const m = morph, now = performance.now();
		const dur = m.phase === "morph" ? MORPH_MS : VEIL_MS;
		const k = m.phase === "park" || m.phase === "wait" || m.hold ? 0 : Math.min(1, (now - m.t0) / dur), e = ease(k);
		let t = 0, veil = 0;   // t＝球(0)→地図(1)・veil＝塗り・ハイプソの見え方(0..1)
		if (m.phase === "park") { t = 0; veil = 0; }
		else if (m.phase === "wait") { t = 1; veil = 0; }   // 開き終えて、地図の本体が揃うのを待つ（フレームのまま）
		else if (m.dir > 0) { if (m.phase === "morph") { t = e; veil = 0; } else { t = 1; veil = e; } }
		else { if (m.phase === "veil") { t = 1; veil = 1 - e; } else { t = 1 - e; veil = 0; } }
		// 変形中＝黒地に白のフレーム（本人 9/20「水色は要らない・背景黒・admin0 とレチクルを白」）。着いたら地図を黒から溶かし出す
		if (veil > 0) { R.beginFrame(view, PALETTE.bg); drawScene(); if (veil < 1) R.drawVeil([0, 0, 0, 1 - veil]); }
		else R.beginFrame(view, BLACK, { t, ppuS: pxPerUnit(m.sphere.zoom), lat: m.sphere.lat * D2R, cam: camDistOf(m.sphere.zoom), dlon: m.sphere.dlon || 0 });
		let more = false;
		if (veil < 1) more = drawFrame(1 - veil);
		if (m.phase === "wait") { if (sceneReady() || now - m.waitT0 > MORPH_WAIT_MS) { m.phase = "veil"; m.t0 = now; } }
		else if (k >= 1) {   // 段の終わり
			if (m.dir > 0) {
				if (m.phase === "morph") { if (sceneReady()) { m.phase = "veil"; m.t0 = now; } else { m.phase = "wait"; m.waitT0 = now; } }
				else { morph = null; fadeTop(""); hoverDirty = true; syncGlobeBtn(); m.resolve(); emit("morph", 0); }
			} else {
				if (m.phase === "veil") { m.phase = "morph"; m.t0 = now; }
				else { m.phase = "park"; m.resolve(); }
			}
		}
		if (morph && ((morph.phase !== "park" && !morph.hold) || more)) requestDraw();
	}
	// フレーム＝白の国境（海岸線＋国境・州境は出さない）＋白の 10° レチクル。層の on/off に関わらず描く。a＝濃さ（幕と同期）
	// 戻り値＝まだ動く（国境のフェード中）
	function drawFrame(a = 1) {
		const thr = lodThreshold(view.zoom);
		let more = false;
		if (countries.status === "ready") {
			const f = Math.min(1, (performance.now() - (countries.readyAt || 0)) / 350);   // 着き次第フェードで現れる（変形の裏で読んだ国境が「湧く」のでなく滲む）
			more = f < 1;
			const tier = gpuTier(countries, thr);
			if (tier.lines) R.drawLines(countries.vtx, tier.lines, [{ color: [1, 1, 1, 0.9 * a * f], width: 0.8 }, { color: [1, 1, 1, 0.9 * a * f], width: 0.8 }, { color: [0, 0, 0, 0], width: 0 }]);
		}
		const tier = gpuTier(frameGrat, thr);
		if (tier.lines) R.drawLines(frameGrat.vtx, tier.lines, [{ color: [1, 1, 1, 0.35 * a], width: 0.6 }]);
		return more;
	}

	function draw() {
		raf = 0;
		if (destroyed) return;
		view = clampView(view, ...size(), MAX_ZOOM);   // リサイズで下限が変わっても余白を出さない
		for (const L of layers) if (L.on && L.status === "idle" && view.zoom >= L.def.loadZoom) loadLayer(L);
		if (settings.hypso > 0 && hypsoState === 0) loadHypso();
		if (near && settings.hypso > 0) { const [W, H] = size(), k = `${view.lon},${view.lat},${view.zoom},${W},${H}`; if (k !== nearViewKey) { nearViewKey = k; near.ensure(view, W, H, (sx, sy) => unproject(view, sx, sy)); } }

		if (!firstFrame) { firstFrame = true; queueMicrotask(() => emit("frame")); }   // 最初の 1 枚を描いた（埋め込みの殻＝親へ「見せてよい」の合図）
		if (morph) drawMorph();
		else {
			R.beginFrame(view, PALETTE.bg);
			drawScene();
			{ const [W, H] = size(); if (labelsLayer.draw(view, W, H, Math.min(window.devicePixelRatio || 1, 2))) requestDraw(); }   // ラベル（フェード中は次のフレームも）
			for (const fn of frameSubs) fn();   // 注釈（anno）＝ラベルの上
			if (hoverDirty) { hoverDirty = false; identify(); }   // 視点が動いた直後＝描いた ID バッファで指の下を読み直す
		}
		updatePos(); updateScale();
		scheduleHash();
	}
	function drawScene() {   // 海 → 層（順は ops）→ コロプレス（beginFrame 済みが前提）
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
			if (L.baked.kind === "point") { if (!def.mark) ops.push([o.points ?? 80, () => R.drawPoints(t, def.pointStyles)]); continue; }   // mark 付き（空港の✈）はラベル層が描く
			// 国 ID バッファ＝面の塗り・コロプレス・ホバー識別が共有する材料。層の塗りとは別の仕事＝別の op（一番先に描く）
			if (t.fills && def.ids) ops.push([ID_ORDER, () => R.drawIds(L.vtx, t.fills)]);
			if (t.fills) ops.push([o.fill ?? 10, def.ids
				? () => R.drawLand({ land: def.fillColor, hypso: hypsoState === 2 ? settings.hypso : 0, pal: worldPal })
				: () => R.drawFill(L.vtx, t.fills, k >= 0.999 ? def.fillColor : [def.fillColor[0], def.fillColor[1], def.fillColor[2], (def.fillColor[3] ?? 1) * k])]);
			if (t.lines) ops.push([o.lines ?? 50, () => R.drawLines(L.vtx, t.lines, fade(def.lineStyles, k))]);
		}
		// コロプレス＝どの層にも属さない被せパス。材料は国 ID バッファと塗り表だけで、層の幾何も配色テーマも見ない。
		// 既定の順は国の塗りの直後＝係争地(11)・市街地(12)・湖(14) はその上に乗る（分離前と同じ見え方）。
		// CHORO_ORDER を動かせば重ね順だけ変えられる＝「湖の下に敷く／上に乗せる」が設定になる。
		ops.push([CHORO_ORDER, () => R.drawChoropleth({ alpha: legendData ? settings.choroAlpha : 0, hover: hoverFid })]);
		ops.sort((a, b) => a[0] - b[0]).forEach(([, fn]) => fn());
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
	// 球 ⇄ 地図（変形の口）：地図なら「Globe」＝球へ畳む・球なら「Map」＝Equal Earth へ開く
	const globeBtn = el("button", { class: "eq-host-btn eq-globe" });
	// 埋め込み（japan の iframe）では「地球儀」＝japan の地球儀へ戻る（球へ畳んで emit("closed")＝殻が親へ渡し、親が iframe を閉じる）。
	// 単体では equal 自身の球に留まる（park）＝以前どおり。Esc も同じ（埋め込みのみ）
	const embedded = q.get("embed") === "1";
	const closeToHost = to => { if (morph && morph.dir < 0) return; morphOut(to).then(() => emit("closed", { zoom: morph.sphere.zoom, lat: morph.sphere.lat, lon: sphereLon() })); };   // to＝球の中心 { lon, lat }（右クリック）
	globeBtn.addEventListener("click", () => {
		if (embedded) return closeToHost();
		if (morph && (morph.phase === "park" || morph.dir < 0)) morphIn(); else morphOut();
	});
	if (embedded) addEventListener("keydown", e => { if (e.key === "Escape" && !e.defaultPrevented) closeToHost(); }, { signal });
	function syncGlobeBtn() {
		const key = morph && (morph.phase === "park" || morph.dir < 0) ? "Map" : "Globe";
		globeBtn.setAttribute("data-t", key); globeBtn.textContent = t(key); globeBtn.title = t(key);
		globeBtn.setAttribute("aria-pressed", String(key === "Map"));
	}
	syncGlobeBtn();
	gadgets.append(globeBtn);
	// コンテキストメニュー（右クリック／長押し）：「この地点を球体へ」＝その地点を中心にした球へ畳む（倍率は維持・本人 9/20）
	const menu = el("div", { class: "eq-menu", role: "menu" }); menu.hidden = true;
	const menuItem = el("button", { class: "eq-menu-item", role: "menuitem", "data-t": "Globe here" }, esc(t("Globe here")));
	menu.append(menuItem); mapEl.append(menu);
	let menuLL = null;
	const closeMenu = () => { menu.hidden = true; menuLL = null; };
	function openMenu(cx, cy) {
		if (morph) return;   // 球の間は地図の地点が無い
		const [W, H] = size(); const ll = unproject(view, cx - W / 2, cy - H / 2);
		if (!ll) return closeMenu();
		menuLL = ll;
		menu.hidden = false;
		const mw = menu.offsetWidth || 160, mh = menu.offsetHeight || 32;
		menu.style.left = Math.min(cx, W - mw - 4) + "px"; menu.style.top = Math.min(cy, H - mh - 4) + "px";
	}
	menuItem.addEventListener("click", () => { const ll = menuLL; closeMenu(); if (!ll) return; embedded ? closeToHost({ lon: ll[0], lat: ll[1] }) : morphOut({ lon: ll[0], lat: ll[1] }); });   // 埋め込み＝その地点を中心にした球で japan へ戻る
	canvas.addEventListener("contextmenu", e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); openMenu(e.clientX - r.left, e.clientY - r.top); }, { signal });
	addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, { signal, capture: true });
	addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); }, { signal });
	// 開閉は「一度に一つ」＝二つのパネルは同じ場所（ボタンの右）へ開くので、開いたら他方を閉じる
	const panels = [];
	const setOpen = (open, p = panel, b = layersBtn) => {
		if (open) for (const [op, ob] of panels) if (op !== p) setOpen(false, op, ob);
		p.hidden = !open; b.classList.toggle("on", open); b.setAttribute("aria-expanded", String(open));
	};
	panels.push([panel, layersBtn]);
	layersBtn.addEventListener("click", () => setOpen(panel.hidden));
	addEventListener("keydown", e => { if (e.key === "Escape") for (const [p, b] of panels) setOpen(false, p, b); }, { signal });

	for (const L of layers) {
		if (L.def.fixed) continue;
		const b = el("button", { class: "chip" + (L.on ? " on" : ""), "data-k": L.def.accent || L.def.id, "aria-pressed": String(L.on), "data-t": L.def.label }, esc(t(L.def.label)));
		b.addEventListener("click", () => { L.on = !L.on; b.classList.toggle("on", L.on); b.setAttribute("aria-pressed", String(L.on)); if (L.def.mark) rebuildLabels(); requestDraw(); });
		panel.append(b);
	}
	const headRow = label => el("div", { class: "eq-head" }, `<span data-t="${esc(label)}">${esc(t(label))}</span>`);   // パネル内の小見出し＝軸の区切り
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

	// ── 配色テーマ列（地図の着せ替え）────────────────────────────────────────────────
	// japan と同じ器：#theme-row / .lp-theme / data-theme=<name>＝名前もトークン（c=）も揃える。
	// ここは「地図の顔」の軸。データの塗り分け（コロプレス）は下の別の列＝軸を混ぜない。
	panel.append(headRow("Map colors"));
	const themeRow = el("div", { id: "theme-row" });
	const themeBtns = [];
	for (const name of THEME_NAMES) {
		const T = THEMES[name];
		const b = el("button", { class: "lp-theme" + (settings.theme === name ? " on" : ""), "data-theme": name, type: "button" },
			`<span class="sw" style="background:${T.swatch}"></span><span class="eq-theme-name" data-t="${esc(T.label)}">${esc(t(T.label))}</span>`);
		b.addEventListener("click", () => { applyTheme(name); scheduleHash(); });
		themeBtns.push(b); themeRow.append(b);
	}
	panel.append(themeRow);

	// ── 主題（コロプレス）列＝データの塗り分け。地図の配色とは別の軸（2026-09-18 本人裁定「レイヤーから分離」）──
	// 描画も層ではなく被せパス（renderer.drawChoropleth＝国 ID バッファ＋塗り表だけ）＝層の定義にも配色テーマにも依存しない。
	// ── 主題（コロプレス）＝独立したガジェット（本人 2026-09-18「別のアイコンで表示する」）────────────
	// 地図の層（何を描くか）と主題（データで塗り分ける）は別の仕事＝入口も別のアイコンにする。
	// アイコンは凡例そのもの（濃さの違う 3 本の帯）＝層アイコン（重なった菱形）と一目で見分けられる。
	const choroChip = el("div", { class: "qm-chips" });
	const choroBtn = el("button", { class: "qm-panel-btn", id: "choro-btn", "aria-expanded": "false", "data-tt": "Choropleth", "data-tip": t("Choropleth") },
		`<svg viewBox="0 0 20 20" width="18" height="18"><rect x="3.5" y="4" width="13" height="3.2" rx="1.1" fill="#3f4757" opacity=".28"/><rect x="3.5" y="8.4" width="13" height="3.2" rx="1.1" fill="#3f4757" opacity=".6"/><rect x="3.5" y="12.8" width="13" height="3.2" rx="1.1" fill="#3f4757" opacity=".92"/></svg>`);
	const choroPanel = el("div", { class: "qm-panel", id: "choro-panel" }); choroPanel.hidden = true;
	choroChip.append(choroBtn, choroPanel);
	gadgets.append(choroChip);
	panels.push([choroPanel, choroBtn]);
	choroBtn.addEventListener("click", () => setOpen(choroPanel.hidden, choroPanel, choroBtn));
	const choroRow = el("div", { id: "choro-row", class: "lp-stack" });
	const swatchOf = id => {
		if (!id) return `<span class="sw eq-none"></span>`;
		const p = PRESETS[id];
		const bg = p.type === "political" ? "linear-gradient(90deg,#f3d9b1 0 33%,#cfe0bf 33% 66%,#d7d0ea 66%)"
			: p.type === "categorical" ? "linear-gradient(90deg,#7fa7c9 0 33%,#e0a96d 33% 66%,#8fbf8a 66%)"
			: { blue: "linear-gradient(90deg,#eef4f8,#18426f)", green: "linear-gradient(90deg,#f2f6ec,#225c2b)", orange: "linear-gradient(90deg,#fbf3e8,#8a3d17)", purple: "linear-gradient(90deg,#f5f2f8,#4a2e70)" }[p.ramp || "blue"];
		return `<span class="sw" style="background:${bg}"></span>`;
	};
	const choroBtns = [];
	function selectChoro(id) {
		settings.choro = id;
		choroBtns.forEach(x => x.classList.toggle("on", x.dataset.choro === (id || "none")));
		applyChoropleth(); scheduleHash();
	}
	for (const id of [null, ...Object.keys(PRESETS)]) {
		const b = el("button", { class: "lp-theme eq-choro" + (settings.choro === id ? " on" : ""), "data-choro": id || "none", type: "button" }, `${swatchOf(id)}<span class="eq-choro-name"></span>`);
		b.addEventListener("click", () => selectChoro(id));
		choroBtns.push(b); choroRow.append(b);
	}
	// CSV：行＝「Open CSV…」（ドロップと同じ入口）→ 読めたらファイル名に変わり、この行で CSV の主題を選び直せる
	const csvBtn = el("button", { class: "lp-theme eq-choro", "data-choro": "csv", type: "button" }, `<span class="sw eq-csv"></span><span class="eq-csv-name" data-t="Open CSV…">${esc(t("Open CSV…"))}</span>`);
	const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,text/tab-separated-values", hidden: "" });
	csvBtn.addEventListener("click", () => {
		if (csv && settings.choro !== "csv") { selectChoro("csv"); return; }
		fileInput.click();
	});
	fileInput.addEventListener("change", () => { if (fileInput.files[0]) openCSV(fileInput.files[0]); fileInput.value = ""; });
	choroBtns.push(csvBtn); choroRow.append(csvBtn, fileInput);
	// 主題の名前＝地図の中身の語＝翻訳（i18n は後から届く＝貼り替える）
	function relabelChoro() {
		for (const b of choroBtns) {
			const id = b.dataset.choro, span = b.querySelector(".eq-choro-name"); if (!span) continue;
			if (id === "none") { span.textContent = t("None"); continue; }
			if (id === "csv") continue;   // ファイル名（csvBtn が自分で持つ）
			const P = PRESETS[id]; if (!P) continue;
			span.innerHTML = `${esc(tr(i18n, t(P.label)))}${P.unit ? ` <span style="opacity:.6">(${esc(P.unit)})</span>` : ""}`;
		}
	}
	relabelChoro();
	choroPanel.append(choroRow);
	const colRow = el("div", { class: "eq-row" }, `<span data-t="Column">${esc(t("Column"))}</span>`); colRow.hidden = true;
	const colSelect = el("select", { class: "eq-select" });
	colSelect.addEventListener("change", () => { if (!csv) return; csv.col = +colSelect.value; csv.preset = csvPreset(csv.ds, csv.col); selectChoro("csv"); });
	colRow.append(colSelect); choroPanel.append(colRow);
	choroPanel.append(rangeRow("Opacity", settings.choroAlpha, a => { settings.choroAlpha = a; requestDraw(); }));   // 主題パネルの中＝語は共有語の「濃さ」
	// 年（DB の統計だけ・各国の最新年＝右端）
	const yearRow = el("div", { class: "eq-row" }, `<span><span data-t="Year">${esc(t("Year"))}</span> <b class="eq-year"></b></span>`); yearRow.hidden = true;
	const yearInput = el("input", { type: "range", min: "2000", max: "2025", step: "1", value: "2025" }), yearLabel = yearRow.querySelector(".eq-year");
	yearInput.addEventListener("input", () => { settings.year = +yearInput.value; yearLabel.textContent = yearInput.value; applyChoropleth(); scheduleHash(); });
	yearInput.addEventListener("dblclick", () => { settings.year = null; applyChoropleth(); scheduleHash(); });   // ダブルクリック＝最新年へ戻す
	yearRow.append(yearInput); choroPanel.append(yearRow);

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
			+ (nodata && preset.type !== "political" ? `<div class="eq-li"><span class="eq-sw" style="background:var(--eq-paper,#f6f6f4);border:1px solid rgba(128,140,160,.55)"></span>${esc(t("No data ($1)", nodata))}</div>` : "")
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
			csvBtn.title = t("Click again to open another CSV");
			selectChoro("csv");
			console.log(`[equal] CSV ${ds.name}: key="${ds.header[ds.keyCol]}" matched ${ds.matched}/${ds.rows.length}, ${ds.columns.length} value columns`);
		} catch (e) {
			console.warn("[equal] CSV failed", e);
			flash(`${file.name}: ${e.message}`);
		}
	}
	// ── 注釈（geoedit の geopbf / GeoJSON）＝japan の anno ガジェットを 2D 投影のアダプタで動かす ──
	// map の契約（japan の app.js と同じ口）：mapEl / overlay(url,{name}) / unprojectXY / getZoom / gadget.tip・pop
	const frameSubs = new Set();
	// 2D 投影（lon,lat → [x,y,front]・CSS px・左上原点）。裏経線の際は「見えない」扱い＝縫い目を跨ぐ線がそこで切れる
	const makeProjector = () => { const [W, H] = size(), s = pxPerUnit(view.zoom), yc = yOfLat(view.lat), lon0 = view.lon; return (lon, lat) => { let d = lon - lon0; d = ((d + 180) % 360 + 360) % 360 - 180; return [W / 2 + d * Math.PI / 180 * kOfLat(lat) * s, H / 2 - (yOfLat(lat) - yc) * s, Math.abs(d) > 179.5 ? -1 : 1]; }; };
	// 同一フレームのオーバーレイ（japan の map.overlay と同じ契約・#13：init(canvas,opts,host)/message/frame(cam,camState,size,api)/destroy）を
	// main スレッドで。equal はレンダーワーカーを持たない＝依存ゼロのモジュール（anno-draw.js）を import() して自前の canvas に描く。
	// frame は equal の draw の末尾（ラベルの上・frameSubs）。api.projectH＝2D なので高さは無い（3D ピンは円になる）
	function overlay(url, { name = "overlay" } = {}) {
		const cv = el("canvas", { class: "eq-overlay", "data-name": name });
		Object.assign(cv.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", transition: "opacity .25s" });
		labelsCanvas.after(cv);   // ラベルの上・家具（#gadgets…）の下
		const o = {
			el: cv, mod: null, queue: [], onmessage: null,
			post: d => { if (o.mod) { o.mod.message(d); requestDraw(); } else o.queue.push(d); },
			remove: () => { frameSubs.delete(step); try { o.mod?.destroy(); } catch {} cv.remove(); },
		};
		const host = { requestDraw, post: d => o.onmessage?.(d) };
		// url＝文字列（相対/絶対 URL）か { builtin: "anno" }（globe の同一フレーム overlay の組み込みモジュール名＝japan の map.overlay と同じ契約）
		const BUILTIN = { anno: () => import("@ortho-earth/globe/gadgets/anno-draw.js") };
		const load = url && typeof url === "object" ? (BUILTIN[url.builtin]?.() ?? Promise.reject(new Error(`unknown builtin overlay "${url.builtin}"`))) : import(/* @vite-ignore */ new URL(url, location.href).href);
		load
			.then(mod => { if (!cv.isConnected) return; o.mod = mod; mod.init(cv, {}, host); for (const d of o.queue) mod.message(d); o.queue = []; requestDraw(); })
			.catch(err => console.error("[equal] overlay", name, "failed to load", url, err?.message || err));
		function step() {
			if (!o.mod) return;
			const [W, H] = size(), dpr = Math.min(window.devicePixelRatio || 1, 2), pw = Math.round(W * dpr), ph = Math.round(H * dpr);
			if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
			const project = makeProjector();
			const api = { W, H, dpr, project, projectH: (lon, lat) => project(lon, lat) };
			try { if (o.mod.frame({ zoom: view.zoom, pitch: 0, bearing: 0 }, null, [W, H], api)) requestDraw(); }
			catch (e) { console.error("[equal] overlay", name, "frame failed", e?.message); }
		}
		frameSubs.add(step);
		return o;
	}
	const annoMap = {
		mapEl, getZoom: () => view.zoom, requestDraw, overlay,
		unprojectXY: (x, y) => { const [W, H] = size(); return unproject(view, x - W / 2, y - H / 2); },
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
		const [, table, ne] = await Promise.all([setLang(c), loadI18n(c).catch(e => { console.warn("[equal] i18n", e); return null; }), loadNeCities(c)]);
		i18n = table; neCities = ne;
		mapEl.dir = isRTL() ? "rtl" : "ltr";
		for (const n of mapEl.querySelectorAll("[data-t]")) n.textContent = t(n.dataset.t);            // 文字を持つ家具
		for (const n of mapEl.querySelectorAll("[data-tt]")) { n.dataset.tip = t(n.dataset.tt); n.setAttribute("aria-label", t(n.dataset.tt)); }   // ボタンの説明
		attrBase = attrBase.replace(/^[^<]*/, esc(t("Sources: ")));
		relabelChoro(); applyChoropleth(); rebuildLabels(); updateToast(); updatePos(); scheduleHash();
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
			settings.theme !== "mono" ? qs.set("c", settings.theme) : qs.delete("c");   // japan と同じトークン（mono は書かない）
			settings.labels ? qs.delete("labels") : qs.set("labels", "0");
			lang === "en" ? qs.delete("lang") : qs.set("lang", lang);   // 言語＝URL に残す（共有した URL は同じ言葉で開く）
			legendData?.years && settings.year != null ? qs.set("year", String(settings.year)) : qs.delete("year");
			qs.delete("morph");   // 到着の合図＝URL に残さない（再読み込みで二度開かない）
			const search = qs.toString() ? "?" + qs : "";
			const onGlobe = morph && (morph.phase === "park" || morph.dir < 0);   // 球（へ向かう）間は URL も球の視点＝japan へ渡す時はこれを読む
			const vh = buildViewHash(onGlobe ? { zoom: morph.sphere.zoom, center: [sphereLon(), morph.sphere.lat], pitch: 0, bearing: 0 } : { zoom: view.zoom, center: [view.lon, view.lat], pitch: 0, bearing: 0 }, [l]);
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

	applyTheme(settings.theme);   // 起動時に一度通す＝PALETTE/ラベル/家具/凡例が同じ一本の道で決まる（既定 mono でも no-op ではなく素通り）
	renderLegend();
	requestDraw();
	// ?morph=1＝球（呼び出し元の視点そのまま・clamp 前）から開いて着く／?morph=lon,lat＝球の中心はそこ（japan の視点）・地図の中心は #hash（右クリック「この地点を中心に」）
	if (q.get("morph") && fromHash) {
		const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(q.get("morph"));
		mapEl.style.background = "#000";   // 最初のフレームまで黒（japan は黒へ落として来る＝灰の一瞬を挟まない）
		morphIn(m ? { lon: +m[1], lat: +m[2], zoom: fromHash.zoom } : { lat: fromHash.lat, zoom: fromHash.zoom }, { hold: q.get("embed") === "1" }).then(() => { mapEl.style.background = ""; });   // 埋め込み＝親の合図（release）まで球のまま
	}

	// ── 外から使う口（埋め込み・検証・殻）──
	return {
		el: mapEl,
		get view() { return view; }, setView,
		layers,
		hypso(opacity) { settings.hypso = Math.max(0, Math.min(1, +opacity || 0)); requestDraw(); },
		choropleth(id, opacity) { if (opacity != null) settings.choroAlpha = +opacity; selectChoro(presetOf(id) ? id : null); },
		theme(name) { applyTheme(name); scheduleHash(); return settings.theme; },   // 配色テーマ＝japan のガジェットとして載る時はホストが呼ぶ（c= と同じ名前）
		get themes() { return THEME_NAMES.slice(); },
		openCSV,   // File/Blob（name 付き）を渡す＝ドロップと同じ
		openGeo, anno,
		labels: labelsLayer,
		get world() { return world; },
		get busy() { return [...busy]; },
		fidAt: (cx, cy) => R.readFid(cx, cy),
		morphIn, morphOut, releaseMorph, close: closeToHost,   // 球 ⇄ Equal Earth の変形（Promise＝着いたら解決）。releaseMorph＝hold を解いて開き始める。close＝球へ畳んで emit("closed", view)
		get drawn() { return firstFrame; },   // 最初の 1 枚を描いた後か（殻が on("frame") を結ぶ前に描き終えている場合の取りこぼし防止）
		get sphereView() { return morph ? { zoom: morph.sphere.zoom, lat: morph.sphere.lat, lon: sphereLon() } : null; },
		get morphing() { return morph ? (morph.phase === "park" ? "globe" : "morphing") : "map"; },
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
