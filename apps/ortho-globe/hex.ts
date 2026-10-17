// 世界の人口を H3 の六角形の柱で（/globe/hex・issue #310・hex.html から遅延 import）。
// deck.gl の H3HexagonLayer／HexagonLayer に当たる口（map.addH3）と、S2Layer・GeohashLayer・QuadkeyLayer に当たる口（map.addCells）を、
// 球の上でいちばん映える題材＝世界の人口で見せる。描くのは全部エンジンの公開の口（addH3／addCells／setFilter／層のイベント）だけ。
//
// 表現の決め事
//   柱     … 高さ＝人口密度（人/km²）に比例（本人 2026-10-12「比例が初期値」）。H3 の六角形はどこでもほぼ同じ広さ＝密度に比例＝人口に比例。
//            粗い段と細かい段で高さの物差しが変わらないよう、密度で揃える（粗い六角形の人口は 7 つの子の合計＝7 倍になるが密度は同じ）。
//            高さの単位は画面の縦の長さ（m）と傾きに連れて変える（止まった時に）＝寄っても引いても柱が画面の同じ割合に立ち、真上から見ても
//            柱がカメラへ突き刺さらない。「柱の高さ」のつまみで倍率。
//   色     … 人口密度の段（凡例）。段の境は解像度によらない（人/km²）
//   段     … 寄ると細かく・引くと粗く（3〜6）。置くのは解像度 4（全球 7.1 万セル）と 6（res 1 の親ごとに 501 本）だけ：
//            3 は r4 から、5 は r6 から、ブラウザで親へ足し上げる（＝粗い段は細かい段の合計＝H3 の親子が目で分かる）。
//            2（一辺 180 km）は作らない＝球の全景でも 3 の六角形が見分けられ、2 の大きな屋根は押し出しが重い（段 0 の計測）。
//            柱は床 0 m の平面に立てる（extrude.bottom: 0）＝屋根の細分が粗く軽い（地面に沿わせると 1.5 km 刻み＝粗い段の六角形 1 枚に数千の三角形）。
//            4 以上は視野の周り（中心からの角距離）だけ描く。5・6 は視野に入った親の束だけ読む。切り替えは「新しい段が揃ってから差し替える」＝消えない
//   五角形 … H3 は正二十面体から作る＝どの段にも五角形がちょうど 12 個。印を付けて、順に飛べる
//   自分の点 … CSV・GeoJSON・GeoPBF・GeoParquet を落とす（か開く）と、その場で格子に数えて柱にする。格子は H3・S2・geohash・quadkey・緯度経度
import { tr, getLang } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { h3, EDGE_M } from "@ortho-earth/h3/core";
import { decodeHexPop, sumToParent, bytesOf } from "./hex-pop.ts";
import type { GlobeMap, CellsLayerHandle, CellsLayerOptions, LayerMouseEvent } from "@ortho-earth/globe";

const t = tr();
type Geopbf = typeof import("@ortho-earth/globe").geopbf;
/** 段ごとの表（lat/lng＝セルの中心・centersOf が足す） */
interface Level { cells: string[]; pop: ArrayLike<number>; lat?: Float32Array; lng?: Float32Array }
/** 柱 1 本の属性（h＝高さ・withH が焼く） */
interface CellProps { pop: number; dens: number; area: number; res: number; h?: number }
interface PtFeature { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: any } }
interface PtCollection { type: "FeatureCollection"; features: PtFeature[] }

export const DATA = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/globe/h3/kontur-20231101/";   // GitHub Pages（焼く＝scripts/kontur-h3.mjs・置く＝world の publish-pages.mjs）
const SOURCE_URL = "https://data.humdata.org/dataset/kontur-population-dataset";
const TARGET_PX = 6;          // 六角形の一辺が画面で約何 px になる段を選ぶか（小さいほど細かい）
const R_KM = 6371.0088;
const COLORS = ["#2d1160", "#5f187f", "#982d80", "#d3436e", "#f8765c", "#febb81", "#fcfdbf"];
const BREAKS = [1, 10, 50, 200, 1000, 5000];   // 人/km²（凡例の段）
const FILTERS = [0, 1, 10, 50, 200, 1000, 5000, 20000];
const DENS_REF = 3000;         // 物差しの密度（人/km²・解像度 3 の一番の密度ほど）＝この密度の柱が画面の高さの 5%（真上から）〜35%（60° 傾け）に立つ
const KINDS = [["h3", "H3"], ["s2", "S2"], ["geohash", "Geohash"], ["quadkey", "Quadkey"], ["grid", "grid"]];
const QUAKES = (days: number) => `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=4.5&orderby=time-asc&starttime=${new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)}`;

const fmt = (n: unknown, d = 0) => Number(n).toLocaleString(getLang(), { maximumFractionDigits: d });
const D2R = Math.PI / 180;
// 二点の角距離（ラジアン）
const angDist = (la1: number, lo1: number, la2: number, lo2: number) => { const a = Math.sin((la2 - la1) * D2R / 2) ** 2 + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.sin((lo2 - lo1) * D2R / 2) ** 2; return 2 * Math.asin(Math.min(1, Math.sqrt(a))); };
// 表示のズーム（256px 世界）の 1px の長さ（m・赤道）
const mPx = (z: number) => 156543.03 / 2 ** z;
// そのズームで一辺が TARGET_PX に近い H3 の解像度（hi＝使える一番細かい段）
export const resAt = (z: number, hi = 6) => { const want = TARGET_PX * mPx(z); let best = 3, bd = Infinity; for (let r = 3; r <= hi; r++) { const d = Math.abs(Math.log(EDGE_M[r] / want)); if (d < bd) { bd = d; best = r; } } return best; };

export async function mountHex(map: GlobeMap, { geopbf, data }: { geopbf?: Geopbf | null; data?: string | null } = {}) {
	document.title = t("World population in hexagons — ortho-globe");   // 器（hex.html）の題名と説明もここで＝i18n の走査器が読む頁の本体（.ts）に置く
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Where the world's 8 billion people live, as hexagonal columns on a 3D globe (H3 cells, Kontur Population). Zoom in for finer hexagons, drop your own points to count them."));
	const base = (data || DATA).replace(/\/?$/, "/");
	const mapEl = map.mapEl;
	const st: { scale: number; minDens: number; showPop: boolean; pent: boolean; pentAt: number; z: number | null; pitch: number; res: number | null; center: { lng: number; lat: number } | null; kind: string; stat: string; weight: string } = { scale: 1, minDens: 0, showPop: true, pent: false, pentAt: -1, z: null, pitch: 0, res: null, center: null, kind: "h3", stat: "count", weight: "" };

	// ── 案内板 ──
	const panel = document.createElement("div");
	panel.className = "hex-panel";
	const legend = COLORS.map(c => `<span style="background:${c}"></span>`).join("");
	panel.innerHTML = `
<style>
.hex-panel{position:absolute;top:12px;right:12px;z-index:30;width:300px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.hex-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.hex-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.hex-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.hex-panel.min .body{display:none}
.hex-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:6px}
.hex-panel .stat{font-variant-numeric:tabular-nums;color:#fff}
.hex-panel .lvl{color:#b9c3d6;font-variant-numeric:tabular-nums}
.hex-panel .row{margin:9px 0}
.hex-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#b9c3d6}
.hex-panel label b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.hex-panel label.chk{justify-content:flex-start;gap:6px;cursor:pointer}
.hex-panel input[type=range]{width:100%;margin:3px 0 0;accent-color:#f8765c}
.hex-panel select{font:inherit;font-size:12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:#1a2238;color:#e7ecf5;padding:3px 6px;max-width:150px}
.hex-panel button.b{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:4px 10px;cursor:pointer;font:inherit}
.hex-panel button.b.go{background:#f8765c;color:#1a0d00;font-weight:700;border-color:transparent}
.hex-panel .btns{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.hex-panel .bar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:4px 0 2px}
.hex-panel .bar span{flex:1}
.hex-panel .ticks{display:flex;justify-content:space-around;color:#9aa6bd;font-size:10.5px;padding:0 4%}
.hex-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.hex-panel .note a{color:#b9c3d6}
.hex-panel details{margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:6px}
.hex-panel details summary{cursor:pointer;color:#e7ecf5;font-weight:600}
.hex-panel table{border-collapse:collapse;font-size:11px;margin-top:4px;width:100%}
.hex-panel td{padding:2px 4px;border-bottom:1px solid rgba(255,255,255,.07);vertical-align:top;color:#b9c3d6}
.hex-panel td code{color:#febb81;font-size:10.5px}
.hex-panel .err{color:#ff8a7a}
.hex-tip{position:absolute;z-index:31;pointer-events:none;min-width:150px;padding:8px 11px;border-radius:10px;display:none;
 background:rgba(12,17,32,.92);color:#e7ecf5;border:1px solid rgba(255,255,255,.16);font:12px/1.55 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;
 box-shadow:0 6px 20px rgba(0,0,0,.4);transform:translate(14px,-50%);font-variant-numeric:tabular-nums;white-space:nowrap}
.hex-tip b{font-size:15px;color:#fff}
.hex-tip small{color:#9aa6bd}
.hex-drop{position:absolute;inset:0;z-index:40;display:none;align-items:center;justify-content:center;background:rgba(20,28,40,.4);pointer-events:none}
.hex-drop div{padding:20px 28px;border-radius:12px;border:2.5px dashed rgba(255,255,255,.85);background:rgba(30,40,56,.6);color:#fff;font:600 15px/1.6 system-ui,sans-serif;text-align:center}
@media (max-width:640px){.hex-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:45%}}
</style>
<div class="head"><h1>${t("World population in hexagons")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub">${t("Kontur Population · H3 hexagons")}</div>
<div class="stat" data-k="status">${t("Loading…")}</div>
<div class="lvl" data-k="level"></div>
<div class="body">
 <div class="row"><label class="chk"><input type="checkbox" data-k="showPop" checked> ${t("Population columns")}</label></div>
 <div class="row"><label>${t("Column height")} <b data-k="scaleV">×1</b></label><input type="range" data-k="scale" min="-1" max="0.7" step="0.05" value="0"></div>
 <div class="row"><label>${t("Only places denser than")} <b data-k="minV"></b></label><input type="range" data-k="min" min="0" max="${FILTERS.length - 1}" step="1" value="0"></div>
 <div class="row"><div class="bar">${legend}</div><div class="ticks">${BREAKS.map(b => `<span>${fmt(b)}</span>`).join("")}</div><div class="note" style="margin-top:0">${t("People per km²")}</div></div>
 <div class="row"><label class="chk"><input type="checkbox" data-k="pent"> ${t("Mark the 12 pentagons")}</label>
  <div class="btns"><button type="button" class="b" data-k="pentGo" hidden>${t("Fly to the next pentagon")}</button></div></div>
 <div class="note">${t("H3 hexagons are nearly the same size everywhere on Earth — on a flat Mercator map the ones near the poles would look huge. Zoom in and each hexagon splits into seven smaller ones; a coarse hexagon is the sum of its children.")}</div>
 <details data-k="ptsBox"><summary>${t("Count your own points")}</summary>
  <div class="note" style="margin-top:4px">${t("Drop a CSV, GeoJSON, GeoPBF or GeoParquet file onto the globe, or:")}</div>
  <div class="btns"><button type="button" class="b" data-k="open">${t("Open a file…")}</button><button type="button" class="b" data-k="quakes">${t("Earthquakes of the past year")}</button>
   <input type="file" data-k="file" accept=".csv,.tsv,.txt,.geojson,.json,.geopbf,.pbf,.parquet,.gz,.fgb,.kml,.gpx,.zip" hidden></div>
  <div class="stat" data-k="ptsStatus"></div>
  <div data-k="ptsCtl" hidden>
   <div class="row"><label>${t("Grid")} <select data-k="kind">${KINDS.map(([k, n]) => `<option value="${k}">${k === "h3" ? t("H3 hexagons") : k === "grid" ? t("Latitude/longitude grid") : n}</option>`).join("")}</select></label></div>
   <div class="row"><label>${t("Value")} <select data-k="stat"><option value="count">${t("Number of points")}</option><option value="sum">${t("Sum")}</option><option value="mean">${t("Average")}</option></select></label></div>
   <div class="row"><label>${t("Weight")} <select data-k="weight"></select></label></div>
   <div class="btns"><button type="button" class="b" data-k="ptsOff">${t("Remove the points")}</button></div>
  </div>
 </details>
 <details><summary>${t("How this page is drawn")}</summary>
  <table>
   <tr><td><code>map.addH3(cells)</code></td><td>H3HexagonLayer</td></tr>
   <tr><td><code>extrude: { height }</code></td><td>extruded · getElevation</td></tr>
   <tr><td><code>map.addH3(points, { res: "auto", weight })</code></td><td>HexagonLayer</td></tr>
   <tr><td><code>["step", ["get", "dens"], …]</code></td><td>getFillColor</td></tr>
   <tr><td><code>map.on("mousemove", id, …)</code></td><td>pickable · onHover</td></tr>
   <tr><td><code>map.setFilter</code></td><td>DataFilterExtension</td></tr>
   <tr><td><code>map.addCells(points, { kind })</code></td><td>S2Layer · GeohashLayer · QuadkeyLayer · GridLayer</td></tr>
  </table>
 </details>
 <div class="note">${t("Population: $1 (2023-11-01), CC BY 4.0", `<a href="${SOURCE_URL}" target="_blank" rel="noopener">Kontur Population</a>`)}</div>
</div>`;
	mapEl.append(panel);
	const $ = (k: string) => panel.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
	const tip = document.createElement("div"); tip.className = "hex-tip"; mapEl.append(tip);
	const drop = document.createElement("div"); drop.className = "hex-drop"; drop.innerHTML = `<div>${t("Drop points here to count them")}</div>`; mapEl.append(drop);
	const setFold = (min: boolean) => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	if (matchMedia("(max-width:640px)").matches) setFold(true);   // スマホ＝最初は畳む（地球を先に見せる）

	// ── データ（r4＝全球・r6＝res 1 の親ごと）──
	const fetchBin = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return decodeHexPop(await bytesOf(r)); };
	const t0 = performance.now();
	const r4 = await fetchBin(`${base}r4.h3p.gz`);
	const total = r4.pop.reduce((a, b) => a + b, 0);
	const tLoad = performance.now() - t0;
	// 段ごとの表：{ cells: string[], pop: number[], lat?, lng? }
	const fromMap = (m: Map<string, number>): Level => ({ cells: [...m.keys()], pop: [...m.values()] });
	const levels = new Map<number, Level>([[4, { cells: r4.cells, pop: r4.pop }]]);
	levels.set(3, fromMap(sumToParent(r4.cells, r4.pop, 3)));
	const centersOf = (L: Level) => { if (!L.lat) { const n = L.cells.length; L.lat = new Float32Array(n); L.lng = new Float32Array(n); for (let i = 0; i < n; i++) { const [a, b] = h3.cellToLatLng(L.cells[i]); L.lat![i] = a; L.lng![i] = b; } } return L as Required<Level>; };
	// r6：索引（res 1 の親 → セル数）と読んだ束。無い（未アップロード）なら 4 までで止める
	let r6index: Record<string, number> | null = null;
	const r6 = new Map<string, Promise<Required<Level>>>();   // 親 → Promise<{ cells, pop, lat, lng }>
	const r6ready = fetch(`${base}r6/index.json`).then(r => r.ok ? r.json() : null).then(j => { r6index = j?.parents || null; }).catch(() => { r6index = null; });
	const loadR6 = (p: string) => r6.get(p) ?? r6.set(p, fetchBin(`${base}r6/${p}.h3p.gz`).then(d => centersOf({ cells: d.cells, pop: d.pop })).catch(e => { console.warn("[hex] r6", p, e); return { cells: [], pop: [], lat: new Float32Array(0), lng: new Float32Array(0) }; })).get(p)!;

	// ── 視野の周りの角距離（ラジアン）＝画面の対角の半分 × 1px の長さ × ゆとり（傾けた時は奥へ伸ばす）
	const capOf = () => {
		const z = map.getZoom(), W = mapEl.clientWidth || 1200, H = mapEl.clientHeight || 800;
		const km = Math.hypot(W, H) / 2 * mPx(z) / 1000 * 1.1 * (1 + (map.getPitch?.() || 0) / 90);
		return Math.min(Math.PI / 2 + 0.2, km / R_KM);
	};
	const cellProps = (cell: string, pop: number, res: number): CellProps => { const area = h3.cellArea(cell, "km2"); return { pop, dens: pop / area, area, res }; };
	// 今の視点で描くセル（Map(id → 属性)）
	async function cellsFor(res: number) {
		const out = new Map<string, number>(), c = map.getCenter(), cap = capOf();
		const pick = (L: Required<Level>) => { for (let i = 0; i < L.cells.length; i++) if (angDist(c.lat, c.lng, L.lat[i], L.lng[i]) < cap) out.set(L.cells[i], L.pop[i]); };
		if (res <= 3) { const L = levels.get(res)!; L.cells.forEach((id, i) => out.set(id, L.pop[i])); }
		else if (res === 4) pick(centersOf(levels.get(4)!));
		else {   // 5・6＝視野にかかる res 1 の親の束を読む
			const home = h3.latLngToCell(c.lat, c.lng, 1), k = Math.min(6, Math.ceil(cap * R_KM / (EDGE_M[1] / 1000 * 1.5)) + 1);
			const ps = h3.gridDisk(home, k).filter(p => r6index?.[p]).filter(p => { const [a, b] = h3.cellToLatLng(p); return angDist(c.lat, c.lng, a, b) < cap + 700 / R_KM; });
			for (const L of await Promise.all(ps.map(loadR6))) pick(L);
			if (res === 5) { const s = sumToParent([...out.keys()], [...out.values()], 5); out.clear(); for (const [k, v] of s) out.set(k, v); }
		}
		const m = new Map<string, CellProps>();
		for (const [id, pop] of out) m.set(id, cellProps(id, pop, res));
		return m;
	}

	// ── 人口の柱（map.addH3 にセル id の Map を渡す＝H3HexagonLayer 相当）──
	// 高さ＝属性 h（密度 × ズームの単位）× つまみ。h はデータに焼く＝段の替わりとズームの替わりが同じ 1 回の setData（押し出しの作り直しは 1 回）
	const unitH = (z: number, pitch: number) => (0.05 + 0.3 * Math.min(1, pitch / 60)) * (mapEl.clientHeight || 800) * mPx(z) / DENS_REF;   // 1 人/km² あたりの高さ（m）
	const heightExpr = () => ["*", ["get", "h"], st.scale];
	const colorExpr = ["step", ["get", "dens"], COLORS[0], ...BREAKS.flatMap((b, i) => [b, COLORS[i + 1]])];
	let pop: CellsLayerHandle | null = null, building = 0, shown: Map<string, CellProps> | null = null;
	const stats: { cells: number; ms: number; res: number | null; loadMs: number } = { cells: 0, ms: 0, res: null, loadMs: Math.round(tLoad) };
	const withH = (cells: Map<string, CellProps>, z: number, pitch: number) => { const u = unitH(z, pitch); for (const p of cells.values()) p.h = Math.round(p.dens * u); return cells; };
	async function refresh(force = false) {
		const z = map.getZoom(), c = map.getCenter(), pitch = map.getPitch?.() || 0;
		const hi = r6index ? 6 : 4, res = resAt(z, hi);
		const moved = st.center ? angDist(st.center.lat, st.center.lng, c.lat, c.lng) : Infinity;
		const needData = force || res !== st.res || (res >= 4 && moved > capOf() / 3);
		const needH = st.z == null || Math.abs(z - st.z) > 0.6 || Math.abs(pitch - st.pitch) > 8;
		if (!needData && !needH) return;
		const my = ++building, t1 = performance.now();
		const cells = needData ? await cellsFor(res) : shown;
		if (my !== building || !cells) return;   // 追い越された（新しい視点の方が勝つ）
		st.z = z; st.pitch = pitch; withH(cells, z, pitch);
		if (needData) { st.res = res; st.center = c; }
		if (!pop) {
			pop = await map.addH3(cells, { id: "pop", outline: false as unknown as null, extrude: { height: heightExpr(), bottom: 0 }, paint: { "fill-extrusion-color": colorExpr, "fill-extrusion-opacity": 0.92 } });   // outline: false＝縁なし（型は null だけ受ける）
			if (st.minDens) map.setFilter("pop", [">=", ["get", "dens"], st.minDens]);
		} else await pop.setData(cells);   // 古い柱は新しい柱が揃うまで出たまま（消えない）
		shown = cells; stats.cells = cells.size; stats.res = st.res;
		stats.ms = Math.round(performance.now() - t1);
		showLevel();
	}
	const showLevel = () => {
		const r = st.res;
		$("level").textContent = r == null ? "" : t("Hexagon level $1 · edge ≈ $2 km · $3 hexagons", r, fmt(EDGE_M[r] / 1000, r >= 5 ? 1 : 0), fmt(stats.cells));
	};
	$("status").textContent = t("$1 people · $2 hexagons", fmt(total), fmt(r4.cells.length));
	await refresh(true);
	r6ready.then(() => refresh());
	map.on("settle", () => refresh());

	// ── 乗せると数字（層のイベント＝pickable・onHover 相当）──
	const showTip = (e: LayerMouseEvent, html: string) => { tip.innerHTML = html; tip.style.display = "block"; tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`; };
	const hideTip = () => { tip.style.display = "none"; };
	const popTip = (e: LayerMouseEvent) => {
		const p = e.features?.[0]?.properties; if (!p) return hideTip();
		const pent = h3.isPentagon(p.h3);
		showTip(e, `<b>${t("$1 people", fmt(p.pop))}</b><br>${t("$1 people/km²", fmt(p.dens, p.dens < 10 ? 1 : 0))} · ${t("$1 km²", fmt(p.area))}<br><small>${pent ? t("Pentagon $1 (level $2)", p.h3, p.res) : t("Hexagon $1 (level $2)", p.h3, p.res)}</small>`);
	};
	map.on("mousemove", "pop", popTip); map.on("mouseleave", "pop", hideTip);
	map.on("click", "pop", popTip);   // タッチ＝押すと出す

	// ── つまみ ──
	$("scale").addEventListener("input", e => { st.scale = 10 ** +(e.target as HTMLInputElement).value; $("scaleV").textContent = `×${fmt(st.scale, st.scale < 1 ? 2 : 1)}`; });
	$("scale").addEventListener("change", () => { pop?.setPaint({ "fill-extrusion-height": heightExpr() }); pts?.restyle(true); });   // 離した時に（高さは押し出しの作り直し＝重い）
	const showMin = () => { $("minV").textContent = st.minDens ? t("$1 /km²", fmt(st.minDens)) : t("everywhere"); };
	showMin();
	$("min").addEventListener("input", e => { st.minDens = FILTERS[+(e.target as HTMLInputElement).value]; showMin(); });
	$("min").addEventListener("change", () => { if (pop) map.setFilter("pop", st.minDens ? [">=", ["get", "dens"], st.minDens] : null); });   // DataFilterExtension 相当
	$("showPop").addEventListener("change", e => { st.showPop = (e.target as HTMLInputElement).checked; if (pop) map.setLayoutProperty("pop", "visibility", st.showPop ? "visible" : "none"); });

	// ── 五角形 12 個（解像度 2 で印＝球で一度に見渡せる大きさ）──
	const PENTS = h3.getPentagons(2);
	let pentL: CellsLayerHandle | null = null;
	$("pent").addEventListener("change", async e => {
		st.pent = (e.target as HTMLInputElement).checked; $("pentGo").hidden = !st.pent;
		if (st.pent && !pentL) pentL = await map.addH3(new Map(PENTS.map((p, i) => [p, { n: i + 1 }])), { id: "pent", paint: { "fill-color": "#3ff0ff", "fill-opacity": 0.28 }, outline: { "line-color": "#3ff0ff", "line-width": 2.5 } });
		else if (!st.pent && pentL) { pentL.remove(); pentL = null; }
	});
	$("pentGo").addEventListener("click", () => { st.pentAt = (st.pentAt + 1) % PENTS.length; const [lat, lng] = h3.cellToLatLng(PENTS[st.pentAt]); map.flyTo({ center: [lng, lat], zoom: 3.6, pitch: 0 }); });

	// ── 自分の点（HexagonLayer 相当＝map.addH3(points, { res: "auto", weight })・格子の切り替え＝map.addCells(points, { kind })）──
	let pts: { restyle: (force?: boolean) => void; remove: () => void } | null = null, points: PtCollection | null = null;
	const numericKeys = (fc: PtCollection) => { const ks = new Map<string, number>(); for (const f of fc.features.slice(0, 500)) for (const [k, v] of Object.entries(f.properties || {})) if (typeof v === "number" && Number.isFinite(v)) ks.set(k, (ks.get(k) || 0) + 1); return [...ks.keys()]; };
	async function showPoints() {
		pts?.remove(); pts = null;
		if (!points) return;
		const weight = st.weight || null, stat = st.stat;
		const o: CellsLayerOptions = { id: "pts", res: "auto", weight, outline: false as unknown as null, extrude: { height: 0, bottom: 0 }, paint: { "fill-extrusion-color": "#3ff0ff", "fill-extrusion-opacity": 0.9 } };

		const h = st.kind === "h3" ? await map.addH3(points, o) : await map.addCells(points, { ...o, kind: st.kind as "grid" | "geohash" | "quadkey" | "s2" });
		// 一番大きいセルが画面の同じ割合に立つよう、集め直すたびに物差しを付け直す（"auto" の集め直しは globe の idle の後）
		let last = "";
		const restyle = (force = false) => {
			if (force) last = "";
			let mx = 0; for (const c of (h.cells as Map<string, Record<string, number>>).values()) mx = Math.max(mx, +c[stat] || 0);
			mx = mx || 1;
			const top = Math.min(1.5e6, 40 * mPx(map.getZoom())) * st.scale;   // 一番大きいセル＝画面で約 40px（×つまみ）
			const key = `${mx}|${Math.round(Math.log2(top) * 2)}`;
			if (key === last) return;   // 変わらない時は付け直さない（高さの付け直し＝押し出しの作り直し）
			last = key;
			map.setPaintProperty("pts", "fill-extrusion-height", ["*", ["get", stat], top / mx]);
			map.setPaintProperty("pts", "fill-extrusion-color", ["interpolate", ["linear"], ["get", stat], 0, "#1d4e89", mx * 0.5, "#3ff0ff", mx, "#ffffff"]);
		};
		restyle();
		const onIdle = () => restyle();
		map.on("idle", onIdle);
		pts = { restyle, remove: () => { map.off("idle", onIdle); h.remove(); } };
	}
	const ptsTip = (e: LayerMouseEvent) => {
		const p = e.features?.[0]?.properties; if (!p) return hideTip();
		const id = p.h3 ?? p.id;
		showTip(e, `<b>${t("$1 points", fmt(p.count))}</b>${st.weight ? `<br>${t("Sum")} ${fmt(p.sum, 2)} · ${t("Average")} ${fmt(p.mean, 2)}` : ""}<br><small>${id}</small>`);
	};
	map.on("mousemove", "pts", ptsTip); map.on("mouseleave", "pts", hideTip); map.on("click", "pts", ptsTip);
	async function usePoints(fc: PtCollection, name: string) {
		const n = fc?.features?.length || 0;
		if (!n) { $("ptsStatus").innerHTML = `<span class="err">${t("No points found in $1", name)}</span>`; return; }
		points = fc;
		const ks = numericKeys(fc);
		st.weight = ""; $("weight").innerHTML = `<option value="">${t("(none)")}</option>` + ks.map(k => `<option>${k.replace(/[<&"]/g, "")}</option>`).join("");
		$("ptsCtl").hidden = false; ($("ptsBox") as unknown as HTMLDetailsElement).open = true;
		$("ptsStatus").textContent = t("$1 points from $2", fmt(n), name);
		if (st.showPop) $("showPop").click();   // 人口の柱は伏せる（点の柱と重ならない・チェックで戻せる）
		await showPoints();
	}
	$("kind").addEventListener("change", e => { st.kind = (e.target as HTMLSelectElement).value; showPoints(); });
	$("stat").addEventListener("change", e => { st.stat = (e.target as HTMLSelectElement).value; showPoints(); });
	$("weight").addEventListener("change", e => { st.weight = (e.target as HTMLSelectElement).value; if (st.weight && st.stat === "count") { st.stat = "sum"; $("stat").value = "sum"; } showPoints(); });
	$("ptsOff").addEventListener("click", () => { points = null; showPoints(); $("ptsCtl").hidden = true; $("ptsStatus").textContent = ""; });
	const readFile = async (file: File) => {
		$("ptsStatus").textContent = t("Reading $1…", file.name);
		try { await usePoints(await pointsFromFile(file, geopbf), file.name); }
		catch (e) { console.error("[hex] file", e); $("ptsStatus").innerHTML = `<span class="err">${t("Could not read $1", file.name)}</span>`; }
	};
	$("open").addEventListener("click", () => $("file").click());
	$("file").addEventListener("change", e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) readFile(f); (e.target as HTMLInputElement).value = ""; });
	$("quakes").addEventListener("click", async () => {
		$("ptsStatus").textContent = t("Loading…");
		try { const fc = await (await fetch(QUAKES(365))).json(); await usePoints(fc, "USGS"); }
		catch (e) { console.error("[hex] usgs", e); $("ptsStatus").innerHTML = `<span class="err">${t("Could not read $1", "USGS")}</span>`; }
	});
	let dragN = 0;
	mapEl.addEventListener("dragenter", e => { if (!e.dataTransfer?.types?.includes("Files")) return; e.preventDefault(); dragN++; drop.style.display = "flex"; });
	mapEl.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
	mapEl.addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; drop.style.display = "none"; } });
	mapEl.addEventListener("drop", e => { e.preventDefault(); dragN = 0; drop.style.display = "none"; const f = e.dataTransfer?.files?.[0]; if (f) readFile(f); });

	return {
		get res() { return st.res; }, get cells() { return stats.cells; }, get total() { return total; }, get stats() { return { ...stats }; },
		get points() { return points?.features?.length || 0; }, usePoints, refresh,
		layer: () => pop, pentagons: PENTS,
	};
}

// ── ファイル → 点の GeoJSON ──
// CSV/TSV＝緯度・経度の列を名前で探す。GeoJSON はそのまま。GeoParquet＝geopbf の変換。他（GeoPBF・FlatGeobuf・KML・GPX・Shapefile zip…）＝geopbf。
// 線・面は代表点（最初の頂点の平均）に替える＝何でも「数える」に使える
export async function pointsFromFile(file: File, geopbf?: Geopbf | null): Promise<PtCollection> {
	const name = (file.name || "").toLowerCase();
	if (/\.(csv|tsv|txt)$/.test(name)) return csvPoints(await file.text());
	if (/\.(geo)?json$/.test(name)) return toPoints(JSON.parse(await file.text()));
	if (/\.parquet$/.test(name)) {
		const { fromGeoParquet } = await import("geopbf/geoparquet");
		const r = await fromGeoParquet(new Uint8Array(await file.arrayBuffer()));
		return toPoints((r as { pbf: { geojson: unknown } }).pbf.geojson);
	}
	if (!geopbf) throw new Error("no decoder");
	const pbf = await geopbf(file, { name: `hex/${file.name}` });
	return toPoints(pbf.geojson);
}
const firstCoords = (g: { type: string; coordinates: any }): number[][] => g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" || g.type === "LineString" ? g.coordinates : g.type === "Polygon" || g.type === "MultiLineString" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : [];
export function toPoints(gj: any): PtCollection {
	const feats: any[] = gj?.type === "FeatureCollection" ? gj.features : gj?.type === "Feature" ? [gj] : Array.isArray(gj) ? gj : [];
	const out: PtFeature[] = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		if (g.type === "Point" || g.type === "MultiPoint") { out.push(f); continue; }
		const cs = firstCoords(g); if (!cs.length) continue;
		let x = 0, y = 0; for (const c of cs) { x += c[0]; y += c[1]; }
		out.push({ type: "Feature", properties: f.properties || {}, geometry: { type: "Point", coordinates: [x / cs.length, y / cs.length] } });
	}
	return { type: "FeatureCollection", features: out };
}
// 引用符つきの CSV（区切り＝, ; タブ を先頭行で決める）
export function csvPoints(text: string): PtCollection {
	text = text.replace(/^﻿/, "");
	const head = text.slice(0, text.indexOf("\n") + 1 || undefined);
	const sep = [",", "\t", ";"].map((s): [string, number] => [s, head.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
	const rows: string[][] = [];
	let row: string[] = [], cell = "", q = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
		if (ch === '"') q = true;
		else if (ch === sep) { row.push(cell); cell = ""; }
		else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
		else cell += ch;
	}
	if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
	const cols = (rows.shift() || []).map(s => s.trim());
	const find = (re: RegExp) => cols.findIndex(c => re.test(c));
	const iLat = find(/^(lat|latitude|y|緯度|lat_?deg)$/i), iLon = find(/^(lon|lng|long|longitude|x|経度|lon_?deg)$/i);
	if (iLat < 0 || iLon < 0) throw new Error("csv: no latitude/longitude columns");
	const features: PtFeature[] = [];
	for (const r of rows) {
		const lat = +r[iLat], lon = +r[iLon];
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
		const properties: Record<string, unknown> = {};

		cols.forEach((c, j) => { if (j === iLat || j === iLon || !c) return; const v = r[j], n = v === "" || v == null ? NaN : +v; properties[c] = Number.isFinite(n) ? n : v; });
		features.push({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } });
	}
	return { type: "FeatureCollection", features };
}
