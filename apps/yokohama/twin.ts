// 横浜市デジタルツインの案内板と機能（main.ts から遅延 import）。地図は orthoJapan（PLATEAU の建物・地形・基図はエンジンが持つ）。
// ここが足すのは 4 つの面（2026-10-21 に組み直し・本人）：
//   観光 … 地区（18 区）を平面で画面の 9 割に収める・名所ツアー・名所（写真つき）・公共施設（区分ごと・押すと吹き出し）
//   交通 … 横浜市営地下鉄（駅番号の記号つき・既定）・市営バスの停留所・JR と私鉄の駅と線路
//   防災 … 重ねるハザードマップ（洪水・高潮・津波・土砂災害警戒区域）を 3D の街に重ねる・指定緊急避難場所（対応災害で絞る・押すと標高）
//   解析 … 可視域・切り取り（断面）・一人称で歩く・距離と面積・断面図・その時刻の建物の影・冬至の日影図
// 建物＝18 区とも常に出す（LOD2 の 5 区はエンジンの登録簿・残り 13 区は LOD1 をここで足す・切り替えは置かない＝本人 2026-10-21）。
// 区の境界・鉄道・バス停・公共施設・名所の写真＝ortho-data/japan/yokohama/（scripts/bake-yokohama.mjs が組む）を opts.base から読む。
// 出典は案内板に書かず、地図の出典の欄（#attr）にまとめる（各 source／raster／tiles3d の attribution・本人 2026-10-21）。写真の作者と使用許諾だけは写真に添える（CC の条件）。
// 状態は URL の search（?tab=&hz=&ward=&spot=&tr=）に写す＝その画面をそのまま共有できる（data.ts の parseState／writeState）。
// UI は 26 言語（英語キー・t()・頁の辞書 i18n/pages/yokohama.json）。選挙・候補者・政策の中身には触れない＝市政の中立な道具として作る（本人 2026-10-18）。
import { createPanel, PANEL_MOBILE } from "common/panel";   // 案内パネルの枠（共有エンジンの入口）
import type { BigTable } from "common/bigtable";   // 施設の検索の表（仮想スクロール）＝engine の入口（ortho-japan の温泉の一覧と共用・2026-10-24）・「暮らし」の面を開いた時に遅延 import
import { tr, getLang } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語（頁の辞書＝i18n/pages/yokohama.json・main.ts の startPage が先に読む）。モジュール評価時に t() を呼ばない
import type { GlobeMap, LayerMouseEvent, RenderedFeature, GeoJSONFeature, LonLat, WalkHandle, Tiles3DHandle, StyleExpression, Marker, Popup } from "@ortho-earth/globe";
import { WARDS, SPOTS, TOUR, HAZARDS, CITY_VIEW, CITY_BBOX, HINAN_FLAGS, LOD1_WARDS, BUILDINGS_MIN_ZOOM, SUBWAY_MIN_ZOOM, MASK_BOX, insideBox, SUBWAY, TRANSIT, FACILITY_CATS, FACILITY_SUBS, subOf, facilityIndex, normJa, wardOfAddress, ZONES, AREAS, TAB_NAMES, TABS, lod1Url, yokohamaShelters, flagsOf, subwayCodes, parseState, writeState, DEPTH, tilePixel, legendIndex, floorsOfDepth, nearestSites, nearestRows, featureAt, siteName, walkMin, distM, PORT_STORY, SEA_VIEWS, WALK_RINGS, walkRadius, circleRing, countRings } from "./data.ts";
import type { AreaId, Spot, HinanRow, TwinState, Tab, Photo, FacilityRow, StationRow, BusRow } from "./data.ts";

const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/14.json";   // 神奈川県の指定緊急避難場所（census2020 と同じ焼き・[経度, 緯度, 名称, 住所, 対応災害ビット]）
const JAPAN_BBOX: [number, number, number, number] = [122, 20, 154, 46];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const gunzip = async (buf: ArrayBuffer): Promise<ArrayBuffer> => {
	const h = new Uint8Array(buf, 0, 2);
	return h[0] === 0x1f && h[1] === 0x8b ? new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : buf;
};
// 日本時間の「YYYY-MM-DD」と時（小数）→ Date
const jst = (ymd: string, h: number) => new Date(`${ymd}T${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}:00+09:00`);
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
/** 長い列（バスの系統・乗り入れる路線）を吹き出しに収める */
const clip = (s: string, n: number, t: (k: string, ...a: unknown[]) => string) => { const a = String(s || "").split("・").filter(Boolean); return a.length > n ? t("$1 and $2 more", a.slice(0, n).join("・"), a.length - n) : a.join("・"); };

export interface TwinOptions { /** 台帳の置き場（末尾 /・ortho-data/japan/yokohama/） */ base: string }
type MapDom = GlobeMap & { Marker: typeof Marker; Popup: typeof Popup };   // map.Marker／map.Popup（import しなくても使える口・型は globe.d.ts に無い）

export async function mountTwin(map: GlobeMap, opts: TwinOptions) {
	const t = tr(), lang = getLang();
	// 出典＝表示言語で（地図の出典の欄・2026-10-21 CDP 実測で英語ほか全言語に日本語が残っていた）
	const HAZARD_ATTR = `<a href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html" target="_blank" rel="noopener">${esc(t("Hazard Map Portal Site (MLIT)"))}</a>`;
	const HINAN_ATTR = t("Designated emergency evacuation site data (GSI)");
	// nc＝国土数値情報の使用許諾が「非商用」の物（P17 消防署・P18 警察署・P27 文化施設・P28 国の機関）＝出典に書き添える（本人 2026-10-21：今は非商用で良い・横浜市が使う時に一緒に詰める）
	const KSJ_ATTR = (what: string, nc = false) => `<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener">${esc(t("National Land Numerical Information ($1)", t(what)))}</a>${nc ? (lang === "ja" ? `（${esc(t("non-commercial use"))}）` : ` (${esc(t("non-commercial use"))})`) : ""}`;
	const LOD1_ATTR = t("MLIT PLATEAU (LOD1 buildings)");
	const num = (n: number) => n.toLocaleString(lang);
	document.title = t("Yokohama Digital Twin");
	const wardName = (code: string) => { const w = WARDS.find(x => x.code === code); return w ? t(w.en) : ""; };
	// 地下鉄の駅名＝日本語以外はローマ字（SUBWAY.romaji）。他の駅・停留所・施設の名は台帳の日本語のまま（固有名）
	const staName = (ja: string) => { if (lang === "ja" || lang === "zh") return ja;   // 中国語は漢字の駅名がそのまま読める
		const c = subwayCodes(ja)[0]; return c ? c.line.romaji[+c.code.slice(1) - 1] : ja; };
	const mapEl = map.mapEl;
	const ML = map as MapDom;
	const st: TwinState = parseState(location.search);
	// backend は初描画（frame1）で決まる＝それまで null。案内板を組む前に待つ（最長 10 秒）＝待たないと WebGPU でも切り取り・影の口が出なかった（2026-10-21 CDP 実測）
	for (let i = 0; i < 100 && !map.backend; i++) await sleep(100);
	const gpu = map.backend === "webgpu";
	const save = () => { const s = writeState(location.search, st); history.replaceState(history.state, "", location.pathname + s + location.hash); };
	// 台帳（JSON）＝一度だけ取る。無い・壊れた＝null（その機能だけ黙る）
	const memo = new Map<string, Promise<unknown>>();
	const ledger = <T>(name: string): Promise<T | null> => (memo.get(name) ?? memo.set(name, fetch(opts.base + name, { credentials: "omit" })
		.then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
		.catch(e => { console.warn("[yokohama]", name, e); return null; })).get(name)!) as Promise<T | null>;

	// ── カメラ ──
	// 地区（区・全市）＝平面の地区図：基図はベクターのまま全層（地名・地形・鉄道・道路・施設）を点ける。傾けた 3D（名所・ツアー・海の眺め）へ移る時は元の点け方へ戻す（本人 2026-10-21・ラスターには替えない）
	const ALL_LAYERS = { place: true, terrain: true, rail: true, road: true, facility: true };
	let layersBefore: ReturnType<GlobeMap["getBaseLayers"]> | undefined;   // undefined＝平面にしていない
	const setFlat = (on: boolean) => {
		if (!map.setBaseLayers) { showAreas(on); return; }   // 旧エンジン（setBaseLayers 前）＝区域だけ
		if (on) { if (layersBefore === undefined) { const now = map.getBaseLayers(); layersBefore = Object.values(now).every(Boolean) ? { ...now, terrain: false, rail: false, road: false, facility: false } : now; } showAreas(true); map.setBaseLayers(ALL_LAYERS); }   // 既に全層＝平面の地区図の共有 URL（l= が全層）から開いた＝戻り先は既定（地名だけ）
		else if (layersBefore !== undefined) { const b = layersBefore; layersBefore = undefined; showAreas(false); map.setBaseLayers(b); }
	};
	const flyView = (v: { lon: number; lat: number; zoom: number; tilt: number; bearing: number }) => { if (v.tilt > 0) setFlat(false); return map.flyTo({ center: [v.lon, v.lat], zoom: v.zoom, pitch: v.tilt, bearing: v.bearing }); };
	const flySpot = (s: Spot) => flyView(s);

	// ── 案内板（右上）──
	// 枠（見出し・副題・折り畳み・PC は右上／スマホは下端のシート）＝共通の器 common/panel（夜の配色）。ここは中身だけ
	const P = createPanel({ host: mapEl, title: t("Yokohama Digital Twin"), cls: "yk-panel",   // 副題は置かない（本人 2026-10-21）
		labels: { fold: t("Collapse panel"), unfold: t("Expand panel") } });
	const panel = P.el;
	P.body.insertAdjacentHTML("beforebegin", `<style>${CSS}</style>`);
	P.body.innerHTML = `
			<nav class="tabs" role="tablist">
				${TABS.map(k => `<button type="button" role="tab" data-tab="${k}">${esc(t(TAB_NAMES[k]))}</button>`).join("")}
			</nav>
			<section data-pane="sight" hidden>
				<button class="tour" type="button">${esc(t("▶ Landmark tour"))}</button>
				<button class="tour port" type="button">${esc(t("⚓ Port story (1859 to today)"))}</button>
				<button class="act sea" type="button">${esc(t("View the city from the sea"))}</button>
				<h2>${esc(t("Landmarks"))}</h2>
				<div class="spots">${SPOTS.map(s => `<button type="button" data-spot="${s.id}">${esc(t(s.name))}</button>`).join("")}</div>
				<div class="spot-note" hidden></div>
			</section>
			<section data-pane="life">
				<!-- 市民ファースト（本人 2026-10-25）：地区 → 探す（検索と表）を先に・地図に出す施設の種類と区域は畳む＝スマホで最初の一画面に「探す」が入る -->
				<h2>${esc(t("Around my home"))}</h2>
				<div class="hm-btns"><button type="button" class="act hm-tap">${esc(t("Tap the map at your home"))}</button><button type="button" class="act hm-gps">${esc(t("Use my current location"))}</button></div>
				<p class="sub flat hm-msg">${esc(t("One card shows your school districts, nearest stations, flood risk, evacuation site and nearby facilities."))}</p>
				<div class="detail home-out" hidden></div>
				<h2>${esc(t("District"))}</h2>
				<div class="wrow"><select class="ward" aria-label="${esc(t("District"))}"><option value="">${esc(t("Yokohama City (18 wards)"))}</option>${WARDS.map(w => `<option value="${w.code}">${esc(t(w.en))}</option>`).join("")}</select><button type="button" class="fitc" title="${esc(t("Show the whole city"))}">${esc(t("Whole city"))}</button></div>
				<h2>${esc(t("Search facilities"))}</h2>
				<input type="search" class="fq" placeholder="${esc(t("Name, type or address"))}" aria-label="${esc(t("Search facilities"))}" enterkeyhint="search">
				<div class="fbt"></div>
				<div class="fbar"><small class="fq-n"></small><button type="button" class="fcsv">${esc(t("Download CSV"))}</button></div>
				<p class="sub flat">${esc(t("Tap a row to fly there. Lists the chosen district and the facility types switched on below."))}</p>
				<label class="grp fac-w"><input type="checkbox" class="fac" checked><b>${esc(t("Show public facilities"))}</b><small class="fac-n"></small></label>
				<details class="fold ftypes"><summary>${esc(t("Types of facilities on the map"))}</summary>
				<div class="cats">${FACILITY_CATS.map((c, i) => { const subs = FACILITY_SUBS.map((x, j) => ({ x, j })).filter(({ x }) => x.cat === i);
					return `<div class="cg"><button type="button" class="on" data-cat="${i}"><i style="background:${c.color}"></i>${esc(t(c.name))}<small></small></button>${subs.length > 1 ? subs.map(({ x, j }) => `<button type="button" class="on kd" data-sub="${j}">${esc(t(x.name))}<small></small></button>`).join("") : ""}</div>`; }).join("")}</div>
				<p class="sub flat">${esc(t("They appear as you zoom in. Tap a dot for its name and address."))}</p>
				</details>
				<details class="fold areas"><summary>${esc(t("Zones and districts"))}</summary>
				<p class="sub flat">${esc(t("Shown on the flat district map (choose a district or the whole city)."))}</p>
				${AREAS.map(x => `<label class="grp"><input type="checkbox" data-area="${x.id}"><b>${x.color ? `<i class="ar" style="border-color:${x.color}"></i>` : ""}${esc(t(x.name))}</b><small data-arn="${x.id}"></small></label>`).join("")}
				<div class="lg zlg" hidden><small>${esc(t("Land-use zoning"))}</small>${ZONES.map((z, i) => `<span data-z="${i}"><i style="background:${z.color}"></i>${esc(t(z.name))}</span>`).join("")}</div>
				</details>
			</section>
			<section data-pane="transit" hidden>
				<h2>${esc(t("Railways and buses"))}</h2>
				${TRANSIT.map(x => `<label class="grp"><input type="checkbox" data-tr="${x.id}"><b>${esc(t(x.name))}</b><small data-trn="${x.id}"></small></label>`).join("")}
				<div class="lines">${SUBWAY.map(l => `<span><i class="sw" style="background:${l.color}">${l.id}</i>${esc(t(l.name))} (${esc(t("$1 stations", l.stations.length))})</span>`).join("")}</div>
				<p class="sub flat">${esc(t("Subway stations carry their station numbers (B = Blue Line, G = Green Line). Tap a station or stop to see its lines or routes."))}</p>
				<h2>${esc(t("Walking distance from a station"))}</h2>
				<label class="msel"><select class="wsta"><option value="">${esc(t("Choose a subway station"))}</option>${SUBWAY.map(l => `<optgroup label="${esc(t(l.name))}">${l.stations.map((n, i) => `<option value="${esc(n)}">${l.id}${String(i + 1).padStart(2, "0")} ${esc(staName(n))}</option>`).join("")}</optgroup>`).join("")}</select></label>
				<p class="sub flat">${esc(t("Or tap any station on the map and choose “Walking distance”."))}</p>
				<div class="detail walk-out" hidden></div>
			</section>
			<section data-pane="risk" hidden>
				<h2>${esc(t("Check a location"))}</h2>
				<button type="button" class="act probe">${esc(t("Tap the map to check a location"))}</button>
				<div class="detail probe-out" hidden></div>
				<h2>${esc(t("Overlay hazard scenarios"))}</h2>
				${HAZARDS.map(h => `<label class="grp"><input type="checkbox" data-hz="${h.id}"><b>${esc(t(h.name))}</b></label><p class="sub" data-hznote="${h.id}" hidden>${esc(t(h.note))}</p>`).join("")}
				<label class="msel hzop-w" hidden><span>${esc(t("Opacity"))}</span><input type="range" class="hzop" min="0.2" max="1" step="0.05" value="0.7"></label>
				<div class="legend" hidden></div>
				<h2>${esc(t("Designated emergency evacuation sites"))}</h2>
				<label class="grp"><input type="checkbox" class="hinan"><b>${esc(t("Show evacuation sites"))}</b><small class="hn-n"></small></label>
				<label class="msel"><span>${esc(t("Disaster type"))}</span><select class="hnf"><option value="-1">${esc(t("All"))}</option>${HINAN_FLAGS.map((f, i) => `<option value="${i}">${esc(t(f))}</option>`).join("")}</select></label>
				<div class="detail" hidden></div>
				<p class="note">${esc(t("Tilt the map to compare flood depths with building heights. Scenarios are official estimates by the national government, Kanagawa Prefecture and others; real disasters can exceed them."))}</p>
			</section>
			<section data-pane="tools" hidden>
				<h2>${esc(t("At the center of the screen"))}</h2>
				<button type="button" class="act vs">${esc(t("Viewshed (1 km radius, eye height 1.6 m)"))}</button>
				<button type="button" class="act vsclear" hidden>${esc(t("Clear the viewshed"))}</button>
				${gpu ? `<button type="button" class="act clip">${esc(t("Clip (500 m square)"))}</button>` : ""}
				<button type="button" class="act walk">${esc(t("Walk in first person (Esc to return)"))}</button>
				<h2>${esc(t("Measure"))}</h2>
				<button type="button" class="act measure">${esc(t("Distance and area"))}</button>
				<button type="button" class="act profile">${esc(t("Elevation profile"))}</button>
				<p class="sub flat toolmsg"></p>
				<h2>${esc(t("Building shadows"))}</h2>
				${gpu ? `<label class="grp"><input type="checkbox" class="shadow"><b>${esc(t("Cast shadows for this time"))}</b></label>
				<div class="dates"><label>${esc(t("Date"))}<input type="date" class="sday"></label><label>${esc(t("Time"))} <output class="shour-o"></output><input type="range" class="shour" min="5" max="19" step="0.25" value="12"></label></div>`
					: `<p class="sub flat">${esc(t("Real-time shadows need a browser with WebGPU (Chrome, Edge, etc.)."))}</p>`}
				<button type="button" class="act sunmap">${esc(t("Winter solstice shadow map (8:00–16:00)"))}</button>
				<button type="button" class="act sunclear" hidden>${esc(t("Clear the shadow map"))}</button>
				<p class="sub flat sunmsg"></p>
			</section>
		`;
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());
	const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => panel.querySelector<T>(s)!;
	const $$ = <T extends HTMLElement = HTMLInputElement>(s: string) => [...panel.querySelectorAll<T>(s)];

	// ── 面の切り替え ──
	function setTab(k: Tab) {
		st.tab = k; save(); closePop();
		$$<HTMLButtonElement>("[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === k)));
		$$<HTMLElement>("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== k; });
		if (k === "life") facTable();
	}
	$$<HTMLButtonElement>("[data-tab]").forEach(b => b.onclick = () => setTab(b.dataset.tab as Tab));

	// ── 吹き出し（施設・駅・停留所で 1 つを使い回す）──
	let pop: Popup | null = null;
	const closePop = () => { pop?.remove(); pop = null; };   // 面・地区を替えたら閉じる
	// 地点を調べる中（と、その一押しの直後）は吹き出しを出さない＝層のクリックと地図のクリックの順はエンジン任せ（どちらが先でも止める）
	const openPop = (ll: LonLat, html: string) => { if (probing || Date.now() - probedAt < 600) return; pop?.remove(); pop = new ML.Popup({ closeButton: true, maxWidth: "260px", className: "yk-pop", offset: 10 }).setLngLat(ll).setHTML(html).addTo(map); };

	// ── 観光：地区＝平面（真上から・北が上）で区の外接矩形を画面の 9 割に収める ──
	// 区の境界（wards.json）は起動時に読み、市の外の薄い覆い・全区の線・選んだ区の塗りを描く（「全部入り」の地図）。区の名前は基図が出す（重ねると二重になる・Mac 実測）
	type WardFC = { type: "FeatureCollection"; features: (GeoJSONFeature & { properties: { code: string; name: string; bbox: [number, number, number, number] } })[]; city?: LonLat[][] };
	let wardsReady: Promise<WardFC | null> | null = null;
	const maskOn = () => insideBox(map.getBounds(), MASK_BOX);
	const loadWards = () => wardsReady ??= ledger<WardFC>("wards.json").then(async fc => {
		if (!fc?.features?.length) return null;
		// 市の外を薄く覆う（本人 2026-10-21）＝周りの大きな矩形に市の外周の環を穴として開ける
		if (fc.city?.length) {
			map.addSource("yk-mask", { type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", properties: {},
				geometry: { type: "Polygon", coordinates: [[[MASK_BOX[0], MASK_BOX[1]], [MASK_BOX[2], MASK_BOX[1]], [MASK_BOX[2], MASK_BOX[3]], [MASK_BOX[0], MASK_BOX[3]], [MASK_BOX[0], MASK_BOX[1]]], ...fc.city] } }] } });
			await map.addLayer({ id: "yk-mask", type: "fill", source: "yk-mask", layout: { visibility: maskOn() ? "visible" : "none" }, paint: { "fill-color": "#26323f", "fill-opacity": 0.16 } });
			// 外枠の縁が画面に入ったら覆いごと消す（枠を見せない・本人 2026-10-21）
			let maskShown = maskOn();
			map.on("move", () => { const on = maskOn(); if (on !== maskShown) { maskShown = on; map.setLayoutProperty("yk-mask", "visibility", on ? "visible" : "none"); } });
		}
		map.addSource("yk-wards", { type: "geojson", data: fc, attribution: KSJ_ATTR("administrative boundaries") });
		await map.addLayer({ id: "yk-ward-on", type: "fill", source: "yk-wards", filter: ["==", ["get", "code"], ""], paint: { "fill-color": "#1e88e5", "fill-opacity": 0.12 } });
		await map.addLayer({ id: "yk-ward-line", type: "line", source: "yk-wards", paint: { "line-color": "#37474f", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 2.5], "line-opacity": 0.75 } });
		return fc;
	});
	// 9 割＝縦横とも 5% の余白。PC は右上の案内板の幅を右の余白に足す（板の下に区を隠さない）
	const pad90 = () => {
		const w = mapEl.clientWidth, h = mapEl.clientHeight, side = Math.min(w, h) * 0.05;
		const pr = panel.getBoundingClientRect(), mr = mapEl.getBoundingClientRect();
		const desk = pr.width < w * 0.6 && !panel.classList.contains("min");
		const sheet = !desk && !panel.classList.contains("min") && pr.top > mr.top + h * 0.3;   // スマホ＝下端のシート
		const onLeft = pr.left + pr.width / 2 < mr.left + w / 2;   // RTL（ar・fa・ur・he）は板が左に来る＝余白を足す側を板のある側に
		return { top: side, left: side + (desk && onLeft ? pr.right - mr.left : 0), right: side + (desk && !onLeft ? mr.right - pr.left : 0), bottom: side + (sheet ? mr.bottom - pr.top : 0) };
	};
	const wardSel = $<HTMLSelectElement>(".ward");
	const cityBox = (fc: WardFC | null): [number, number, number, number] | null => {
		const pts = fc?.city?.flat() ?? fc?.features.flatMap(f => [[f.properties.bbox[0], f.properties.bbox[1]], [f.properties.bbox[2], f.properties.bbox[3]]] as LonLat[]) ?? [];
		if (!pts.length) return null;
		const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
		return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
	};
	async function setWard(code: string) {
		st.ward = code; save(); wardSel.value = code; closePop(); facTable();
		const w = WARDS.find(x => x.code === code);
		const fc = await loadWards();
		if (st.ward !== code) return;   // 読んでいる間に選び直した
		const f = fc?.features.find(x => x.properties.code === code);
		const bb = f?.properties.bbox ?? (w ? null : cityBox(fc) ?? CITY_BBOX);   // 全市＝市の境界の外接矩形（読めない時は台帳の矩形）
		if (fc) map.setFilter("yk-ward-on", ["==", ["get", "code"], code || "-"]);   // 全市＝どの区も塗らない
		setFlat(true);
		if (bb) await map.fitBounds(bb, { padding: pad90(), pitch: 0, bearing: 0 });
		else if (w) await flyView({ lon: w.lon, lat: w.lat, zoom: w.zoom, tilt: 0, bearing: 0 });   // 境界が読めない時＝区の中ほどへ真上から
	}
	wardSel.onchange = () => { setWard(wardSel.value); };
	$(".fitc").onclick = () => { setWard(""); };   // 全市＝選び直さなくても押せる（セレクタは同じ値を選んでも change が来ない）

	// ── 観光：名所（写真つき）──
	const photos = () => ledger<Record<string, Photo>>("photos.json");
	const photoHTML = (ph: Photo | undefined, cls = "ph") => ph ? `<figure class="${cls}"><img src="${esc(ph.src)}" alt="" loading="lazy" referrerpolicy="no-referrer">
		<figcaption><a href="${esc(ph.file)}" target="_blank" rel="noopener">${esc(t("Photo: $1", (ph.artist || "Wikimedia Commons") + (ph.license ? ` / ${ph.license}` : "")))}</a></figcaption></figure>` : "";
	const spotNote = $<HTMLElement>(".spot-note");
	async function showSpot(s: Spot | null) {
		st.spot = s?.id || ""; save();
		$$<HTMLButtonElement>("[data-spot]").forEach(b => b.classList.toggle("on", b.dataset.spot === st.spot));
		spotNote.hidden = !s;
		if (!s) { spotNote.innerHTML = ""; return; }
		const head = `<b>${esc(t(s.name))}</b><span>${esc(wardName(s.ward))}</span><p>${esc(t(s.note))}</p>`;
		spotNote.innerHTML = head;
		const ph = (await photos())?.[s.id];
		if (st.spot === s.id && ph) spotNote.innerHTML = photoHTML(ph) + head;
	}
	$$<HTMLButtonElement>("[data-spot]").forEach(b => b.onclick = () => { const s = SPOTS.find(x => x.id === b.dataset.spot)!; showSpot(s); flySpot(s); });

	// ── 観光：公共施設（区分ごとに出し入れ・押すと吹き出し）──
	let fac: FacilityRow[] | null = null, facOn = $(".fac").checked;
	const subOn = new Set(FACILITY_SUBS.map((_, i) => i));   // 種別ごと（区分のチップは中の種別をまとめて出し入れ）
	// 全区分＝filter なし（null）。定数だけの式 ["==", 1, 1] はエンジンが何も描かない（Mac 実測 2026-10-18）＝絞らない時は filter を外す
	const facFilter = (): StyleExpression | null => subOn.size === FACILITY_SUBS.length ? null : ["match", ["get", "s"], [...subOn].length ? [...subOn] : [-1], true, false];
	let facReady: Promise<void> | null = null;
	const loadFac = () => facReady ??= (async () => {
		$<HTMLElement>(".fac-n").textContent = t("Loading…");
		const d = await ledger<{ rows: FacilityRow[] }>("facilities.json");
		if (!d?.rows?.length) { $<HTMLElement>(".fac-n").textContent = t("Could not load"); return; }
		fac = d.rows;
		map.addSource("yk-fac", { type: "geojson", attribution: KSJ_ATTR("public facilities, schools, cultural facilities, medical institutions, etc.", true),
			data: { type: "FeatureCollection", features: fac.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r[0], r[1]] }, properties: { i, c: r[3], s: subOf(r[3], r[5]) } })) } });
		const f0 = facFilter();
		await map.addLayer({ id: "yk-fac", type: "circle", source: "yk-fac", minzoom: 12.5, ...(f0 ? { filter: f0 } : {}),
			paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 3, 15, 5.5, 18, 8], "circle-color": ["match", ["get", "c"], ...FACILITY_CATS.flatMap((c, i) => [i, c.color]), "#777"],
				"circle-stroke-color": "#fff", "circle-stroke-width": 1.3 } });
		const tip = map.gadget.tip();
		const top = (e: LayerMouseEvent) => (e.features || []).find(f => f.properties?.i != null);
		map.on("mousemove", "yk-fac", e => { const f = top(e), r = f && fac![f.properties.i]; tip(r ? `<b>${esc(r[2])}</b>` : null); });
		map.on("mouseleave", "yk-fac", () => tip(null));
		map.on("click", "yk-fac", e => { const f = top(e), r = f && fac![f.properties.i]; if (!r) return; tip(null); facPop(r); });
		$$<HTMLButtonElement>("[data-cat]").forEach(b => { b.querySelector("small")!.textContent = num(fac!.filter(r => r[3] === +b.dataset.cat!).length); });
		$$<HTMLButtonElement>("[data-sub]").forEach(b => { b.querySelector("small")!.textContent = num(fac!.filter(r => subOf(r[3], r[5]) === +b.dataset.sub!).length); });
		countFac();
		facTable();
	})();
	const facKind = (r: FacilityRow) => lang === "ja" ? r[5] || t(FACILITY_CATS[r[3]]?.name || "") : t(FACILITY_SUBS[subOf(r[3], r[5])]?.name || "");
	const facPop = (r: FacilityRow) => { const c = FACILITY_CATS[r[3]];
		openPop([r[0], r[1]], `<div class="pk"><i style="background:${c?.color || "#777"}"></i>${esc(c ? t(c.name) : "")}${r[5] ? `${lang === "ja" ? "・" : " · "}${esc(facKind(r))}` : ""}</div><b>${esc(r[2])}</b>${r[4] ? `<p>${esc(r[4])}</p>` : ""}`); };
	const countFac = () => { if (fac) $<HTMLElement>(".fac-n").textContent = t("$1 places", num(fac.filter(r => subOn.has(subOf(r[3], r[5]))).length)); };
	async function setFac(on: boolean) {
		facOn = on; $(".fac").checked = on;
		if (on) await loadFac();
		if (fac) map.setLayoutProperty("yk-fac", "visibility", facOn ? "visible" : "none");
	}
	$(".fac").onchange = () => setFac($(".fac").checked);
	// チップの見た目＝種別は on/off・区分は中の種別が全部 on＝on・一部＝part
	const paintChips = () => {
		$$<HTMLButtonElement>("[data-sub]").forEach(b => b.classList.toggle("on", subOn.has(+b.dataset.sub!)));
		$$<HTMLButtonElement>("[data-cat]").forEach(b => { const js = FACILITY_SUBS.flatMap((x, j) => x.cat === +b.dataset.cat! ? [j] : []), n = js.filter(j => subOn.has(j)).length;
			b.classList.toggle("on", n === js.length); b.classList.toggle("part", n > 0 && n < js.length); });
	};
	const applyFac = () => { paintChips(); if (fac) map.setFilter("yk-fac", facFilter()); countFac(); facTable(); if (!facOn) setFac(true); };
	$$<HTMLButtonElement>("[data-cat]").forEach(b => b.onclick = () => {   // 区分＝中の種別が 1 つでも出ていれば全部消す・全部消えていれば全部出す
		const js = FACILITY_SUBS.flatMap((x, j) => x.cat === +b.dataset.cat! ? [j] : []), any = js.some(j => subOn.has(j));
		for (const j of js) any ? subOn.delete(j) : subOn.add(j);
		applyFac();
	});
	$$<HTMLButtonElement>("[data-sub]").forEach(b => b.onclick = () => { const j = +b.dataset.sub!; subOn.has(j) ? subOn.delete(j) : subOn.add(j); applyFac(); });

	// ── 暮らし：施設の検索（common/bigtable の表・本人 2026-10-22）──
	// 行＝選んだ地区（区・全市）× 出している種別（上のチップ）の施設。窓の文字＝名称・種別・区・住所の部分一致（表記の揺れは normJa で揃える）。
	// 行を押す＝その施設へ飛んで吹き出し。表は「暮らし」の面を開いている時だけ組み直す（開くまで common/bigtable も読まない）
	const fq = $(".fq"), fqN = $<HTMLElement>(".fq-n");
	let tableReady: Promise<BigTable> | null = null;
	const facTableOf = () => tableReady ??= import("common/bigtable").then(({ BigTable }) => new BigTable($<HTMLElement>(".fbt"), {
		columns: [{ index: 0, label: t("Facility name"), width: 168 }, { index: 1, label: t("Type"), width: 104 }, { index: 2, label: t("Ward"), width: 84 }, { index: 3, label: t("Address"), width: 220 }],
		rowNumbers: false, theme: "dark", rowHeight: 26,
		onRowClick: (row, k) => { const r = fac?.[(row as unknown[])[4] as number]; if (!r) return; table?.select(k, { scroll: false }); goFac(r); },
		onCountChange: c => { fqN.textContent = t("$1 of $2 places", num(c.shown), num(c.total)); },
	}));
	let table: BigTable | null = null;
	async function facTable() {
		if (!fac || st.tab !== "life") return;
		const tb = table = await facTableOf();
		tb.setQuery(normJa(fq.value));
		tb.setRows(facilityIndex(fac, st.ward, subOn).map(i => { const r = fac![i]; return [normJa(r[2]), facKind(r), wardName(wardOfAddress(r[4])?.code ?? ""), normJa(r[4]), i]; }));
	}
	fq.oninput = () => { table?.setQuery(normJa(fq.value)); };
	async function goFac(r: FacilityRow) {
		if (!facOn) await setFac(true);
		facPop(r);
		await map.flyTo({ center: [r[0], r[1]], zoom: Math.max(map.getZoom(), 16.5) });   // 点が見える z（minzoom 12.5）の上・建物も立つ（BUILDINGS_MIN_ZOOM）
	}
	$(".fcsv").onclick = async () => {
		if (!fac) return;
		const tb = await facTableOf(), a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([tb.toCSV()], { type: "text/csv;charset=utf-8" }));
		a.download = `yokohama-facilities${st.ward ? "-" + st.ward : ""}.csv`;
		a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	};

	// ── 観光：平面の地区地図に重ねる区域（用途地域・小／中学校区・警察署／消防署の管轄）＝淡色の平面の時だけ出す（本人 2026-10-21）──
	const areaOn = new Set<AreaId>(), areaReady = new Map<AreaId, Promise<boolean>>();
	const POINT_LAYERS = new Set(["yk-fac", "yk-hinan", "yk-bus", "yk-rail-st"]);   // 面より先に答える点の層
	let flat = false;
	const zoneOf = (n: string) => ZONES.findIndex(z => z.ja === n);
	const areaIds = (id: AreaId) => [`yk-area-${id}`, `yk-area-${id}-line`];
	const loadArea = (id: AreaId) => {
		let p = areaReady.get(id);
		if (p) return p;
		const x = AREAS.find(a => a.id === id)!;
		p = ledger<{ type: "FeatureCollection"; features: GeoJSONFeature[] }>(x.file).then(async fc => {
			const n = $<HTMLElement>(`[data-arn="${id}"]`);
			if (!fc?.features?.length) { n.textContent = t("Could not load"); return false; }
			n.textContent = "";
			if (id === "zoning") { const has = new Set(fc.features.map(f => zoneOf(String(f.properties?.n || "")))); $$<HTMLElement>(".zlg [data-z]").forEach(e => e.style.display = has.has(+e.dataset.z!) ? "" : "none"); }   // 凡例は市内にある種だけ（田園住居地域は無い）
			const [fid, lid] = areaIds(id);
			const data = id === "zoning" ? { ...fc, features: fc.features.map(f => ({ ...f, properties: { ...f.properties, z: zoneOf(String(f.properties?.n || "")) } })) } : fc;
			map.addSource(fid, { type: "geojson", data, attribution: KSJ_ATTR(x.name, id === "police" || id === "fire") });
			await map.addLayer({ id: fid, type: "fill", source: fid, layout: { visibility: "none" },
				paint: id === "zoning" ? { "fill-color": ["match", ["get", "z"], ...ZONES.flatMap((z, i) => [i, z.color]), "#bbbbbb"], "fill-opacity": 0.5 } : { "fill-color": x.color, "fill-opacity": 0.06 } });
			await map.addLayer({ id: lid, type: "line", source: fid, layout: { visibility: "none" },
				paint: id === "zoning" ? { "line-color": "#ffffff", "line-width": 0.6, "line-opacity": 0.8 } : { "line-color": x.color, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.2, 16, 2.6], "line-opacity": 0.85 } });
			map.on("click", fid, (e: LayerMouseEvent) => { areaPop(e); });
			return true;
		});
		areaReady.set(id, p);
		return p;
	};
	// 区域の吹き出し＝押した所にある区域（出している物だけ）を 1 つにまとめる（重ねた時に片方しか出なかった・Mac 実測 2026-10-21）。
	// 1 回の押しで層ごとに呼ばれる＝同じ点の 2 回目からは捨てる。点（施設・避難場所・バス停・駅）を押した時は出さない＝面が点のクリックを奪っていた
	let areaPopKey = "";
	async function areaPop(e: LayerMouseEvent) {
		const ll = e.lngLat, key = `${e.point.x},${e.point.y},${e.originalEvent?.timeStamp ?? ""}`;
		if (probing || !ll || key === areaPopKey) return;
		areaPopKey = key;
		const under = await map.queryRenderedFeatures([e.point.x, e.point.y]).catch(() => [] as RenderedFeature[]);
		if (under.some(g => POINT_LAYERS.has(String(g.layer?.id)))) return;
		const rows: string[] = [];
		for (const x of AREAS) {
			const f = under.find(g => g.layer?.id === `yk-area-${x.id}`); if (!f) continue;
			const p = f.properties || {}, z = x.id === "zoning" ? ZONES[zoneOf(String(p.n || ""))] : null;
			rows.push(`<div class="pk">${esc(t(x.name))}</div><b>${esc(z ? (lang === "ja" ? z.ja : t(z.name)) : String(p.n || ""))}</b>`
				+ (z && (p.b || p.f) ? `<p>${esc(t("Building coverage $1% · Floor area ratio $2%", p.b ?? "?", p.f ?? "?"))}</p>` : "")
				+ (p.a ? `<p>${esc(String(p.a))}</p>` : "") + (x.id === "police" || x.id === "fire" ? `<p>${esc(t("Boundaries as of 2012."))}</p>` : ""));
		}
		if (rows.length) openPop([ll.lng, ll.lat], rows.join(`<hr class="ys">`));
	}
	const areaVis = (id: AreaId) => { if (!areaReady.has(id)) return; areaReady.get(id)!.then(ok => { if (ok) for (const l of areaIds(id)) map.setLayoutProperty(l, "visibility", flat && areaOn.has(id) ? "visible" : "none"); }); };
	function showAreas(on: boolean) { flat = on; for (const x of AREAS) areaVis(x.id); }
	async function setArea(id: AreaId, on: boolean) {
		on ? areaOn.add(id) : areaOn.delete(id);
		$(`[data-area="${id}"]`).checked = on;
		if (on) $<HTMLDetailsElement>("details.areas").open = true;   // 畳んだ中の区域が点いている＝見えるように開く
		if (id === "zoning") $<HTMLElement>(".zlg").hidden = !on;
		if (on) { if (!flat) setWard(st.ward); await loadArea(id); }   // 3D の時に入れた＝平面の地区地図へ移る
		areaVis(id);
	}
	$$("[data-area]").forEach(inp => inp.onchange = () => setArea(inp.dataset.area as AreaId, inp.checked));

	// ── 建物：18 区（LOD2 の 5 区はエンジン・残り 13 区の LOD1 はここで PLATEAU の 3D Tiles を直に・z が BUILDINGS_MIN_ZOOM 以上の時だけ）──
	const lod1: Tiles3DHandle[] = [];
	const lod1Ready = Promise.all(LOD1_WARDS.map(w => map.gadget.tiles3d(lod1Url(w.code), { id: `yk-lod1-${w.code}`, ground: "terrain", textures: false, fit: false, pickable: false, attribution: LOD1_ATTR,
		style: { color: "color('#8d96a3')" } })   // 箱は白地の基図に白では埋もれる（Mac 実測）＝LOD2 の建物と同じ灰で立てる。文字列は Cesium の式として読まれる＝素の "#rrggbb" は字句で落ちて 13 区とも出なかった＝color() で包む
		.catch(e => { console.warn("[yokohama] lod1", w.name, e); return null; })))
		.then(hs => { for (const h of hs) if (h) { h.setVisible(lod1Shown); lod1.push(h); } return lod1; });
	// LOD1 は z で出し入れ（BUILDINGS_MIN_ZOOM 未満＝全部隠す・傾きは見ない）＝粗い段だけの枠が四角く抜けるまだらを出さない。隠している間は取りにも行かない
	let lod1Shown = map.getZoom() >= BUILDINGS_MIN_ZOOM;
	// 基図の押し出し（building-extrusion＝PLATEAU の無い所の大きな建物だけ）と LOD2 の 5 区のメッシュ（map.setMeshVisible）も同じしきいで伏せる＝しきい未満は 18 区とも建物なし（本人「ないところがあるなら、全部ない方がいい」）
	const extrusion = (on: boolean) => { map.setMeshVisible(on); try { if (map.getLayer("building-extrusion")) map.setLayoutProperty("building-extrusion", "visibility", on ? "visible" : "none"); } catch (e) { console.warn("[yokohama] extrusion", e); } };
	const lod1Gate = () => { const on = map.getZoom() >= BUILDINGS_MIN_ZOOM; if (on === lod1Shown) return; lod1Shown = on; for (const h of lod1) h.setVisible(on); extrusion(on); };
	extrusion(lod1Shown);
	map.on("move", lod1Gate);

	// ── 名所ツアー（画面の下に札・地図に触れたら止まる）──
	const cap = document.createElement("div");
	cap.className = "yk-cap"; cap.hidden = true;
	mapEl.appendChild(cap);
	let touring = 0;   // ツアーの通し番号（0＝止まっている）
	const stopTour = () => { if (!touring) return; touring = 0; cap.hidden = true; $(".tour:not(.port)").textContent = t("▶ Landmark tour"); $(".port").textContent = t("⚓ Port story (1859 to today)"); };
	for (const ev of ["pointerdown", "wheel"]) mapEl.addEventListener(ev, e => { if (!panel.contains(e.target as Node) && !cap.contains(e.target as Node)) stopTour(); });
	cap.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".x")) stopTour(); });
	async function tour() {
		if (touring) { stopTour(); return; }
		const run = touring = Date.now();
		setTab("sight");
		$(".tour:not(.port)").textContent = t("■ Stop the tour");
		const stops = TOUR.map(id => SPOTS.find(s => s.id === id)!);
		const ph = await photos();
		const say = (html: string) => { if (touring === run) { cap.hidden = false; cap.innerHTML = `${html}<button class="x" type="button" aria-label="${esc(t("Stop"))}">×</button>`; } };
		say(`<div class="ct"><b>${esc(t("Yokohama City"))}</b><p>${esc(t("18 wards, about 437 km². From the port to the hillside suburbs, a tour through the city in 3D."))}</p></div>`);
		await flyView(CITY_VIEW); await sleep(2500);
		for (const [i, s] of stops.entries()) {
			if (touring !== run) return;
			say(`${photoHTML(ph?.[s.id], "cph")}<div class="ct"><small>${i + 1} / ${stops.length} · ${esc(wardName(s.ward))}</small><b>${esc(t(s.name))}</b><p>${esc(t(s.note))}</p></div>`);
			showSpot(s);
			await flySpot(s);
			if (touring !== run) return;
			await map.easeTo({ bearing: s.bearing + 40, duration: 6000 });   // ゆっくり回り込む
		}
		if (touring !== run) return;
		await flyView(CITY_VIEW);
		stopTour();
	}
	$(".tour:not(.port)").onclick = () => { tour(); };

	// ── 港の物語（1859 の開港から今まで・章ごとに年と写真）と、海からの眺め＝東京都の頁に無い「横浜の物語」（本人 2026-10-21）──
	async function seaView(run: number) {
		for (const [i, v] of SEA_VIEWS.entries()) {
			if (touring !== run) return;
			await (i ? map.easeTo({ center: [v.lon, v.lat], zoom: v.zoom, pitch: v.tilt, bearing: v.bearing, duration: 7000 }) : flyView(v));
			if (touring !== run) return;
			await map.easeTo({ bearing: v.bearing + 25, duration: 5000 });   // 船の上から見渡す
		}
	}
	async function portStory() {
		if (touring) { stopTour(); return; }
		const run = touring = Date.now();
		setTab("sight"); showSpot(null);
		$(".port").textContent = t("■ Stop the tour");
		const ph = await photos();
		const say = (html: string) => { if (touring === run) { cap.hidden = false; cap.innerHTML = `${html}<button class="x" type="button" aria-label="${esc(t("Stop"))}">×</button>`; } };
		for (const c of PORT_STORY) {
			if (touring !== run) return;
			say(`${photoHTML(ph?.[c.photo || c.id], "cph")}<div class="ct"><small class="yr">${c.year}</small><b>${esc(t(c.name))}</b><p>${esc(t(c.note))}</p></div>`);
			await flySpot(c);
			if (touring !== run) return;
			await map.easeTo({ bearing: c.bearing + 35, duration: 5500 });
		}
		if (touring !== run) return;
		say(`<div class="ct"><small class="yr">${esc(t("Today"))}</small><b>${esc(t("View the city from the sea"))}</b><p>${esc(t("The skyline as seen from a ship entering the harbor."))}</p></div>`);
		await seaView(run);
		stopTour();
	}
	$(".port").onclick = () => { portStory(); };
	$(".sea").onclick = async () => {
		if (touring) stopTour();
		const run = touring = Date.now();
		$(".port").textContent = t("■ Stop the tour");
		await seaView(run);
		if (touring === run) stopTour();
	};

	// ── 交通：地下鉄（線＝路線の色・駅＝駅番号の記号）・JR と私鉄・市営バス ──
	type RailLedger = { lines: { type: "FeatureCollection"; features: GeoJSONFeature[] }; stations: StationRow[] };
	const trOn = new Set<string>();
	let railReady: Promise<RailLedger | null> | null = null;
	const subMarks: Marker[] = [];
	const lineColor = (name: string) => /4号線|グリーン/.test(name) ? SUBWAY[1].color : SUBWAY[0].color;   // N02 の路線名＝1号線・3号線（ブルー）／4号線（グリーン）
	const loadRail = () => railReady ??= ledger<RailLedger>("rail.json").then(async d => {
		if (!d?.lines?.features?.length) return null;
		const sub = d.lines.features.filter(f => f.properties?.subway), other = d.lines.features.filter(f => !f.properties?.subway);
		map.addSource("yk-rail", { type: "geojson", data: { type: "FeatureCollection", features: other }, attribution: KSJ_ATTR("railways") });
		await map.addLayer({ id: "yk-rail", type: "line", source: "yk-rail", layout: { visibility: "none" }, paint: { "line-color": "#5d6670", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 3] } });
		const ost = d.stations.filter(s => !s[4]);
		map.addSource("yk-rail-st", { type: "geojson", data: { type: "FeatureCollection", features: ost.map((s, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s[0], s[1]] }, properties: { i } })) } });
		await map.addLayer({ id: "yk-rail-st", type: "circle", source: "yk-rail-st", layout: { visibility: "none" },
			paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6], "circle-color": "#fff", "circle-stroke-color": "#37474f", "circle-stroke-width": 2 } });
		const tip = map.gadget.tip();
		const top = (e: LayerMouseEvent) => (e.features || []).find(f => f.properties?.i != null);
		map.on("mousemove", "yk-rail-st", e => { const f = top(e); tip(f ? `<b>${esc(t("$1 Station", ost[f.properties.i][2]))}</b>` : null); });
		map.on("mouseleave", "yk-rail-st", () => tip(null));
		map.on("click", "yk-rail-st", e => { const f = top(e), s = f && ost[f.properties.i]; if (!s) return; tip(null);
			openPop([s[0], s[1]], `<div class="pk">${esc(t("Railway station"))}</div><b>${esc(t("$1 Station", s[2]))}</b><p>${esc(clip(s[3], 8, t))}</p>${walkBtn(s[0], s[1], s[2], s[2])}`); });
		// 地下鉄の線＝路線の色（N02 の路線名で塗り分けを焼く＝式に文字列の部分一致を頼らない）
		map.addSource("yk-sub", { type: "geojson", data: { type: "FeatureCollection", features: sub.map(f => ({ ...f, properties: { ...f.properties, col: lineColor(String(f.properties?.line || "")) } })) } });
		await map.addLayer({ id: "yk-sub-case", type: "line", source: "yk-sub", layout: { visibility: "none" }, paint: { "line-color": "#fff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 9] } });
		await map.addLayer({ id: "yk-sub", type: "line", source: "yk-sub", layout: { visibility: "none" }, paint: { "line-color": ["get", "col"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, 6] } });
		// 地下鉄の駅＝駅番号の記号（DOM の Marker・42 駅）。乗換駅（センター南・北）は記号を 2 つ並べる
		for (const s of d.stations.filter(s => s[4])) {
			const codes = subwayCodes(s[2]);
			const el = document.createElement("div");
			el.className = "yk-sta";
			el.innerHTML = `<span class="sym">${codes.map(c => `<i style="--c:${c.line.color}">${c.code}</i>`).join("") || "<i>?</i>"}</span><span class="nm">${esc(staName(s[2]))}</span>`;
			el.title = t("$1 Station", staName(s[2]));
			el.addEventListener("click", ev => { ev.stopPropagation();
				openPop([s[0], s[1]], `<div class="pk">${esc(t("Yokohama Municipal Subway"))}</div><b>${esc(t("$1 Station", staName(s[2])))}</b><p>${codes.map(c => `${c.code} · ${esc(t(c.line.name))}`).join("<br>") || esc(s[3])}</p>${walkBtn(s[0], s[1], staName(s[2]), s[2])}`); });
			subMarks.push(new ML.Marker({ element: el, anchor: "center" }).setLngLat([s[0], s[1]]));
		}
		$<HTMLElement>('[data-trn="subway"]').textContent = t("$1 stations", num(subMarks.length));
		$<HTMLElement>('[data-trn="rail"]').textContent = t("$1 stations", num(ost.length));
		return d;
	});
	let bus: BusRow[] | null = null, busReady: Promise<void> | null = null;
	const loadBus = () => busReady ??= ledger<{ stops: BusRow[] }>("bus.json").then(async d => {
		if (!d?.stops?.length) { $<HTMLElement>('[data-trn="bus"]').textContent = t("Could not load"); return; }
		bus = d.stops;
		map.addSource("yk-bus", { type: "geojson", attribution: KSJ_ATTR("bus stops"), data: { type: "FeatureCollection", features: bus.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r[0], r[1]] }, properties: { i } })) } });
		await map.addLayer({ id: "yk-bus", type: "circle", source: "yk-bus", minzoom: 12.5, layout: { visibility: "none" },
			paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 2, 15, 4, 18, 6.5], "circle-color": "#ef6c00", "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
		const tip = map.gadget.tip();
		const top = (e: LayerMouseEvent) => (e.features || []).find(f => f.properties?.i != null);
		map.on("mousemove", "yk-bus", e => { const f = top(e); tip(f ? `<b>${esc(bus![f.properties.i][2])}</b>` : null); });
		map.on("mouseleave", "yk-bus", () => tip(null));
		map.on("click", "yk-bus", e => { const f = top(e), r = f && bus![f.properties.i]; if (!r) return; tip(null);
			openPop([r[0], r[1]], `<div class="pk">${esc(t("Yokohama Municipal Bus"))}</div><b>${esc(r[2])}</b>${r[3] ? `<p>${esc(t("Routes: $1", clip(r[3], 10, t)))}</p>` : ""}`); });
		$<HTMLElement>('[data-trn="bus"]').textContent = t("$1 places", num(bus.length));
	});
	async function setTransit(id: string, on: boolean) {
		on ? trOn.add(id) : trOn.delete(id);
		st.tr = TRANSIT.filter(x => trOn.has(x.id)).map(x => x.id); save();
		$(`[data-tr="${id}"]`).checked = on;
		const vis = (lid: string, v: boolean) => map.setLayoutProperty(lid, "visibility", v ? "visible" : "none");
		if (id === "bus") { if (on) await loadBus(); if (bus) vis("yk-bus", trOn.has("bus")); return; }
		if (on) $<HTMLElement>(`[data-trn="${id}"]`).textContent ||= t("Loading…");
		const d = await loadRail();
		if (!d) { $<HTMLElement>(`[data-trn="${id}"]`).textContent = t("Could not load"); return; }
		const rail = trOn.has("rail");
		subReady = true; subShown = null; subGate();
		vis("yk-rail", rail); vis("yk-rail-st", rail);
	}
	// 市営地下鉄は SUBWAY_MIN_ZOOM 未満（市より広い縮尺）では線も駅の記号も消す（本人 2026-10-21）
	let subShown: boolean | null = null, subReady = false;   // subReady＝地下鉄の層と記号ができた（loadRail の後）
	function subGate() {
		if (!subReady) return;
		const on = trOn.has("subway") && map.getZoom() >= SUBWAY_MIN_ZOOM;
		if (on === subShown) return;
		subShown = on;
		for (const l of ["yk-sub-case", "yk-sub"]) map.setLayoutProperty(l, "visibility", on ? "visible" : "none");
		for (const m of subMarks) on ? m.addTo(map) : m.remove();
	}
	map.on("move", subGate);
	$$("[data-tr]").forEach(inp => inp.onchange = () => setTransit(inp.dataset.tr!, inp.checked));
	// 地下鉄の駅名は寄った時だけ（引くと記号だけ）
	const nameGate = () => mapEl.classList.toggle("yk-sta-names", map.getZoom() >= 13.5);
	map.on("move", nameGate); nameGate();

	// ── 交通：駅からの徒歩圏（5・10・15 分の輪と、輪の中の公共施設・バス停・駅・避難場所の数）＝東京都の頁に無い「暮らしの読み」（本人 2026-10-21）──
	// 輪は直線の目安（80m/分・道のりは直線の 1.3 倍）。道路網の到達圏ではない＝注記で言う
	function walkBtn(lon: number, lat: number, name: string, ja: string) { return `<button type="button" class="walkr" data-lon="${lon}" data-lat="${lat}" data-name="${esc(name)}" data-ja="${esc(ja)}">${esc(t("Walking distance"))}</button>`; }
	const walkOut = $<HTMLElement>(".walk-out");
	let walkLayer = false; const walkLabels: Marker[] = [];
	const clearWalk = () => { walkOut.hidden = true; walkLabels.splice(0).forEach(m => m.remove()); if (walkLayer) { map.setLayoutProperty("yk-walk", "visibility", "none"); map.setLayoutProperty("yk-walk-line", "visibility", "none"); } };
	async function walkFrom(lon: number, lat: number, name: string, ja: string) {   // name＝見出し（表示言語）・ja＝台帳の駅名（同じ名の駅を数えない）
		closePop(); clearWalk();
		if (st.tab !== "transit") setTab("transit");
		if (narrow()) P.setFold(false);
		const at: [number, number] = [lon, lat];
		const fc = { type: "FeatureCollection" as const, features: [...WALK_RINGS].reverse().map(m => ({ type: "Feature" as const, properties: { m }, geometry: { type: "Polygon" as const, coordinates: [circleRing(at, walkRadius(m))] } })) };
		if (!walkLayer) {
			walkLayer = true;
			map.addSource("yk-walk", { type: "geojson", data: fc });
			await map.addLayer({ id: "yk-walk", type: "fill", source: "yk-walk", paint: { "fill-color": "#1f6fc5", "fill-opacity": ["match", ["get", "m"], 5, 0.16, 10, 0.1, 0.06] } });
			await map.addLayer({ id: "yk-walk-line", type: "line", source: "yk-walk", paint: { "line-color": "#1f6fc5", "line-width": 1.6, "line-opacity": 0.8 } });
		} else { map.getSource("yk-walk")?.setData?.(fc); map.setLayoutProperty("yk-walk", "visibility", "visible"); map.setLayoutProperty("yk-walk-line", "visibility", "visible"); }
		for (const m of WALK_RINGS) {
			const el = document.createElement("div"); el.className = "yk-wlab"; el.textContent = t("$1 min", m);
			walkLabels.push(new ML.Marker({ element: el, anchor: "bottom" }).setLngLat(circleRing(at, walkRadius(m), 4)[0]).addTo(map));
		}
		const r = circleRing(at, walkRadius(WALK_RINGS[WALK_RINGS.length - 1]), 4);
		map.fitBounds([[r[3][0], r[2][1]], [r[1][0], r[0][1]]], { padding: pad90(), pitch: 0, bearing: 0 });
		walkOut.hidden = false;
		const head = `<div class="dh"><b>${esc(t("Walking distance from $1", t("$1 Station", name)))}</b><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>`;
		walkOut.innerHTML = head + `<p class="sub flat">${esc(t("Loading…"))}</p>`;
		const run = walkOut.dataset.run = String(Date.now());
		const [, rail, , sh] = await Promise.all([loadFac(), loadRail(), loadBus(), loadShelters()]);
		if (walkOut.dataset.run !== run) return;
		const rows: [string, string, number[]][] = [];
		if (fac) FACILITY_CATS.forEach((c, i) => { const n = countRings(fac!, at, r => r[3] === i); if (n[n.length - 1]) rows.push([c.color, t(c.name), n]); });
		if (sh) { const seen = new Set<string>(); rows.push(["#1f9d55", t("Evacuation sites"), countRings(sh.filter(r => !seen.has(siteName(r[2])) && !!seen.add(siteName(r[2]))), at)]); }   // 棟ごとの行を 1 か所に
		if (bus) rows.push(["#ef6c00", t("Bus stops"), countRings(bus, at)]);
		if (rail) rows.push(["#37474f", t("Railway stations"), countRings(rail.stations.filter(s => distM(at, [s[0], s[1]]) > 30 && s[2] !== ja), at)]);   // 自分の駅（他社の同じ名の駅も）は数えない
		walkOut.innerHTML = head + `<table class="wt"><thead><tr><th></th>${WALK_RINGS.map(m => `<th>${esc(t("$1 min", m))}</th>`).join("")}</tr></thead>
			<tbody>${rows.map(([c, n, v]) => `<tr><td><i style="background:${c}"></i>${esc(n)}</td>${v.map(x => `<td>${num(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>
			<p class="sub flat">${esc(t("Rings are rough estimates: 80 m per minute, with routes 1.3 times the straight line."))}</p>`;
		walkOut.scrollIntoView({ block: "nearest", behavior: "smooth" });   // スマホ：表が板の下に隠れないよう（板の中を送る）
	}
	walkOut.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".x")) { clearWalk(); $<HTMLSelectElement>(".wsta").value = ""; } });
	$<HTMLSelectElement>(".wsta").onchange = async () => {
		const n = $<HTMLSelectElement>(".wsta").value; if (!n) { clearWalk(); return; }
		const d = await loadRail(); const s = d?.stations.find(x => x[4] && subwayCodes(x[2]).some(c => c.line.stations[+c.code.slice(1) - 1] === n));
		if (s) walkFrom(s[0], s[1], staName(s[2]), s[2]);
	};
	document.addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".walkr"); if (b) walkFrom(+b.dataset.lon!, +b.dataset.lat!, b.dataset.name!, b.dataset.ja || ""); });

	// ── 防災：ハザードの画像タイル ──
	const hzOn = new Set<string>();
	let hzOpacity = 0.7;
	const hzIds = (id: string) => HAZARDS.find(h => h.id === id)!.urls.map((_, i) => `yk-hz-${id}-${i}`);
	async function setHazard(id: string, on: boolean) {
		const h = HAZARDS.find(x => x.id === id); if (!h) return;
		on ? hzOn.add(id) : hzOn.delete(id);
		st.hz = HAZARDS.filter(x => hzOn.has(x.id)).map(x => x.id); save();
		$(`[data-hz="${id}"]`).checked = on;
		$<HTMLElement>(`[data-hznote="${id}"]`).hidden = !on;
		renderLegend();
		if (!on) { for (const rid of hzIds(id)) map.raster.remove(rid); return; }
		await Promise.all(h.urls.map((url, i) => map.raster.add(`yk-hz-${id}-${i}`, { url, minZoom: 2, maxZoom: h.maxZoom, bbox: JAPAN_BBOX, attribution: HAZARD_ATTR, name: t(h.name) }, { order: "over", opacity: hzOpacity })
			.catch(e => console.warn("[yokohama] hazard", id, e))));
	}
	function renderLegend() {
		const el = $<HTMLElement>(".legend");
		const hs = HAZARDS.filter(h => hzOn.has(h.id));
		el.hidden = !hs.length; $<HTMLElement>(".hzop-w").hidden = !hs.length;
		// 浸水深の凡例は洪水・高潮・津波で同じ＝1 回だけ出す
		const seen = new Set<string>();
		el.innerHTML = hs.map(h => { const k = h.legend.map(l => l.label).join(); if (seen.has(k)) return ""; seen.add(k);
			return `<div class="lg"><small>${esc(t(h.id === "dosha" ? "Sediment disasters" : "Flood depth"))}</small>${h.legend.map(l => `<span><i style="background:${l.color}"></i>${esc(t(l.label))}</span>`).join("")}</div>`; }).join("");
	}
	$$("[data-hz]").forEach(inp => inp.onchange = () => setHazard(inp.dataset.hz!, inp.checked));
	$(".hzop").oninput = () => { hzOpacity = +$(".hzop").value; for (const id of hzOn) for (const rid of hzIds(id)) map.raster.set(rid, { opacity: hzOpacity }); };

	// ── 防災：指定緊急避難場所（点の層・押すと詳細と標高）──
	let shelters: HinanRow[] | null = null, hinanOn = false;
	// 「すべて」＝filter なし（null）。定数だけの式 ["==", 1, 1] はエンジンが何も描かない（Mac 実測 2026-10-18）＝絞らない時は filter を外す
	const hnFilter = (): StyleExpression | null => { const f = +$<HTMLSelectElement>(".hnf").value; return f < 0 ? null : ["==", ["get", `f${f}`], 1]; };
	// 避難場所の台帳（読むだけ・層は隠して足す）＝防災の点・地点を調べる・駅の徒歩圏で使い回す
	let shReady: Promise<HinanRow[] | null> | null = null;
	const loadShelters = () => shReady ??= (async () => {
		$<HTMLElement>(".hn-n").textContent = t("Loading…");
		try {
			const r = await fetch(HINAN_URL, { credentials: "omit" });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			shelters = yokohamaShelters(JSON.parse(new TextDecoder().decode(await gunzip(await r.arrayBuffer()))));
		} catch (e) { console.warn("[yokohama] hinan", e); $<HTMLElement>(".hn-n").textContent = t("Could not load"); shReady = null; return null; }
		const feats: GeoJSONFeature[] = shelters.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r[0], r[1]] },
			properties: { i, ...Object.fromEntries(HINAN_FLAGS.map((_, b) => [`f${b}`, r[4] & (1 << b) ? 1 : 0])) } }));
		map.addSource("yk-hinan", { type: "geojson", data: { type: "FeatureCollection", features: feats }, attribution: HINAN_ATTR });
		const f0 = hnFilter();
		await map.addLayer({ id: "yk-hinan", type: "circle", source: "yk-hinan", ...(f0 ? { filter: f0 } : {}), layout: { visibility: "none" },
			paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 5, 18, 8], "circle-color": "#1f9d55", "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
		const tip = map.gadget.tip();
		const top = (e: LayerMouseEvent) => (e.features || []).find(f => f.properties?.i != null);
		map.on("mousemove", "yk-hinan", e => { const f = top(e), r = f && shelters![f.properties.i]; tip(r ? [`<b>${esc(r[2])}</b>`, esc(flagsOf(r[4]).map(f => t(f)).join(" · ") || t("No disaster types listed"))] : null); });
		map.on("mouseleave", "yk-hinan", () => tip(null));
		map.on("click", "yk-hinan", e => { const f = top(e); if (f) showShelter(shelters![f.properties.i]); });
		countShelters();
		return shelters;
	})();
	async function setHinan(on: boolean) {
		hinanOn = on; $(".hinan").checked = on;
		if (!on) { if (shelters) map.setLayoutProperty("yk-hinan", "visibility", "none"); $<HTMLElement>(".detail").hidden = true; return; }
		if (!await loadShelters()) { hinanOn = false; $(".hinan").checked = false; return; }
		if (!hinanOn) return;   // 読んでいる間に外した
		map.setLayoutProperty("yk-hinan", "visibility", "visible");
		countShelters();
	}
	function countShelters() {
		if (!shelters) return;
		const f = +$<HTMLSelectElement>(".hnf").value;
		$<HTMLElement>(".hn-n").textContent = t("$1 places", num(shelters.filter(r => f < 0 || r[4] & (1 << f)).length));
	}
	async function showShelter(r: HinanRow) {
		const el = $<HTMLElement>(".detail");
		el.hidden = false;
		el.innerHTML = `<div class="dh"><b>${esc(r[2])}</b><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>
			<p>${esc(r[3])}</p>
			<div class="badges">${flagsOf(r[4]).map(f => `<span>${esc(t(f))}</span>`).join("") || `<small>${esc(t("No disaster types listed"))}</small>`}</div>
			<p class="elev">${esc(t("Elevation …"))}</p>`;
		el.querySelector<HTMLButtonElement>(".x")!.onclick = () => { el.hidden = true; };
		const h = await map.getHeight(r[0], r[1]).catch(() => NaN);   // 標高＝高台へ逃げるか（水平避難）の読みどころ
		const ev = el.querySelector(".elev");
		if (ev?.isConnected) ev.textContent = Number.isFinite(h) ? t("Elevation about $1 m", num(Math.round(h))) : "";
	}
	$(".hinan").onchange = () => setHinan($(".hinan").checked);
	$<HTMLSelectElement>(".hnf").onchange = () => { if (shelters) map.setFilter("yk-hinan", hnFilter()); countShelters(); };

	// ── 防災：地点を調べる（押した所の想定浸水の深さ・土砂の区域・最寄りの避難場所 3 か所の距離・徒歩・標高差）＝東京都の頁に無い「自分ごと」の読み（本人 2026-10-21）──
	// 浸水の深さ＝重ねるハザードマップの PNG（z17）の 1 画素を凡例の色に当てる（ブラウザが直に取る・ACAO *）。標高＝map.getHeight。距離＝直線・徒歩＝80m/分×道のり 1.3 倍
	const probeOut = $<HTMLElement>(".probe-out");
	let probing = false, probeHome = false, probedAt = 0, probeMark: Marker | null = null, probeLine = false;
	// 地図を押して調べる口は 2 つ＝防災の「地点を調べる」と暮らしの「わが家のまわり」（home）。どちらも同じ押し待ち（吹き出しを止める）
	const setProbing = (on: boolean, home = false) => {
		probing = on; probeHome = on && home;
		$(".probe").textContent = t(on && !home ? "Tap a point on the map." : "Tap the map to check a location"); $(".probe").classList.toggle("on", on && !home);
		$(".hm-tap").textContent = t(on && home ? "Tap a point on the map." : "Tap the map at your home"); $(".hm-tap").classList.toggle("on", on && home);
		mapEl.classList.toggle("yk-probing", on);
	};
	// スマホ：地図を押す間はパネルを畳み、結果が出たら開く（下からのパネルが地図を隠すため）
	const narrow = () => matchMedia(`(max-width:${PANEL_MOBILE}px)`).matches;
	$(".probe").onclick = () => { setProbing(!(probing && !probeHome)); if (probing && narrow()) P.setFold(true); };
	async function samplePx(url: string, lon: number, lat: number, legend: typeof DEPTH): Promise<number> {
		const z = 17, p = tilePixel(lon, lat, z);
		try {
			const r = await fetch(url.replace("{z}", String(z)).replace("{x}", String(p.x)).replace("{y}", String(p.y)), { credentials: "omit" });
			if (!r.ok) return -1;   // 404＝その枡に想定なし
			const bmp = await createImageBitmap(await r.blob());
			const cv = new OffscreenCanvas(1, 1), cx = cv.getContext("2d")!;
			cx.drawImage(bmp, p.px, p.py, 1, 1, 0, 0, 1, 1);
			const d = cx.getImageData(0, 0, 1, 1).data;
			return legendIndex(legend, d[0], d[1], d[2], d[3]);
		} catch { return -1; }
	}
	async function probe(ll: LonLat) {
		const [lon, lat] = ll;
		probeMark?.remove();
		const el = document.createElement("div"); el.className = "yk-probe";
		probeMark = new ML.Marker({ element: el, anchor: "center" }).setLngLat(ll).addTo(map);
		probeOut.hidden = false;
		probeOut.innerHTML = `<div class="dh"><b>${esc(t("Loading…"))}</b><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>`;
		const run = probeOut.dataset.run = String(Date.now());
		const water = HAZARDS.filter(h => h.id !== "dosha"), dosha = HAZARDS.find(h => h.id === "dosha")!;
		const [here, depths, dz, rows] = await Promise.all([
			map.getHeight(lon, lat).catch(() => NaN),
			Promise.all(water.map(h => samplePx(h.urls[0], lon, lat, h.legend))),
			Promise.all(dosha.urls.map(u => samplePx(u, lon, lat, dosha.legend))).then(a => Math.max(...a)),
			(shelters ? Promise.resolve(shelters) : setHinan(true).then(() => shelters)),
		]);
		if (probeOut.dataset.run !== run) return;
		const near = rows ? nearestSites(rows, [lon, lat], 3) : [];   // 同じ学校の棟違いは 1 件に
		const worst = Math.max(...depths);
		const band = (i: number, legend: typeof DEPTH) => i < 0 ? `<span class="out">${esc(t("Outside the expected area"))}</span>` : `<span><i style="background:${legend[i].color}"></i>${esc(t(legend[i].label))}</span>`;
		probeOut.innerHTML = `<div class="dh"><b>${Number.isFinite(here) ? esc(t("Elevation about $1 m", num(Math.round(here)))) : ""}</b><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>
			<h3>${esc(t("Expected flood depth here"))}</h3>
			<div class="pr">${water.map((h, i) => `<div><small>${esc(t(h.name))}</small>${band(depths[i], h.legend)}</div>`).join("")}
				<div><small>${esc(t(dosha.name))}</small>${band(dz, dosha.legend)}</div></div>
			${floorsOfDepth(worst) ? `<p class="warn">${esc(t("Water could reach floor $1 (3 m per floor).", floorsOfDepth(worst) >= 7 ? "7+" : floorsOfDepth(worst)))}</p>` : ""}
			<h3>${esc(t("Nearest evacuation sites"))}</h3>
			<ol class="near">${near.map(({ row, m }, i) => `<li data-i="${i}"><b>${esc(row[2])}</b><small>${esc(t("$1 m · about $2 min on foot", num(Math.round(m)), walkMin(m)))}</small><small class="el"></small></li>`).join("")}</ol>
			<p class="sub flat">${esc(t("Straight-line distance; walking time assumes 80 m per minute."))}</p>`;
		// 最寄りへ線を引く（直線）
		const n0 = near[0]?.row;
		const fc = { type: "FeatureCollection" as const, features: n0 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[lon, lat], [n0[0], n0[1]]] } }] : [] };
		if (!probeLine) { probeLine = true; map.addSource("yk-probe", { type: "geojson", data: fc }); await map.addLayer({ id: "yk-probe", type: "line", source: "yk-probe", paint: { "line-color": "#e65100", "line-width": 3 } }); }
		else map.getSource("yk-probe")?.setData?.(fc);
		// 避難場所の標高と、ここからの差（高台へ逃げるか）
		near.forEach(async ({ row }, i) => {
			const h = await map.getHeight(row[0], row[1]).catch(() => NaN);
			const li = probeOut.querySelector(`[data-i="${i}"] .el`);
			if (li && probeOut.dataset.run === run && Number.isFinite(h)) li.textContent = t("Elevation about $1 m ($2 m from here)", num(Math.round(h)), Number.isFinite(here) ? (h - here >= 0 ? "+" : "") + Math.round(h - here) : "?");
		});
	}
	probeOut.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".x")) { probeOut.hidden = true; probeMark?.remove(); if (probeLine) map.setLayoutProperty("yk-probe", "visibility", "none"); } });
	// スマホ：開いた板（下からのシート）に押した点と最寄りへの線が隠れる＝点が板の上の見える所の中ほどに来るよう地図をずらす
	const revealAbovePanel = (ll: LonLat) => requestAnimationFrame(() => {
		const pr = panel.getBoundingClientRect(), mr = mapEl.getBoundingClientRect(), top = pr.top - mr.top;
		const p = map.project(ll), want = top / 2;
		if (top <= 0 || p.y < top - 24) return;   // もう見えている
		const c = map.unproject([mapEl.clientWidth / 2, mapEl.clientHeight / 2 + (p.y - want)]);
		if (c) map.easeTo({ center: [c.lng, c.lat], duration: 400 });
	});
	map.on("click", (e: { lngLat: LonLat | null }) => {
		if (!probing || !e.lngLat) return;
		const home = probeHome; probedAt = Date.now(); setProbing(false);
		if (narrow()) { P.setFold(false); revealAbovePanel(e.lngLat); }
		if (home) { homeAt(e.lngLat); return; }
		if (probeLine) map.setLayoutProperty("yk-probe", "visibility", "visible"); probe(e.lngLat);
	});

	// ── 暮らし：わが家のまわり＝押した所（か現在地）の区・小／中学校区・最寄り駅とバス停・想定浸水と土砂・最寄りの避難場所・用途地域・近くの施設・警察／消防の管轄を 1 枚に（市民ファースト・本人 2026-10-25）──
	// 東京都の頁は層を重ねて読む＝専門家の道具。ここは「自分の家」から引く＝答えが 1 枚で出る。台帳はどれも既にある物（読むだけ・層は足さない）
	const homeOut = $<HTMLElement>(".home-out"), hmMsg = $<HTMLElement>(".hm-msg");
	let homeMark: Marker | null = null;
	const areaFile = (id: AreaId) => AREAS.find(a => a.id === id)!.file;
	type AreaFC = { features: { geometry: { type: string; coordinates: unknown } | null; properties: { n?: string; a?: string; b?: number; f?: number } }[] };
	const SUB = (name: string) => FACILITY_SUBS.findIndex(x => x.name === name);
	const HOME_NEAR = ["Ward offices", "Libraries", "Hospitals", "Police boxes", "Fire stations and headquarters"].map(n => ({ n, i: SUB(n) }));
	const clearHome = () => { homeOut.hidden = true; homeMark?.remove(); homeMark = null; };
	async function homeAt(ll: LonLat) {
		const at: [number, number] = [ll[0], ll[1]];
		closePop(); homeMark?.remove();
		const el = document.createElement("div"); el.className = "yk-probe yk-home";
		homeMark = new ML.Marker({ element: el, anchor: "center" }).setLngLat(ll).addTo(map);
		if (st.tab !== "life") setTab("life");
		homeOut.hidden = false;
		const x = `<button class="x" type="button" aria-label="${esc(t("Close"))}">×</button>`;
		homeOut.innerHTML = `<div class="dh"><b>${esc(t("Loading…"))}</b>${x}</div>`;
		const run = homeOut.dataset.run = String(Date.now());
		const water = HAZARDS.filter(h => h.id !== "dosha"), dosha = HAZARDS.find(h => h.id === "dosha")!;
		const [wards, se, sj, zn, po, fi, rail, , sh, , here, depths, dz] = await Promise.all([
			loadWards(), ledger<AreaFC>(areaFile("school-e")), ledger<AreaFC>(areaFile("school-j")), ledger<AreaFC>(areaFile("zoning")), ledger<AreaFC>(areaFile("police")), ledger<AreaFC>(areaFile("fire")),
			loadRail(), loadBus(), loadShelters(), loadFac(),
			map.getHeight(at[0], at[1]).catch(() => NaN),
			Promise.all(water.map(h => samplePx(h.urls[0], at[0], at[1], h.legend))),
			Promise.all(dosha.urls.map(u => samplePx(u, at[0], at[1], dosha.legend))).then(a => Math.max(...a)),
		]);
		if (homeOut.dataset.run !== run) return;
		const ward = featureAt(wards as unknown as { features: { geometry: { type: string; coordinates: unknown } | null; properties: { code?: string } }[] } | null, at);
		if (wards && !ward?.code) { homeOut.innerHTML = `<div class="dh"><b>${esc(t("Outside Yokohama City."))}</b>${x}</div>`; return; }
		const row = (k: string, v: string) => `<div><small>${esc(k)}</small><span>${v}</span></div>`;
		const walk = (m: number) => esc(t("$1 m · about $2 min on foot", num(Math.round(m)), walkMin(m)));
		const band = (i: number, legend: typeof DEPTH) => i < 0 ? `<span class="out">${esc(t("Outside the expected area"))}</span>` : `<span><i style="background:${legend[i].color}"></i>${esc(t(legend[i].label))}</span>`;
		const out: string[] = [];
		out.push(`<div class="dh"><b>${esc(ward?.code ? wardName(ward.code) : "")}${Number.isFinite(here) ? ` · ${esc(t("Elevation about $1 m", num(Math.round(here))))}` : ""}</b>${x}</div>`);
		// 学区
		const e1 = featureAt(se, at), j1 = featureAt(sj, at);
		if (e1 || j1) out.push(`<h3>${esc(t("School districts"))}</h3><div class="pr">${e1 ? row(t("Elementary schools"), esc(String(e1.n || ""))) : ""}${j1 ? row(t("Junior high schools"), esc(String(j1.n || ""))) : ""}</div>`);
		// 交通＝最寄りの駅 2 つ（同じ名の駅は 1 つに）・バス停 1 つ
		const sta: { row: StationRow; m: number }[] = [];
		if (rail) for (const r of nearestRows(rail.stations, at, 12)) { if (!sta.some(s => s.row[2] === r.row[2])) sta.push(r); if (sta.length >= 2) break; }
		const bs = bus ? nearestRows(bus, at, 1)[0] : null;
		if (sta.length || bs) out.push(`<h3>${esc(t("Getting around"))}</h3><div class="pr">${sta.map(({ row: r, m }) => row(t("$1 Station", staName(r[2])), walk(m))).join("")}${bs ? row(t("Bus stops"), `${esc(bs.row[2])}<br><small>${walk(bs.m)}</small>`) : ""}</div>${sta[0] ? `<button type="button" class="walkr" data-lon="${sta[0].row[0]}" data-lat="${sta[0].row[1]}" data-name="${esc(staName(sta[0].row[2]))}" data-ja="${esc(sta[0].row[2])}">${esc(t("Walking distance from $1", t("$1 Station", staName(sta[0].row[2]))))}</button>` : ""}`);
		// 防災＝想定浸水（3 つの想定）・土砂・水が届く階・最寄りの避難場所
		const worst = Math.max(...depths), ev = sh ? nearestSites(sh, at, 1)[0] : null;
		out.push(`<h3>${esc(t("Disasters"))}</h3><div class="pr">${water.map((h, i) => `<div><small>${esc(t(h.name))}</small>${band(depths[i], h.legend)}</div>`).join("")}<div><small>${esc(t(dosha.name))}</small>${band(dz, dosha.legend)}</div>${ev ? row(t("Nearest evacuation sites"), `${esc(ev.row[2])}<br><small>${walk(ev.m)}</small>`) : ""}</div>`
			+ (floorsOfDepth(worst) ? `<p class="warn">${esc(t("Water could reach floor $1 (3 m per floor).", floorsOfDepth(worst) >= 7 ? "7+" : floorsOfDepth(worst)))}</p>` : ""));
		// 近くの施設（区役所・図書館・病院・交番・消防署）
		if (fac) {
			const near = HOME_NEAR.map(({ n, i }) => ({ n, r: nearestRows(fac!.filter(r => subOf(r[3], r[5]) === i), at, 1)[0] })).filter(x => x.r);
			if (near.length) out.push(`<h3>${esc(t("Nearby facilities"))}</h3><div class="pr">${near.map(({ n, r }) => row(t(n), `${esc(r!.row[2])}<br><small>${walk(r!.m)}</small>`)).join("")}</div>`);
		}
		// まちのきまり＝用途地域（建ぺい率・容積率）・警察署／消防署の管轄
		const z = featureAt(zn, at), zi = z ? zoneOf(String(z.n || "")) : -1, p1 = featureAt(po, at), f1 = featureAt(fi, at);
		if (z || p1 || f1) out.push(`<h3>${esc(t("Zones and districts"))}</h3><div class="pr">${z ? row(t("Land-use zoning"), `${esc(zi >= 0 ? (lang === "ja" ? ZONES[zi].ja : t(ZONES[zi].name)) : String(z.n || ""))}${z.b || z.f ? `<br><small>${esc(t("Building coverage $1% · Floor area ratio $2%", z.b ?? "?", z.f ?? "?"))}</small>` : ""}`) : ""}${p1 ? row(t("Police station jurisdictions"), esc(String(p1.n || ""))) : ""}${f1 ? row(t("Fire station jurisdictions"), esc(String(f1.n || ""))) : ""}</div>${p1 || f1 ? `<p class="sub flat">${esc(t("Boundaries as of 2012."))}</p>` : ""}`);
		out.push(`<p class="sub flat">${esc(t("Straight-line distance; walking time assumes 80 m per minute."))}</p>`);
		homeOut.innerHTML = out.join("");
		homeOut.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}
	homeOut.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".x")) clearHome(); });
	$(".hm-tap").onclick = () => { setProbing(!(probing && probeHome), true); if (probing && narrow()) P.setFold(true); };
	$(".hm-gps").onclick = () => {
		if (!navigator.geolocation) { hmMsg.textContent = t("Could not get your location."); return; }
		hmMsg.textContent = t("Loading…");
		navigator.geolocation.getCurrentPosition(p => {
			const ll: LonLat = [p.coords.longitude, p.coords.latitude];
			hmMsg.textContent = "";
			if (ll[0] < CITY_BBOX[0] || ll[0] > CITY_BBOX[2] || ll[1] < CITY_BBOX[1] || ll[1] > CITY_BBOX[3]) { hmMsg.textContent = t("Outside Yokohama City."); return; }
			setFlat(false); map.flyTo({ center: ll, zoom: 16.5, pitch: 0, bearing: 0 }).then(() => { if (narrow()) revealAbovePanel(ll); });   // スマホ：家の印が下のシートに隠れない所へ
			homeAt(ll);
		}, () => { hmMsg.textContent = t("Could not get your location."); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
	};

	// ── 解析：影（WebGPU）と日影図 ──
	if (gpu) {
		const day = $(".sday"), hour = $(".shour"), out = $<HTMLOutputElement>(".shour-o");
		day.value = todayJST();
		const apply = () => {
			const h = +hour.value; out.textContent = `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
			map.setShadows($(".shadow").checked ? { on: true, time: jst(day.value || todayJST(), h) } : false);
		};
		$(".shadow").onchange = apply; hour.oninput = apply; day.onchange = apply;
		apply();
	}
	const sunMsg = $<HTMLElement>(".sunmsg");
	$(".sunmap").onclick = async () => {
		if (map.getZoom() < 14.5) { sunMsg.textContent = t("Zoom in to street-block level (zoom 14.5 or more), then press again."); return; }
		sunMsg.textContent = t("Computing…");
		try {
			const r = await map.sunShadow({ mode: "duration" });
			sunMsg.textContent = t("Computed from $1 building faces. Darker areas stay in shade longer (up to $2 hours).", num(r.triangles), r.maxHours.toFixed(1));
			$<HTMLElement>(".sunclear").hidden = false;
		} catch (e) { sunMsg.textContent = t("Could not compute."); console.warn("[yokohama] sunShadow", e); }
	};
	$(".sunclear").onclick = () => { map.raster.remove("sunshadow"); $<HTMLElement>(".sunclear").hidden = true; sunMsg.textContent = ""; };

	// ── 解析：可視域・切り取り・歩く・測る ──
	const toolMsg = $<HTMLElement>(".toolmsg");
	const center = (): LonLat => { const c = map.getCenter(); return [c.lng, c.lat]; };
	$(".vs").onclick = async () => {
		toolMsg.textContent = t("Computing the viewshed…");
		try {
			const r = await map.viewshed({ observer: center(), radius: 1000, eyeH: 1.6 });
			toolMsg.textContent = t("Green areas are visible ($1% of the 1 km radius). Areas hidden by buildings and terrain stay uncolored.", Math.round(r.visibleRatio * 100));
			$<HTMLElement>(".vsclear").hidden = false;
		} catch (e) { toolMsg.textContent = t("Could not compute."); console.warn("[yokohama] viewshed", e); }
	};
	$(".vsclear").onclick = async () => { await map.clearViewshed(); $<HTMLElement>(".vsclear").hidden = true; toolMsg.textContent = ""; };
	if (gpu) {
		let clipped = false;
		$(".clip").onclick = () => {
			clipped = !clipped;
			map.setClipping(clipped ? { box: { center: center(), size: [500, 500] } } : false);
			$(".clip").textContent = t(clipped ? "Stop clipping" : "Clip (500 m square)");
		};
	}
	let walker: WalkHandle | null = null;
	$(".walk").onclick = () => { walker ??= map.walk(); if (map.getZoom() < 15) toolMsg.textContent = t("Zoom in before walking to see the streets."); walker.start(); };
	const measure = map.gadget.measure(), profile = map.gadget.profile();
	$(".measure").onclick = () => { measure.open?.(); };
	$(".profile").onclick = () => { profile.open?.(); };

	// ── 起動時の状態（URL）──
	setTab(st.tab);
	const s0 = SPOTS.find(s => s.id === st.spot);
	if (s0) { showSpot(s0); if (!location.hash) flySpot(s0); }
	else if (st.ward && !location.hash) setWard(st.ward);
	else if (st.ward) wardSel.value = st.ward;
	for (const id of st.hz) setHazard(id, true);
	for (const id of st.tr) setTransit(id, true);
	if (facOn) setFac(true);
	loadWards();   // 市の外の覆いと区の線は最初から

	return { state: st, setTab, setWard, setHazard, setHinan, setTransit, setFac, tour, stopTour, lod1Ready,
		get shelters() { return shelters; }, get lod1() { return lod1; }, get facilities() { return fac; }, get bus() { return bus; }, get subwayMarkers() { return subMarks; } };
}

// ── 意匠（quiet-mono のトークン＝#map の変数・choju の案内板と同じ黒地白文字）──
const CSS = `
.yk-panel .oe-panel-head h1{font-size:19px;letter-spacing:.04em}
.yk-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.yk-panel .tour.port{background:linear-gradient(90deg,#0b3d6b,#1565c0);margin-top:6px}
.yk-cap .yr{font-weight:700;letter-spacing:.04em}
.yk-panel .tour{width:100%;margin:10px 0 2px;padding:9px 10px;border:0;border-radius:var(--qm-r-m);background:linear-gradient(90deg,#1565c0,#0d8bb0);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.yk-panel .tabs{display:flex;flex-wrap:wrap;gap:4px;margin:10px 0 8px}
.yk-panel .tabs button{flex:1 1 0;min-width:max-content;font:inherit;padding:6px 8px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);cursor:pointer}
.yk-panel .tabs button[aria-selected=true]{background:#fff;color:#0b1220;border-color:#fff;font-weight:700}
.yk-panel h2{font-size:12px;margin:12px 0 4px;color:var(--qm-text-dim);font-weight:600}
.yk-panel .msel{display:flex;flex-direction:column;gap:3px;margin-top:8px;font-size:12px;color:var(--qm-text-dim)}
.yk-panel select,.yk-panel input[type=date]{font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#1b1f26;color:var(--qm-text);padding:5px 6px;min-width:0}
.yk-panel input[type=range]{width:100%;accent-color:#4fc3f7}
.yk-panel .spots,.yk-panel .cats{display:flex;flex-wrap:wrap;gap:5px}
.yk-panel .spots button,.yk-panel .cats button{font:inherit;font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text);cursor:pointer}
.yk-panel .spots button.on{background:#4fc3f7;border-color:#4fc3f7;color:#06121f}
.yk-panel .cats button{opacity:.45}
.yk-panel .cats button.on,.yk-panel .cats button.part{opacity:1;background:rgba(255,255,255,.08)}
.yk-panel .cats button.part{border-style:dashed}
.yk-panel .cats .cg{display:flex;flex-wrap:wrap;gap:4px;width:100%;align-items:center}
.yk-panel .cats button.kd{font-size:11px;padding:2px 7px}   /* 種別のチップ（.sub は注記の段落の字下げ＝別の名に） */
.yk-panel .cats i,.yk-panel .lg i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.yk-panel .cats small{margin-left:5px;color:var(--qm-text-faint);font-variant-numeric:tabular-nums}
.yk-panel .spot-note{margin-top:8px;padding:8px 10px;border-radius:var(--qm-r-m);background:rgba(255,255,255,.06);border:1px solid var(--qm-border-soft)}
.yk-panel .spot-note b{color:var(--qm-ink);font-size:14px}
.yk-panel .spot-note span{margin-left:8px;color:var(--qm-text-faint);font-size:12px}
.yk-panel .spot-note p{margin:4px 0 0;color:var(--qm-text-dim)}
.yk-panel .ph{margin:0 0 8px}
.yk-panel .ph img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:6px;background:#222}
.yk-panel .ph figcaption,.yk-cap figcaption{font-size:10.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.yk-panel .ph a,.yk-cap figcaption a{color:var(--qm-text-faint);text-decoration:none}
.yk-panel .grp{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
.yk-panel .grp b{font-weight:600;color:var(--qm-ink)}
.yk-panel .grp small{margin-left:auto;color:var(--qm-text-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.yk-panel .sub{margin:0 0 4px 24px;color:var(--qm-text-dim);font-size:12px}
.yk-panel .sub.flat{margin:6px 0 4px}
.yk-panel [hidden]{display:none!important}
.yk-panel input.fq{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#1b1f26;color:var(--qm-text);padding:6px 8px;margin:2px 0 6px}
.yk-panel .fbt{height:232px;border-radius:var(--qm-r-m);overflow:hidden}
.yk-panel .fbt.oe-bt{--oe-bt-font:12px/1.4 var(--qm-font);--oe-bt-bg:#15181d;--oe-bt-odd:#1b1f26;--oe-bt-line:rgba(255,255,255,.08);--oe-bt-head:#22262e}
.yk-panel .fbt .oe-bt-row{cursor:pointer}
.yk-panel .fbar{display:flex;align-items:center;gap:8px;margin-top:4px}
.yk-panel .fbar small{color:var(--qm-text-faint);font-variant-numeric:tabular-nums}
.yk-panel .fcsv{margin-left:auto;font:inherit;font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text);cursor:pointer}
@media (max-width:640px){ .yk-panel .fbt{height:180px} }
.yk-panel .wrow{display:flex;gap:6px;margin-top:2px}
.yk-panel .wrow select{flex:1 1 auto}
.yk-panel .fitc{flex:none;font:inherit;font-size:12.5px;padding:5px 10px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:rgba(255,255,255,.05);color:var(--qm-text);cursor:pointer;white-space:nowrap}
.yk-panel .fac-w{margin-top:8px}
.yk-panel details.fold{margin-top:6px;border-top:1px solid var(--qm-border-soft);padding-top:4px}
.yk-panel details.fold>summary{cursor:pointer;padding:6px 0;font-size:12.5px;font-weight:600;color:var(--qm-text-dim);list-style:none;display:flex;align-items:center;gap:6px}
.yk-panel details.fold>summary::-webkit-details-marker{display:none}
.yk-panel details.fold>summary::before{content:"▸";font-size:11px;transition:transform .15s}
.yk-panel details.fold[open]>summary::before{transform:rotate(90deg)}
/* 指で押す画面（スマホ・タブレット）＝押す所を 40px 前後に（市民ファースト・本人 2026-10-25「スマホ画面は特に重要」） */
@media (pointer:coarse){
	.yk-panel .tabs button{min-height:40px}
	.yk-panel select,.yk-panel input.fq,.yk-panel .fitc{min-height:40px;font-size:16px}   /* 16px 未満の入力は iOS が勝手に拡大する */
	.yk-panel .act,.yk-panel .tour{min-height:44px}
	.yk-panel .grp{min-height:36px}
	.yk-panel .grp input{width:20px;height:20px}
	.yk-panel .spots button,.yk-panel .cats button{min-height:32px;font-size:13px}
	.yk-panel details.fold>summary{min-height:36px;font-size:14px}
	.yk-panel .fcsv{min-height:32px}
}
.yk-panel .lines{display:flex;flex-wrap:wrap;gap:4px 12px;margin:6px 0 0 24px;font-size:12px;color:var(--qm-text-dim)}
.yk-panel .sw{display:inline-block;font-style:normal;font-weight:700;font-size:10px;color:#fff;border-radius:3px;padding:0 4px;margin-right:5px}
.yk-panel .legend{margin-top:8px}
.yk-panel .zlg{margin-top:6px}
.yk-panel i.ar{display:inline-block;width:12px;height:9px;border:2px solid;border-radius:2px;margin-right:6px;vertical-align:-1px}
.yk-panel .lg{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:4px;font-size:11.5px;color:var(--qm-text-dim)}
.yk-panel .lg small{width:100%;color:var(--qm-text-faint)}
.yk-panel .lg i{border-radius:3px;width:12px;height:12px;margin-right:4px;vertical-align:-2px}
.yk-panel .dates{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0 6px}
.yk-panel .dates label{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--qm-text-dim)}
.yk-panel .act{display:block;width:100%;margin:5px 0 0;padding:7px 10px;text-align:left;font:inherit;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:rgba(255,255,255,.05);color:var(--qm-text);cursor:pointer}
.yk-panel .act:hover,.yk-panel .spots button:hover,.yk-panel .cats button:hover,.yk-panel .tabs button:hover{border-color:rgba(255,255,255,.5)}
.yk-panel .detail{margin:8px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:rgba(255,255,255,.06);border:1px solid var(--qm-border-soft)}
.yk-panel .detail .dh{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
.yk-panel .detail .dh b{color:var(--qm-ink);font-size:14px}
.yk-panel .detail p{margin:4px 0;color:var(--qm-text-dim)}
.yk-panel .badges{display:flex;flex-wrap:wrap;gap:4px}
.yk-panel .badges span{border:1px solid rgba(143,211,154,.6);color:#bfe8c6;border-radius:4px;padding:0 5px;font-size:11.5px}
.yk-panel .note{color:var(--qm-text-dim);font-size:12px;margin:10px 0 0}
.yk-panel .act.on{border-color:#ffb74d;background:rgba(255,183,77,.15)}
.yk-panel .detail h3{font-size:11.5px;margin:8px 0 3px;color:var(--qm-text-faint);font-weight:600}
.yk-panel .pr{display:grid;gap:2px}
.yk-panel .pr div{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.yk-panel .pr small{color:var(--qm-text-dim)}
.yk-panel .pr span{color:var(--qm-ink);white-space:nowrap}
.yk-panel .pr span.out{color:var(--qm-text-faint)}
.yk-panel .pr i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.yk-panel .warn{margin:6px 0 0;padding:5px 8px;border-radius:6px;background:rgba(229,57,53,.18);color:#ffcdd2;font-size:12px}
.yk-panel .near{margin:0;padding-left:18px}
.yk-panel .near li{margin:3px 0}
.yk-panel .near b{display:block;color:var(--qm-ink);font-size:12.5px}
.yk-panel .near small{display:block;color:var(--qm-text-dim);font-size:11.5px}
.yk-probing canvas{cursor:crosshair}
.yk-home{background:#1f6fc5}
.yk-panel .hm-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.yk-panel .hm-btns .act{margin:0;text-align:center}
.yk-panel .home-out .walkr{margin-top:8px;padding:6px 12px;border-radius:999px;border:1px solid #1f6fc5;background:#1f6fc5;color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;min-height:34px}
.yk-panel .home-out .pr span small{color:var(--qm-text-dim)}
.yk-panel .home-out .pr span{text-align:end;white-space:normal}
.yk-probe{width:16px;height:16px;border-radius:50%;background:#e65100;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)}
.yk-pop .oe-popup-body{padding:9px 26px 9px 11px}
.yk-pop b{font-size:14px}
.yk-pop p{margin:3px 0 0;font-size:12px;opacity:.8}
.yk-pop hr.ys{border:0;border-top:1px solid rgba(127,127,127,.3);margin:6px 0}
.yk-pop .pk{font-size:11px;opacity:.7;margin-bottom:1px}
.yk-pop .walkr{margin-top:7px;padding:5px 10px;border-radius:6px;border:1px solid #1f6fc5;background:#1f6fc5;color:#fff;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer;min-height:32px}
.yk-wlab{padding:1px 6px;border-radius:9px;background:#1f6fc5;color:#fff;font:600 11px/1.4 system-ui,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.3);pointer-events:none;white-space:nowrap}
.yk-panel .wt{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
.yk-panel .wt th{font-weight:600;color:var(--qm-text-faint);text-align:right;padding:2px 4px;white-space:nowrap}
.yk-panel .wt td{padding:3px 4px;text-align:right;color:var(--qm-ink);font-variant-numeric:tabular-nums}
.yk-panel .wt td:first-child{text-align:start;color:var(--qm-text-dim)}
.yk-panel .wt td i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-inline-end:5px}
.yk-pop .pk i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px}
.yk-sta{display:flex;flex-direction:column;align-items:center;transform:translateY(25%)}
.yk-sta .sym{display:flex;gap:1px}
.yk-sta .sym i{font:700 10px/1 system-ui,sans-serif;font-style:normal;color:#fff;background:var(--c,#555);border:2px solid #fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.yk-sta .nm{display:none;margin-top:1px;font:600 11px/1.2 system-ui,sans-serif;color:#1d2733;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff;white-space:nowrap}
.yk-sta-names .yk-sta .nm{display:block}
.yk-cap{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:31;width:min(600px,calc(100% - 24px));box-sizing:border-box;padding:12px 44px 12px 12px;display:flex;gap:12px;align-items:flex-start;
	border-radius:var(--qm-r-l);background:rgba(8,14,26,.88);color:#f1f3f6;font:13px/1.5 var(--qm-font);box-shadow:var(--qm-shadow-pop);backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur))}
.yk-cap[hidden]{display:none}
.yk-cap .cph{flex:none;width:168px;margin:0}
.yk-cap .cph img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:6px;background:#222}
.yk-cap .ct{min-width:0}
.yk-cap small{display:block;color:rgba(255,255,255,.55);font-size:11.5px}
.yk-cap b{font-size:18px;color:#fff}
.yk-cap p{margin:3px 0 0;color:rgba(255,255,255,.8)}
.yk-cap .x{position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.25);background:transparent;color:rgba(255,255,255,.75);cursor:pointer}
@media (max-width:640px){ .yk-cap{bottom:auto;top:12px} .yk-cap .cph{width:96px} }`;
