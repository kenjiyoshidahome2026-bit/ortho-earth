// 日本の地形（山・火山・山地・平野・盆地・川・湖・滝・半島・岬・島・湾・海峡・海溝…約 1,500 件）を日本の 3D 地図（ortho-japan）に（terrain.html から遅延 import）。
// /globe/physical（世界の地形）と同じ骨格＝台帳（物理量）＋形状台帳（geopbf）＋名前表（言語別）を、エンジンの MapLibre 互換の口（addSource／addLayer）と anno（面の絵）で描く。
//
// データ（scripts/terrain-ledger が組む・public/ に置く）
//   terrain.json            … items[]（qid・分類・rank・name{ja,en}・wiki{ja,en}・coord・物理量）＋ catNames（分類名 26 言語）
//   terrain-i18n/<lang>.json … { qid: [名前, 記事名] }（ja/en 以外・言語を選んだ時だけ読む）
//   terrain.geopbf          … 形状台帳（湖の面＝国土数値情報 W09・川の線＝W05・山地と海溝の軸線＝手書き・海流＝手書き・構造線）
// 選抜＝地理院ベクトルタイルの注記（z4〜9）に名前が置かれる物＝「地図帳に載る地形」（world の NE scalerank に相当）＋手動層（平野・盆地・滝・砂丘・湿原・海流・構造線…）。
//
// 表現の決め事（physical と同じ）
//   色   … 系統ごとに 1 色（起伏＝茶・川と湖＝青・海＝青（濃いインク）・海岸と島＝インクの灰・海流＝赤と青・プレートと構造線＝赤紫）
//   量   … 山の記号＝標高・川の太さ＝長さ・山地の帯の幅＝実寸（km）。数値は名前の下に添える（山・火山・滝）
//   出し … rank（地理院が名前を置く最小のズーム）で名前の出しズームを決める＝大きな物ほど遠くから
//   選択 … 地図・一覧・比較図のどこで選んでも同じ（赤の縁取り＋詳細カード＋そこへ飛ぶ）。?q=QID で共有できる
import { tr, setLang, getLang, loadPage, LANGUAGES } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { gunzip, isGzip } from "geopbf/gzip";
const t = tr();

// ── 系統（凡例と表示の切り替えの単位）──────────────────────────────────────────
const GROUPS = [
	{ id: "relief", color: "#8f4a14", ink: "#6e3810", cats: ["range", "peak", "volcano", "pass", "plateau", "hills", "plain", "basin", "trench", "ridge", "seamount", "cave"] },
	{ id: "water", color: "#2f78c4", ink: "#1f5ea4", cats: ["river", "lake", "waterfall", "wetland"] },
	{ id: "sea", color: "#2f78c4", ink: "#23609c", cats: ["sea", "bay", "strait", "reef"] },
	{ id: "coast", color: "#5a6472", ink: "#4a5058", cats: ["island", "islands", "peninsula", "cape", "beach", "dune"] },
];
// 「重ねる」で出す系統＝海流（矢印）・プレートと構造線（境界の重ねと一緒に名前）
const OVERLAY_GROUPS = [{ id: "plate", color: "#b04a9c", ink: "#8e3a7e", cats: ["plate", "fault"] }, { id: "current", color: "#d4553a", ink: "#a8402a", cats: ["current"] }];
const ALL_GROUPS = [...GROUPS, ...OVERLAY_GROUPS];
const groupName = id => ({ relief: t("Mountains & relief"), water: t("Rivers & lakes"), sea: t("Seas & bays"), coast: t("Coasts & islands") })[id];
const GROUP_OF = Object.fromEntries(ALL_GROUPS.flatMap(g => g.cats.map(c => [c, g.id])));
const SEL = "#d7263d";   // 選択の縁取り（どの系統の色とも違う赤）
// プレート境界（PB2002 の 7 種別）→ 動きの 3 系統（広がる・近づく・すれ違う）＝world の plates.geopbf を読む
const PLATE_KINDS = [{ id: "divergent", color: "#e0a020" }, { id: "convergent", color: "#b04a9c" }, { id: "transform", color: "#5a6472" }];
const PLATE_KIND_OF = { OSR: "divergent", CRB: "divergent", SUB: "convergent", OCB: "convergent", CCB: "convergent", OTF: "transform", CTF: "transform" };
const plateKindName = id => ({ divergent: t("Spreading (ridges, rifts)"), convergent: t("Converging (subduction, collision)"), transform: t("Sliding (transform faults)") })[id];
const WORLD_GIS = "https://api.ortho-earth.com/bucket/GIS/world/";   // プレート境界（world の生成物）＝@ortho-earth/core/worldcontent の WORLD_GIS と同じ

// ── 物理量 ─────────────────────────────────────────────────────────────────
const METRICS = {
	elevation: { unit: "m" }, prominence: { unit: "m" }, height: { unit: "m" }, depth: { unit: "m" },
	length: { unit: "km" }, area: { unit: "km²" }, basin: { unit: "km²" }, volume: { unit: "km³" }, discharge: { unit: "m³/s" },
};
const metricName = k => ({ elevation: t("Elevation"), prominence: t("Prominence"), height: t("Height"), depth: t("Depth"), length: t("Length"),
	area: t("Area"), basin: t("Drainage basin"), volume: t("Volume"), discharge: t("Discharge") })[k];
const valueOf = (d, k) => k === "depth" ? (d.depth ?? (d.elevation < 0 ? -d.elevation : null)) : d[k] ?? null;   // 海溝・海盆は標高が負＝深さとして読む
const fmtNum = v => v == null ? "" : v.toLocaleString(getLang(), { maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0 });
const fmtVal = (v, k) => v == null ? "–" : `${fmtNum(v)} ${METRICS[k].unit}`;

// 比較図の題目（分類 × 量。2 量は同じ行で並べた小さな 2 枚＝軸を共有しない）
const PRESETS = [
	{ id: "peaks", cats: ["peak", "volcano"], metrics: ["elevation", "prominence"], shape: "mountain" },
	{ id: "volcanoes", cats: ["volcano"], metrics: ["elevation"], shape: "mountain" },
	{ id: "rivers", cats: ["river"], metrics: ["length", "basin"] },
	{ id: "lakes", cats: ["lake"], metrics: ["area", "depth"] },
	{ id: "waterfalls", cats: ["waterfall"], metrics: ["height"] },
	{ id: "islands", cats: ["island"], metrics: ["area", "elevation"] },
	{ id: "passes", cats: ["pass"], metrics: ["elevation"] },
	{ id: "plains", cats: ["plain", "basin"], metrics: ["area"] },
	{ id: "trenches", cats: ["trench"], metrics: ["depth"] },
];
const presetName = id => ({ peaks: t("Highest mountains"), volcanoes: t("Highest volcanoes"), rivers: t("Longest rivers"), lakes: t("Largest lakes"), waterfalls: t("Tallest waterfalls"),
	islands: t("Largest islands"), passes: t("Highest passes"), plains: t("Largest plains and basins"), trenches: t("Deepest trenches") })[id];

// 山地の帯：軸線を Catmull-Rom で滑らかにし、左右へ幅の半分ずつ張り出した面にする（両端の 2 割はすぼめる＝地図帳の山脈の形）。physical.js の rangeBand と同じ
function rangeBand(coords, widthKm) {
	const P = coords.map(p => [p[0], p[1]]); if (P.length < 2) return null;
	const S = [P[0]], K = 6;
	for (let i = 0; i + 1 < P.length; i++) {
		const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
		for (let j = 1; j <= K; j++) { const u = j / K, u2 = u * u, u3 = u2 * u;
			S.push([0, 1].map(d => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3))); }
	}
	const KX = lat => 111.32 * Math.cos(lat * Math.PI / 180), KY = 110.57;
	const cum = [0]; for (let i = 1; i < S.length; i++) cum.push(cum[i - 1] + Math.hypot((S[i][0] - S[i - 1][0]) * KX(S[i][1]), (S[i][1] - S[i - 1][1]) * KY));
	const L = cum.at(-1) || 1, half = (widthKm > 0 ? widthKm : 20) / 2, left = [], right = [];
	for (let i = 0; i < S.length; i++) {
		const a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)], kx = KX(S[i][1]);
		let tx = (b[0] - a[0]) * kx, ty = (b[1] - a[1]) * KY; const n = Math.hypot(tx, ty) || 1; tx /= n; ty /= n;
		const u = cum[i] / L, w = half * Math.pow(Math.min(1, u / 0.2, (1 - u) / 0.2), 0.6);
		left.push([S[i][0] - ty * w / kx, S[i][1] + tx * w / KY]); right.push([S[i][0] + ty * w / kx, S[i][1] - tx * w / KY]);
	}
	const ring = [...left, ...right.reverse()]; ring.push(ring[0]);
	let A = 0; for (let i = 1; i < ring.length; i++) A += (ring[i][0] - ring[i - 1][0]) * (ring[i][1] + ring[i - 1][1]);
	if (A > 0) ring.reverse();   // 外周は反時計回り（RFC 7946）
	return { type: "Polygon", coordinates: [ring.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)])] };
}
const segLen = c => { let L = 0; for (let i = 1; i < c.length; i++) L += Math.hypot((c[i][0] - c[i - 1][0]) * Math.cos(c[i][1] * Math.PI / 180), c[i][1] - c[i - 1][1]); return L; };
const midOf = c => { const half = segLen(c) / 2; let acc = 0;
	for (let i = 1; i < c.length; i++) { const l = segLen([c[i - 1], c[i]]); if (acc + l >= half) { const u = (half - acc) / (l || 1); return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * u, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * u]; } acc += l; }
	return c[c.length >> 1]; };
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);

// 形状台帳を読む＝fetch（HTTP キャッシュが ETag で新旧を確かめる）→ 中身を geopbf へ（physical と同じ）
async function loadPbf(geopbf, url) {
	const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	const b = await r.blob();
	return geopbf(await (await isGzip(b) ? await gunzip(b) : b).arrayBuffer());
}
// 単純化（Douglas–Peucker・経度は cos(緯度) で縮めた画面の尺で測る）＝anno の段ごとの粗い版に使う
function simplifyPts(P, tol, closed) {
	const n = P.length, min = closed ? 4 : 2; if (n <= min || !(tol > 0)) return P;
	const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const t2 = tol * tol, stack = [[0, n - 1]];
	while (stack.length) { const [a, b] = stack.pop(); if (b - a < 2) continue;
		const k = Math.cos(((P[a][1] + P[b][1]) / 2) * Math.PI / 180), ax = P[a][0] * k, ay = P[a][1], dx = P[b][0] * k - ax, dy = P[b][1] - ay, L2 = dx * dx + dy * dy; let best = -1, bd = t2;
		for (let i = a + 1; i < b; i++) { const px = P[i][0] * k - ax, py = P[i][1] - ay, u = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, ex = px - u * dx, ey = py - u * dy, d = ex * ex + ey * ey; if (d > bd) { bd = d; best = i; } }
		if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); } }
	const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(P[i]); return out.length >= min ? out : P;
}
function simplifyGeom(g, tol) {
	const L = l => simplifyPts(l, tol, false), R = r => simplifyPts(r, tol, true);
	switch (g?.type) {
		case "LineString": return { type: g.type, coordinates: L(g.coordinates) };
		case "MultiLineString": return { type: g.type, coordinates: g.coordinates.map(L) };
		case "Polygon": return { type: g.type, coordinates: g.coordinates.map(R) };
		case "MultiPolygon": return { type: g.type, coordinates: g.coordinates.map(p => p.map(R)) };
		default: return g;
	}
}

// 名前の出しズーム（rank＝地理院が名前を置く最小のズーム。島は z4 から置かれるが海の上の空きを使った物＝一段遅らせる）
const minZoomOf = d => { const z = { 4: 3.4, 6: 4.8, 7: 5.8, 8: 7, 9: 8.4 }[d.rank] ?? (d.rank >= 99 ? 11 : 8.4); return d.category === "island" || d.category === "islands" ? z + (d.rank <= 4 ? 1.2 : 0.6) : d.category === "cape" ? z + 0.8 : z; };
const textSizeOf = d => d.category === "sea" && d.rank <= 4 ? 15 : ({ 4: 14, 6: 13, 7: 12.5, 8: 12, 9: 11.2 }[d.rank] ?? 11);
const ICON = { peak: "tr-peak", volcano: "tr-volcano", pass: "tr-pass", waterfall: "tr-fall", trench: "tr-trench", cape: "tr-dot", reef: "tr-dot", cave: "tr-dot", seamount: "tr-dot" };
const LINE_LABEL = new Set(["river", "current", "fault"]);   // 名前を線に沿わせる

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountTerrain(map, { geopbf, base = "./" } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/terrain/${c}.json`));
	document.title = t("Landforms of Japan — ortho-japan");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Mountains, volcanoes, rivers, lakes, plains, islands and seas of Japan on a 3D map, with their heights, lengths, areas and depths side by side."));
	const lang = getLang(), mapEl = map.mapEl;

	// データ（3 本を並行に）。名前表の失敗は英語／日本語で出すだけ（地図は止めない）
	const [db, i18n, pbf] = await Promise.all([
		fetch(base + "terrain.json", { credentials: "omit" }).then(r => { if (!r.ok) throw new Error("terrain.json HTTP " + r.status); return r.json(); }),
		lang === "ja" || lang === "en" ? null : fetch(`${base}terrain-i18n/${lang}.json`, { credentials: "omit" }).then(r => r.ok ? r.json() : null).catch(e => (console.warn("[terrain] i18n", lang, e), null)),
		loadPbf(geopbf, base + "terrain.geopbf"),
	]);
	const items = db.items.filter(d => d.coord);
	const byQ = new Map(items.map(d => [d.qid, d]));
	// 名前＝その言語 → 英語 → 日本語（日本語は全件ある）。記事＝その言語 → 日本語 → 英語（日本語版が最も揃う）
	const nameOf = d => lang === "ja" ? d.name.ja : lang === "en" ? d.name.en || d.name.ja : i18n?.[d.qid]?.[0] || d.name.en || d.name.ja;
	const catName = c => db.catNames?.[c]?.[lang] || db.catNames?.[c]?.en || c;
	const wikiOf = d => { const w = lang !== "ja" && lang !== "en" ? i18n?.[d.qid]?.[1] : d.wiki[lang]; if (w) return [lang, w]; if (d.wiki.ja) return ["ja", d.wiki.ja]; if (d.wiki.en) return ["en", d.wiki.en]; return null; };
	const wikiUrl = d => { const w = wikiOf(d); return w ? `https://${w[0]}.wikipedia.org/wiki/${encodeURIComponent(w[1].replace(/ /g, "_"))}` : null; };

	// 形状台帳 → GeoJSON（台帳の物理量を属性へ結ぶ＝式で太さ・色を引く）
	const shapes = [], geomsOf = new Map(), axisOf = new Map();   // axisOf＝山地・海溝の軸線（名前を帯の中心に置く）
	for (let i = 0, n = pbf.fmap?.length ?? pbf.length ?? 0; i < n; i++) {
		const f = pbf.getFeature(i); const p = f?.properties || pbf.getProperties(i) || {};
		if (!f?.geometry || !p.qid) continue;
		const d = byQ.get(p.qid); if (!d) continue;
		(geomsOf.get(p.qid) || geomsOf.set(p.qid, []).get(p.qid)).push(f.geometry);
		let geometry = f.geometry;
		if (p.shape === "axis") { const axis = f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates[0]; axisOf.set(p.qid, axis); if (d.category !== "current") geometry = rangeBand(axis, p.width); }
		if (!geometry) continue;
		shapes.push({ type: "Feature", geometry, properties: { qid: p.qid, category: d.category, g: GROUP_OF[d.category] || "coast", shape: p.shape, width: p.width ?? null, flow: p.flow ?? null, length: d.length ?? null, name: nameOf(d) } });
	}
	// 線に沿う名前の材料＝川・海流・構造線ごとに最も長い 1 区間だけ
	const lineLabels = [];
	for (const f of shapes) {
		if (!LINE_LABEL.has(f.properties.category) || !/LineString$/.test(f.geometry.type)) continue;
		const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
		let best = null, bl = 0; for (const c of parts) { const L = segLen(c); if (L > bl) { bl = L; best = c; } }
		if (best) lineLabels.push({ type: "Feature", geometry: { type: "LineString", coordinates: simplifyPts(best, 0.002, false) }, properties: { ...f.properties, deg: bl, rank: byQ.get(f.properties.qid).rank } });
	}
	// 名前と記号の点（代表点＝Wikidata の P625 か地理院の注記の位置）。線に沿わせる物（川・海流・構造線）で形のある物はここに入れない
	const valLabel = d => d.category === "waterfall" ? fmtVal(d.height ?? null, "height") : d.elevation != null && d.elevation > 0 ? fmtVal(d.elevation, "elevation") : "";
	const points = items.filter(d => !LINE_LABEL.has(d.category) || !geomsOf.has(d.qid)).map(d => ({ type: "Feature",
		geometry: { type: "Point", coordinates: (d.category === "range" || d.category === "trench") && axisOf.has(d.qid) ? midOf(axisOf.get(d.qid)) : d.coord },
		properties: { qid: d.qid, category: d.category, g: GROUP_OF[d.category] || "coast", name: nameOf(d), elev: d.elevation ?? 0,
			sub: ICON[d.category] && d.category !== "trench" ? valLabel(d) : d.category === "trench" && valueOf(d, "depth") != null ? "−" + fmtVal(valueOf(d, "depth"), "depth") : "",
			icon: ICON[d.category] || "", mz: minZoomOf(d), size: textSizeOf(d), ...((d.category === "range" || d.category === "trench") && axisOf.has(d.qid) ? { label: 1 } : {}),
			sort: d.rank * 1e5 - (d.category === "range" ? 5000 : d.elevation ?? d.length ?? Math.sqrt(d.area ?? 0)) } }));

	// ── 記号の画像 ──
	const icon = (draw, s = 22) => { const c = document.createElement("canvas"); c.width = c.height = s; const x = c.getContext("2d"); x.lineJoin = "round"; draw(x, s); return c; };
	const tri = (color, down = false) => (x, s) => { x.beginPath(); if (down) { x.moveTo(3, 5); x.lineTo(s - 3, 5); x.lineTo(s / 2, s - 3); } else { x.moveTo(s / 2, 3); x.lineTo(s - 3, s - 5); x.lineTo(3, s - 5); } x.closePath();
		x.fillStyle = color; x.fill(); x.lineWidth = 2; x.strokeStyle = "rgba(255,255,255,.95)"; x.stroke(); };
	await Promise.all([
		map.addImage("tr-peak", icon(tri("#8f4a14")), { pixelRatio: 2 }),
		map.addImage("tr-volcano", icon((x, s) => { tri("#c2410c")(x, s); x.fillStyle = "#fff"; x.fillRect(s / 2 - 2, 3, 4, 4); }), { pixelRatio: 2 }),
		map.addImage("tr-trench", icon(tri("#b04a9c", true)), { pixelRatio: 2 }),
		map.addImage("tr-pass", icon((x, s) => { x.lineWidth = 2.6; x.strokeStyle = "#8f4a14"; x.beginPath(); x.arc(2, s / 2, 8, -0.9, 0.9); x.stroke(); x.beginPath(); x.arc(s - 2, s / 2, 8, Math.PI - 0.9, Math.PI + 0.9); x.stroke(); }), { pixelRatio: 2 }),
		map.addImage("tr-fall", icon((x, s) => { x.strokeStyle = "#fff"; x.lineWidth = 5; x.beginPath(); for (const dx of [-4, 0, 4]) { x.moveTo(s / 2 + dx, 4); x.lineTo(s / 2 + dx, s - 4); } x.stroke(); x.strokeStyle = "#2f78c4"; x.lineWidth = 2.2; x.stroke(); }), { pixelRatio: 2 }),
		map.addImage("tr-dot", icon((x, s) => { x.beginPath(); x.arc(s / 2, s / 2, 4, 0, Math.PI * 2); x.fillStyle = "#4a5058"; x.fill(); x.lineWidth = 2; x.strokeStyle = "#fff"; x.stroke(); }), { pixelRatio: 2 }),
	]);

	// ── 層 ──
	const colorBy = key => ["match", ["get", "g"], ...ALL_GROUPS.flatMap(g => [g.id, g[key]]), "#5a6472"];
	const shown = new Set(GROUPS.map(g => g.id));
	const groupFilter = () => ["match", ["get", "g"], [...shown].length ? [...shown] : ["-"], true, false];
	// gint に積むのは描く物と当たり判定に使う物（川の線・湖の面・山地と海溝の帯・構造線・海流の当たり）。面の絵は anno（drawAnno）＝gint の塗りは海面高で山に隠れる（physical の経験）
	map.addSource("tr", { type: "geojson", data: { type: "FeatureCollection", features: shapes } });
	map.addSource("tr-pts", { type: "geojson", data: { type: "FeatureCollection", features: points } });
	map.addSource("tr-lab", { type: "geojson", data: { type: "FeatureCollection", features: lineLabels } });
	const polyF = ["==", ["geometry-type"], "Polygon"];
	const LAYERS = {
		"tr-lake": { type: "fill", source: "tr", filter: ["all", polyF, ["==", ["get", "category"], "lake"]], paint: { "fill-color": "#2f78c4", "fill-opacity": 0.01 } },   // 当たり判定だけ（塗りは anno）
		"tr-band": { type: "fill", source: "tr", filter: ["==", ["get", "shape"], "axis"], paint: { "fill-opacity": 0.01 } },
		"tr-lake-line": { type: "line", source: "tr", filter: ["all", polyF, ["==", ["get", "category"], "lake"]], paint: { "line-color": "#2f78c4", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 10, 1.4], "line-opacity": 0.8 } },
		"tr-river": { type: "line", source: "tr", filter: ["all", ["==", ["get", "category"], "river"], ["!=", ["geometry-type"], "Polygon"]],
			layout: { "line-cap": "round", "line-join": "round" },
			paint: { "line-color": "#2f78c4", "line-width": ["interpolate", ["linear"], ["zoom"], 4, ["step", ["coalesce", ["get", "length"], 0], 0.5, 100, 0.8, 200, 1.2, 300, 1.6], 10, ["step", ["coalesce", ["get", "length"], 0], 1.4, 100, 2, 200, 2.8, 300, 3.6]] } },
		"tr-fault": { type: "line", source: "tr", filter: ["==", ["get", "category"], "fault"], layout: { "line-join": "round" }, paint: { "line-color": "#b04a9c", "line-width": 2, "line-dasharray": [5, 3], "line-opacity": 0.85 } },
		"tr-current": { type: "line", source: "tr", filter: ["==", ["get", "category"], "current"], paint: { "line-color": "#5a6472", "line-width": 10, "line-opacity": 0.01 } },   // 海流の絵は anno の矢印＝この層は当たり判定だけ
		"tr-sel-line": { type: "line", source: "tr", filter: ["==", ["get", "qid"], ""], layout: { "line-join": "round" }, paint: { "line-color": SEL, "line-width": 2.4 } },
		"tr-sel-pt": { type: "circle", source: "tr-pts", filter: ["==", ["get", "qid"], ""], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SEL, "circle-stroke-width": 2.4 } },
		// 線に沿う名前（川＝rank のズームから・海流と構造線＝重ねた時）
		"tr-line-label": { type: "symbol", source: "tr-lab", filter: [">=", ["zoom"], ["-", ["get", "rank"], 1]],
			layout: { "symbol-placement": "line-center", "text-field": ["get", "name"], "text-size": 11.5, "text-max-angle": 35, "symbol-sort-key": ["-", 0, ["get", "deg"]] },
			paint: { "text-color": ["match", ["get", "category"], "fault", "#8e3a7e", "current", ["match", ["get", "flow"], "warm", "#a8402a", "#1f5ea4"], "#1f5ea4"], "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.6 } },
		"tr-poi": { type: "symbol", source: "tr-pts", filter: ["all", ["!=", ["get", "icon"], ""], ["!", ["has", "label"]], ["<=", ["get", "mz"], ["zoom"]]],
			layout: { "icon-image": ["get", "icon"], "icon-size": ["match", ["get", "category"], ["peak", "volcano"], ["interpolate", ["linear"], ["get", "elev"], 0, 0.6, 2000, 0.85, 3776, 1.2], 0.85], "symbol-sort-key": ["get", "sort"],
				"text-field": ["case", ["!=", ["get", "sub"], ""], ["concat", ["get", "name"], "\n", ["get", "sub"]], ["get", "name"]],
				"text-size": ["get", "size"], "text-anchor": "left", "text-offset": [0.75, 0], "text-justify": "left", "text-optional": true },
			paint: { "text-color": ["match", ["get", "category"], "trench", "#8e3a7e", colorBy("ink")], "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.8 } },
		// 山地・海溝の名前＝帯の中心。ぶつかったら中心の上下左右へずれて空きを探す
		"tr-range-label": { type: "symbol", source: "tr-pts", filter: ["all", ["any", ["==", ["get", "category"], "range"], ["has", "label"]], ["<=", ["get", "mz"], ["zoom"]]],
			layout: { "text-field": ["get", "name"], "text-size": ["+", 1, ["get", "size"]], "symbol-sort-key": ["get", "sort"], "text-max-width": 8,
				"text-variable-anchor": ["center", "top", "bottom", "left", "right"], "text-radial-offset": 0.9 },
			paint: { "text-color": ["match", ["get", "category"], "trench", "#8e3a7e", colorBy("ink")], "text-halo-color": "rgba(255,255,255,.85)", "text-halo-width": 1.8 } },
		"tr-area-label": { type: "symbol", source: "tr-pts", filter: ["all", ["==", ["get", "icon"], ""], ["!=", ["get", "category"], "range"], ["!", ["has", "label"]], ["<=", ["get", "mz"], ["zoom"]]],
			layout: { "text-field": ["get", "name"], "text-size": ["get", "size"], "symbol-sort-key": ["get", "sort"], "text-max-width": 8 },
			paint: { "text-color": colorBy("ink"), "text-halo-color": "rgba(255,255,255,.85)", "text-halo-width": 1.8 } },
	};
	for (const [id, L] of Object.entries(LAYERS)) await map.addLayer({ id, ...L });
	const baseFilter = Object.fromEntries(Object.entries(LAYERS).map(([id, L]) => [id, L.filter]));
	const TOGGLED = ["tr-lake", "tr-band", "tr-lake-line", "tr-river", "tr-fault", "tr-current", "tr-line-label", "tr-poi", "tr-range-label", "tr-area-label"];
	const applyGroups = () => { for (const id of TOGGLED) map.setFilter(id, ["all", baseFilter[id], groupFilter()]); drawAnno(); };

	// 面の絵（anno）：山地の帯（2 重＝中ほどが濃く縁が淡い）・海溝の帯・湖の塗り・海流の矢印・選択した面の縁取り。系統の切り替えと選択のたびに積み直す
	const RANGE_OUT = "rgba(143,74,20,.22)", RANGE_IN = "rgba(143,74,20,.26)", NONE = "rgba(0,0,0,0)", TRENCH_FILL = ["rgba(126,48,110,.22)", "rgba(126,48,110,.34)"], LAKE_FILL = "rgba(47,120,196,.28)";
	const coreOf = new Map([...axisOf].map(([q, c]) => { const f = shapes.find(x => x.properties.qid === q && x.properties.shape === "axis"); return [q, f && f.properties.category !== "current" ? rangeBand(c, (f.properties.width || 20) * 0.55) : null]; }));
	const CURRENT_FILL = { warm: "rgba(214,85,58,.5)", cold: "rgba(47,120,196,.5)" }, CURRENT_EDGE = { warm: "rgba(168,64,42,.55)", cold: "rgba(31,94,164,.55)" };
	const arrowWidth = () => Math.max(4, Math.min(14, 1 + map.view.zoom * 1.8));
	const chunks = (line, step = 400, gap = 0.05) => {   // 累積距離で step km ごとに切る＝途中でも向きが読める
		const total = line.slice(1).reduce((L, p, i) => L + kmOf(line[i], p), 0), n = Math.max(1, Math.round(total / step)), seg = total / n, out = [];
		for (let k = 0; k < n; k++) {
			const a = k * seg + (k ? seg * gap : 0), b = (k + 1) * seg - (k + 1 < n ? seg * gap : 0), part = []; let acc = 0;
			for (let i = 0; i < line.length; i++) {
				const l = i ? kmOf(line[i - 1], line[i]) : 0, a0 = acc; acc += l;
				const at = u => [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * u, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * u];
				if (i && a0 < a && acc > a) part.push(at((a - a0) / l));
				if (acc >= a && acc <= b) part.push(line[i]);
				if (i && a0 < b && acc > b) { part.push(at((b - a0) / l)); break; }
			}
			if (part.length >= 2) out.push(part);
		}
		return out;
	};
	let arrowW = 0, annoLod = -1;
	const lodOf = z => z < 4.5 ? 0 : z < 6.5 ? 1 : z < 9 ? 2 : 3, LOD_TOL = [0.02, 0.006, 0.0015, 0];
	const lodCache = [new Map(), new Map(), new Map(), null];
	const lodGeom = (key, g, lv) => { if (!LOD_TOL[lv]) return g; let m = lodCache[lv].get(key); if (!m) lodCache[lv].set(key, m = simplifyGeom(g, LOD_TOL[lv])); return m; };
	map.on("settle", () => { if (Math.abs(arrowWidth() - arrowW) >= 1 || lodOf(map.view.zoom) !== annoLod) drawAnno(); });
	function drawAnno() {
		const fs = [];
		arrowW = arrowWidth(); annoLod = lodOf(map.view.zoom); const lv = annoLod;
		for (const f of shapes) {
			const { g, category, flow } = f.properties;
			if (category !== "current" || !shown.has(g) || !/LineString$/.test(f.geometry.type)) continue;
			const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates, w = flow === "warm" ? "warm" : "cold";
			for (const part of parts) for (const c of chunks(part))
				fs.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: { "@poly": true, "@width": arrowW, "@end": "arrow", "@fill": CURRENT_FILL[w], "@stroke": CURRENT_EDGE[w] } });
		}
		for (const f of shapes) {
			const { g, category, shape, qid } = f.properties; if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
			const on = shown.has(g), geom = () => lodGeom(f, f.geometry, lv);
			if (on && shape === "axis") {
				const [OUT, IN] = category === "trench" ? TRENCH_FILL : [RANGE_OUT, RANGE_IN];
				fs.push({ type: "Feature", geometry: geom(), properties: { "@fill": OUT, "@stroke": NONE, "@width": 0.01 } });
				const core = coreOf.get(qid); if (core) fs.push({ type: "Feature", geometry: lodGeom(core, core, lv), properties: { "@fill": IN, "@stroke": NONE, "@width": 0.01 } });
			} else if (on && category === "lake") fs.push({ type: "Feature", geometry: geom(), properties: { "@fill": LAKE_FILL, "@stroke": NONE, "@width": 0.01 } });
			if (qid === sel) fs.push({ type: "Feature", geometry: geom(), properties: { "@fill": "rgba(215,38,61,.10)", "@stroke": SEL, "@width": 2.4 } });
		}
		const my = ++annoSeq;   // 呼び出しを 1 列に並べて最後の版だけ流す（physical と同じ）
		annoChain = annoChain.then(() => my === annoSeq ? map.gadget.anno({ type: "FeatureCollection", features: fs }) : null).catch(e => console.warn("[terrain] anno", e));
	}
	let annoSeq = 0, annoChain = Promise.resolve();

	// ── 選択（地図・一覧・比較図の共通の口）──
	let sel = null;
	applyGroups();
	const bboxOf = qid => {
		const gs = geomsOf.get(qid); if (!gs) return null;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		const walk = c => { if (typeof c[0] === "number") { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; } else for (const k of c) walk(k); };
		for (const g of gs) walk(g.coordinates);
		return x0 <= x1 ? [x0, y0, x1, y1] : null;
	};
	// 寄るズーム＝形のある物はその範囲・点の物は分類ごと（山＝z11・滝や峠＝z13・海や山地＝z6…）
	const ZOOM_OF = { sea: 5.5, bay: 8, strait: 9, reef: 9, island: 9, islands: 7, peninsula: 8, cape: 11, beach: 11, dune: 12, range: 7, peak: 11, volcano: 10.5, pass: 12, plateau: 9, hills: 9, plain: 8, basin: 8.5, trench: 5.5, ridge: 5, seamount: 7, cave: 13, river: 8, lake: 10, waterfall: 13, wetland: 10, current: 5, plate: 4.5, fault: 7 };
	async function select(qid, { fly = true } = {}) {
		const d = byQ.get(qid) || null; sel = d?.qid ?? null;
		const f = ["==", ["get", "qid"], sel ?? ""];
		map.setFilter("tr-sel-line", ["all", f, ["!=", ["geometry-type"], "Polygon"], ["!=", ["get", "shape"], "axis"]]); map.setFilter("tr-sel-pt", ["all", f, ["!", ["has", "label"]]]);
		drawAnno();
		const u = new URL(location.href); sel ? u.searchParams.set("q", sel) : u.searchParams.delete("q"); history.replaceState(null, "", u);
		closeWiki(); renderDetail(); list.mark(); chart.mark();
		if (!d || !fly) return;
		const bb = bboxOf(qid), [lon, lat] = d.coord;
		if (bb && (bb[2] - bb[0] > 0.05 || bb[3] - bb[1] > 0.05)) {
			const z = Math.max(4, Math.min(12, map.fitZoomForBbox(bb) - 0.3));
			await map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, z);
		} else await map.flyTo(lon, lat, ZOOM_OF[d.category] ?? 9);
	}

	// ── 地図の操作（ホバー＝名前と主な量・クリック＝選択）──
	const tip = map.gadget.tip();
	const HIT = ["tr-poi", "tr-range-label", "tr-area-label", "tr-line-label", "tr-river", "tr-fault", "tr-band", "tr-current", "tr-lake"];
	const keyMetrics = d => Object.keys(METRICS).filter(k => valueOf(d, k) != null).slice(0, 2);
	const topQid = e => (e.features || []).filter(f => f.properties?.qid).sort((a, b) => HIT.indexOf(a.layer?.id) - HIT.indexOf(b.layer?.id))[0]?.properties.qid;
	map.on("mousemove", HIT, e => { const d = byQ.get(topQid(e));
		tip(d ? [`<b>${esc(nameOf(d))}</b>　${esc(catName(d.category))}`, ...keyMetrics(d).map(k => `${esc(metricName(k))}: ${esc(fmtVal(valueOf(d, k), k))}`)] : null); });
	map.on("mouseleave", HIT, () => tip(null));
	map.on("click", HIT, e => { const q = topQid(e); if (q) select(q, { fly: false }); });

	// ── 案内板（右上）：詳細カード＋タブ（表示・一覧・比較）──
	const panel = document.createElement("div");
	panel.className = "tr-panel";
	panel.innerHTML = `<style>${CSS}</style>
		<div class="head"><h1>${esc(t("Landforms of Japan"))}</h1><select class="lang" aria-label="Language">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select><button class="fold" type="button" aria-label="${esc(t("Fold"))}">–</button></div>
		<div class="body">
			<div class="detail" hidden></div>
			<div class="tabs" role="tablist">
				<button type="button" data-tab="layers" class="on">${esc(t("Layers"))}</button>
				<button type="button" data-tab="rank">${esc(t("Ranking"))}</button>
				<button type="button" data-tab="compare">${esc(t("Compare"))}</button>
			</div>
			<div class="pane" data-pane="layers">
				${GROUPS.map(g => `<label class="grp"><input type="checkbox" data-g="${g.id}" checked><span class="sw" style="background:${g.color}"></span>${esc(groupName(g.id))}<small>${items.filter(d => g.cats.includes(d.category)).length}</small></label>`).join("")}
				<h2>${esc(t("Overlays"))}</h2>
				<label class="grp"><input type="checkbox" data-ov="currents"><span class="sw ln" style="background:linear-gradient(90deg,#d4553a 50%,#2f78c4 50%)"></span>${esc(t("Ocean currents"))}<small>${items.filter(d => d.category === "current").length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="plates"><span class="sw ln" style="background:linear-gradient(90deg,#e0a020 33%,#b04a9c 33% 66%,#5a6472 66%)"></span>${esc(t("Plate boundaries & faults"))}</label>
				<div class="leg" data-leg="plates" hidden>${PLATE_KINDS.map(k => `<span><i style="background:${k.color}"></i>${esc(plateKindName(k.id))}</span>`).join("")}<span><i style="background:#b04a9c;height:2px;border-top:2px dashed #b04a9c;background:none"></i>${esc(t("Tectonic lines (faults)"))}</span></div>
				<p class="note">${esc(t("Symbol size and line width follow height and length. Names appear as you zoom in, larger features first."))}</p>
				<p class="src">${esc(t("Data: Wikidata (CC0), GSI vector tiles, MLIT National Land Numerical Information (rivers, lakes)"))}</p>
			</div>
			<div class="pane" data-pane="rank" hidden>
				<div class="ctl"><select class="cat"></select><select class="met"></select></div>
				<input class="find" type="search" placeholder="${esc(t("Search by name"))}">
				<ol class="list"></ol>
			</div>
			<div class="pane" data-pane="compare" hidden>
				<div class="ctl"><select class="preset">${PRESETS.map(p => `<option value="${p.id}">${esc(presetName(p.id))}</option>`).join("")}</select></div>
				<p class="note">${esc(t("Hover a bar for its value; click to go there."))}</p>
			</div>
		</div>`;
	mapEl.appendChild(panel);
	const $ = s => panel.querySelector(s);
	$(".lang").onchange = e => { const u = new URL(location.href); u.searchParams.set("lang", e.target.value); location.assign(u); };   // 言語＝読み直す（視点と選択は URL に残る）
	$(".fold").onclick = () => { panel.classList.toggle("min"); $(".fold").textContent = panel.classList.contains("min") ? "+" : "–"; };
	panel.querySelectorAll("input[data-g]").forEach(inp => inp.onchange = () => { inp.checked ? shown.add(inp.dataset.g) : shown.delete(inp.dataset.g); applyGroups(); });
	panel.querySelectorAll("input[data-ov]").forEach(inp => inp.onchange = () => overlay(inp.dataset.ov, inp.checked));

	// ── 重ね（プレート境界＝world の PB2002・初めて点けた時に読む）──
	let platesP = null;
	async function overlay(id, on) {
		const leg = panel.querySelector(`[data-leg="${id}"]`); if (leg) leg.hidden = !on;
		if (id === "currents") { on ? shown.add("current") : shown.delete("current"); return applyGroups(); }
		on ? shown.add("plate") : shown.delete("plate"); applyGroups();   // 構造線とプレートの名前は境界の重ねと一緒に
		platesP ??= (async () => {
			const p = await loadPbf(geopbf, WORLD_GIS + "plates.geopbf"), feats = [];
			for (let i = 0, n = p.fmap?.length ?? 0; i < n; i++) { const f = p.getFeature(i); if (!f?.geometry) continue; const pr = f.properties || p.getProperties(i) || {};
				if (pr.kind !== "boundary") continue;
				feats.push({ type: "Feature", geometry: f.geometry, properties: { cls: PLATE_KIND_OF[pr.class] || "other" } }); }
			map.addSource("tr-plates", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
			await map.addLayer({ id: "tr-plates", type: "line", source: "tr-plates", paint: { "line-color": ["match", ["get", "cls"], ...PLATE_KINDS.flatMap(k => [k.id, k.color]), "#5a6472"], "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.4, 8, 3], "line-opacity": 0.85 } }, "tr-sel-line");
		})().catch(e => console.warn("[terrain] plates", e));
		await platesP;
		map.setLayoutProperty("tr-plates", "visibility", panel.querySelector(`input[data-ov="plates"]`).checked ? "visible" : "none");
	}

	let tab = "layers";
	panel.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
		tab = b.dataset.tab;
		panel.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
		panel.querySelectorAll(".pane").forEach(p => p.hidden = p.dataset.pane !== tab);
		chart.show(tab === "compare");
		if (tab === "rank") list.render();
	});
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());

	// Wikipedia＝アプリ内の iframe（physical と同じ作法）。COEP credentialless の頁＝<iframe credentialless>（Chrome/Edge）で免除・非対応のブラウザは別タブ
	const CAN_FRAME = "credentialless" in HTMLIFrameElement.prototype;
	const wiki = document.createElement("div");
	wiki.className = "tr-wiki"; wiki.hidden = true;
	wiki.innerHTML = `<div class="bar"><b class="tt"></b><a class="nt" target="_blank" rel="noopener" aria-label="${esc(t("Open in a new tab"))}" title="${esc(t("Open in a new tab"))}">↗</a><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div><iframe title="Wikipedia" credentialless referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`;
	mapEl.appendChild(wiki);
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) wiki.addEventListener(ev, e => e.stopPropagation());
	const closeWiki = () => { if (wiki.hidden) return; wiki.hidden = true; wiki.querySelector("iframe").removeAttribute("src"); };
	function showWiki(url, name) {
		wiki.querySelector(".tt").textContent = name || ""; wiki.querySelector(".nt").href = url;
		wiki.querySelector("iframe").src = url.replace(/^https:\/\/([a-z-]+)\.wikipedia\.org/, "https://$1.m.wikipedia.org");
		wiki.hidden = false;
	}
	wiki.querySelector(".x").onclick = closeWiki;
	addEventListener("keydown", e => { if (e.key === "Escape") closeWiki(); });

	// 詳細カード
	function renderDetail() {
		const el = $(".detail"), d = sel && byQ.get(sel);
		if (!d) { el.hidden = true; el.innerHTML = ""; return; }
		const rows = Object.keys(METRICS).map(k => [k, valueOf(d, k)]).filter(([, v]) => v != null)
			.map(([k, v]) => `<div class="m"><span>${esc(metricName(k))}</span><b>${esc(fmtVal(v, k))}</b>${rankNote(d, k)}</div>`).join("");
		const w = wikiUrl(d), g = ALL_GROUPS.find(x => x.id === (GROUP_OF[d.category] || "coast"));
		const alt = [lang !== "ja" ? d.name.ja : null, lang !== "en" && d.name.en && d.name.en !== nameOf(d) ? d.name.en : null].filter(Boolean).filter(s => s !== nameOf(d));
		el.hidden = false;
		el.innerHTML = `<div class="dh"><span class="sw" style="background:${g.color}"></span><div><b class="nm">${esc(nameOf(d))}</b><small>${esc(catName(d.category))}${alt.length ? " · " + esc(alt.join(" · ")) : ""}</small></div><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>
			${rows || `<p class="note">${esc(t("No measurements recorded for this feature."))}</p>`}
			<div class="dl"><span>${d.coord[1].toFixed(3)}°, ${d.coord[0].toFixed(3)}°</span>${w ? `<a class="wk" href="${esc(w)}" target="_blank" rel="noopener">Wikipedia</a>` : ""}</div>`;
		el.querySelector(".x").onclick = () => select(null);
		const wk = el.querySelector(".wk"); if (wk) wk.onclick = e => { if (!CAN_FRAME || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); showWiki(w, nameOf(d)); };
	}
	function rankNote(d, k) {   // 同じ分類の中で何番目か（例：日本で 3 番目に高い）
		const peers = items.filter(x => x.category === d.category && valueOf(x, k) != null);
		if (peers.length < 3) return "";
		const r = 1 + peers.filter(x => valueOf(x, k) > valueOf(d, k)).length;
		return `<small>${esc(t("#$1 of $2", r, peers.length))}</small>`;
	}

	// ── 一覧（分類 × 量で並べ替え・名前で検索）＝地図の表の顔 ──
	const catSel = $(".cat"), metSel = $(".met"), find = $(".find"), ol = $(".list");
	const CAT_ORDER = ALL_GROUPS.flatMap(g => g.cats).filter(c => items.some(d => d.category === c));
	catSel.innerHTML = CAT_ORDER.map(c => `<option value="${c}">${esc(catName(c))} (${items.filter(d => d.category === c).length})</option>`).join("");
	catSel.value = "peak";
	const MAIN_METRIC = { lake: "area", river: "length", waterfall: "height", island: "area", islands: "area", sea: "area", bay: "area", strait: "length", peninsula: "area", trench: "depth", plateau: "elevation", basin: "area", plain: "area", wetland: "area", reef: "area", hills: "elevation", dune: "area", beach: "length" };
	const metricsFor = c => Object.keys(METRICS).filter(k => items.some(d => d.category === c && valueOf(d, k) != null));
	const fillMetrics = () => { const ms = metricsFor(catSel.value); metSel.innerHTML = ms.map(k => `<option value="${k}">${esc(metricName(k))}</option>`).join("") + `<option value="">${esc(t("Name"))}</option>`; metSel.value = ms.includes(MAIN_METRIC[catSel.value]) ? MAIN_METRIC[catSel.value] : ms[0] ?? ""; };
	fillMetrics();
	const list = {
		render() {
			const c = catSel.value, k = metSel.value, q = find.value.trim().toLowerCase();
			let rows = q ? items.filter(d => nameOf(d).toLowerCase().includes(q) || d.name.ja.includes(q) || (d.name.en || "").toLowerCase().includes(q) || (d.kana || "").toLowerCase().includes(q)) : items.filter(d => d.category === c);
			rows = k && !q ? rows.slice().sort((a, b) => (valueOf(b, k) ?? -Infinity) - (valueOf(a, k) ?? -Infinity)) : rows.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), lang));
			if (q) rows = rows.slice(0, 200);
			const max = k ? Math.max(...rows.map(d => valueOf(d, k) ?? 0), 1) : 1;
			ol.innerHTML = rows.map((d, i) => { const v = k ? valueOf(d, k) : null;
				return `<li data-q="${d.qid}"><span class="i">${k && !q && v != null ? i + 1 : ""}</span><span class="n">${esc(nameOf(d))}${q ? `<small>${esc(catName(d.category))}</small>` : ""}</span><span class="v">${v != null ? esc(fmtVal(v, k)) : ""}</span>${v != null ? `<span class="bar" style="width:${(100 * v / max).toFixed(1)}%"></span>` : ""}</li>`; }).join("");
			this.mark();
		},
		mark() { ol.querySelectorAll("li").forEach(li => li.classList.toggle("on", li.dataset.q === sel)); },
	};
	catSel.onchange = () => { fillMetrics(); find.value = ""; list.render(); };
	metSel.onchange = () => list.render();
	find.oninput = () => list.render();
	ol.onclick = e => { const li = e.target.closest("li"); if (li) select(li.dataset.q); };
	ol.onmouseover = e => { const li = e.target.closest("li"); map.setFilter("tr-sel-pt", ["match", ["get", "qid"], [sel ?? "", li?.dataset.q ?? ""], true, false]); };

	// ── 比較図（下の帯）──
	const chart = makeChart({ mapEl, items, byQ, nameOf, getSel: () => sel, onPick: q => select(q) });
	$(".preset").onchange = e => chart.draw(PRESETS.find(p => p.id === e.target.value));
	chart.draw(PRESETS[0]);

	// 共有 URL（?q=QID）の選択を復元
	const q0 = new URLSearchParams(location.search).get("q");
	if (q0 && byQ.has(q0)) select(q0, { fly: !location.hash });

	return { select, items, byQ, shapes, points, get sel() { return sel; }, chart, list };
}

// ── 比較図：高さ比べ（山＝三角の影絵）と長さ・広さ比べ（横棒・2 量は並べた 2 枚）＝physical.js と同じ ──
function makeChart({ mapEl, items, byQ, nameOf, getSel, onPick }) {
	const el = document.createElement("div");
	el.className = "tr-chart"; el.hidden = true;
	el.innerHTML = `<div class="ch"><b class="tt"></b><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div><div class="cv"></div><div class="ctip" hidden></div>`;
	mapEl.appendChild(el);
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) el.addEventListener(ev, e => e.stopPropagation());
	const cv = el.querySelector(".cv"), ctip = el.querySelector(".ctip");
	let preset = null;
	el.querySelector(".x").onclick = () => { el.hidden = true; };
	const N = 20;
	const pick = p => items.filter(d => p.cats.includes(d.category) && valueOf(d, p.metrics[0]) != null)
		.sort((a, b) => valueOf(b, p.metrics[0]) - valueOf(a, p.metrics[0])).slice(0, N);
	const nice = v => { const e = 10 ** Math.floor(Math.log10(v)), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };
	function mountains(rows, W, H) {
		const k = rows[0] ? valueOf(rows[0], "elevation") : 1, top = 22, bot = 40, h = H - top - bot;
		const step = W / rows.length, grid = nice(k / 4), lines = [], ticks = [];
		for (let v = grid; v <= k; v += grid) { const y = top + h * (1 - v / k); lines.push(`<line x1="0" x2="${W}" y1="${y}" y2="${y}" class="gl"/>`); ticks.push(`<text x="${W - 2}" y="${y - 3}" class="ax" text-anchor="end">${fmtVal(v, "elevation")}</text>`); }
		const peaks = rows.map((d, i) => { const v = valueOf(d, "elevation"), x = step * (i + 0.5), y = top + h * (1 - v / k), hw = Math.max(6, step * 0.62);
			return `<g class="mk" data-q="${d.qid}"><path d="M${x - hw} ${top + h}L${x} ${y}L${x + hw} ${top + h}Z" class="${d.category === "volcano" ? "vol" : "mtn"}"/>
				<text x="${x}" y="${y - 4}" class="val">${fmtNum2(v)}</text>
				<text x="${x}" y="${top + h + 13 + (i % 2) * 13}" class="lb">${esc(fit(nameOf(d), step * 1.9))}</text>
				<rect x="${x - step / 2}" y="${top}" width="${step}" height="${h + bot}" class="hit"/></g>`; }).join("");
		return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${lines.join("")}<line x1="0" x2="${W}" y1="${top + h}" y2="${top + h}" class="base"/>${peaks}${ticks.join("")}</svg>`;
	}
	function bars(rows, metrics, W) {
		const nameW = Math.min(150, W * 0.3), rowH = 18, colW = (W - nameW - 8) / metrics.length, H = rows.length * rowH + 22;
		const max = metrics.map(k => Math.max(...rows.map(d => valueOf(d, k) ?? 0), 1));
		const head = metrics.map((k, j) => `<text x="${nameW + 8 + j * colW}" y="12" class="mh">${esc(metricName(k))}</text>`).join("");
		const body = rows.map((d, i) => { const y = 20 + i * rowH;
			return `<g class="mk" data-q="${d.qid}"><text x="${nameW}" y="${y + 12}" class="nm">${esc(short(nameOf(d), 22))}</text>` +
				metrics.map((k, j) => { const v = valueOf(d, k), x0 = nameW + 8 + j * colW, bw = v == null ? 0 : Math.max(2, (colW - 104) * v / max[j]);
					return v == null ? `<text x="${x0}" y="${y + 12}" class="na">–</text>` : `<rect x="${x0}" y="${y + 4}" width="${bw}" height="10" rx="3" class="bar b${j}"/><text x="${x0 + bw + 4}" y="${y + 12}" class="val2">${esc(fmtVal(v, k))}</text>`; }).join("") +
				`<rect x="0" y="${y}" width="${W}" height="${rowH}" class="hit"/></g>`; }).join("");
		return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${head}${body}</svg>`;
	}
	function draw(p) {
		if (p) preset = p; if (!preset) return;
		const rows = pick(preset), W = Math.max(280, cv.clientWidth || el.clientWidth - 24);
		el.querySelector(".tt").textContent = t("$1 — top $2", presetName(preset.id), rows.length);
		cv.innerHTML = preset.shape === "mountain" ? mountains(rows, W, Math.max(180, (cv.clientHeight || 220))) : bars(rows, preset.metrics, W);
		cv.classList.toggle("scroll", preset.shape !== "mountain");
		mark();
	}
	function mark() { const s = getSel(); cv.querySelectorAll(".mk").forEach(g => g.classList.toggle("on", g.dataset.q === s)); }
	cv.addEventListener("click", e => { const g = e.target.closest(".mk"); if (g) onPick(g.dataset.q); });
	cv.addEventListener("pointermove", e => {
		const g = e.target.closest(".mk"), d = g && byQ.get(g.dataset.q);
		if (!d) { ctip.hidden = true; return; }
		const ms = (preset.metrics).filter(k => valueOf(d, k) != null);
		ctip.innerHTML = `<b>${esc(nameOf(d))}</b>${ms.map(k => `<div>${esc(metricName(k))}: ${esc(fmtVal(valueOf(d, k), k))}</div>`).join("")}`;
		const r = el.getBoundingClientRect(); ctip.hidden = false;
		ctip.style.left = Math.min(r.width - 180, e.clientX - r.left + 12) + "px"; ctip.style.top = Math.max(4, e.clientY - r.top - 40) + "px";
	});
	cv.addEventListener("pointerleave", () => ctip.hidden = true);
	addEventListener("resize", () => { if (!el.hidden) draw(); });
	return { draw, mark, show(on) { el.hidden = !on; if (on) requestAnimationFrame(() => draw()); } };
}
const fmtNum2 = v => v.toLocaleString(getLang(), { maximumFractionDigits: 0 });
const measure = (() => { let cx; return s => (cx ||= document.createElement("canvas").getContext("2d"), cx.font = "10px system-ui, sans-serif", cx.measureText(s).width); })();
const fit = (s, w) => { if (measure(s) <= w) return s; const a = [...s]; while (a.length > 1 && measure(a.join("") + "…") > w) a.pop(); return a.join("") + "…"; };
const short = (s, n = 12) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── 意匠（quiet-mono のトークン＝#map の変数を使う＝physical と同じ）──
const CSS = `
.tr-panel{position:absolute;top:12px;right:12px;z-index:30;width:320px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;box-sizing:border-box;
	padding:12px 14px;border-radius:var(--qm-r-l);background:var(--qm-panel-solid);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);
	backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur));color:var(--qm-text);font:13px/1.45 var(--qm-font)}
.tr-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tr-panel h1{flex:1;min-width:0;font-size:15px;margin:0;font-weight:700;color:var(--qm-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tr-panel .head .lang{flex:none;max-width:120px;font-size:12px;padding:3px 4px}
.tr-panel .fold,.tr-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.tr-panel.min .body{display:none}
.tr-panel .tabs{display:flex;gap:4px;margin:10px 0 8px;border-bottom:1px solid var(--qm-border-soft)}
.tr-panel .tabs button{flex:1;border:0;background:none;padding:6px 4px;font:inherit;color:var(--qm-text-dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tr-panel .tabs button.on{color:var(--qm-ink);font-weight:700;border-bottom-color:var(--qm-ink)}
.tr-panel .grp{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer}
.tr-panel h2{font-size:12px;margin:12px 0 2px;color:var(--qm-text-dim);font-weight:600}
.tr-panel .sw.ln{height:4px;border-radius:2px}
.tr-panel .leg{display:flex;flex-direction:column;gap:2px;margin:0 0 4px 34px;font-size:11.5px;color:var(--qm-text-dim)}
.tr-panel .leg[hidden]{display:none}
.tr-panel .leg i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.tr-panel .grp small{margin-left:auto;color:var(--qm-text-faint)}
.tr-panel .sw{flex:none;width:12px;height:12px;border-radius:3px}
.tr-panel .note{color:var(--qm-text-dim);font-size:12px;margin:8px 0 0}
.tr-panel .src{color:var(--qm-text-faint);font-size:11px;margin:6px 0 0}
.tr-panel .ctl{display:flex;gap:6px}
.tr-panel select,.tr-panel .find{flex:1;min-width:0;font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#fff;color:var(--qm-text);padding:5px 6px}
.tr-panel .find{display:block;width:100%;box-sizing:border-box;margin-top:6px}
.tr-panel .list{list-style:none;margin:6px 0 0;padding:0;max-height:46vh;overflow:auto}
.tr-panel .list li{position:relative;display:flex;gap:6px;align-items:baseline;padding:4px 4px 6px;border-radius:6px;cursor:pointer}
.tr-panel .list li:hover{background:rgba(43,59,87,.06)}
.tr-panel .list li.on{background:rgba(215,38,61,.08)}
.tr-panel .list .i{flex:none;width:22px;text-align:right;color:var(--qm-text-faint);font-variant-numeric:tabular-nums}
.tr-panel .list .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tr-panel .list .n small{margin-left:6px;color:var(--qm-text-faint)}
.tr-panel .list .v{flex:none;color:var(--qm-num);font-variant-numeric:tabular-nums;font-size:12px}
.tr-panel .list .bar{position:absolute;left:32px;bottom:2px;height:2px;border-radius:2px;background:var(--qm-border-strong);opacity:.5;max-width:calc(100% - 36px)}
.tr-panel .detail{margin:10px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:rgba(43,59,87,.04);border:1px solid var(--qm-border-soft)}
.tr-panel .dh{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
.tr-panel .dh .sw{margin-top:4px}
.tr-panel .dh > div{flex:1;min-width:0}
.tr-panel .dh .nm{display:block;font-size:15px;color:var(--qm-ink)}
.tr-panel .dh small{color:var(--qm-text-dim)}
.tr-panel .m{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.tr-panel .m span{color:var(--qm-text-dim);min-width:92px}
.tr-panel .m b{color:var(--qm-ink);font-variant-numeric:tabular-nums}
.tr-panel .m small{margin-left:auto;color:var(--qm-text-faint)}
.tr-panel .dl{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--qm-text-faint)}
.tr-panel .dl a{color:var(--qm-ink)}
.tr-wiki{position:absolute;left:12px;top:12px;bottom:calc(40px + var(--qm-safe-b));z-index:31;width:min(560px,calc(100% - 356px));display:flex;flex-direction:column;overflow:hidden;
	border-radius:var(--qm-r-l);background:#fff;border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);color:var(--qm-text);font:13px/1.4 var(--qm-font)}
.tr-wiki[hidden]{display:none}
.tr-wiki .bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--qm-border-soft)}
.tr-wiki .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--qm-ink)}
.tr-wiki .nt,.tr-wiki .x{flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer;text-decoration:none}
.tr-wiki iframe{flex:1;min-height:0;width:100%;border:0;background:#fff}
.tr-chart{position:absolute;left:12px;right:344px;bottom:calc(40px + var(--qm-safe-b));z-index:29;height:300px;box-sizing:border-box;padding:8px 12px 10px;display:flex;flex-direction:column;
	border-radius:var(--qm-r-l);background:var(--qm-panel-solid);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);color:var(--qm-text);font:12px/1.4 var(--qm-font)}
.tr-chart[hidden]{display:none}
.tr-chart .ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.tr-chart .ch b{color:var(--qm-ink);font-size:13px}
.tr-chart .x{width:24px;height:24px;border-radius:6px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);cursor:pointer}
.tr-chart .cv{flex:1;min-height:0;overflow:hidden}
.tr-chart .cv.scroll{overflow:auto}
.tr-chart svg{display:block;font:11px var(--qm-font)}
.tr-chart .gl{stroke:rgba(90,100,120,.16);stroke-width:1}
.tr-chart .base{stroke:var(--qm-text-dim);stroke-width:1}
.tr-chart .ax{fill:var(--qm-text-dim);font-size:10px;paint-order:stroke;stroke:#fff;stroke-width:3px}
.tr-chart .mtn{fill:#8f4a14;fill-opacity:.78;stroke:#fff;stroke-width:1}
.tr-chart .vol{fill:#c2410c;fill-opacity:.78;stroke:#fff;stroke-width:1}
.tr-chart .val{fill:var(--qm-num);font-size:9.5px;text-anchor:middle;font-variant-numeric:tabular-nums}
.tr-chart .lb{fill:var(--qm-text);font-size:10px;text-anchor:middle}
.tr-chart .mh{fill:var(--qm-text-dim);font-weight:600}
.tr-chart .nm{fill:var(--qm-text);text-anchor:end}
.tr-chart .na{fill:var(--qm-text-faint)}
.tr-chart .bar{fill:#2f78c4;fill-opacity:.85}
.tr-chart .bar.b1{fill:#5a6472;fill-opacity:.7}
.tr-chart .val2{fill:var(--qm-num);font-size:10.5px;font-variant-numeric:tabular-nums}
.tr-chart .hit{fill:transparent;cursor:pointer}
.tr-chart .mk:hover .mtn,.tr-chart .mk:hover .vol,.tr-chart .mk:hover .bar{fill-opacity:1}
.tr-chart .mk.on .mtn,.tr-chart .mk.on .vol,.tr-chart .mk.on .bar{stroke:#d7263d;stroke-width:2;fill-opacity:1}
.tr-chart .mk.on .nm,.tr-chart .mk.on .lb{fill:#d7263d;font-weight:700}
.tr-chart .ctip{position:absolute;pointer-events:none;min-width:120px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.97);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-card);font-size:12px}
.tr-chart .ctip[hidden]{display:none}
@media (max-width:720px){
	.tr-wiki{left:8px;right:8px;top:8px;width:auto}
	.tr-panel{left:12px;right:12px;width:auto;max-height:44vh}
	.tr-chart{left:8px;right:8px;height:240px}
}`;
