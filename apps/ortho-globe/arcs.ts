// 弧の頁（/globe/arcs・issue #311）：いちばん近い道は、弧になる。地球の上の最短の道は大円＝球の上では真っすぐ、平らな地図では曲がって見える。
// deck.gl の ArcLayer・GreatCircleLayer に当たる map.addData(…, { kind: "arcs" }) を、球の上でいちばん映える題材で見せる（arcs.html から遅延 import）。
// 4 つの見方（パネルのタブ）：
//   ここから世界へ … 押した所から世界中の首都へ弧が一斉に伸びる（遠い所ほど高い・乗せると距離）。起動はここ（本人裁定 2026-10-12）
//   比べる       … 同じ 2 点を大円（最短の道）と等角航路（メルカトルで真っすぐな線）の 2 本で引き、距離の差を出す
//   空の道       … OpenFlights の路線（約 3.7 万の向きのある対・2014 年 6 月の姿・ODbL）。空港を押すとそこから出る路線だけ・指した所の弧だけ光る（brush）・
//                  距離のつまみ（GPU の範囲フィルタ＝getFilterValue＋setFilter）・国で切る（setMask＝NE admin_0 の形）
//   自分の表     … 出発と到着の列がある CSV を落とす（座標・空港の記号・国の記号のどれでも・?csv=URL）
// どの見方も弧の上を光の粒が飛ぶ（kind:"trips"）。右下は小さなメルカトル図（arcs-mini.ts）＝見えている所と選んだ道（本人 2026-10-12）。
// データ：首都＝world の台帳（NationDB・CityDB＝GitHub Pages の ortho-data/globe/・worldcontent の WORLD_DATA）。
//   空港・路線＝OpenFlights（airports.dat・routes.dat）をブラウザが直に読む（raw.githubusercontent.com・CORS 開放）→ Cache API に置く＝R2 には何も置かない。
//   国の形＝NE admin_0 50m（エンジンが世界の線に読むのと同じ geopbf・同じキャッシュ名）。
// エンジンとの接点は公開面だけ：map.addData（points／arcs／trips）・map.on(ev, 層, cb)・map.project／unproject・onFrame・mapEl。
import { gcDistance, gcPath, rhumbPath, rhumbDistance, rhumbBearing, tripOf, parseAirports, parseRoutes, parseTable, detectColumns, makeResolver, tableToArcs } from "./arcs-data.ts";
import { createMini } from "./arcs-mini.ts";
import type { MiniLine, MiniMark } from "./arcs-mini.ts";
import type { Airport, Arc, Nation as ArcNation, Resolver } from "./arcs-data.ts";
import type { GlobeMap, DataLayerHandle, LonLat } from "@ortho-earth/globe";
import type { GeoPBF } from "geopbf";
type GeopbfFn = typeof import("@ortho-earth/globe").geopbf;
import type { Nation, WorldI18n } from "@ortho-earth/core/worldcontent";
import { WORLD_DATA, fetchJsonMaybeGz, loadI18n, F } from "@ortho-earth/core/worldcontent";
import { tr, getLang } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない。頁の辞書は startPage（page.js）が足す
const t = tr();

type RGBA = number[];
type Pos = number[];
/** 首都 */
interface Cap { pos: Pos; name: string; nameEn: string; country: string; key: string }
/** 空港（路線の数 deg つき） */
type AirportDeg = Airport & { deg: number };
/** 弧の層の 1 本（見方ごとに中身が違う＝ここから世界へ cap・空の道 a/b/n・自分の表 sLabel/tLabel/w0・比べる flat） */
interface ArcItem { s: Pos; t: Pos; c0: RGBA; c1: RGBA; w: number; km: number; flat?: boolean; cap?: Cap; a?: AirportDeg; b?: AirportDeg; n?: number; sLabel?: string; tLabel?: string; w0?: number }
/** 点の層の 1 つ */
interface PtItem { pos: Pos; c: RGBA; r: number; cap?: Cap; ap?: AirportDeg }
interface TripItem { path: number[][]; timestamps: number[] }
interface Country { key: string; name: string; rings: number[][][] }
type Mode = "here" | "cmp" | "air" | "csv";

export const OPENFLIGHTS = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/";
const CACHE = "ortho-arcs-v1";   // 路線は 2014 年で止まっている＝一度取れば取り直さない（版を変える時だけ名前を変える）
const H0 = 0.18;                 // 弧の高さ（弦の長さに対する比）の既定
const KM_MAX = 20100;
const C: Record<string, RGBA> = {   // 色（0〜255・deck.gl と同じ）
	src: [255, 190, 80, 235], dst: [90, 200, 255, 235],
	gc: [255, 214, 90, 255], rh: [255, 92, 150, 255],
	cap: [225, 232, 245, 200], ap: [150, 210, 255, 210], apSel: [255, 214, 90, 255],
	base: [110, 160, 230, 46], hot0: [255, 190, 80, 230], hot1: [90, 220, 255, 230],
	trip: [255, 250, 225, 255],
};
const css = (c: RGBA, a?: number) => `rgba(${c[0]},${c[1]},${c[2]},${a ?? (c[3] ?? 255) / 255})`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
const fmt = (n: number, d = 0) => (+n).toLocaleString(getLang(), { maximumFractionDigits: d, minimumFractionDigits: d });
const km = (n: number) => t("$1 km", fmt(n));

// ── データ ───────────────────────────────────────────────────────────────────
// 首都＝[{ pos, name, country, key }]（台帳の都市名と国名は言語ごとの名前表）
interface City { qid: string; coords?: number[]; name?: { en?: string } }
async function loadCapitals(lang: string) {
	const [nd, cd, names] = await Promise.all([fetchJsonMaybeGz(WORLD_DATA + "NationDB.json") as Promise<any>, fetchJsonMaybeGz(WORLD_DATA + "CityDB.json") as Promise<any>, loadI18n(lang).catch((): WorldI18n | null => null)]);
	const nations: (Nation & { capital?: string })[] = nd.items || nd, cities = new Map<string, City>((cd.items || cd).map((c: City) => [c.qid, c]));
	const caps: Cap[] = [];
	for (const n of nations) {
		const c = n.capital ? cities.get(n.capital) : null;
		if (!c?.coords) continue;
		caps.push({ pos: [c.coords[0], c.coords[1]], name: names?.cities?.[c.qid]?.name || c.name?.en || "", nameEn: c.name?.en || "", country: names?.nations?.[n.key]?.name || n.name?.en || n.key, key: n.key });
	}
	const nat: ArcNation[] = nations.map(n => ({ iso: n.iso, coord: n.coord, name: names?.nations?.[n.key]?.name || n.name?.en, nameEn: n.name?.en }));
	return { caps, nations: nat };
}
// 手元のキャッシュ（Cache API）を先に・無ければ取って置く
async function cachedText(url: string) {
	const cache = await caches.open(CACHE).catch(() => null);
	const hit = await cache?.match(url).catch(() => null);
	if (hit) return hit.text();
	const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	const txt = await r.text();
	cache?.put(url, new Response(txt, { headers: { "content-type": "text/plain" } })).catch(() => {});
	return txt;
}
let airportsP: Promise<Map<number, Airport>> | null = null, routesP: Promise<{ ap: Map<number, Airport>; routes: ReturnType<typeof parseRoutes> }> | null = null;
const loadAirports = () => airportsP ??= cachedText(OPENFLIGHTS + "airports.dat").then(parseAirports).catch(e => { airportsP = null; throw e; });
const loadRoutes = () => routesP ??= Promise.all([loadAirports(), cachedText(OPENFLIGHTS + "routes.dat")]).then(([ap, txt]) => ({ ap, routes: parseRoutes(txt, ap) })).catch(e => { routesP = null; throw e; });
// 国の形（NE admin_0 50m）＝[{ key（ISO_A2 か ADM0_A3）, name, rings }]。小地図の陸と国で切るマスクの両方に使う
async function loadCountries(geopbf: GeopbfFn, lang: string) {
	const pbf = await geopbf("ne_50m_admin_0_countries") as GeoPBF;   // getGeometry は geopbf の GeoPBF の口（globe の型は主要面だけ）
	const out: Country[] = [], L = lang.replace("-", "_").toUpperCase();
	for (let i = 0; i < pbf.length; i++) {
		const p = pbf.getProperties(i), g = pbf.getGeometry(i); if (!p || !g) continue;
		const rings = (g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : null) as number[][][] | null; if (!rings) continue;
		const iso = F(p, "ISO_A2"), a3 = F(p, "ADM0_A3");
		out.push({ key: (iso && iso !== "-99" ? iso : a3) as string, name: (F(p, `NAME_${L}`) || F(p, `NAME_${L.slice(0, 2)}`) || F(p, "NAME_EN") || F(p, "NAME") || a3) as string, rings });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, lang));
}
// 間引き（Douglas–Peucker・度）＝小地図の陸
const simplify = (ring: number[][], tol: number) => {
	if (ring.length <= 8) return ring;
	const keep = new Uint8Array(ring.length); keep[0] = keep[ring.length - 1] = 1;
	const st = [[0, ring.length - 1]];
	while (st.length) {
		const [a, b] = st.pop()!; if (b - a < 2) continue;
		const [ax, ay] = ring[a], [bx, by] = ring[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
		let best = -1, bi = -1;
		for (let i = a + 1; i < b; i++) { const [px, py] = ring[i]; const d = L ? Math.abs((px - ax) * dy - (py - ay) * dx) / L : Math.hypot(px - ax, py - ay); if (d > best) { best = d; bi = i; } }
		if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
	}
	return ring.filter((_, i) => keep[i]);
};
// 見る人の居場所の見当＝タイムゾーンの都市名が首都の英語名に当たればそこ（当たらなければ null＝地図の中心）。位置の許可は求めない（ボタンを押した時だけ）
const tzCapital = (caps: Cap[]) => { const z = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; const city = z.split("/").pop()!.replace(/_/g, " ").toLowerCase(); return caps.find(c => c.nameEn.toLowerCase() === city) ?? null; };

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountArcs(map: GlobeMap, geopbf: GeopbfFn, { csv = null, mode: mode0 = null }: { csv?: string | null; mode?: string | null } = {}) {
	document.title = t("The shortest way is an arc — ortho-globe");   // 器（arcs.html）の題名と説明もここで＝i18n の走査器が読む頁の本体（.ts）に置く
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("On a globe the shortest way between two places is a great circle. Arcs from anywhere to every capital, 37,000 air routes, great circle vs rhumb line, and your own CSV."));
	const lang = getLang(), mapEl = map.mapEl;
	const state: { mode: Mode | null; H: number; trips: boolean; origin: Pos | null; originLabel: string; A: Pos | null; B: Pos | null; aLabel: string; bLabel: string; nextB: boolean; sel: AirportDeg | null; kmLo: number; kmHi: number; country: string; brush: boolean; csvArcs: ArcItem[] } = { mode: null, H: H0, trips: true, origin: null, originLabel: "", A: null, B: null, aLabel: "", bLabel: "", nextB: false, sel: null, kmLo: 0, kmHi: KM_MAX, country: "", brush: true, csvArcs: [] };
	const touch = matchMedia("(pointer: coarse)").matches;

	// ── パネル ──
	const panel = document.createElement("div");
	panel.className = "arcs-panel";
	panel.innerHTML = `
<style>
.arcs-panel{position:absolute;top:12px;right:12px;z-index:30;width:316px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.arcs-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.arcs-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.arcs-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.arcs-panel.min .body{display:none}
.arcs-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:8px}
.arcs-panel .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin:8px 0 10px}
.arcs-panel .tab{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#cfd7e6;border-radius:7px;padding:5px 2px;font:inherit;font-size:11.5px;line-height:1.25;cursor:pointer}
.arcs-panel .tab[aria-selected=true]{background:rgba(255,214,90,.16);border-color:rgba(255,214,90,.55);color:#fff}
.arcs-panel .pane{display:none}.arcs-panel .pane.on{display:block}
.arcs-panel .stat{font-variant-numeric:tabular-nums;color:#fff;margin:6px 0}
.arcs-panel .big{font-size:14px;font-weight:700}
.arcs-panel .m{color:#b9c3d6;font-variant-numeric:tabular-nums}
.arcs-panel .row{margin:8px 0}
.arcs-panel label.ck{display:flex;align-items:center;gap:7px;cursor:pointer;margin:5px 0}
.arcs-panel .rng{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;margin:5px 0}
.arcs-panel .rng input{width:100%;accent-color:#ffd65a}
.arcs-panel .rng em{font-style:normal;color:#9aa6bd;font-variant-numeric:tabular-nums;min-width:62px;text-align:end}
.arcs-panel button.act,.arcs-panel select{font:inherit;color:#fff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:5px 9px;cursor:pointer;max-width:100%}
.arcs-panel select option{color:#000}
.arcs-panel .bar{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.arcs-panel .key{display:inline-block;width:18px;height:3px;border-radius:2px;vertical-align:middle;margin-inline-end:6px}
.arcs-panel .drop{border:1.5px dashed rgba(255,255,255,.28);border-radius:10px;padding:12px;text-align:center;color:#b9c3d6;margin:6px 0}
.arcs-panel .drop.over{border-color:#ffd65a;color:#fff}
.arcs-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.arcs-panel .note a{color:#9fc3ff}
.arcs-panel .common{border-top:1px solid rgba(255,255,255,.12);margin-top:10px;padding-top:6px}
.arcs-tip{position:absolute;z-index:31;pointer-events:none;transform:translate(12px,-50%);padding:3px 8px;border-radius:6px;white-space:nowrap;
 background:rgba(20,24,32,.88);color:#fff;font:11.5px/1.5 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;font-variant-numeric:tabular-nums}
.arcs-mini{position:absolute;right:12px;bottom:58px;z-index:31;width:280px;border-radius:9px;overflow:hidden;box-shadow:0 6px 22px rgba(0,0,0,.4);background:#0e1526}
.arcs-mini canvas{display:block}
.arcs-mini .cap{position:absolute;left:7px;top:4px;color:#cfd7e6;font:600 10.5px/1.4 system-ui,sans-serif;letter-spacing:.03em;text-shadow:0 1px 2px #000;pointer-events:none}
.arcs-mini .tog{position:absolute;right:4px;top:4px;width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(12,17,32,.7);color:#e7ecf5;font-size:12px;line-height:1;cursor:pointer}
.arcs-mini.min{width:112px;height:30px}.arcs-mini.min canvas{display:none}
@media (max-width:640px){
 .arcs-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:46%}
 .arcs-mini{top:10px;right:8px;bottom:auto;width:168px}
}
</style>
<div class="head"><h1>${t("The shortest way is an arc")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub">${t("On a globe the shortest way is straight; on a flat map it bends.")}</div>
<div class="body">
<div class="tabs" role="tablist">
 <button type="button" class="tab" role="tab" data-m="here">${t("From here")}</button>
 <button type="button" class="tab" role="tab" data-m="cmp">${t("Compare")}</button>
 <button type="button" class="tab" role="tab" data-m="air">${t("Air routes")}</button>
 <button type="button" class="tab" role="tab" data-m="csv">${t("Your table")}</button>
</div>
<div class="pane" data-p="here">
 <div class="stat" data-k="hereStat">${t("Loading capitals…")}</div>
 <div class="bar"><button type="button" class="act" data-k="geo">${t("Start from my location")}</button></div>
 <div class="note">${t("Click anywhere on the globe: arcs fly from there to every capital. The farther the place, the higher the arc. Point at an arc for the distance.")}</div>
</div>
<div class="pane" data-p="cmp">
 <div class="stat"><span class="big" data-k="cmpTitle"></span></div>
 <div class="stat"><span class="key" style="background:${css(C.gc)}"></span>${t("Great circle (shortest)")}: <b data-k="gcKm"></b></div>
 <div class="stat"><span class="key" style="background:${css(C.rh)}"></span>${t("Rhumb line (straight on Mercator)")}: <b data-k="rhKm"></b></div>
 <div class="stat m" data-k="cmpDiff"></div>
 <div class="bar"><button type="button" class="act" data-k="swapAB">${t("Pick two new points")}</button></div>
 <div class="note">${t("Click two places on the globe. The rhumb line keeps one compass bearing, so it is a straight line on a Mercator map — but it is longer.")}</div>
</div>
<div class="pane" data-p="air">
 <div class="stat" data-k="airStat">${t("Loading air routes…")}</div>
 <div class="stat m" data-k="airSel"></div>
 <div class="bar"><button type="button" class="act" data-k="clearSel" hidden>${t("Show all routes")}</button></div>
 <div class="rng"><span>${t("Shortest")}</span><input type="range" data-k="kmLo" min="0" max="${KM_MAX}" step="100" value="0" aria-label="${t("Shortest")}"><em data-k="kmLoV"></em></div>
 <div class="rng"><span>${t("Longest")}</span><input type="range" data-k="kmHi" min="0" max="${KM_MAX}" step="100" value="${KM_MAX}" aria-label="${t("Longest")}"><em data-k="kmHiV"></em></div>
 <div class="row"><select data-k="country" aria-label="${t("Only routes leaving a country")}"><option value="">${t("Only routes leaving a country")}…</option></select></div>
 ${touch ? "" : `<label class="ck"><input type="checkbox" data-k="brush" checked>${t("Light up the routes near the pointer")}</label>`}
 <div class="note">${t("Click an airport to see only its routes. The route from Tokyo to New York passes over Alaska.")}<br>${t("Routes: $1 (as of June 2014, ODbL)", `<a href="https://openflights.org/data.php" target="_blank" rel="noopener">OpenFlights</a>`)}</div>
</div>
<div class="pane" data-p="csv">
 <div class="drop" data-k="drop">${t("Drop a CSV here")}<br><button type="button" class="act" data-k="pick" style="margin-top:6px">${t("Choose a file")}</button><input type="file" data-k="file" accept=".csv,.tsv,.txt,text/csv" hidden></div>
 <div class="stat" data-k="csvStat"></div>
 <div class="note">${t("Columns for where it starts and ends: coordinates (from_lon, from_lat, to_lon, to_lat), airport codes (NRT, JFK) or country codes (JP, US). A count column makes arcs thicker.")}</div>
</div>
<div class="common">
 <div class="rng"><span>${t("Arc height")}</span><input type="range" data-k="h" min="0" max="0.5" step="0.01" value="${H0}" aria-label="${t("Arc height")}"><em data-k="hV"></em></div>
 <label class="ck"><input type="checkbox" data-k="trips" checked>${t("Lights flying along the arcs")}</label>
 <div class="note">${t("Height 0 draws the great circle on the ground.")}</div>
</div>
</div>`;
	mapEl.appendChild(panel);
	const $ = (k: string) => panel.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
	const tip = document.createElement("div"); tip.className = "arcs-tip"; tip.style.display = "none"; mapEl.appendChild(tip);
	const showTip = (pt: { x: number; y: number } | null, html?: string | null) => { if (!pt) { tip.style.display = "none"; return; } tip.innerHTML = html!; tip.style.left = pt.x + "px"; tip.style.top = pt.y + "px"; tip.style.display = ""; };
	const setFold = (min: boolean) => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);
	const mini = createMini(map, { label: t("Mercator map"), hideLabel: t("Hide map"), showLabel: t("Show map") });

	// ── 層（map.addData）＝5 つだけ（1 層＝オーバーレイ 1 枚＝WebGL の文脈 1 つ。見方ごとに層を持つと 12 枚になり、文脈の上限で地球が消えた・2026-10-14 実測）。
	//   見方を替える＝同じ層に別のデータを入れ直す。描く順に足す（後の物が上・当たりも後の物）
	//   base … 空の道の全路線（薄く・空の道を開いた時に作る）  arcs … 主役の弧（見方ごと）  trips … 弧の上の光の粒  pts … 首都か空港の点＋印（起点・比べる 2 点）＝印は後ろに足す（上に描く）
	const trip = (a: Pos, b: Pos, phase = 0): TripItem => tripOf(a, b, { h: state.H, phase });
	const heightOf = (d: ArcItem) => d.flat ? 0 : state.H;
	const L: { arcs: DataLayerHandle; trips: DataLayerHandle; pts: DataLayerHandle; base?: DataLayerHandle } = {
		arcs: map.addData([], { id: "arcs", kind: "arcs", getSourcePosition: (d: ArcItem) => d.s, getTargetPosition: (d: ArcItem) => d.t, getSourceColor: (d: ArcItem) => d.c0, getTargetColor: (d: ArcItem) => d.c1, getWidth: (d: ArcItem) => d.w, getHeight: heightOf, getFilterValue: (d: ArcItem) => d.km }),
		trips: map.addData([], { id: "trips", kind: "trips", getPath: (d: TripItem) => d.path, getTimestamps: (d: TripItem) => d.timestamps, getColor: C.trip, getWidth: 2.4, trailLength: 0.55, fadeTrail: true }),
		pts: map.addData([], { id: "pts", kind: "points", getPosition: (d: PtItem) => d.pos, getColor: (d: PtItem) => d.c, getRadius: (d: PtItem) => d.r }),
	};
	let arcsNow: ArcItem[] = [], ptsNow: PtItem[] = [], tripsNow: TripItem[] = [], dotsNow: PtItem[] = [], marksNow: PtItem[] = [];   // 層に今入っているデータ（当たりの index はこの配列の添字）
	const setArcs = (d: ArcItem[]) => { arcsNow = d; return L.arcs.setData(d); };
	const flushPts = () => { ptsNow = dotsNow.concat(marksNow); return L.pts.setData(ptsNow); };
	const setPts = (dots: PtItem[], marks: PtItem[] = []) => { dotsNow = dots; marksNow = marks; return flushPts(); };
	const setTrips = (d: TripItem[]) => { tripsNow = d; return L.trips.setData(d).then(() => { if (tripsNow !== d) return; const tMax = d.reduce((m, x) => Math.max(m, x.timestamps[x.timestamps.length - 1]), 0); d.length ? L.trips.animate!({ from: 0, to: tMax + 0.8, speed: 1, loop: true }) : L.trips.animate!(false); }); };
	L.trips.setVisible(state.trips);
	// 空の道の絞り（距離・国）は base・arcs・trips の 3 層に。他の見方では外す
	type Mask = { type: "MultiPolygon"; coordinates: number[][][][] } | null;
	let maskPoly: Mask = null, maskOn: Mask = null, maskBase = false;
	const applyFilters = () => {
		const air = state.mode === "air";
		const r = air && !(state.kmLo <= 0 && state.kmHi >= KM_MAX) ? [state.kmLo, state.kmHi] : null;
		L.base?.setFilter!(r as [number, number] | null); L.arcs.setFilter!(r as [number, number] | null);
		const m = air ? maskPoly : null;   // マスクは画像に焼く（重い）＝変わった時だけ送る
		if (m !== maskOn || (L.base && !maskBase)) { maskOn = m; maskBase = !!L.base; for (const h of [L.base, L.arcs, L.trips]) h?.setMask!(m); }
		L.arcs.brush!(air && !state.sel && state.brush && !touch, 46);
	};

	// ── ここから世界へ ──
	let caps: Cap[] = [], nations: ArcNation[] = [], hereData: ArcItem[] = [];
	const capPts = () => caps.map((c): PtItem => ({ pos: c.pos, c: C.cap, r: 2.6, cap: c }));
	const nearestCap = (p: Pos) => { let best: Cap | null = null, bd = Infinity; for (const c of caps) { const d = gcDistance(p, c.pos); if (d < bd) { bd = d; best = c; } } return best ? { c: best, km: bd } : null; };
	const showHere = () => {
		setPts(capPts(), state.origin ? [{ pos: state.origin, c: C.src, r: 6 }] : []); setArcs(hereData);
		setTrips(hereData.map(d => trip(d.s, d.t)));
	};
	const setOrigin = (pos: Pos, label?: string | null) => {
		state.origin = pos;
		const near = label ? null : nearestCap(pos);
		state.originLabel = label || (near ? (near.km < 60 ? near.c.name : t("Near $1", near.c.name)) : `${pos[1].toFixed(2)}, ${pos[0].toFixed(2)}`);
		hereData = caps.filter(c => gcDistance(pos, c.pos) > 30).map(c => ({ s: pos, t: c.pos, c0: C.src, c1: C.dst, w: 1.6, cap: c, km: gcDistance(pos, c.pos) }));
		const far = hereData.reduce((m: { km: number; cap?: Cap }, d) => d.km > m.km ? d : m, { km: 0 });
		$("hereStat").innerHTML = `<span class="big">${esc(state.originLabel)}</span><br>${t("$1 capitals · farthest: $2 ($3)", fmt(hereData.length), esc(far.cap?.name ?? "—"), km(far.km))}`;
		if (state.mode === "here") { showHere(); refreshMini(); }
	};
	$("geo").addEventListener("click", () => {
		if (!navigator.geolocation) return;
		navigator.geolocation.getCurrentPosition(p => { const pos = [p.coords.longitude, p.coords.latitude]; setOrigin(pos, t("My location")); map.flyTo({ center: pos as LonLat, zoom: Math.min(map.getZoom(), 2) }); }, () => { $("hereStat").textContent = t("Could not get your location"); }, { timeout: 10000 });
	});

	// ── 比べる（等角航路は短い大円の弧の連なりで描く＝同じ層・高さ 0）──
	let cmpData: ArcItem[] = [];
	const showCmp = () => {
		setPts(capPts(), ([state.A, state.B].filter(Boolean) as Pos[]).map(pos => ({ pos, c: [255, 255, 255, 255], r: 5 }))); setArcs(cmpData); setTrips([]);
	};
	const setCompare = () => {
		const { A, B } = state;
		cmpData = [];
		if (A && B) {
			const rp = rhumbPath(A, B, 96);
			for (let i = 0; i + 1 < rp.length; i++) cmpData.push({ s: rp[i], t: rp[i + 1], c0: C.rh, c1: C.rh, w: 3, flat: true, km: 0 });
			cmpData.push({ s: A, t: B, c0: C.gc, c1: C.gc, w: 3.2, flat: true, km: 0 });   // 大円は最後＝上に描く
			const g = gcDistance(A, B), r = rhumbDistance(A, B);
			$("cmpTitle").textContent = `${state.aLabel} → ${state.bLabel}`;
			$("gcKm").textContent = km(g); $("rhKm").textContent = km(r);
			$("cmpDiff").textContent = t("The rhumb line is $1 longer ($2%). Its bearing stays at $3°.", km(r - g), fmt((r / g - 1) * 100, 1), fmt(rhumbBearing(A, B)));
		}
		if (state.mode === "cmp") { showCmp(); refreshMini(); }
	};
	const placeLabel = (p: Pos) => { const n = nearestCap(p); return n && n.km < 80 ? n.c.name : `${p[1].toFixed(1)}, ${p[0].toFixed(1)}`; };
	const cmpPick = () => { state.nextB = false; state.B = null; state.A = null; $("cmpTitle").textContent = t("Click the starting point"); $("gcKm").textContent = $("rhKm").textContent = $("cmpDiff").textContent = ""; setCompare(); };
	$("swapAB").addEventListener("click", cmpPick);

	// ── 空の道 ──
	let ap: Map<number, Airport> | null = null, routes: ArcItem[] = [], apList: AirportDeg[] = [], countries: Country[] = [], airReady = false, airLoading: Promise<void> | null = null;
	const airArcs = () => state.sel ? routes.filter(r => r.a === state.sel) : routes;
	const showAir = () => {
		if (!airReady) { setPts([]); setArcs([]); setTrips([]); return; }
		const data = airArcs();
		setPts(apList.map((a): PtItem => ({ pos: [a.lon, a.lat], c: a === state.sel ? C.apSel : C.ap, r: a === state.sel ? 7 : 1.2 + Math.min(5, Math.sqrt(a.deg) * 0.45), ap: a })));
		setArcs(state.sel ? data : (state.brush && !touch ? routes : []));
		setTrips(state.sel ? data.map((r, i) => trip(r.s, r.t, (i % 7) * 0.35)) : []);
		$("clearSel").hidden = !state.sel;
		if (state.sel) {
			const far = data.reduce((m: { km: number; b?: AirportDeg }, r) => r.km > m.km ? r : m, { km: 0 });
			$("airSel").innerHTML = `<b>${esc(state.sel.iata || state.sel.icao || "")}</b> ${esc(state.sel.name)}${state.sel.city ? ` · ${esc(state.sel.city)}` : ""}<br>${t("$1 routes · longest: $2 ($3)", fmt(data.length), esc(far.b ? (far.b.iata || far.b.city) : "—"), km(far.km))}`;
		} else $("airSel").textContent = "";
		applyFilters();
	};
	const ensureAir = () => airLoading ??= (async () => {
		try {
			const d = await loadRoutes(); ap = d.ap;
			const deg = new Map<number, number>(); for (const r of d.routes) { deg.set(r.s, (deg.get(r.s) || 0) + 1); deg.set(r.t, (deg.get(r.t) || 0) + 1); }
			routes = d.routes.map(r => { const a = ap!.get(r.s) as AirportDeg, b = ap!.get(r.t) as AirportDeg; return { s: [a.lon, a.lat], t: [b.lon, b.lat], a, b, n: r.n, km: r.km!, c0: C.hot0, c1: C.hot1, w: 1 + Math.min(3, Math.sqrt(r.n) * 0.7) }; });
			apList = [...deg].map(([id, n]) => Object.assign(ap!.get(id)!, { deg: n })).sort((x, y) => x.deg - y.deg);   // 大きい空港を後に＝上に描く・当たりも優先
			airReady = true;
			// 全路線の薄い層は空の道を開いた時に初めて作る（オーバーレイ 1 枚＝WebGL の文脈 1 つ＝要る時だけ）
			L.base ??= map.addData([], { id: "base", kind: "arcs", getSourcePosition: (d: ArcItem) => d.s, getTargetPosition: (d: ArcItem) => d.t, getColor: C.base, getWidth: 0.9, getHeight: heightOf, getFilterValue: (d: ArcItem) => d.km });
			await L.base.setData(routes);
			L.base.setVisible(state.mode === "air");
			$("airStat").innerHTML = t("$1 routes between $2 airports", `<b>${fmt(routes.length)}</b>`, `<b>${fmt(apList.length)}</b>`);
			if (state.mode === "air") { showAir(); refreshMini(); }
		} catch (e) { airLoading = null; console.warn("[arcs] routes", e); $("airStat").textContent = t("Could not load the air routes"); }
	})();
	const selectAirport = (a: AirportDeg | null) => { state.sel = a; if (state.mode === "air") { showAir(); refreshMini(); } };
	$("clearSel").addEventListener("click", () => selectAirport(null));
	const setRange = () => {
		state.kmLo = +$("kmLo").value; state.kmHi = Math.max(state.kmLo, +$("kmHi").value);
		$("kmLoV").textContent = km(state.kmLo); $("kmHiV").textContent = km(state.kmHi);
		applyFilters();
	};
	$("kmLo").addEventListener("input", setRange); $("kmHi").addEventListener("input", setRange);
	$("kmLoV").textContent = km(0); $("kmHiV").textContent = km(KM_MAX);
	$("brush")?.addEventListener("change", e => { state.brush = (e.target as HTMLInputElement).checked; if (state.mode === "air") showAir(); });
	$("country").addEventListener("change", e => {
		const c = countries.find(x => x.key === (e.target as HTMLSelectElement).value) ?? null; state.country = c?.key ?? "";
		maskPoly = c ? { type: "MultiPolygon", coordinates: c.rings.map(r => [r]) } : null;
		applyFilters();
	});

	// ── 自分の表 ──
	const showCsv = () => {
		setPts([]); setArcs(state.csvArcs);
		setTrips(state.csvArcs.slice(0, 3000).map((a, i) => trip(a.s, a.t, (i % 11) * 0.3)));
	};
	const loadTable = async (text: string, name: string) => {
		$("csvStat").textContent = t("Reading…");
		const tb = parseTable(text), det = detectColumns(tb.cols);
		let resolver: Resolver | null = null;
		if (det?.kind === "codes") {
			const vals = tb.rows.slice(0, 200).flatMap(r => [r[det.s], r[det.t]]).filter(Boolean);
			const r0 = makeResolver({ nations });
			resolver = r0.needsAirports(vals) ? makeResolver({ airports: await loadAirports().catch(() => null), nations }) : r0;
		}
		const { arcs, skipped, how } = tableToArcs(tb, det, resolver!);
		const wMax = arcs.reduce((m, a) => Math.max(m, Number.isFinite(a.w) ? a.w : 0), 0) || 1;
		state.csvArcs = arcs.map((a: Arc) => ({ ...a, c0: C.src, c1: C.dst, w0: a.w, w: det?.weight! >= 0 ? 0.8 + 5 * Math.sqrt(Math.max(0, a.w) / wMax) : 1.6 }));
		const HOW: Record<string, string> = { coords: t("coordinates"), iata: t("airport codes"), icao: t("airport codes"), iso2: t("country codes"), iso3: t("country codes"), name: t("country names") };
		$("csvStat").innerHTML = arcs.length
			? `<b>${esc(name)}</b><br>${t("$1 arcs ($2)", fmt(arcs.length), esc(HOW[how!] ?? how ?? ""))}${skipped ? ` · ${t("$1 rows skipped", fmt(skipped))}` : ""}`
			: t("No arcs found. Check the column names.");
		if (state.mode !== "csv") setMode("csv"); else { showCsv(); refreshMini(); }
		if (arcs.length) map.flyTo({ center: arcs[0].s as LonLat, zoom: Math.min(map.getZoom(), 1.8) });
	};
	const readFile = (f: File | null | undefined) => f && f.text().then(txt => loadTable(txt, f.name)).catch(e => { console.warn("[arcs] csv", e); $("csvStat").textContent = t("Could not read the file"); });
	$("pick").addEventListener("click", () => $("file").click());
	$("file").addEventListener("change", e => readFile((e.target as HTMLInputElement).files?.[0]));
	const drop = $("drop");
	for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); });
	for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
	drop.addEventListener("drop", e => { e.preventDefault(); readFile(e.dataTransfer?.files?.[0]); });
	// 地図の上に落としても受ける（表の見方へ切り替える）
	mapEl.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
	mapEl.addEventListener("drop", e => { const f = e.dataTransfer?.files?.[0]; if (!f || !/\.(csv|tsv|txt)$/i.test(f.name)) return; e.preventDefault(); e.stopPropagation(); readFile(f); }, true);

	// ── 見方の切替 ──
	const SHOW: Record<Mode, () => void> = { here: showHere, cmp: showCmp, air: showAir, csv: showCsv };
	const setMode = (m: Mode) => {
		state.mode = m; hovered = null;
		panel.querySelectorAll<HTMLElement>(".tab").forEach(b => b.setAttribute("aria-selected", (b.dataset.m === m) as unknown as string));
		panel.querySelectorAll<HTMLElement>(".pane").forEach(p => p.classList.toggle("on", p.dataset.p === m));
		const u = new URL(location.href); if (m === "here") u.searchParams.delete("mode"); else u.searchParams.set("mode", m); history.replaceState(null, "", u);
		showTip(null);
		L.base?.setVisible(m === "air" && airReady);
		if (m === "air") ensureAir();
		SHOW[m]();
		applyFilters();
		refreshMini();
	};
	panel.addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLElement>(".tab"); if (b) setMode(b.dataset.m as Mode); });

	// ── 共通：高さ・光の粒 ──
	const setH = () => {
		state.H = +$("h").value; $("hV").textContent = state.H ? fmt(state.H, 2) : t("flat");
		if (state.mode === "air") L.base?.setProps({});
		SHOW[state.mode!]();
	};
	let hT = 0; $("h").addEventListener("input", () => { $("hV").textContent = +$("h").value ? fmt(+$("h").value, 2) : t("flat"); clearTimeout(hT); hT = setTimeout(setH, 120); });
	$("hV").textContent = fmt(H0, 2);
	$("trips").addEventListener("change", e => { state.trips = (e.target as HTMLInputElement).checked; L.trips.setVisible(state.trips); });

	// ── 地図のクリック ──
	map.on("click", async e => {
		const ll = e.lngLat; if (!ll) return;
		const p: Pos = Array.isArray(ll) ? [ll[0], ll[1]] : [(ll as { lng: number }).lng, (ll as { lat: number }).lat];
		const xy = map.project(p as [number, number])!;
		const hit = (await L.pts.pick(xy.x, xy.y, state.mode === "air" ? 8 : 6))?.[0], d = hit ? ptsNow[hit.index] : null;
		if (state.mode === "here") setOrigin(d?.cap ? d.cap.pos : p, d?.cap ? d.cap.name : null);   // 首都の点に当たれば、そこへ吸い付く
		else if (state.mode === "cmp") {
			const q = d?.cap ? d.cap.pos : p, lab = d?.cap ? d.cap.name : placeLabel(p);
			if (!state.nextB) { state.A = q; state.aLabel = lab; state.B = null; state.nextB = true; setCompare(); $("cmpTitle").textContent = t("Now click the destination"); $("gcKm").textContent = $("rhKm").textContent = $("cmpDiff").textContent = ""; }
			else { state.B = q; state.bLabel = lab; state.nextB = false; setCompare(); }
		} else if (state.mode === "air" && d?.ap) selectAirport(d.ap);
	});
	// ── 乗せると（pointer の下の弧・点）──
	let hovered: ArcItem | null = null;
	const routeTip = (r: ArcItem | null) => r && `<b>${esc(r.a!.iata || r.a!.city)}</b> ${esc(r.a!.city || "")} → <b>${esc(r.b!.iata || r.b!.city)}</b> ${esc(r.b!.city || "")} · ${km(r.km)} · ${t("$1 airlines", fmt(r.n!))}`;
	const arcTip = (d: ArcItem | null) => {
		if (!d) return null;
		if (state.mode === "here") return `${esc(state.originLabel)} → <b>${esc(d.cap!.name)}</b> <span style="color:#9aa6bd">${esc(d.cap!.country)}</span> · ${km(d.km)}`;
		if (state.mode === "air") return routeTip(d);
		if (state.mode === "csv") return `${esc(d.sLabel)} → ${esc(d.tLabel)} · ${km(d.km)}${Number.isFinite(d.w0) && d.w0 !== 1 ? ` · ${fmt(d.w0!)}` : ""}`;
		return null;
	};
	const ptTip = (d: PtItem | null) => d?.cap ? `<b>${esc(d.cap.name)}</b> <span style="color:#9aa6bd">${esc(d.cap.country)}</span>` : d?.ap ? `<b>${esc(d.ap.iata || d.ap.icao || "")}</b> ${esc(d.ap.name)} · ${t("$1 routes", fmt(d.ap.deg))}` : null;
	const hover = <T,>(id: string, get: () => T[], tipOf: (d: T | null) => string | null | undefined) => {
		map.on("mousemove", id, e => { const i = (e.features as ({ overlay?: { index?: number } } | undefined)[] | undefined)?.[0]?.overlay?.index, d = i != null ? get()[i] : null, s = tipOf(d); showTip(s ? e.point : null, s); const h = d && id !== "pts" ? d as unknown as ArcItem : null;
 if (h !== hovered) { hovered = h; refreshMiniHover(); } });
		map.on("mouseleave", id, () => { showTip(null); if (hovered) { hovered = null; refreshMiniHover(); } });
	};
	hover("pts", () => ptsNow, ptTip);
	hover("arcs", () => arcsNow, arcTip);
	hover("base", () => routes, d => state.mode === "air" ? routeTip(d) : null);

	// ── 小地図に渡す線 ──
	const path = (a: Pos, b: Pos) => gcPath(a, b, 48);
	let miniBase: MiniLine[] = [], miniMarks: MiniMark[] = [];
	const refreshMiniHover = () => {
		const d = hovered, extra: MiniLine[] = d && d.s && d.t && !d.flat ? [{ pts: path(d.s, d.t), color: "#fff", width: 2.4 }, { pts: rhumbPath(d.s, d.t, 48), color: css(C.rh), width: 1.4, dash: [3, 3] }] : [];
		mini.setLines(miniBase.concat(extra), miniMarks);
	};
	const refreshMini = () => {
		miniBase = []; miniMarks = [];
		if (state.mode === "here" && state.origin) { miniBase = hereData.map(d => ({ pts: path(d.s, d.t), color: css(C.src), width: 0.8, alpha: 0.55 })); miniMarks = [{ pos: state.origin, color: css(C.src), r: 3.5 }]; }
		if (state.mode === "cmp") { if (state.A && state.B) miniBase = [{ pts: rhumbPath(state.A, state.B, 64), color: css(C.rh), width: 2 }, { pts: path(state.A, state.B), color: css(C.gc), width: 2.2 }]; miniMarks = ([state.A, state.B].filter(Boolean) as Pos[]).map(pos => ({ pos, color: "#fff" })); }
		if (state.mode === "air" && state.sel) { miniBase = airArcs().map(r => ({ pts: path(r.s, r.t), color: css(C.hot1), width: 0.9, alpha: 0.7 })); miniMarks = [{ pos: [state.sel.lon, state.sel.lat], color: css(C.apSel), r: 3.5 }]; }
		if (state.mode === "csv") miniBase = state.csvArcs.slice(0, 1500).map(a => ({ pts: path(a.s, a.t), color: css(C.dst), width: 0.8, alpha: 0.6 }));
		refreshMiniHover();
	};

	// ── 起動：見方・首都・国の形 ──
	setMode(["here", "cmp", "air", "csv"].includes(mode0!) ? mode0 as Mode : "here");
	loadCountries(geopbf, lang).then(cs => {
		countries = cs;
		mini.setLand(cs.flatMap(c => c.rings.map(r => simplify(r, 0.25))).filter(r => r.length >= 4));
		$("country").insertAdjacentHTML("beforeend", cs.map(c => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join(""));
	}).catch(e => console.warn("[arcs] countries", e));
	try {
		({ caps, nations } = await loadCapitals(lang));
		// 比べるの初期＝東京 → ニューヨーク（アラスカの上を通る）
		state.A = [139.6917, 35.6895]; state.aLabel = caps.find(c => c.key === "JP")?.name ?? "Tokyo";
		state.B = [-74.006, 40.7128]; state.bLabel = t("New York");
		setCompare();
		const home = tzCapital(caps);
		setOrigin(home ? home.pos : [map.getCenter().lng, map.getCenter().lat], home ? home.name : null);
		if (home && !location.hash) map.jumpTo({ center: [home.pos[0], Math.max(-30, Math.min(30, home.pos[1]))], zoom: map.getZoom() });
		if (state.mode !== "air" && state.mode !== "csv") SHOW[state.mode!]();

		refreshMini();
	} catch (e) { console.warn("[arcs] capitals", e); $("hereStat").textContent = t("Could not load the capitals"); }
	if (csv) fetch(csv).then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))).then(txt => loadTable(txt, decodeURIComponent(csv.split("/").pop()!.split("?")[0]) || "CSV")).catch(e => { console.warn("[arcs] ?csv", e); setMode("csv"); $("csvStat").textContent = t("Could not read the file"); });

	return {
		get mode() { return state.mode }, setMode, setOrigin, selectAirport, loadTable, ensureAir, layers: L, state,
		get capitals() { return caps }, get routes() { return routes }, get airports() { return apList }, get count() { return arcsNow.length },
		destroy() { for (const h of Object.values(L)) h!.remove();
 mini.destroy(); panel.remove(); tip.remove(); },
	};
}
