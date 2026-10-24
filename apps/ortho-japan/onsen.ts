// 日本の温泉（温泉一覧＋Wikipedia 日本語版の温泉地 約 5,200 件＋温泉郷 100）を日本の 3D 地図（ortho-japan）に（onsen.html から遅延 import）。
// terrain.js と同じ骨格＝台帳（ortho-data/japan/onsen.json）を、エンジンの MapLibre 互換の口（addSource／addLayer）と anno（面の絵）で描く。
//
// データ（scripts/onsen-ledger が組む・ortho-data/japan/onsen.json）
//   items[] … 温泉（k:"o"）と温泉郷（k:"g"・poly＝構成する温泉を包む面）。座標の無い記事は検索で推定した（a＝精度 m・e＝推定の方法）
//   inns[]  … 日本秘湯を守る会の会員宿（o＝どの温泉の宿か）
//   s       … 源泉が温泉地から離れている物（岳温泉＝8 km 上の鉄山の麓から引湯）。s.c があれば源泉の位置まで線を引く
//
// 表現の決め事
//   色   … 泉質の 10 分類（環境省の掲示用新泉質名）で色分け。複数の泉質を持つ温泉は最初の分類の色（表示の切り替えはどれか一つが合えば出す）
//   推定 … 座標を推定した温泉は白抜きの輪（実測は塗りの丸）。選ぶと推定の誤差の円を出す
//   郷   … 淡い紫の面（構成する温泉の集合）。源泉 … 赤い破線で温泉地と結ぶ・源泉の位置が分からない物は赤い外輪だけ
//   選択 … 地図・一覧のどこで選んでも同じ（赤の縁取り＋詳細カード＋そこへ飛ぶ）。?o=ID で共有できる
import { tr, setLang, getLang, loadPage } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { createWikiFrame, langChain, pickTitle, wikiUrl } from "@ortho-earth/globe/wiki.js";
import { onsenName } from "./onsen-names.ts";   // よみ → 各言語の文字（26 言語の温泉名）
import { createPanel } from "common/panel";   // 案内パネルの枠（共有エンジンの入口）
import type { BigTable } from "common/bigtable";   // 一覧の表（仮想スクロール）＝一覧の面を開いた時に遅延 import（engine の入口 common/bigtable）
import type { GlobeMap, LayerMouseEvent, RenderedFeature, MapLibreLayer, StyleExpression, LonLat, Bbox, GeoJSONFeature, GeoPBF } from "@ortho-earth/globe";
const t = tr();

// 台帳（onsen.json）の形＝scripts/onsen-ledger/ledger-build.mjs の短い鍵
//   k＝"o"（温泉）／"g"（温泉郷）・n＝名前・en＝英語名・r＝よみ・p＝都道府県コード・m＝市区町村・w＝Wikipedia の題名（言語→題）・c＝座標
//   a＝推定の精度 m（0＝実測）・e＝推定の方法・h＝会員宿（inns の添字）・s＝源泉・par＝属する温泉郷・poly＝温泉郷の面・qc＝泉質の分類
//   q＝泉質・t＝温度・ph・l＝液性・site＝公式サイト
//   cs＝座標は温泉一覧から・x＝温泉一覧の測定値（n＝一覧の名・dp＝深度 m（-1＝自然湧出）・fl＝湯量 L/分・f＝成分の記号・c＝位置が違う時）・bz＝江戸の番付の位
//   f＝有名さの段（0＝現代番付・1＝英語版 Wikipedia か湯量 3,000 L/分・2＝日本語版 Wikipedia・秘湯の宿・湯量 300 L/分・無し＝その他）＝地図の LOD
interface OnsenRecord { n: string; dp?: number; fl?: number; t?: number; ph?: number; f?: string; c?: LonLat }
interface OnsenSource { c?: LonLat; f?: string; k?: string; d?: number; fn?: string; x?: string }
export interface OnsenItem { id: string; k: "o" | "g"; n: string; en?: string; r?: string; p?: number; m?: string; w?: Record<string, string>; c: LonLat;
	a: number; e?: string; h?: number[]; s?: OnsenSource; par?: string[]; poly?: LonLat[]; qc?: number[]; q?: string; t?: number; ph?: number; l?: string; site?: string; cs?: number; x?: OnsenRecord[]; bz?: string[]; f?: number }
export interface OnsenInn { c?: LonLat; o?: string; n: string; u: string; q?: string }
interface OnsenDb { items: OnsenItem[]; inns?: OnsenInn[]; prefNames?: Record<string, Record<string, string>> }

// ── 泉質の 10 分類（台帳の classes と同じ順）──────────────────────────────────
const CLASS_COLORS = ["#7a8699", "#2f78c4", "#2aa198", "#8e6bbf", "#5bc0eb", "#b5542b", "#d6336c", "#6b4226", "#e0b100", "#3c9a3c"];
const UNKNOWN = "#9aa3ad";
const className = (i: number) => [t("Simple spring"), t("Chloride spring"), t("Bicarbonate spring"), t("Sulfate spring"), t("Carbon dioxide spring"),
	t("Iron spring"), t("Acidic spring"), t("Iodine spring"), t("Sulfur spring"), t("Radioactive spring")][i] ?? t("Not recorded");
const SEL = "#d7263d", SRC = "#c0392b", KYO = "#7a4a8c";
const estName = (e: string | undefined) => ({ osm: t("Estimated from place names on OpenStreetMap"), addr: t("Estimated from the address (GSI geocoder)"), muni: t("Placed at the municipal office"), region: t("Placed in the region only"), kyo: t("Placed at its onsen district") } as Record<string, string>)[e!] || t("Estimated position");
const srcKindName = (k: string | undefined) => ({ 遠隔: t("Piped from a distant source"), 運搬: t("Hot water is carried in by truck"), 引湯元あり: t("Piped from another hot spring"), 源泉座標あり: t("The source lies away from the town") } as Record<string, string>)[k!] || t("The source lies away from the town");

// ひらがな・カタカナの区別なく検索する
const kana = (s: string | undefined) => String(s || "").toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const kmOf = (a: LonLat, b: LonLat) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
// 半径 m の円（推定の誤差・anno の面）
const circle = ([lon, lat]: LonLat, m: number, n = 48) => { const ring: LonLat[] = [], kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110570;
	for (let i = 0; i <= n; i++) { const a = -2 * Math.PI * i / n; ring.push([lon + Math.cos(a) * m / kx, lat + Math.sin(a) * m / ky]); } return { type: "Polygon", coordinates: [ring] }; };
const bboxOf = (pts: LonLat[]): Bbox => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountOnsen(map: GlobeMap, { base = "./" } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/onsen/${c}.json`));
	document.title = t("Hot springs of Japan — ortho-japan");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("About 5,000 hot springs of Japan on a 3D map, colored by spring type, with onsen districts, distant sources and member inns of the Japan Secluded Hot Spring Association."));
	const lang = getLang(), mapEl = map.mapEl;

	const db: OnsenDb = await fetch(base + "onsen.json", { credentials: "omit" }).then(r => { if (!r.ok) throw new Error("onsen.json HTTP " + r.status); return r.json(); });
	const items = db.items, byId = new Map(items.map(d => [d.id, d])), inns = db.inns || [];
	const onsens = items.filter(d => d.k === "o"), kyos = items.filter(d => d.k === "g");
	const membersOf = new Map<string, string[]>(); for (const d of onsens) for (const g of d.par || []) (membersOf.get(g) || membersOf.set(g, []).get(g))!.push(d.id);
	// 名前＝日本語の頁は日本語・それ以外は英語名（en 記事の題名か よみのローマ字）→ 日本語
	// よみの無い物も、名前がかなだけ（スパジアムジャポン・ひらふ温泉）ならそれをよみにして音写する
	const readingOf = (d: OnsenItem) => d.r || (/^[ぁ-んァ-ヶー]+(温泉|鉱泉)?$/.test(d.n) ? d.n.replace(/温泉$/, "おんせん").replace(/鉱泉$/, "こうせん") : undefined);
	const nameOf = (d: OnsenItem) => lang === "ja" || lang === "zh" ? d.n : onsenName(lang, readingOf(d)) || d.en || d.n;   // 中国語は漢字のまま・キリル／ハングル／アラビア…はよみから音写（onsen-names.ts）・ラテン文字は en
	const prefOf = (d: OnsenItem) => { const v = d.p && db.prefNames?.[String(d.p).padStart(2, "0")]; return v ? v[lang] || v.en || v.ja : ""; };   // prefNames の鍵は "01"〜"47"
	const wikiOf = (d: OnsenItem) => { const w = d.w ? pickTitle(d.w, lang === "ja" ? ["ja", "en"] : langChain(lang, ["en", "ja"])) : null; return w ? wikiUrl(w.title, w.lang) : null; };
	const srcPos = (d: OnsenItem) => d.s?.c || (d.s?.f && byId.get(d.s.f)?.c) || null;   // 源泉の位置＝座標か、引湯元の温泉の位置

	// ── 地物 ──
	// LOD＝有名さの段 f ごとに出し始める z（5,000 か所を全国の縮尺で全部出すと潰れる・本人 2026-10-24）。名札はその 1.2 上から
	const LOD_Z = [0, 6, 7.5, 9];
	const hasF = onsens.some(d => d.f != null);   // f の無い古い台帳（一覧を重ねる前）は全部出す
	const qflags = (d: OnsenItem) => { const f: Record<string, number> = { qx: d.qc?.length ? 0 : 1 }; for (let i = 0; i < 10; i++) f["q" + i] = d.qc?.includes(i) ? 1 : 0; return f; };
	const points: GeoJSONFeature[] = onsens.map(d => ({ type: "Feature", geometry: { type: "Point", coordinates: d.c },
		properties: { id: d.id, cls: d.qc?.[0] ?? -1, est: d.a > 0 ? 1 : 0, mz: hasF ? LOD_Z[d.f ?? 3] : 0, inn: d.h ? 1 : 0, src: d.s ? 1 : 0, name: nameOf(d), ...qflags(d),
			sort: (d.f ?? 3) * 1e4 + (d.a > 0 ? 5e4 : 0) - (d.h ? 3000 : 0) - (d.w?.en ? 2000 : 0) - (d.par ? 0 : 500) - (d.s ? 1000 : 0) } }));
	const kyoFeats: GeoJSONFeature[] = kyos.filter(d => d.poly).map(d => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [d.poly!] }, properties: { id: d.id, name: nameOf(d) } }));
	const kyoPts: GeoJSONFeature[] = kyos.map(d => ({ type: "Feature", geometry: { type: "Point", coordinates: d.poly ? centerOf(d.poly) : d.c }, properties: { id: d.id, name: nameOf(d) } }));
	const srcFeats: GeoJSONFeature[] = [];
	for (const d of items) { const p = srcPos(d); if (!d.s || !p || kmOf(d.c, p) < 0.05) continue;
		srcFeats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [d.c, p] }, properties: { id: d.id, name: nameOf(d) } });
		srcFeats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { id: d.id, name: nameOf(d) } }); }
	const innFeats = inns.map((x, j) => x.c && ({ type: "Feature", geometry: { type: "Point", coordinates: x.c }, properties: { j, id: x.o || "", name: x.n } })).filter(Boolean) as GeoJSONFeature[];

	// ── 記号の画像（秘湯の宿＝提灯色の家）──
	const icon = (draw: (x: CanvasRenderingContext2D, s: number) => void, s = 22) => { const c = document.createElement("canvas"); c.width = c.height = s; const x = c.getContext("2d")!; x.lineJoin = "round"; draw(x, s); return c; };
	await map.addImage("on-inn", icon((x, s) => { x.beginPath(); x.moveTo(s / 2, 2.5); x.lineTo(s - 3, s / 2 - 1); x.lineTo(s - 5, s / 2 - 1); x.lineTo(s - 5, s - 3); x.lineTo(5, s - 3); x.lineTo(5, s / 2 - 1); x.lineTo(3, s / 2 - 1); x.closePath();
		x.fillStyle = "#a8402a"; x.fill(); x.lineWidth = 1.8; x.strokeStyle = "#fff"; x.stroke(); x.fillStyle = "#fff"; x.fillRect(s / 2 - 2, s - 9, 4, 6); }), { pixelRatio: 2 });

	// ── 層 ──
	map.addSource("on-pts", { type: "geojson", data: { type: "FeatureCollection", features: points } });
	map.addSource("on-kyo", { type: "geojson", data: { type: "FeatureCollection", features: kyoFeats } });
	map.addSource("on-kyo-pts", { type: "geojson", data: { type: "FeatureCollection", features: kyoPts } });
	map.addSource("on-src", { type: "geojson", data: { type: "FeatureCollection", features: srcFeats } });
	map.addSource("on-inns", { type: "geojson", data: { type: "FeatureCollection", features: innFeats } });
	const clsColor: StyleExpression = ["match", ["get", "cls"], ...CLASS_COLORS.flatMap((c, i) => [i, c]), UNKNOWN];
	const radius: StyleExpression = ["interpolate", ["linear"], ["zoom"], 4, 2.6, 8, 4.5, 12, 7];
	const LAYERS: Record<string, Omit<MapLibreLayer, "id">> = {
		"on-kyo-fill": { type: "fill", source: "on-kyo", paint: { "fill-color": KYO, "fill-opacity": 0.01 } },   // 当たり判定だけ（塗りは anno）
		"on-src-line": { type: "line", source: "on-src", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": SRC, "line-width": 1.8, "line-dasharray": [2, 2], "line-opacity": 0.9 } },
		"on-src-pt": { type: "circle", source: "on-src", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 12, 5], "circle-color": "#fff", "circle-stroke-color": SRC, "circle-stroke-width": 2 } },
		"on-src-ring": { type: "circle", source: "on-pts", filter: ["==", ["get", "src"], 1], paint: { "circle-radius": ["+", 3.5, radius], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SRC, "circle-stroke-width": 1.4, "circle-stroke-opacity": 0.9 } },
		"on-est": { type: "circle", source: "on-pts", filter: ["==", ["get", "est"], 1], paint: { "circle-radius": radius, "circle-color": "rgba(255,255,255,.85)", "circle-stroke-color": clsColor, "circle-stroke-width": 1.6, "circle-opacity": 0.75, "circle-stroke-opacity": 0.75 } },
		"on-pt": { type: "circle", source: "on-pts", filter: ["==", ["get", "est"], 0], paint: { "circle-radius": radius, "circle-color": clsColor, "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } },
		"on-inn": { type: "symbol", source: "on-inns", layout: { "icon-image": "on-inn", "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 11, 1.05], "icon-allow-overlap": true } },
		"on-sel": { type: "circle", source: "on-pts", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": ["+", 5, radius], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SEL, "circle-stroke-width": 2.4 } },
		"on-kyo-label": { type: "symbol", source: "on-kyo-pts", filter: [">=", ["zoom"], 6.2],
			layout: { "text-field": ["get", "name"], "text-size": 13, "text-max-width": 8, "symbol-sort-key": 0 },
			paint: { "text-color": KYO, "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.8 } },
		"on-label": { type: "symbol", source: "on-pts", filter: ["all", [">=", ["zoom"], ["+", ["get", "mz"], 1.2]], [">=", ["zoom"], ["case", ["==", ["get", "est"], 1], 9, 6]]],
			layout: { "text-field": ["get", "name"], "text-size": 11.5, "text-anchor": "left", "text-offset": [0.7, 0], "text-justify": "left", "symbol-sort-key": ["get", "sort"] },
			paint: { "text-color": ["case", ["==", ["get", "est"], 1], "#6a7380", "#33404f"], "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.6 } },
	};
	for (const [id, L] of Object.entries(LAYERS)) await map.addLayer({ id, ...L });

	// 表示の切り替え（泉質・重ね）＝点の層の filter を組み直す
	const shownCls = new Set([...CLASS_COLORS.keys(), -1]);
	const ov: Record<string, boolean> = { kyo: false, src: false, est: false, inn: false, innOnly: false };   // 重ねは全部 OFF で始める（本人 2026-10-24）
	const ptFilter = () => {
		const any = [...shownCls].map(i => ["==", ["get", i < 0 ? "qx" : "q" + i], 1]);
		return ["all", [">=", ["zoom"], ["get", "mz"]], any.length ? ["any", ...any] : false, ...(ov.est ? [] : [["==", ["get", "est"], 0]]), ...(ov.innOnly ? [["==", ["get", "inn"], 1]] : [])];
	};
	function apply() {
		const f = ptFilter();
		map.setFilter("on-pt", ["all", LAYERS["on-pt"].filter, f]); map.setFilter("on-est", ["all", LAYERS["on-est"].filter, f]); map.setFilter("on-label", ["all", LAYERS["on-label"].filter, f]);
		map.setFilter("on-src-ring", ["all", LAYERS["on-src-ring"].filter, f]);
		const vis = (on: boolean) => on ? "visible" : "none";
		for (const id of ["on-src-line", "on-src-pt", "on-src-ring"]) map.setLayoutProperty(id, "visibility", vis(ov.src));
		for (const id of ["on-kyo-fill", "on-kyo-label"]) map.setLayoutProperty(id, "visibility", vis(ov.kyo));
		map.setLayoutProperty("on-inn", "visibility", vis(ov.inn));
		drawAnno();
	}

	// 面の絵（anno）：温泉郷の面・選んだ物の縁取り・推定の誤差の円。切り替えと選択のたびに積み直す
	const KYO_FILL = "rgba(122,74,140,.10)", KYO_EDGE = "rgba(122,74,140,.55)";
	let annoSeq = 0, annoChain: Promise<unknown> = Promise.resolve();
	function drawAnno() {
		const fs: GeoJSONFeature[] = [];
		if (ov.kyo) for (const f of kyoFeats) fs.push({ type: "Feature", geometry: f.geometry, properties: { "@fill": KYO_FILL, "@stroke": KYO_EDGE, "@width": 1 } });
		const d = (sel && byId.get(sel)) as OnsenItem | null | undefined;
		if (d?.k === "g" && d.poly) fs.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [d.poly] }, properties: { "@fill": "rgba(215,38,61,.08)", "@stroke": SEL, "@width": 2.4 } });
		if (d?.k === "o" && d.a > 0) fs.push({ type: "Feature", geometry: circle(d.c, d.a), properties: { "@fill": "rgba(215,38,61,.06)", "@stroke": "rgba(215,38,61,.6)", "@width": 1.2 } });
		const my = ++annoSeq;   // 呼び出しを 1 列に並べて最後の版だけ流す（terrain と同じ）
		annoChain = annoChain.then(() => my === annoSeq ? map.gadget.anno({ type: "FeatureCollection", features: fs } as unknown as GeoPBF) : null).catch(e => console.warn("[onsen] anno", e));
	}

	// ── 選択（地図・一覧の共通の口）──
	let sel: string | null = null;
	async function select(id: string | null, { fly = true } = {}) {
		const d = byId.get(id!) || null; sel = d?.id ?? null;
		map.setFilter("on-sel", ["==", ["get", "id"], d?.k === "o" ? sel : ""]);
		drawAnno();
		const u = new URL(location.href); sel ? u.searchParams.set("o", sel) : u.searchParams.delete("o"); history.replaceState(null, "", u);
		wikiFrame.close(); renderDetail(); list.mark(); banzuke.mark();
		if (!d || !fly) return;
		const pts = d.k === "g" ? [...(d.poly || [d.c]), ...(membersOf.get(d.id) || []).map(m => byId.get(m)!.c)] : [d.c, ...(srcPos(d) ? [srcPos(d)!] : [])];
		const bb = bboxOf(pts);
		if (bb[2] - bb[0] > 0.02 || bb[3] - bb[1] > 0.02) await map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(5, Math.min(12.5, map.fitZoomForBbox(bb) - 0.4)));
		else await map.flyTo(d.c[0], d.c[1], d.a > 20000 ? 9 : d.a > 3000 ? 11 : 12.5);
	}

	// ── 地図の操作（ホバー＝名前と泉質・クリック＝選択）──
	const tip = map.gadget.tip();
	const HIT = ["on-pt", "on-est", "on-label", "on-src-pt", "on-src-line", "on-inn", "on-kyo-label", "on-kyo-fill"];
	const top = (e: LayerMouseEvent) => (e.features || []).filter(f => f.properties?.id || f.properties?.j != null).sort((a, b) => HIT.indexOf(a.layer?.id) - HIT.indexOf(b.layer?.id))[0];
	const tipLines = (f: RenderedFeature | undefined) => {
		if (!f) return null;
		if (f.layer?.id === "on-inn") { const x = inns[f.properties.j]; return [`<b>${esc(x.n)}</b>　${esc(t("Member inn of the Japan Secluded Hot Spring Association"))}`]; }
		const d = byId.get(f.properties.id); if (!d) return null;
		if (f.layer?.id === "on-src-pt") return [`<b>${esc(t("Source of $1", nameOf(d)))}</b>`];
		return [`<b>${esc(nameOf(d))}</b>　${esc(d.k === "g" ? t("Onsen district") : prefOf(d))}`,
			...(d.qc ? [d.qc.map(i => esc(className(i))).join(" · ")] : []), ...(d.t != null ? [`${esc(t("Temperature"))}: ${d.t} °C`] : []), ...(d.a > 0 ? [esc(t("Estimated position"))] : [])];
	};
	map.on("mousemove", HIT, (e: LayerMouseEvent) => tip(tipLines(top(e))));
	map.on("mouseleave", HIT, () => tip(null));
	map.on("click", HIT, (e: LayerMouseEvent) => { const f = top(e); if (!f) return; const id = f.properties.id || inns[f.properties.j]?.o; if (id) select(id, { fly: false }); else if (f.properties.j != null) window.open(inns[f.properties.j].u, "_blank", "noopener"); });

	// ── 案内板（右上）：詳細カード＋タブ（表示・一覧）──
	const count = (i: number) => onsens.filter(d => i < 0 ? !d.qc?.length : d.qc?.includes(i)).length;
	// 枠（見出し・折り畳み・PC は右上／スマホは下端のシート）＝共通の器 common/panel（紙の地図＝light）。言語の切替は地図のボタン（gadget.lang）
	const P = createPanel({ host: mapEl, title: t("Hot springs of Japan"), cls: "on-panel",
		labels: { fold: t("Collapse panel"), unfold: t("Expand panel") } });
	const panel = P.el;
	P.body.insertAdjacentHTML("beforebegin", `<style>${CSS}</style>`);
	P.body.innerHTML = `
			<div class="detail" hidden></div>
			<div class="bzb"><span>${t("Hot spring rankings")}</span><button type="button" data-bz="現代">${t("Modern")}</button><button type="button" data-bz="江戸">${t("Edo period")}</button></div>
			<div class="tabs" role="tablist">
				<button type="button" data-tab="layers" class="on">${esc(t("Layers"))}</button>
				<button type="button" data-tab="list">${esc(t("List"))}</button>
			</div>
			<div class="pane" data-pane="layers">
				<h2>${esc(t("Spring type"))}</h2>
				${[...CLASS_COLORS.keys(), -1].map(i => `<label class="grp"><input type="checkbox" data-c="${i}" checked><span class="sw" style="background:${i < 0 ? UNKNOWN : CLASS_COLORS[i]}"></span>${esc(className(i))}<small>${count(i)}</small></label>`).join("")}
				<div class="all"><button type="button" data-all="1">${esc(t("All"))}</button><button type="button" data-all="0">${esc(t("None"))}</button></div>
				<h2>${esc(t("Overlays"))}</h2>
				<label class="grp"><input type="checkbox" data-ov="kyo"><span class="sw" style="background:${KYO_FILL};border:1px solid ${KYO_EDGE}"></span>${esc(t("Onsen districts"))}<small>${kyos.length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="src"><span class="sw ln" style="background:repeating-linear-gradient(90deg,${SRC} 0 4px,transparent 4px 7px)"></span>${esc(t("Sources away from the town"))}<small>${items.filter(d => d.s).length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="est"><span class="sw ring"></span>${esc(t("Estimated positions"))}<small>${onsens.filter(d => d.a > 0).length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="inn"><span class="sw inn"></span>${esc(t("Secluded hot spring inns"))}<small>${inns.length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="innOnly"><span class="sw none"></span>${esc(t("Only hot springs with such an inn"))}</label>
				<p class="note">${esc(t("Filled dots have measured coordinates (hot spring list, Wikipedia, Wikidata); hollow rings were placed by searching place names and addresses. A red outer ring means the source is far from the town."))}</p>
				<p class="src">${esc(t("Data: hot spring list (compiled from Wikipedia and years of visits on site), Japanese Wikipedia (CC BY-SA 4.0), Wikidata (CC0), © OpenStreetMap contributors (ODbL), GSI, Japan Secluded Hot Spring Association"))}</p>
			</div>
			<div class="pane" data-pane="list" hidden>
				<div class="ctl"><select class="pref"><option value="">${esc(t("All prefectures"))}</option>${Object.keys(db.prefNames || {}).map(c => `<option value="${c}">${esc(db.prefNames![c][lang] || db.prefNames![c].en)}</option>`).join("")}</select>
					<select class="kind"><option value="">${esc(t("All"))}</option><option value="g">${esc(t("Onsen districts"))}</option><option value="s">${esc(t("Sources away from the town"))}</option><option value="h">${esc(t("Secluded hot spring inns"))}</option><option value="e">${esc(t("Estimated positions"))}</option></select></div>
				<input class="find" type="search" placeholder="${esc(t("Search by name"))}">
				<p class="cnt"></p>
				<div class="obt"></div>
			</div>
		`;
	const $ = <E extends HTMLElement = HTMLElement>(s: string) => panel.querySelector(s) as E;
	panel.querySelectorAll<HTMLInputElement>("input[data-c]").forEach(inp => inp.onchange = () => { const i = +inp.dataset.c!; inp.checked ? shownCls.add(i) : shownCls.delete(i); apply(); });
	panel.querySelectorAll<HTMLElement>("button[data-all]").forEach(b => b.onclick = () => { panel.querySelectorAll<HTMLInputElement>("input[data-c]").forEach(inp => { inp.checked = b.dataset.all === "1"; const i = +inp.dataset.c!; inp.checked ? shownCls.add(i) : shownCls.delete(i); }); apply(); });
	panel.querySelectorAll<HTMLInputElement>("input[data-ov]").forEach(inp => inp.onchange = () => { ov[inp.dataset.ov!] = inp.checked; apply(); });
	panel.querySelectorAll<HTMLElement>(".tabs button").forEach(b => b.onclick = () => {
		panel.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
		panel.querySelectorAll<HTMLElement>(".pane").forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
		if (b.dataset.tab === "list") list.render();
	});
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());

	// Wikipedia＝アプリ内の枠（共通の芯 @ortho-earth/globe/wiki.js）。非対応のブラウザ・修飾キーは別タブ
	const wikiFrame = createWikiFrame({ host: mapEl, className: "on-wiki", labels: { newTab: t("Open in a new tab"), close: t("Close") } });

	// 詳細カード
	function renderDetail() {
		const el = $(".detail"), d = sel && byId.get(sel);
		if (!d) { el.hidden = true; el.innerHTML = ""; return; }
		const w = wikiOf(d), alt = [lang !== "ja" ? d.n : null, d.r].filter(Boolean).filter(s => s !== nameOf(d));
		const row = (k: string, v: string | null | undefined) => v == null || v === "" ? "" : `<div class="m"><span>${esc(k)}</span><b>${v}</b></div>`;
		const chips = (d.qc || []).map(i => `<span class="chip" style="--c:${CLASS_COLORS[i]}">${esc(className(i))}</span>`).join("");
		const pos = d.a > 0 ? `${esc(estName(d.e))} <small>(±${d.a >= 1000 ? fmt(d.a / 1000) + " km" : fmt(d.a) + " m"})</small>` : esc(d.cs ? t("From the hot spring list") : t("From Wikipedia or Wikidata"));
		const par = ((d.par || []).map(id => byId.get(id)).filter(Boolean) as OnsenItem[]).map(g => `<a href="#" data-go="${g.id}">${esc(nameOf(g))}</a>`).join(" · ");
		const mem = d.k === "g" ? (membersOf.get(d.id) || []).map(id => byId.get(id)!).sort((a, b) => kana(a.r || a.n).localeCompare(kana(b.r || b.n), "ja")).map(m => `<a href="#" data-go="${m.id}">${esc(nameOf(m))}</a>`).join(" · ") : "";
		const s = d.s, sp = srcPos(d), from = s?.f && byId.get(s.f);
		const srcHtml = s ? `<div class="srcbox"><b>${esc(srcKindName(s.k))}</b>${s.d ? ` <small>${esc(t("about $1 km", fmt(s.d / 1000)))}</small>` : sp ? ` <small>${esc(t("about $1 km", fmt(kmOf(d.c, sp))))}</small>` : ""}
			${from ? `<div>${esc(t("Source"))}: <a href="#" data-go="${from.id}">${esc(nameOf(from))}</a></div>` : s.fn && lang === "ja" ? `<div>${esc(t("Source"))}: ${esc(s.fn)}</div>` : ""}
			${s.x && lang === "ja" ? `<q>${esc(s.x)}</q>` : ""}${sp ? `<a href="#" class="srcgo">${esc(t("Show the source"))}</a>` : ""}</div>` : "";
		const depth = (v: number) => v < 0 ? esc(t("Natural flow")) : `${fmt(v)} m`;
		const recs = d.x || [], one = recs.length === 1 ? recs[0] : null;
		const recHtml = one ? row(t("Well depth"), one.dp != null ? depth(one.dp) : null) + row(t("Flow rate"), one.fl != null ? `${fmt(one.fl)} L/min` : null) + row(t("Composition"), one.f && (lang === "ja" || !/[一-龥ぁ-ん]/.test(one.f)) ? esc(one.f) : null)
			: recs.length ? `<div class="recs"><span>${esc(t("Records in the hot spring list"))}</span><ul>${recs.map(r => `<li><b>${esc(r.n)}</b> ${esc([r.t != null ? `${fmt(r.t)} °C` : "", r.ph != null ? `pH ${fmt(r.ph)}` : "", r.fl != null ? `${fmt(r.fl)} L/min` : "", r.f && (lang === "ja" || !/[一-龥ぁ-ん]/.test(r.f)) ? r.f : ""].filter(Boolean).join(" · "))}${r.dp != null ? ` <small>${esc(t("Well depth"))} ${depth(r.dp)}</small>` : ""}</li>`).join("")}</ul></div>` : "";
		const myInns = (d.h || []).map(j => inns[j]).filter(Boolean).map(x => `<li><a href="${esc(x.u)}" target="_blank" rel="noopener">${esc(x.n)}</a>${x.q && lang === "ja" ? `<small>${esc(x.q)}</small>` : ""}</li>`).join("");
		el.hidden = false;
		el.innerHTML = `<div class="dh"><span class="sw" style="background:${d.k === "g" ? KYO : d.qc ? CLASS_COLORS[d.qc[0]] : UNKNOWN}"></span><div><b class="nm">${esc(nameOf(d))}</b><small>${esc([d.k === "g" ? t("Onsen district") : "", prefOf(d), lang === "ja" ? d.m : ""].filter(Boolean).join(" · "))}${alt.length ? "<br>" + esc(alt.join(" · ")) : ""}</small></div><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>
			${chips ? `<div class="chips">${chips}</div>` : ""}
			${lang === "ja" ? row(t("Spring quality"), esc(d.q)) : ""}
			${row(t("Temperature"), d.t != null ? `${fmt(d.t)} °C` : null)}${row("pH", d.ph != null ? fmt(d.ph) : null)}${lang === "ja" ? row(t("Liquid"), esc(d.l)) : ""}
			${recHtml}${lang === "ja" && d.bz ? row("江戸の番付", esc(d.bz.join("・"))) : ""}
			${row(t("Position"), pos)}
			${par ? row(t("Part of"), par) : ""}${mem ? `<div class="mem"><span>${esc(t("Hot springs in this district"))}</span><div>${mem}</div></div>` : ""}
			${srcHtml}
			${myInns ? `<div class="inns"><span>${esc(t("Secluded hot spring inns"))}</span><ul>${myInns}</ul></div>` : ""}
			<div class="dl"><span>${d.c[1].toFixed(4)}°, ${d.c[0].toFixed(4)}°</span><span>${w ? `<a class="wk" href="${esc(w)}" target="_blank" rel="noopener">Wikipedia</a>` : ""}${d.site ? ` <a href="${esc(d.site)}" target="_blank" rel="noopener">${esc(t("Official site"))}</a>` : ""}</span></div>`;
		el.querySelector<HTMLElement>(".x")!.onclick = () => select(null);
		el.querySelectorAll<HTMLElement>("[data-go]").forEach(a => a.onclick = e => { e.preventDefault(); select(a.dataset.go!); });
		const sg = el.querySelector<HTMLElement>(".srcgo"); if (sg) sg.onclick = e => { e.preventDefault(); const bb = bboxOf([d.c, sp!]); map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(8, Math.min(13, map.fitZoomForBbox(bb) - 0.6))); };
		const wk = el.querySelector<HTMLAnchorElement>(".wk"); if (wk) wikiFrame.link(wk, w!, nameOf(d));
	}

	// ── 一覧（都道府県・種別で絞る・名前／よみ／ローマ字／各言語の名前で検索）＝common/bigtable の表（5,000 行を仮想スクロール・見出しで並べ替え・本人 2026-10-24）──
	//    表は一覧の面を開いた時に初めて組む（開くまで common/bigtable も読まない）。行を押す＝その温泉を選ぶ（地図・番付と同じ select）
	const prefSel = $<HTMLSelectElement>(".pref"), kindSel = $<HTMLSelectElement>(".kind"), find = $<HTMLInputElement>(".find"), cnt = $(".cnt"), obt = $(".obt");
	const KIND: Record<string, (d: OnsenItem) => boolean> = { g: d => d.k === "g", s: d => !!d.s, h: d => !!d.h, e: d => d.a > 0 };
	const flowOf = (d: OnsenItem) => d.x?.reduce((s, r) => s + (r.fl || 0), 0) || null;
	const depthOf = (d: OnsenItem) => d.x?.find(r => r.dp != null)?.dp ?? null;
	const blank = (v: unknown) => v == null ? "" : fmt(v as number);
	let tableReady: Promise<BigTable> | null = null, table: BigTable | null = null, shown: OnsenItem[] = [];
	const tableOf = () => tableReady ??= import("common/bigtable").then(({ BigTable }) => new BigTable(obt, {
		columns: [{ index: 0, label: t("Name"), width: 150 }, { index: 1, label: t("Prefecture"), width: 84 }, { index: 2, label: t("Spring type"), width: 104 },
			{ index: 3, label: t("Temperature"), width: 64, align: "right", numeric: true, format: blank }, { index: 4, label: "pH", width: 44, align: "right", numeric: true, format: blank },
			{ index: 5, label: t("Flow rate"), width: 70, align: "right", numeric: true, format: blank }, { index: 6, label: t("Well depth"), width: 70, align: "right", numeric: true, format: v => v == null ? "" : (v as number) < 0 ? t("Natural flow") : fmt(v as number) }],
		rowNumbers: false, theme: "dark", rowHeight: 26,
		onRowClick: (_row, k) => { const d = shown[k]; if (d) select(d.id); },
		onCountChange: c => { cnt.textContent = t("$1 places", c.shown.toLocaleString(lang)); },
	}));
	const list = {
		async render() {
			const p = +prefSel.value || 0, k = KIND[kindSel.value], q = kana(find.value.trim());
			shown = items.filter(d => (!p || d.p === p) && (!k || k(d)) && (!q || kana(d.n).includes(q) || kana(d.r).includes(q) || (d.en || "").toLowerCase().includes(q) || nameOf(d).toLowerCase().includes(q) || kana(d.m).includes(q)));
			shown.sort((a, b) => (a.f ?? 3) - (b.f ?? 3) || (lang === "ja" ? kana(a.r || a.n).localeCompare(kana(b.r || b.n), "ja") : nameOf(a).localeCompare(nameOf(b), lang)));   // 有名な順・同じ段はよみ順
			const tb = table = await tableOf();
			tb.setRows(shown.map(d => [nameOf(d), prefOf(d), d.k === "g" ? t("Onsen district") : d.qc ? className(d.qc[0]) : "", d.t ?? null, d.ph ?? null, flowOf(d), depthOf(d)]));
			this.mark();
		},
		mark() { if (!table) return; const i = shown.findIndex(d => d.id === sel); table.select(i >= 0 ? i : null, { scroll: false }); },
	};
	prefSel.onchange = () => { list.render(); const p = +prefSel.value; if (p) { const bb = bboxOf(items.filter(d => d.p === p).map(d => d.c)); map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(5, Math.min(10, map.fitZoomForBbox(bb) - 0.3))); } };
	kindSel.onchange = () => list.render();
	find.oninput = () => list.render();

	// ── 温泉番付（現代＝onsen-banzuke.ts で組む・江戸＝public/onsen-banzuke-edo.svg）。名を押すとその温泉を選ぶ＝地図・一覧と同じ select ──
	// 番付の絵は日本語の一枚もの。案内板の「温泉番付・現代・江戸」と窓の見出しは 26 言語（本人 2026-10-24）
	const prefCode = new Map(Object.entries(db.prefNames || {}).map(([c, v]) => [v.ja.replace(/[都府県]$/, ""), +c]));
	const byPrefName = new Map(items.map(d => [`${d.p}:${d.n}`, d.id]));
	const byEdo = new Map(items.flatMap(d => (d.bz || []).map(r => [r, d.id] as const)));   // 江戸の位 → 温泉（温泉一覧の番付の列＝本人の比定）。無い位は onsen-banzuke.ts の表
	const idOfRef = (r: string | null | undefined) => { if (!r) return null; const [p, n] = r.split(":"); return byPrefName.get(`${prefCode.get(p)}:${n}`) ?? null; };
	const bzEl = document.createElement("div"); bzEl.className = "on-banzuke"; bzEl.hidden = true;
	bzEl.innerHTML = `<style>${BZ_CSS}</style><div class="bh"><b></b><button type="button" class="x" aria-label="${t("Close")}">×</button></div><div class="sv"></div>`;
	mapEl.appendChild(bzEl);
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) bzEl.addEventListener(ev, e => e.stopPropagation());
	const bzSv = bzEl.querySelector<HTMLElement>(".sv")!, bzSvg: Record<string, string> = {};
	let bzMod: typeof import("./onsen-banzuke.ts") | null = null, bzKind: "現代" | "江戸" | null = null;
	const narrow = () => matchMedia("(max-width:640px)").matches;
	// 窓の大きさ＝地図の高さいっぱいに番付の縦横比で（PC は右の案内板の分を空ける）
	const fitBanzuke = () => { if (bzEl.hidden) return; const H = mapEl.clientHeight - 12 - 40 - 34, W = mapEl.clientWidth - (narrow() ? 16 : 24 + 360);
		bzEl.style.width = Math.max(160, Math.min(W, H * 190 / 258)) + "px"; };
	const banzuke = {
		async open(kind: "現代" | "江戸") {
			if (bzKind === kind && !bzEl.hidden) return banzuke.close();
			bzMod ||= await import("./onsen-banzuke.ts");
			bzSvg[kind] ||= kind === "現代" ? bzMod.温泉番付()
				: await fetch(import.meta.env.BASE_URL + "onsen-banzuke-edo.svg").then(r => { if (!r.ok) throw new Error("onsen-banzuke-edo.svg HTTP " + r.status); return r.text(); });
			bzSv.innerHTML = bzSvg[kind].replace(/^<\?xml[^>]*>\s*/, "");
			bzSv.querySelector("style")?.remove();   // SVG の .hover 規則は頁全体に効く＝窓の CSS（BZ_CSS）へ閉じ込める
			bzSv.querySelectorAll(".hover").forEach(el => {
				const nm = el.getAttribute("name") || "", id = (kind === "江戸" && byEdo.get(nm)) || idOfRef(bzMod!.番付の比定(kind, nm));
				if (id) { el.setAttribute("data-o", id); return; }
				el.classList.add("nf"); const tt = el.querySelector("title"); if (tt) tt.textContent += lang === "ja" ? "（地図上の温泉は不明）" : ` (${t("not found on the map")})`;
			});
			bzKind = kind; bzEl.querySelector("b")!.textContent = kind === "現代" ? t("Hot spring rankings (modern)") : t("Hot spring rankings (Edo period)");   // 日本語は出典の書名入り
			bzEl.hidden = false; fitBanzuke(); banzuke.mark();
		},
		close() { bzEl.hidden = true; bzKind = null; banzuke.mark(); },
		mark() {
			panel.querySelectorAll<HTMLElement>("[data-bz]").forEach(b => b.classList.toggle("on", b.dataset.bz === bzKind));
			bzSv.querySelectorAll("[data-o]").forEach(el => el.classList.toggle("on", el.getAttribute("data-o") === sel));
		},
	};
	panel.querySelectorAll<HTMLElement>("[data-bz]").forEach(b => b.onclick = () => banzuke.open(b.dataset.bz as "現代" | "江戸").catch(e => console.warn("[onsen] banzuke", e)));
	bzEl.querySelector<HTMLElement>(".x")!.onclick = () => banzuke.close();
	bzSv.onclick = e => { const el = (e.target as Element).closest("[data-o]"); if (!el) return; select(el.getAttribute("data-o")!); if (narrow()) banzuke.close(); };   // スマホは窓が地図を覆う＝選んだら閉じて見せる
	addEventListener("resize", fitBanzuke);
	addEventListener("keydown", e => { if (e.key === "Escape" && !bzEl.hidden) banzuke.close(); });

	apply();
	// 共有 URL（?o=ID）の選択を復元
	const o0 = new URLSearchParams(location.search).get("o");
	if (o0 && byId.has(o0)) select(o0, { fly: !location.hash });

	return { select, items, byId, inns, points, kyoFeats, srcFeats, get sel() { return sel; }, list, banzuke };
}

function centerOf(ring: LonLat[]): LonLat { const bb = bboxOf(ring); return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]; }
const fmt = (v: number) => (+v).toLocaleString(getLang(), { maximumFractionDigits: v < 10 ? 1 : 0 });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

// 番付の窓：紙の色（#eec）の一枚を地図の左に。押せる名＝赤・不明の名＝薄く・選んだ温泉＝赤
const BZ_CSS = `
.on-banzuke{position:absolute;left:12px;top:12px;z-index:31;background:#eec;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden;color:#444}
.on-banzuke .bh{display:flex;align-items:center;gap:8px;height:34px;padding:0 6px 0 12px;box-sizing:border-box;border-bottom:1px solid rgba(0,0,0,.15)}
.on-banzuke .bh b{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.on-banzuke .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(0,0,0,.2);background:transparent;color:#444;font-size:14px;line-height:1;cursor:pointer}
.on-banzuke .sv svg{display:block;width:100%;height:auto}
.on-banzuke [data-o]{cursor:pointer}
.on-banzuke [data-o]:hover{fill:#a00;stroke:#000;stroke-width:.2}
.on-banzuke .on{fill:#d7263d}
.on-banzuke .nf{fill-opacity:.4;cursor:default}
@media (max-width:640px){.on-banzuke{left:8px;top:8px}}`;

// ── 意匠（quiet-mono のトークン＝#map の変数を使う＝terrain と同じ）──
const CSS = `
.on-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.on-panel .bzb{display:flex;align-items:center;gap:6px;margin:10px 0 0}
.on-panel .bzb span{color:var(--qm-text-dim);font-size:12px;margin-right:auto}
.on-panel .bzb button{font:inherit;font-size:12px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text);border-radius:6px;padding:2px 12px;cursor:pointer}
.on-panel .bzb button.on{background:var(--oe-on);color:var(--qm-ink);font-weight:700}
.on-panel .tabs{display:flex;gap:4px;margin:10px 0 8px;border-bottom:1px solid var(--qm-border-soft)}
.on-panel .tabs button{flex:1;border:0;background:none;padding:6px 4px;font:inherit;color:var(--qm-text-dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.on-panel .tabs button.on{color:var(--qm-ink);font-weight:700;border-bottom-color:var(--qm-ink)}
.on-panel .grp{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
.on-panel .grp small{margin-left:auto;color:var(--qm-text-faint)}
.on-panel h2{font-size:12px;margin:10px 0 2px;color:var(--qm-text-dim);font-weight:600}
.on-panel .sw{flex:none;width:12px;height:12px;border-radius:50%;box-sizing:border-box}
.on-panel .sw.ln{height:4px;border-radius:2px}
.on-panel .sw.ring{background:#fff;border:2px solid #7a8699;opacity:.8}
.on-panel .sw.inn{border-radius:2px;background:#a8402a}
.on-panel .sw.none{background:none}
.on-panel .all{display:flex;gap:6px;margin:2px 0 0 20px}
.on-panel .all button{font:inherit;font-size:11.5px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);border-radius:6px;padding:1px 8px;cursor:pointer}
.on-panel .note{color:var(--qm-text-dim);font-size:12px;margin:8px 0 0}
.on-panel .src{color:var(--qm-text-faint);font-size:11px;margin:6px 0 0}
.on-panel .ctl{display:flex;gap:6px}
.on-panel select,.on-panel .find{flex:1;min-width:0;font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:var(--oe-field);color:var(--qm-text);padding:5px 6px}
.on-panel .find{display:block;width:100%;box-sizing:border-box;margin-top:6px}
.on-panel .cnt{margin:6px 0 0;font-size:11.5px;color:var(--qm-text-faint)}
.on-panel .obt{height:46vh;margin-top:4px;border-radius:var(--qm-r-m);overflow:hidden}
.on-panel .obt.oe-bt{--oe-bt-font:12px/1.4 var(--qm-font);--oe-bt-bg:#15181d;--oe-bt-odd:#1b1f26;--oe-bt-line:rgba(255,255,255,.08);--oe-bt-head:#22262e}
.on-panel .obt .oe-bt-row{cursor:pointer}
.on-panel .detail{margin:10px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:var(--oe-inset);border:1px solid var(--qm-border-soft)}
.on-panel .dh{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
.on-panel .dh .sw{margin-top:4px}
.on-panel .dh > div{flex:1;min-width:0}
.on-panel .dh .nm{display:block;font-size:15px;color:var(--qm-ink)}
.on-panel .dh small{color:var(--qm-text-dim)}
.on-panel .chips{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}
.on-panel .chip{font-size:11.5px;padding:1px 7px;border-radius:9px;color:#fff;background:var(--c)}
.on-panel .m{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.on-panel .m span{flex:none;color:var(--qm-text-dim);min-width:84px}
.on-panel .m b{font-weight:500;color:var(--qm-ink)}
.on-panel .m small{color:var(--qm-text-faint)}
.on-panel .mem,.on-panel .inns{margin-top:6px}
.on-panel .mem span,.on-panel .inns span{display:block;color:var(--qm-text-dim);font-size:12px}
.on-panel .mem div{font-size:12.5px;line-height:1.6}
.on-panel .inns ul{margin:2px 0 0;padding-left:16px}
.on-panel .recs{margin-top:6px}
.on-panel .recs>span{display:block;color:var(--qm-text-dim);font-size:12px}
.on-panel .recs ul{margin:2px 0 0;padding-left:16px;font-size:12.5px;line-height:1.5}
.on-panel .recs b{font-weight:500}
.on-panel .recs small{color:var(--qm-text-faint)}
.on-panel .inns small{display:block;color:var(--qm-text-faint);font-size:11px}
.on-panel .srcbox{margin-top:6px;padding:6px 8px;border-left:3px solid ${SRC};background:rgba(231,76,60,.12);border-radius:0 6px 6px 0;font-size:12.5px}
.on-panel .srcbox b{color:#ff8a7a;font-weight:600}
.on-panel .srcbox small{color:var(--qm-text-dim)}
.on-panel .srcbox q{display:block;margin-top:3px;color:var(--qm-text-dim);font-size:12px}
.on-panel .srcbox .srcgo{display:inline-block;margin-top:3px}
.on-panel a{color:var(--qm-ink)}
.on-panel .dl{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:12px;color:var(--qm-text-faint)}
.oe-wiki.on-wiki{left:12px;top:12px;bottom:calc(40px + var(--qm-safe-b));width:min(560px,calc(100% - 356px));z-index:31}
@media (max-width:640px){
	.oe-wiki.on-wiki{left:8px;right:8px;top:8px;width:auto}
}`;
