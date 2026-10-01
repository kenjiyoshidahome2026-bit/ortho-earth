// 世界の地形（山・川・湖・海・砂漠…約 1,000 件）を地球儀（@ortho-earth/globe）に（physical.html から遅延 import）。
//
// データ（packages/world の生成物＝本番は bucket GIS/world/・dev は手元の out/）
//   TerrainDB.json        … qid ごとの分類・代表点・物理量（標高・長さ・面積・深さ・流量・流域面積・落差・プロミネンス・体積）
//   i18n/<lang>.json      … terrains[qid] の名前と Wikipedia 記事名（英語は TerrainDB の name.en）
//   ne-physical.geopbf    … 形状台帳（面・線・点・山脈の軸線＝qid で TerrainDB と結ぶ）
// 描き方＝エンジンの MapLibre 互換の口（addSource／addLayer）だけ：面＝fill・川と山脈の軸と海流＝line・名前と記号＝symbol（川と海流は線に沿わせる）。
//
// 表現の決め事
//   色   … 系統ごとに 1 色（起伏＝茶・水と海＝青・乾燥と氷＝黄土・プレートと海溝＝赤紫・陸＝インクの灰）。
//          色覚の型を問わず全組で見分けられる 4 色（dataviz の検査器 --pairs all で通過・2026-10-01）＝系統を増やす時は検査し直す
//   量   … 山の記号＝標高・川の太さ＝長さ・山脈の帯の幅＝実寸（km）。数値は名前の下に添える（山・火山・滝）
//   出し … NE の scalerank（rank）で名前の出しズームを決める＝大きな物ほど遠くから
//   選択 … 地図・一覧・比較図のどこで選んでも同じ（赤の縁取り＋詳細カード＋そこへ飛ぶ）。?q=QID で共有できる
import { tr, setLang, getLang, loadPage, LANGUAGES } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { WORLD_GIS, fetchJsonMaybeGz } from "@ortho-earth/core/worldcontent";
import { gunzip, isGzip } from "geopbf/gzip";
import { categories as CATEGORY_NAMES } from "world-data/i18n/ui.json";   // 分類名（Wikidata のクラスのラベル・26 言語）
const t = tr();

// ── 系統（凡例と表示の切り替えの単位）──────────────────────────────────────────
const GROUPS = [
	{ id: "relief", color: "#8f4a14", ink: "#6e3810", cats: ["range", "peak", "volcano", "pass", "plateau", "plain", "basin", "valley", "shield", "region", "trench", "ridge"] },   // 海溝・海嶺も起伏（本人 2026-10-01）
	{ id: "water", color: "#2f78c4", ink: "#1f5ea4", cats: ["river", "lake", "waterfall", "delta", "wetland", "canal"] },
	{ id: "sea", color: "#2f78c4", ink: "#23609c", cats: ["ocean", "sea", "bay", "strait", "reef"] },
	{ id: "dry", color: "#e0a020", ink: "#8a6410", cats: ["desert", "saltflat", "ice", "pole"] },
	{ id: "land", color: "#5a6472", ink: "#4a5058", cats: ["continent", "island", "islands", "peninsula", "cape", "isthmus"] },
];
// 「重ねる」で出す系統（上の一覧には無い）＝プレート（境界の重ねと一緒に名前）・海流（矢印）。本人 2026-10-01「海流は重ねに・プレートは重ねのみ」
const OVERLAY_GROUPS = [{ id: "plate", color: "#b04a9c", ink: "#8e3a7e", cats: ["plate"] }, { id: "current", color: "#d4553a", ink: "#a8402a", cats: ["current"] }];
const ALL_GROUPS = [...GROUPS, ...OVERLAY_GROUPS];
const groupName = id => ({ relief: t("Mountains & relief"), water: t("Rivers & lakes"), sea: t("Seas & oceans"), dry: t("Deserts & ice"), land: t("Continents & islands") })[id];
const GROUP_OF = Object.fromEntries(ALL_GROUPS.flatMap(g => g.cats.map(c => [c, g.id])));
const SEL = "#d7263d";   // 選択の縁取り（どの系統の色とも違う赤）

// プレート境界（PB2002 の 7 種別）→ 動きの 3 系統（広がる・近づく・すれ違う）
// ケッペン気候区分の大区分（30 区分は属性に残し、塗りは大区分＝Kenji 2026-09-15）。色は従来の地図帳の系統（熱帯＝青・乾燥＝赤橙・温帯＝緑・亜寒帯＝紫・寒帯＝灰青）を淡く
const KOPPEN_GROUPS = [{ id: "A", color: "#1e60c8" }, { id: "B", color: "#de6028" }, { id: "C", color: "#4ca83c" }, { id: "D", color: "#8c48b0" }, { id: "E", color: "#8cb8ce" }];
const koppenGroupName = id => ({ A: t("Tropical (A)"), B: t("Arid (B)"), C: t("Temperate (C)"), D: t("Continental (D)"), E: t("Polar (E)") })[id];
const PLATE_KINDS = [{ id: "divergent", color: "#e0a020" }, { id: "convergent", color: "#b04a9c" }, { id: "transform", color: "#5a6472" }];
const PLATE_KIND_OF = { OSR: "divergent", CRB: "divergent", SUB: "convergent", OCB: "convergent", CCB: "convergent", OTF: "transform", CTF: "transform" };
const plateKindName = id => ({ divergent: t("Spreading (ridges, rifts)"), convergent: t("Converging (subduction, collision)"), transform: t("Sliding (transform faults)") })[id];

// ── 物理量 ─────────────────────────────────────────────────────────────────
const METRICS = {
	elevation: { unit: "m" }, prominence: { unit: "m" }, height: { unit: "m" }, depth: { unit: "m" },
	length: { unit: "km" }, area: { unit: "km²" }, basin: { unit: "km²" }, volume: { unit: "km³" }, discharge: { unit: "m³/s" },
};
const metricName = k => ({ elevation: t("Elevation"), prominence: t("Prominence"), height: t("Height"), depth: t("Depth"), length: t("Length"),
	area: t("Area"), basin: t("Drainage basin"), volume: t("Volume"), discharge: t("Discharge") })[k];
// 海溝・海盆は標高が負（最深部）＝深さとして読む
const valueOf = (d, k) => k === "depth" ? (d.depth ?? (d.elevation < 0 ? -d.elevation : null)) : d[k] ?? null;
const fmtNum = v => v == null ? "" : v.toLocaleString(getLang(), { maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0 });
const fmtVal = (v, k) => v == null ? "–" : `${fmtNum(v)} ${METRICS[k].unit}`;

// 比較図の題目（分類 × 量。2 量は同じ行で並べた小さな 2 枚＝軸を共有しない）
const PRESETS = [
	{ id: "peaks", cats: ["peak", "volcano"], metrics: ["elevation", "prominence"], shape: "mountain" },
	{ id: "rivers", cats: ["river"], metrics: ["length", "discharge"] },
	{ id: "lakes", cats: ["lake"], metrics: ["area", "depth"] },
	{ id: "waterfalls", cats: ["waterfall"], metrics: ["height"] },
	{ id: "islands", cats: ["island"], metrics: ["area", "elevation"] },
	{ id: "deserts", cats: ["desert"], metrics: ["area"] },
	{ id: "seas", cats: ["sea", "ocean"], metrics: ["area", "depth"] },
	{ id: "trenches", cats: ["trench"], metrics: ["depth"] },
];
const presetName = id => ({ peaks: t("Highest mountains"), rivers: t("Longest rivers"), lakes: t("Largest lakes"), waterfalls: t("Tallest waterfalls"),
	islands: t("Largest islands"), deserts: t("Largest deserts"), seas: t("Seas and oceans"), trenches: t("Deepest trenches") })[id];

// 山脈の帯：軸線（約 120 km 間隔の 3〜40 点）を Catmull-Rom で滑らかにし、左右へ幅の半分ずつ張り出した面にする。
// 両端の 2 割はすぼめる（地図帳の山脈の形）。距離は点ごとの局所の正距（経度は cos 緯度）で測る＝z≤8 の尺で十分。
// 幅の無い手書きの軸線（ペナイン・コルドバ）は 60 km
function rangeBand(geom, widthKm) {
	const src = geom?.type === "LineString" ? geom.coordinates : null; if (!src || src.length < 2) return null;
	const P = src.map(p => [p[0], p[1]]);
	for (let i = 1; i < P.length; i++) P[i][0] += 360 * Math.round((P[i - 1][0] - P[i][0]) / 360);   // 経度をほどく（日付変更線）
	const S = [P[0]], K = 6;
	for (let i = 0; i + 1 < P.length; i++) {
		const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
		for (let j = 1; j <= K; j++) { const u = j / K, u2 = u * u, u3 = u2 * u;
			S.push([0, 1].map(d => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3))); }
	}
	const KX = lat => 111.32 * Math.cos(lat * Math.PI / 180), KY = 110.57;
	const cum = [0]; for (let i = 1; i < S.length; i++) cum.push(cum[i - 1] + Math.hypot((S[i][0] - S[i - 1][0]) * KX(S[i][1]), (S[i][1] - S[i - 1][1]) * KY));
	const L = cum.at(-1) || 1, half = (widthKm > 0 ? widthKm : 60) / 2, left = [], right = [];
	for (let i = 0; i < S.length; i++) {
		const a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)], kx = KX(S[i][1]);
		let tx = (b[0] - a[0]) * kx, ty = (b[1] - a[1]) * KY; const n = Math.hypot(tx, ty) || 1; tx /= n; ty /= n;
		const t = cum[i] / L, w = half * Math.pow(Math.min(1, t / 0.2, (1 - t) / 0.2), 0.6);   // 端ですぼむ
		left.push([S[i][0] - ty * w / kx, S[i][1] + tx * w / KY]); right.push([S[i][0] + ty * w / kx, S[i][1] - tx * w / KY]);
	}
	// 経度は折り返さない＝ほどいたまま（±180 を越えてよい・anno の投影は周期的）。折り返すと日付変更線をまたぐ帯（アリューシャン・トンガ）が地球を横切る
	const shift = 360 * Math.round(-(P[0][0] + P.at(-1)[0]) / 720);
	// 長い帯は約 2,000 km ごとの塊（隣と断面を共有）に分けた MultiPolygon にする：anno の塗りは見えない点を地平線へ押し付けて結ぶ＝
	// 「一部が見え・一部が視点の真裏（対蹠点）近く」の 1 枚の面は押し付けの向きが暴れて画面を横切る弦の塗りになった（大西洋中央海嶺・
	// 本人 2026-10-01）。塊が短ければその両立は起きない・真裏の塊は描かれない・1 地物の塊は 1 回で塗る＝継ぎ目は出ない
	const pieces = Math.max(1, Math.round(L / 2000)), parts = [];
	for (let k = 0; k < pieces; k++) {
		const a = Math.round(k * (S.length - 1) / pieces), b = Math.round((k + 1) * (S.length - 1) / pieces);
		const ring = [...left.slice(a, b + 1), ...right.slice(a, b + 1).reverse()]; ring.push(ring[0]);
		// 外周は反時計回り（GeoJSON RFC 7946）＝軸線の向きで回りが決まる（西→東・北→南の軸は時計回りになり、穴として読まれて消えた）
		let A = 0; for (let i = 1; i < ring.length; i++) A += (ring[i][0] - ring[i - 1][0]) * (ring[i][1] + ring[i - 1][1]);
		if (A > 0) ring.reverse();
		parts.push([ring.map(p => [+(p[0] + shift).toFixed(4), +p[1].toFixed(4)])]);
	}
	return parts.length === 1 ? { type: "Polygon", coordinates: parts[0] } : { type: "MultiPolygon", coordinates: parts };
}

// 線（LineString / 日付変更線で割れた MultiLineString）を経度をほどいた 1 本の座標列に（継ぎ目の重複点は落とす）
function joinParts(g) {
	const parts = g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : null; if (!parts) return null;
	const out = [];
	for (const part of parts) for (const c of part) {
		const p = out.length ? [c[0] + 360 * Math.round((out.at(-1)[0] - c[0]) / 360), c[1]] : [c[0], c[1]];
		if (out.length && Math.abs(p[0] - out.at(-1)[0]) < 1e-6 && Math.abs(p[1] - out.at(-1)[1]) < 1e-6) continue;
		out.push(p);
	}
	return out.length >= 2 ? out : null;
}

// 形状台帳を読む＝fetch（HTTP キャッシュが ETag で新旧を確かめる）→ 中身を geopbf へ。geopbf(URL) は URL ごとに IDB へ写して以後は版を見ずに使い回す
//（bucket の名前読み＝GIS/pbf だけが版を突き合わせる）＝台帳を作り直しても開いたことのあるブラウザに届かなかった（海溝・海嶺の帯が出ない・本人 2026-10-01）
async function loadPbf(geopbf, url) {
	const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	const b = await r.blob();
	return geopbf(await (await isGzip(b) ? await gunzip(b) : b).arrayBuffer());
}

// ── 単純化（Douglas–Peucker・経度は cos(緯度) で縮めた画面の尺で測る）────────────────
const SIMPLIFY_TOL = 0.004;   // 度（赤道の z8 で約 0.7 画素）
function simplifyPts(P, tol, closed) {
	const n = P.length, min = closed ? 4 : 2; if (n <= min || !(tol > 0)) return P;
	const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
	const t2 = tol * tol, stack = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop(); if (b - a < 2) continue;
		const k = Math.cos(((P[a][1] + P[b][1]) / 2) * Math.PI / 180), ax = P[a][0] * k, ay = P[a][1], dx = P[b][0] * k - ax, dy = P[b][1] - ay, L2 = dx * dx + dy * dy;
		let best = -1, bd = t2;
		for (let i = a + 1; i < b; i++) {
			const px = P[i][0] * k - ax, py = P[i][1] - ay, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
			if (d > bd) { bd = d; best = i; }
		}
		if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
	}
	const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(P[i]);
	return out.length >= min ? out : P;   // 潰れた小さな環（小島）は元のまま
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
const countPts = g => { let n = 0; const w = c => { if (typeof c[0] === "number") n++; else for (const k of c) w(k); }; if (g?.coordinates) w(g.coordinates); return n; };

// 名前の出しズーム（NE scalerank＝小さいほど大きな物。手動追加は rank なし）
const minZoomOf = d => d.category === "continent" || d.category === "ocean" ? 0 : d.category === "ridge" ? 1.8 : d.rank == null ? 3.2 : [1, 1.8, 2.6, 3.4, 4.2, 5, 5.6][Math.min(6, d.rank)];   // 海嶺＝rank なし（手動）だが地球規模＝遠くから
const textSizeOf = d => d.category === "continent" ? 15 : d.category === "ocean" ? 14 : d.rank == null ? 11 : Math.max(10.5, 13.5 - d.rank * 0.6);
const ICON = { peak: "ph-peak", volcano: "ph-volcano", pass: "ph-pass", waterfall: "ph-fall", trench: "ph-trench", cape: "ph-dot", reef: "ph-dot", pole: "ph-dot" };
const LINE_LABEL = new Set(["river", "current", "canal"]);   // 名前を線に沿わせる

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountPhysical(map, { geopbf, data } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/physical/${c}.json`));
	document.title = t("Physical world — ortho-globe");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Mountains, rivers, lakes, seas and deserts of the world on a 3D globe, with their heights, lengths, areas and depths side by side."));
	const lang = getLang(), mapEl = map.mapEl;
	const base = data || (typeof __WORLD_OUT__ !== "undefined" && __WORLD_OUT__) || WORLD_GIS;

	// データ（3 本を並行に）。名前表の失敗は英語で出すだけ（地図は止めない）
	const [db, i18n, pbf] = await Promise.all([
		fetchJsonMaybeGz(base + "TerrainDB.json"),
		lang === "en" ? null : fetchJsonMaybeGz(`${base}i18n/${lang}.json`).catch(e => (console.warn("[physical] i18n", lang, e), null)),
		loadPbf(geopbf, base + "ne-physical.geopbf"),
	]);
	const items = (db.items || db).filter(d => d.coord);
	const byQ = new Map(items.map(d => [d.qid, d]));
	const nameOf = d => i18n?.terrains?.[d.qid]?.name || d.name.en;
	const catName = c => CATEGORY_NAMES[c]?.[lang] || CATEGORY_NAMES[c]?.en || c;
	const wikiUrl = d => { const w = i18n?.terrains?.[d.qid]?.wiki; return w ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(w)}` : d.wiki?.en ? `https://en.wikipedia.org/wiki/${encodeURIComponent(d.wiki.en)}` : null; };

	// 形状台帳 → GeoJSON（TerrainDB の物理量を属性へ結ぶ＝式で太さ・色を引く）
	const shapes = [], geomsOf = new Map(), axisOf = new Map();   // axisOf＝山脈の軸線（名前を沿わせる）
	for (let i = 0, n = pbf.fmap?.length ?? pbf.length ?? 0; i < n; i++) {
		const f = pbf.getFeature(i); const p = f?.properties || pbf.getProperties(i) || {};
		if (!f?.geometry || !p.qid) continue;
		const d = byQ.get(p.qid); if (!d && p.category !== "current") continue;   // 英語記事の無い「絵」（対馬海流）は線だけ描く
		const g = GROUP_OF[p.category] || "land";
		(geomsOf.get(p.qid) || geomsOf.set(p.qid, []).get(p.qid)).push(f.geometry);
		// 山脈＝軸線を実寸の幅の帯（面）にして描く。NE の山脈ポリゴンは粗く重なる＝描かない（寄り先の範囲にだけ使う）
		if (p.category === "range" && p.shape === "polygon") continue;
		// 軸線は 1 本の線に（台帳の書き出しが日付変更線で MultiLineString に割る＝アリューシャン海溝）＝経度をほどいて継ぎ直す
		const axis = p.shape === "axis" ? joinParts(f.geometry) : null;
		if (axis) axisOf.set(p.qid, axis);
		const geometry = axis ? rangeBand({ type: "LineString", coordinates: axis }, p.width) : f.geometry;
		if (!geometry) continue;
		shapes.push({ type: "Feature", geometry, properties: { qid: p.qid, category: p.category, g, shape: p.shape, width: p.width ?? null, flow: p.flow ?? null,
			length: d?.length ?? null, name: d ? nameOf(d) : p["name_" + lang] || p.name } });   // 絵（TerrainDB に無い）は台帳の name_<lang>
	}
	// 単純化（2026-10-01 本人「描画を高速化・気にならない程度に単純化」「z=8 が max というのが味噌」）：
	// この地図は z8 まで＝1 画素≈0.0055°（赤道）。それより細かい頂点は寄っても見えない＝0.7 画素（0.004°）で Douglas–Peucker
	let nBefore = 0, nAfter = 0;
	for (const f of shapes) { nBefore += countPts(f.geometry); f.geometry = simplifyGeom(f.geometry, SIMPLIFY_TOL); nAfter += countPts(f.geometry); }
	console.log(`[physical] 単純化 ${nBefore} → ${nAfter} 頂点（許容 ${SIMPLIFY_TOL}°）`);
	// 線に沿う名前の材料＝川・海流・運河ごとに最も長い 1 区間だけ（NE の川は区間の束＝区間ごとに名前を置くと同じ名が並ぶ）
	const segLen = c => { let L = 0; for (let i = 1; i < c.length; i++) L += Math.hypot((c[i][0] - c[i - 1][0]) * Math.cos(c[i][1] * Math.PI / 180), c[i][1] - c[i - 1][1]); return L; };
	const lineLabels = [];
	for (const f of shapes) {
		if (!LINE_LABEL.has(f.properties.category) || !/LineString$/.test(f.geometry.type)) continue;
		const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
		let best = null, bl = 0; for (const c of parts) { const L = segLen(c); if (L > bl) { bl = L; best = c; } }
		if (best) lineLabels.push({ type: "Feature", geometry: { type: "LineString", coordinates: best }, properties: { ...f.properties, deg: bl } });
	}
	// 山脈の名前＝帯の中心（軸線の長さの中点）に置く（本人 2026-10-01「ポリゴンの中心においた方がわかりやすい」。代表点 P625 は主峰寄りで帯の端に出ることがある）
	const midOf = c => { const half = segLen(c) / 2; let acc = 0;
		for (let i = 1; i < c.length; i++) { const l = segLen([c[i - 1], c[i]]); if (acc + l >= half) { const t = (half - acc) / (l || 1); return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t]; } acc += l; }
		return c[c.length >> 1]; };
	// 名前と記号の点（代表点＝Wikidata の P625 か NE の代表点）。線に沿わせる物（川・海流・運河）はここに入れない
	const valLabel = d => d.category === "waterfall" ? fmtVal(d.height ?? null, "height") : d.elevation != null ? fmtVal(d.elevation, "elevation") : "";
	const points = items.filter(d => !LINE_LABEL.has(d.category) || !geomsOf.has(d.qid)).map(d => ({ type: "Feature", geometry: { type: "Point", coordinates: (d.category === "range" || d.category === "ridge") && axisOf.has(d.qid) ? midOf(axisOf.get(d.qid)) : d.coord },
		properties: { qid: d.qid, category: d.category, g: GROUP_OF[d.category] || "land", name: nameOf(d), elev: d.elevation ?? 0, sub: ICON[d.category] && d.category !== "trench" ? valLabel(d) : d.category === "trench" && valueOf(d, "depth") != null ? "−" + fmtVal(valueOf(d, "depth"), "depth") : "",
			icon: ICON[d.category] || "", mz: minZoomOf(d), size: textSizeOf(d), ...(d.category === "ridge" && axisOf.has(d.qid) ? { label: 1 } : {}),   // 海嶺＝名前は帯の中心（山脈の名前の層）
			sort: (d.rank ?? 4) * 1e5 - (d.category === "range" ? 5000 : d.elevation ?? d.length ?? Math.sqrt(d.area ?? 0)) } }));   // 山脈＝同じ rank の 5,000 m 級の山と同格
	// 海溝（軸線のある物）＝名前は帯の中心（山脈と同じ層）・最深部の ▼ には深さだけを残す（チャレンジャー海淵などの代表点＝P625）
	for (const f of points.slice()) {
		const p = f.properties; if (p.category !== "trench" || !axisOf.has(p.qid)) continue;
		points.push({ type: "Feature", geometry: { type: "Point", coordinates: midOf(axisOf.get(p.qid)) }, properties: { ...p, icon: "", sub: "", label: 1 } });
		p.name = "";
	}

	// ── 記号の画像 ──
	const icon = (draw, s = 22) => { const c = document.createElement("canvas"); c.width = c.height = s; const x = c.getContext("2d"); x.lineJoin = "round"; draw(x, s); return c; };
	const tri = (color, down = false) => (x, s) => { x.beginPath(); if (down) { x.moveTo(3, 5); x.lineTo(s - 3, 5); x.lineTo(s / 2, s - 3); } else { x.moveTo(s / 2, 3); x.lineTo(s - 3, s - 5); x.lineTo(3, s - 5); } x.closePath();
		x.fillStyle = color; x.fill(); x.lineWidth = 2; x.strokeStyle = "rgba(255,255,255,.95)"; x.stroke(); };
	await Promise.all([
		map.addImage("ph-peak", icon(tri("#8f4a14")), { pixelRatio: 2 }),
		map.addImage("ph-volcano", icon((x, s) => { tri("#c2410c")(x, s); x.fillStyle = "#fff"; x.fillRect(s / 2 - 2, 3, 4, 4); }), { pixelRatio: 2 }),
		map.addImage("ph-trench", icon(tri("#b04a9c", true)), { pixelRatio: 2 }),
		map.addImage("ph-pass", icon((x, s) => { x.lineWidth = 2.6; x.strokeStyle = "#8f4a14"; x.beginPath(); x.arc(2, s / 2, 8, -0.9, 0.9); x.stroke(); x.beginPath(); x.arc(s - 2, s / 2, 8, Math.PI - 0.9, Math.PI + 0.9); x.stroke(); }), { pixelRatio: 2 }),
		map.addImage("ph-fall", icon((x, s) => { x.strokeStyle = "#fff"; x.lineWidth = 5; x.beginPath(); for (const dx of [-4, 0, 4]) { x.moveTo(s / 2 + dx, 4); x.lineTo(s / 2 + dx, s - 4); } x.stroke(); x.strokeStyle = "#2f78c4"; x.lineWidth = 2.2; x.stroke(); }), { pixelRatio: 2 }),
		map.addImage("ph-dot", icon((x, s) => { x.beginPath(); x.arc(s / 2, s / 2, 4, 0, Math.PI * 2); x.fillStyle = "#4a5058"; x.fill(); x.lineWidth = 2; x.strokeStyle = "#fff"; x.stroke(); }), { pixelRatio: 2 }),
	]);

	// ── 層 ──
	const colorBy = key => ["match", ["get", "g"], ...ALL_GROUPS.flatMap(g => [g.id, g[key]]), "#5a6472"];
	const shown = new Set(GROUPS.map(g => g.id));
	const groupFilter = () => ["match", ["get", "g"], [...shown].length ? [...shown] : ["-"], true, false];
	// 面の塗り：乾燥（砂漠・塩原）と氷だけ色を敷く＝他の面（海・高原・島…）は名前だけ（NE の地域面は粗く重なる＝塗ると地図が濁る）
	const FILL_CATS = { desert: "rgba(224,160,32,.16)", saltflat: "rgba(224,160,32,.26)", ice: "rgba(255,255,255,.7)", wetland: "rgba(47,120,196,.12)", delta: "rgba(47,120,196,.10)" };
	// gint に積むのは描く物と当たり判定に使う物だけ（川・運河・海流の線・山脈の帯・乾燥と氷の面）。大陸・湖・海・島…の面は名前だけ＝積まない
	//（寄り先の範囲と選択の縁取り＝anno は shapes から引く）
	const drawnShape = f => /LineString$/.test(f.geometry.type) || f.properties.shape === "axis" || !!FILL_CATS[f.properties.category];
	map.addSource("ph", { type: "geojson", data: { type: "FeatureCollection", features: shapes.filter(drawnShape) } });
	map.addSource("ph-pts", { type: "geojson", data: { type: "FeatureCollection", features: points } });
	map.addSource("ph-lab", { type: "geojson", data: { type: "FeatureCollection", features: lineLabels } });
	const polyF = ["==", ["geometry-type"], "Polygon"];
	// 面（山脈の帯・砂漠・氷…）の「絵」は anno（同一フレームの canvas2D）が描く＝下の drawAnno。gint の塗りは海面高で、
	// 高い地形（チベット・アンデス・南極の氷床）に隠れて消えた（2026-10-01・?noterr=1 で全部出ることを確認）。
	// gint の fill 層は当たり判定（ホバー・クリック）のためだけに残す＝ほぼ透明（0.01）。fill-opacity 0 は問い合わせにも当たらない
	//（MapLibre は不透明度に依らず返る＝互換の差の疑い・2026-10-01）
	const LAYERS = {
		"ph-fill": { type: "fill", source: "ph", filter: ["all", polyF, ["match", ["get", "category"], Object.keys(FILL_CATS), true, false]], paint: { "fill-opacity": 0.01 } },
		"ph-range": { type: "fill", source: "ph", filter: ["==", ["get", "shape"], "axis"], paint: { "fill-opacity": 0.01 } },
		"ph-river": { type: "line", source: "ph", filter: ["all", ["match", ["get", "category"], ["river", "canal"], true, false], ["!=", ["geometry-type"], "Polygon"]],
			layout: { "line-cap": "round", "line-join": "round" },
			paint: { "line-color": "#2f78c4", "line-width": ["interpolate", ["linear"], ["zoom"], 1, ["step", ["coalesce", ["get", "length"], 0], 0.6, 1000, 0.9, 3000, 1.3, 5000, 1.8], 6, ["step", ["coalesce", ["get", "length"], 0], 1.4, 1000, 2, 3000, 2.8, 5000, 3.6]] } },
		"ph-current": { type: "line", source: "ph", filter: ["==", ["get", "category"], "current"],
			paint: { "line-color": "#5a6472", "line-width": 10, "line-opacity": 0.01 } },   // 海流の絵は anno の矢印（drawAnno）＝この層は当たり判定だけ（太めに当てる）
		"ph-sel-line": { type: "line", source: "ph", filter: ["==", ["get", "qid"], ""], layout: { "line-join": "round" }, paint: { "line-color": SEL, "line-width": 2.4 } },   // 線（川・海流）の選択＝面の選択は anno
		"ph-sel-pt": { type: "circle", source: "ph-pts", filter: ["==", ["get", "qid"], ""], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SEL, "circle-stroke-width": 2.4 } },
		// 長い川ほど遠くから（区間の長さ＝度。10° 以上＝z2・5° 以上＝z3・他＝z4）
		"ph-line-label": { type: "symbol", source: "ph-lab", filter: [">=", ["zoom"], ["step", ["get", "deg"], 4.5, 5, 3.4, 10, 2.2]],
			layout: { "symbol-placement": "line-center", "text-field": ["get", "name"], "text-size": 11.5, "text-max-angle": 35, "symbol-sort-key": ["-", 0, ["get", "deg"]] },
			paint: { "text-color": ["match", ["get", "flow"], "warm", "#a8402a", "#1f5ea4"], "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.6 } },
		"ph-poi": { type: "symbol", source: "ph-pts", filter: ["all", ["!=", ["get", "icon"], ""], ["!=", ["get", "category"], "range"], ["<=", ["get", "mz"], ["zoom"]]],
			layout: { "icon-image": ["get", "icon"], "icon-size": ["match", ["get", "category"], ["peak", "volcano"], ["interpolate", ["linear"], ["get", "elev"], 0, 0.6, 4000, 0.85, 8849, 1.3], 0.85],   // 山＝標高に比例 "symbol-sort-key": ["get", "sort"],
				"text-field": ["case", ["==", ["get", "name"], ""], ["get", "sub"], ["!=", ["get", "sub"], ""], ["concat", ["get", "name"], "\n", ["get", "sub"]], ["get", "name"]],
				"text-size": ["get", "size"], "text-anchor": "left", "text-offset": [0.75, 0], "text-justify": "left", "text-optional": true },
			paint: { "text-color": ["match", ["get", "category"], "trench", "#8e3a7e", colorBy("ink")], "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.8 } },   // 海溝の深さ＝赤紫のまま（起伏の系統へ移しても）
		// 山脈の名前＝帯の中心。山の記号の後に置く（山が勝つ）代わりに、ぶつかったら中心の上下左右へずれて空きを探す
		//（ヒマラヤの中心はエベレストとカイラス山の間＝中心固定だとどちらかが消えた・2026-10-01）
		"ph-range-label": { type: "symbol", source: "ph-pts", filter: ["all", ["any", ["==", ["get", "category"], "range"], ["has", "label"]], ["<=", ["get", "mz"], ["zoom"]]],
			layout: { "text-field": ["get", "name"], "text-size": ["+", 1, ["get", "size"]], "symbol-sort-key": ["get", "sort"], "text-max-width": 8,
				"text-variable-anchor": ["center", "top", "bottom", "left", "right"], "text-radial-offset": 0.9 },
			paint: { "text-color": ["match", ["get", "category"], "ridge", "#8a6410", "trench", "#8e3a7e", colorBy("ink")], "text-halo-color": "rgba(255,255,255,.85)", "text-halo-width": 1.8 } },
		"ph-area-label": { type: "symbol", source: "ph-pts", filter: ["all", ["==", ["get", "icon"], ""], ["!=", ["get", "category"], "range"], ["!", ["has", "label"]], ["<=", ["get", "mz"], ["zoom"]]],
			layout: { "text-field": ["get", "name"], "text-size": ["get", "size"], "symbol-sort-key": ["get", "sort"], "text-max-width": 8 },
			paint: { "text-color": colorBy("ink"), "text-halo-color": "rgba(255,255,255,.85)", "text-halo-width": 1.8 } },
	};
	for (const [id, L] of Object.entries(LAYERS)) await map.addLayer({ id, ...L });
	// 系統の表示切り替え＝filter に g の絞りを足す（選択の層は絞らない）
	const baseFilter = Object.fromEntries(Object.entries(LAYERS).map(([id, L]) => [id, L.filter]));
	const TOGGLED = ["ph-fill", "ph-range", "ph-river", "ph-current", "ph-line-label", "ph-poi", "ph-range-label", "ph-area-label"];
	const applyGroups = () => { for (const id of TOGGLED) map.setFilter(id, ["all", baseFilter[id], groupFilter()]); drawAnno(); };
	// 面の絵（anno）：山脈の帯（縁をぼかす）・乾燥と氷の塗り・選択した面の縁取り。系統の切り替えと選択のたびに積み直す（数百の面＝軽い）
	// 山脈は帯を 2 重（全幅＋芯の 55%）に重ねて、中ほどが濃く縁が淡い形に（anno の @blur＝canvas の filter は環境によって効かない＝headless Chrome で無描画だった）
	const RANGE_OUT = "rgba(143,74,20,.24)", RANGE_IN = "rgba(143,74,20,.28)", NONE = "rgba(0,0,0,0)";
	const TRENCH_FILL = ["rgba(126,48,110,.24)", "rgba(126,48,110,.36)"];
	const RIDGE_FILL = ["rgba(214,150,30,.2)", "rgba(214,150,30,.32)"];   // 海嶺＝プレート境界の凡例の「広がる境界」と同じ黄土（海の青の上）   // 海溝＝プレート・海溝の系統（赤紫）を海の青の上で沈めた色
	const coreOf = new Map([...axisOf].map(([q, c]) => [q, rangeBand({ type: "LineString", coordinates: c }, (shapes.find(f => f.properties.qid === q && f.properties.shape === "axis")?.properties.width || 60) * 0.55)]));
	// 海流＝半透明の太い矢印（anno の @poly 線＝帯＋先端の矢じり・幅は画面 px）。長い流れは約 2,000 km ごとに区切って矢印を連ねる＝途中でも向きが読める
	const CURRENT_FILL = { warm: "rgba(214,85,58,.5)", cold: "rgba(47,120,196,.5)" }, CURRENT_EDGE = { warm: "rgba(168,64,42,.55)", cold: "rgba(31,94,164,.55)" };
	const arrowWidth = () => Math.max(4, Math.min(14, 1 + map.view.zoom * 2.2));   // ズームで太らせる（z2≈5px・z4≈10px・z6 以上 14px）
	const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
	const chunks = (line, step = 2000, gap = 0.04) => {   // 累積距離で step km ごとに切る（各片の頭の gap を空ける＝矢じりと次の尾が重ならない）
		const total = line.slice(1).reduce((L, p, i) => L + kmOf(line[i], p), 0), n = Math.max(1, Math.round(total / step)), seg = total / n, out = [];
		for (let k = 0; k < n; k++) {
			const a = k * seg + (k ? seg * gap : 0), b = (k + 1) * seg - (k + 1 < n ? seg * gap : 0), part = [];
			let acc = 0;
			for (let i = 0; i < line.length; i++) {
				const l = i ? kmOf(line[i - 1], line[i]) : 0, a0 = acc; acc += l;
				const at = t => [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
				if (i && a0 < a && acc > a) part.push(at((a - a0) / l));
				if (acc >= a && acc <= b) part.push(line[i]);
				if (i && a0 < b && acc > b) { part.push(at((b - a0) / l)); break; }
			}
			if (part.length >= 2) out.push(part);
		}
		return out;
	};
	let arrowW = 0, annoLod = -1;
	// anno（canvas2D）は毎フレーム全頂点を投影し直す＝ズームの段ごとに粗い版を使う（1 画素の半分を許容＝見た目は同じ）。段ごとに一度だけ作って持つ
	const lodOf = z => z < 2.5 ? 0 : z < 4 ? 1 : z < 5.5 ? 2 : 3, LOD_TOL = [0.08, 0.025, 0.008, 0];
	const lodCache = [new Map(), new Map(), new Map(), null];
	const lodGeom = (key, g, lv) => { if (!LOD_TOL[lv]) return g; let m = lodCache[lv].get(key); if (!m) lodCache[lv].set(key, m = simplifyGeom(g, LOD_TOL[lv])); return m; };
	map.on("settle", () => { if (Math.abs(arrowWidth() - arrowW) >= 1 || lodOf(map.view.zoom) !== annoLod) drawAnno(); });   // 太さと粗さはズームで変わる＝止まった所で積み直す
	let koppenOn = false;   // 気候区分の重ね（下の koppenOverlay が点ける・ホバーが読む）
	function drawAnno() {
		const fs = [];
		arrowW = arrowWidth(); annoLod = lodOf(map.view.zoom); const lv = annoLod;
		for (const f of shapes) {
			const { g, category, flow } = f.properties;
			if (category !== "current" || !shown.has(g) || !/LineString$/.test(f.geometry.type)) continue;
			const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates, w = flow ? "warm" === flow ? "warm" : "cold" : "cold";
			// 経度をほどいてから区切る（日付変更線をまたぐ北太平洋海流など＝179°→−179° を反対回りの 358° と読まない。投影は周期的＝ほどいたままで描ける）
			const unwrap = l => l.reduce((o, p) => (o.push(o.length ? [p[0] + 360 * Math.round((o.at(-1)[0] - p[0]) / 360), p[1]] : [p[0], p[1]]), o), []);
			for (const part of parts) for (const c of chunks(unwrap(part)))
				fs.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: { "@poly": true, "@width": arrowW, "@end": "arrow", "@fill": CURRENT_FILL[w], "@stroke": CURRENT_EDGE[w] } });
		}
		for (const f of shapes) {
			const { g, category, shape, qid } = f.properties; if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") continue;
			const on = shown.has(g);
			const geom = () => lodGeom(f, f.geometry, lv);
			if (on && shape === "axis") {
				const [OUT, IN] = category === "trench" ? TRENCH_FILL : category === "ridge" ? RIDGE_FILL : [RANGE_OUT, RANGE_IN];
				fs.push({ type: "Feature", geometry: geom(), properties: { "@fill": OUT, "@stroke": NONE, "@width": 0.01 } });
				const core = coreOf.get(qid); if (core) fs.push({ type: "Feature", geometry: lodGeom(core, core, lv), properties: { "@fill": IN, "@stroke": NONE, "@width": 0.01 } });
			}
			else if (on && FILL_CATS[category]) fs.push({ type: "Feature", geometry: geom(), properties: { "@fill": FILL_CATS[category], "@stroke": NONE, "@width": 0.01 } });
			if (qid === sel) fs.push({ type: "Feature", geometry: geom(), properties: { "@fill": "rgba(215,38,61,.10)", "@stroke": SEL, "@width": 2.4 } });
		}
		// 呼び出しを 1 列に並べて最後の版だけ流す＝起動直後の 2 回（初回と ?q= の選択）が入れ替わり、選択の縁取りが消えた（2026-10-01）
		const my = ++annoSeq;
		annoChain = annoChain.then(() => my === annoSeq ? map.gadget.anno({ type: "FeatureCollection", features: fs }) : null).catch(e => console.warn("[physical] anno", e));
	}
	let annoSeq = 0, annoChain = Promise.resolve();

	// ── 選択（地図・一覧・比較図の共通の口）──
	let sel = null;
	applyGroups();   // 系統の絞りの初回（海流・プレートは「重ねる」で点けるまで出さない）＋面の絵の初回（sel の宣言の後＝drawAnno が読む）
	const bboxOf = qid => {
		const gs = geomsOf.get(qid); if (!gs) return null;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		const walk = c => { if (typeof c[0] === "number") { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; } else for (const k of c) walk(k); };
		for (const g of gs) walk(g.coordinates);
		return x0 <= x1 ? [x0, y0, x1, y1] : null;
	};
	async function select(qid, { fly = true } = {}) {
		const d = byQ.get(qid) || null; sel = d?.qid ?? null;
		const f = ["==", ["get", "qid"], sel ?? ""];
		map.setFilter("ph-sel-line", ["all", f, ["!=", ["geometry-type"], "Polygon"]]); map.setFilter("ph-sel-pt", ["all", f, ["!", ["has", "label"]]]);   // 名前だけの点（海溝の帯の中心）には輪を付けない
		drawAnno();
		const u = new URL(location.href); sel ? u.searchParams.set("q", sel) : u.searchParams.delete("q"); history.replaceState(null, "", u);
		closeWiki(); renderDetail(); list.mark(); chart.mark();
		if (!d || !fly) return;
		const bb = bboxOf(qid), [lon, lat] = d.coord;
		if (bb && bb[2] - bb[0] < 180 && (bb[2] - bb[0] > 0.5 || bb[3] - bb[1] > 0.5)) {
			const z = Math.max(1.5, Math.min(6, map.fitZoomForBbox(bb) - 0.3));
			await map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, z);
		} else await map.flyTo(lon, lat, d.category === "continent" || d.category === "ocean" ? 2 : 5);
	}

	// ── 地図の操作（ホバー＝名前と主な量・クリック＝選択）──
	const tip = map.gadget.tip();
	const HIT = ["ph-poi", "ph-range-label", "ph-area-label", "ph-line-label", "ph-river", "ph-range", "ph-current", "ph-fill", "ph-koppen"];
	const keyMetrics = d => Object.keys(METRICS).filter(k => valueOf(d, k) != null).slice(0, 2);
	// 重なって当たった時は HIT の順（記号 → 名前 → 線 → 面）で 1 つ＝山の記号の下の氷河の面を拾わない
	const topQid = e => (e.features || []).filter(f => f.properties?.qid).sort((a, b) => HIT.indexOf(a.layer?.id) - HIT.indexOf(b.layer?.id))[0]?.properties.qid;
	map.on("mousemove", HIT, e => {
		if (e.originalEvent?.shiftKey) return;   // Shift＝国名（エンジンの countryTip:"shift" が出す）
		const q = topQid(e), d = byQ.get(q);
		const kf = !d && koppenOn ? (e.features || []).find(f => f.layer?.id === "ph-koppen")?.properties : null;   // 地形が無い所＝気候区分（記号と名前）
		if (kf) return tip([`<b>${esc(kf.koppen)}</b>　${esc(kf.kname)}`, esc(koppenGroupName(kf.group))]);
		tip(d ? [`<b>${esc(nameOf(d))}</b>　${esc(catName(d.category))}`, ...keyMetrics(d).map(k => `${esc(metricName(k))}: ${esc(fmtVal(valueOf(d, k), k))}`)] : null);
	});
	map.on("mouseleave", HIT, e => { if (!e.originalEvent?.shiftKey) tip(null); });
	map.on("click", HIT, e => { const q = topQid(e); if (q) select(q, { fly: false }); });

	// ── 案内板（右上）：詳細カード＋タブ（表示・一覧・比較）──
	const panel = document.createElement("div");
	panel.className = "ph-panel";
	panel.innerHTML = `<style>${CSS}</style>
		<div class="head"><h1>${esc(t("Physical world"))}</h1><select class="lang" aria-label="Language">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select><button class="fold" type="button" aria-label="${esc(t("Fold"))}">–</button></div>
		<div class="body">
			<div class="detail" hidden></div>
			<div class="tabs" role="tablist">
				<button type="button" data-tab="layers" class="on">${esc(t("Layers"))}</button>
				<button type="button" data-tab="rank">${esc(t("Ranking"))}</button>
				<button type="button" data-tab="compare">${esc(t("Compare"))}</button>
			</div>
			<div class="pane" data-pane="layers">
				${GROUPS.map(g => `<label class="grp"><input type="checkbox" data-g="${g.id}" checked><span class="sw" style="background:${g.color}"></span>${esc(groupName(g.id))}<small>${items.filter(d => g.cats.includes(d.category)).length}</small></label>`).join("")}
				<label class="grp"><input type="checkbox" data-ov="lines" checked><span class="sw ln" style="background:#5a6472"></span>${esc(t("Equator, tropics and polar circles"))}</label>
				<label class="rng"><span>${esc(t("Relief colours"))}</span><input type="range" class="hypso" min="0" max="100" value="100" aria-label="${esc(t("Relief colours"))}"><output>100%</output></label>
				<h2>${esc(t("Overlays"))}</h2>
				<label class="grp"><input type="checkbox" data-ov="currents"><span class="sw ln" style="background:linear-gradient(90deg,#d4553a 50%,#2f78c4 50%)"></span>${esc(t("Ocean currents"))}<small>${items.filter(d => d.category === "current").length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="plates"><span class="sw ln" style="background:linear-gradient(90deg,#e0a020 33%,#b04a9c 33% 66%,#5a6472 66%)"></span>${esc(t("Plate boundaries"))}</label>
				<div class="leg" data-leg="plates" hidden>${PLATE_KINDS.map(k => `<span><i style="background:${k.color}"></i>${esc(plateKindName(k.id))}</span>`).join("")}</div>
				<label class="grp"><input type="checkbox" data-ov="koppen"><span class="sw" style="background:linear-gradient(90deg,${KOPPEN_GROUPS.map((g, i) => `${g.color} ${i * 20}% ${(i + 1) * 20}%`).join(",")})"></span>${esc(t("Climate (Köppen)"))}</label>
				<div class="leg kleg grp" data-leg="koppen" hidden>
					<button type="button" class="kmore" aria-pressed="false">${esc(t("Details (30 types)"))}</button>
					<div class="kgroups">${KOPPEN_GROUPS.map(g => `<div class="kg" data-g="${g.id}"><span class="kgn"><i style="background:${g.color};height:8px"></i>${esc(koppenGroupName(g.id))}</span><span class="kcs"></span></div>`).join("")}</div>
					<small class="note">${esc(t("Beck et al. 2023 (CC BY 4.0), 1991–2020"))}</small></div>
				<p class="note">${esc(t("Symbol size and line width follow height and length. Names appear as you zoom in, larger features first."))}</p>
				<p class="src">${esc(t("Data: Wikidata (CC0), Natural Earth"))}</p>
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
	// 言語（world と同じ＝その言語の呼び名を並べた select・26 言語）。地球儀の注記・地形の名前表・エンジンの文言は起動時の言語で組む＝
	// ?lang= を書き換えて読み直す（視点＝hash・選択＝?q= は URL に残る＝同じ場所・同じ選択へ戻る）
	$(".lang").onchange = e => { const u = new URL(location.href); u.searchParams.set("lang", e.target.value); location.assign(u); };
	$(".fold").onclick = () => { panel.classList.toggle("min"); $(".fold").textContent = panel.classList.contains("min") ? "+" : "–"; };
	panel.querySelectorAll("input[data-g]").forEach(inp => inp.onchange = () => { inp.checked ? shown.add(inp.dataset.g) : shown.delete(inp.dataset.g); applyGroups(); });
	panel.querySelectorAll("input[data-ov]").forEach(inp => inp.onchange = () => overlay(inp.dataset.ov, inp.checked));
	// 段彩（全球ハイプソ）の濃さ＝エンジンの setOpacity({ hypso })・0 で陸の地色だけ（本人 2026-10-01）
	const hy = $(".hypso"), hyOut = hy.nextElementSibling;
	hy.oninput = () => { const a = +hy.value / 100; map.setOpacity({ hypso: a }); hyOut.textContent = `${hy.value}%`; };

	// ── 重ね（プレート境界＝PB2002・地理線）＝初めて点けた時に読む ──
	const ovLoaded = {};
	async function overlay(id, on) {
		const leg = panel.querySelector(`[data-leg="${id}"]`); if (leg) leg.hidden = !on;
		if (id === "koppen") return koppenOverlay(on);
		if (id === "currents") { on ? shown.add("current") : shown.delete("current"); return applyGroups(); }   // 海流＝矢印（anno）と名前（線に沿う）＝系統の出し入れと同じ
		if (id === "plates") { on ? shown.add("plate") : shown.delete("plate"); applyGroups(); }   // プレートの名前は境界の重ねと一緒に
		if (!ovLoaded[id]) {
			if (!on) return;
			ovLoaded[id] = (async () => {
				const file = id === "plates" ? "plates.geopbf" : "ne-physical-lines.geopbf";
				const p = await loadPbf(geopbf, base + file), feats = [];
				for (let i = 0, n = p.fmap?.length ?? 0; i < n; i++) { const f = p.getFeature(i); if (!f?.geometry) continue;
					const pr = f.properties || p.getProperties(i) || {};
					if (id === "lines" && pr.kind === "dateline") continue;   // 日付変更線は人が決めた線＝地形の地図には入れない（赤道・回帰線・極圏＝自転軸の傾きで決まる線だけ・本人 2026-10-01）
					feats.push({ type: "Feature", geometry: f.geometry, properties: id === "plates" ? { kind: pr.kind, cls: PLATE_KIND_OF[pr.class] || "other", name: pr.name ?? "" }
						: { kind: pr.kind, name: pr["name_" + lang] || pr.name } }); }
				map.addSource("ph-" + id, { type: "geojson", data: { type: "FeatureCollection", features: feats } });
				const L = id === "plates" ? [
					{ id: "ph-plates", type: "line", source: "ph-plates", filter: ["==", ["get", "kind"], "boundary"],
						paint: { "line-color": ["match", ["get", "cls"], ...PLATE_KINDS.flatMap(k => [k.id, k.color]), "#5a6472"], "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.2, 6, 2.6], "line-opacity": 0.85 } },
				] : [
					{ id: "ph-lines", type: "line", source: "ph-lines", filter: ["==", ["get", "kind"], "equator"], paint: { "line-color": "#5a6472", "line-width": 1.2, "line-opacity": 0.75 } },
					{ id: "ph-lines-dash", type: "line", source: "ph-lines", filter: ["!=", ["get", "kind"], "equator"], paint: { "line-color": "#5a6472", "line-width": 1, "line-opacity": 0.7, "line-dasharray": [4, 3] } },
					{ id: "ph-lines-label", type: "symbol", source: "ph-lines", layout: { "symbol-placement": "line", "symbol-spacing": 600, "text-field": ["get", "name"], "text-size": 10.5 },
						paint: { "text-color": "#4a5058", "text-halo-color": "rgba(255,255,255,.85)", "text-halo-width": 1.6 } },
				];
				for (const l of L) await map.addLayer(l, "ph-sel-line");   // 地形の線と名前より下
				return L.map(l => l.id);
			})();
		}
		const ids = await ovLoaded[id];
		for (const l of ids) map.setLayoutProperty(l, "visibility", panel.querySelector(`input[data-ov="${id}"]`).checked ? "visible" : "none");
	}

	// ── 気候区分（ケッペン）＝0.1° の格子のセル辺そのまま（間引かない＝z8 まで寄っても四角の集まりのまま・本人 2026-10-01）を gint の塗りで。
	// 頂点 37.5 万は GPU の LOD に任せる（anno で毎フレーム投影するより軽い）。30 区分は属性に残し、塗りは大区分。高地（チベット）でも塗りは出る（実測）
	let koppenP = null, koppenMode = "group";   // 既定＝大区分 5 色・「詳細」で 30 区分（Beck の配色）＝本人 2026-10-01
	const koppenColor = () => koppenMode === "class" ? ["get", "kc"] : ["match", ["get", "group"], ...KOPPEN_GROUPS.flatMap(g => [g.id, g.color]), "rgba(0,0,0,0)"];
	panel.querySelector(".kmore").onclick = async e => {
		koppenMode = koppenMode === "group" ? "class" : "group";
		e.currentTarget.setAttribute("aria-pressed", String(koppenMode === "class")); e.currentTarget.classList.toggle("on", koppenMode === "class");
		panel.querySelector(".kleg").classList.toggle("grp", koppenMode === "group");
		if (koppenP) { await koppenP; map.setPaintProperty("ph-koppen", "fill-color", koppenColor()); }
	};
	async function koppenOverlay(on) {
		const leg = panel.querySelector(`[data-leg="koppen"]`); if (leg) leg.hidden = !on;
		koppenP ??= (async () => {
			const p = await loadPbf(geopbf, base + "climate-koppen.geopbf"), feats = [];
			for (let i = 0, n = p.fmap?.length ?? 0; i < n; i++) { const f = p.getFeature(i); if (!f?.geometry) continue;
				const pr = f.properties || {};
				const kc = Array.isArray(pr.color) ? `rgb(${pr.color.join(",")})` : "#888";   // Beck et al. の標準配色（区分ごと）
				feats.push({ type: "Feature", geometry: f.geometry, properties: { koppen: pr.code, group: pr.group, kname: pr["name_" + lang] || pr.name, kc } });
				const chips = panel.querySelector(`.kg[data-g="${pr.group}"] .kcs`);
				if (chips) chips.insertAdjacentHTML("beforeend", `<span class="kc" title="${esc(pr["name_" + lang] || pr.name)}"><i style="background:${kc}"></i>${esc(pr.code)}</span>`); }
			map.addSource("ph-koppen", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
			await map.addLayer({ id: "ph-koppen", type: "fill", source: "ph-koppen",
				paint: { "fill-color": koppenColor(), "fill-opacity": 0.42 } }, "ph-fill");   // いちばん下（地形の面・線・名前の下）
		})();
		await koppenP;
		koppenOn = on;
		map.setLayoutProperty("ph-koppen", "visibility", on ? "visible" : "none");
	}

	overlay("lines", true);   // 赤道・回帰線・極圏＝上の一覧で既定で点灯（本人 2026-10-01）＝ovLoaded・koppen の宣言の後で呼ぶ

	let tab = "layers";
	panel.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
		tab = b.dataset.tab;
		panel.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
		panel.querySelectorAll(".pane").forEach(p => p.hidden = p.dataset.pane !== tab);
		chart.show(tab === "compare");
		if (tab === "rank") list.render();
	});
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());   // 案内板の上の操作を地図に渡さない

	// Wikipedia＝アプリ内の iframe（world・census と同じ作法・本人 2026-10-01）。この頁は COEP credentialless＝素の iframe は Wikipedia が COEP を返さず
	// 遮断される＝<iframe credentialless>（Chrome/Edge）で免除・非対応のブラウザは別タブ（リンクの既定）。記事は m. 版＝狭い枠でも読みやすい
	const CAN_FRAME = "credentialless" in HTMLIFrameElement.prototype;
	const wiki = document.createElement("div");
	wiki.className = "ph-wiki"; wiki.hidden = true;
	wiki.innerHTML = `<div class="bar"><b class="tt"></b><a class="nt" target="_blank" rel="noopener" aria-label="${esc(t("Open in a new tab"))}" title="${esc(t("Open in a new tab"))}">↗</a><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div><iframe title="Wikipedia" credentialless referrerpolicy="no-referrer"></iframe>`;
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
		const w = wikiUrl(d), g = ALL_GROUPS.find(x => x.id === (GROUP_OF[d.category] || "land"));
		el.hidden = false;
		el.innerHTML = `<div class="dh"><span class="sw" style="background:${g.color}"></span><div><b class="nm">${esc(nameOf(d))}</b><small>${esc(catName(d.category))}${lang !== "en" && nameOf(d) !== d.name.en ? " · " + esc(d.name.en) : ""}</small></div><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>
			${rows || `<p class="note">${esc(t("No measurements recorded for this feature."))}</p>`}
			<div class="dl"><span>${d.coord[1].toFixed(2)}°, ${d.coord[0].toFixed(2)}°</span>${w ? `<a class="wk" href="${esc(w)}" target="_blank" rel="noopener">Wikipedia</a>` : ""}</div>`;
		el.querySelector(".x").onclick = () => select(null);
		const wk = el.querySelector(".wk"); if (wk) wk.onclick = e => { if (!CAN_FRAME || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); showWiki(w, nameOf(d)); };   // 修飾キー＝ブラウザの既定（別タブ）
	}
	// 同じ分類の中で何番目か（例：世界で 3 番目に高い）
	function rankNote(d, k) {
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
	// 分類ごとの「まず比べたい量」（無い分類は量の並びの先頭）
	const MAIN_METRIC = { lake: "area", river: "length", canal: "length", waterfall: "height", island: "area", islands: "area", desert: "area", ice: "area", sea: "area", ocean: "area", bay: "area",
		strait: "length", peninsula: "area", continent: "area", trench: "depth", plateau: "elevation", basin: "area", plain: "area", reef: "length", saltflat: "area", delta: "area", wetland: "area" };
	const metricsFor = c => Object.keys(METRICS).filter(k => items.some(d => d.category === c && valueOf(d, k) != null));
	const fillMetrics = () => { const ms = metricsFor(catSel.value); metSel.innerHTML = ms.map(k => `<option value="${k}">${esc(metricName(k))}</option>`).join("") + `<option value="">${esc(t("Name"))}</option>`; metSel.value = ms.includes(MAIN_METRIC[catSel.value]) ? MAIN_METRIC[catSel.value] : ms[0] ?? ""; };
	fillMetrics();
	const list = {
		render() {
			const c = catSel.value, k = metSel.value, q = find.value.trim().toLowerCase();
			let rows = q ? items.filter(d => nameOf(d).toLowerCase().includes(q) || d.name.en.toLowerCase().includes(q)) : items.filter(d => d.category === c);
			rows = k && !q ? rows.slice().sort((a, b) => (valueOf(b, k) ?? -Infinity) - (valueOf(a, k) ?? -Infinity)) : rows.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), lang));
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
	ol.onmouseover = e => { const li = e.target.closest("li"); for (const id of ["ph-sel-pt"]) map.setFilter(id, ["match", ["get", "qid"], [sel ?? "", li?.dataset.q ?? ""], true, false]); };

	// ── 比較図（下の帯）──
	const chart = makeChart({ mapEl, items, byQ, nameOf, getSel: () => sel, onPick: q => select(q) });
	$(".preset").onchange = e => chart.draw(PRESETS.find(p => p.id === e.target.value));
	chart.draw(PRESETS[0]);

	// 共有 URL（?q=QID）の選択を復元
	const q0 = new URLSearchParams(location.search).get("q");
	if (q0 && byQ.has(q0)) select(q0, { fly: !location.hash });

	return { select, items, byQ, shapes, points, get sel() { return sel; }, chart, list };
}

// ── 比較図：高さ比べ（山＝三角の影絵）と長さ・広さ比べ（横棒・2 量は並べた 2 枚）──
function makeChart({ mapEl, items, byQ, nameOf, getSel, onPick }) {
	const el = document.createElement("div");
	el.className = "ph-chart"; el.hidden = true;
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

	function mountains(rows, W, H) {   // 高さ比べ＝各峰を等脚三角形（底辺＝高さに比例＝昔の地図帳の山の比較図）。0 m の地平線から実寸比
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
	function bars(rows, metrics, W) {   // 横棒（行＝地物・列＝量）。量ごとに独立した尺＝軸を共有しない小さな複数枚
		const nameW = Math.min(150, W * 0.3), rowH = 18, colW = (W - nameW - 8) / metrics.length, H = rows.length * rowH + 22;
		const max = metrics.map(k => Math.max(...rows.map(d => valueOf(d, k) ?? 0), 1));
		const head = metrics.map((k, j) => `<text x="${nameW + 8 + j * colW}" y="12" class="mh">${esc(metricName(k))}</text>`).join("");
		const body = rows.map((d, i) => { const y = 20 + i * rowH;
			return `<g class="mk" data-q="${d.qid}"><text x="${nameW}" y="${y + 12}" class="nm">${esc(short(nameOf(d), 22))}</text>` +
				metrics.map((k, j) => { const v = valueOf(d, k), x0 = nameW + 8 + j * colW, bw = v == null ? 0 : Math.max(2, (colW - 104) * v / max[j]);   // 右に数値（〜100px）の余地
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
// 名前を幅（px）に収める（比較図の山の名前＝2 段の互い違いで 1 峰あたり約 2 本ぶんの幅）
const measure = (() => { let cx; return s => (cx ||= document.createElement("canvas").getContext("2d"), cx.font = "10px system-ui, sans-serif", cx.measureText(s).width); })();
const fit = (s, w) => { if (measure(s) <= w) return s; const a = [...s]; while (a.length > 1 && measure(a.join("") + "…") > w) a.pop(); return a.join("") + "…"; };
const short = (s, n = 12) => [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── 意匠（quiet-mono のトークン＝#map の変数を使う＝昼夜の配色テーマに追随）──
const CSS = `
.ph-panel{position:absolute;top:12px;right:12px;z-index:30;width:320px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;box-sizing:border-box;
	padding:12px 14px;border-radius:var(--qm-r-l);background:var(--qm-panel-solid);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);
	backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur));color:var(--qm-text);font:13px/1.45 var(--qm-font)}
.ph-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ph-panel h1{flex:1;min-width:0;font-size:15px;margin:0;font-weight:700;color:var(--qm-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-panel .head .lang{flex:none;max-width:120px;font-size:12px;padding:3px 4px}
.ph-panel .fold,.ph-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.ph-panel.min .body{display:none}
.ph-panel .tabs{display:flex;gap:4px;margin:10px 0 8px;border-bottom:1px solid var(--qm-border-soft)}
.ph-panel .tabs button{flex:1;border:0;background:none;padding:6px 4px;font:inherit;color:var(--qm-text-dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.ph-panel .tabs button.on{color:var(--qm-ink);font-weight:700;border-bottom-color:var(--qm-ink)}
.ph-panel .grp{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer}
.ph-panel h2{font-size:12px;margin:12px 0 2px;color:var(--qm-text-dim);font-weight:600}
.ph-panel .sw.ln{height:4px;border-radius:2px}
.ph-panel .leg{display:flex;flex-direction:column;gap:2px;margin:0 0 4px 34px;font-size:11.5px;color:var(--qm-text-dim)}
.ph-panel .leg[hidden]{display:none}   /* display:flex が hidden 属性に勝って、消した重ねの凡例が出ていた */
.ph-panel .kleg{gap:4px;align-items:flex-start}
.ph-panel .kgroups{display:flex;flex-direction:column;gap:3px;align-self:stretch}
.ph-panel .kmore{align-self:flex-start;margin:2px 0 4px;font:inherit;font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--qm-border-soft);background:#fff;color:var(--qm-text);cursor:pointer}
.ph-panel .kmore.on{background:var(--qm-ink);color:#fff;border-color:var(--qm-ink)}
.ph-panel .kg{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
.ph-panel .kcs{display:flex;flex-wrap:wrap;gap:2px 8px;margin-left:20px}
.ph-panel .kc{display:inline-flex;align-items:center;font-size:11px;font-variant-numeric:tabular-nums}
.ph-panel .kc i{width:10px !important;height:10px !important;border-radius:2px;margin-right:3px !important}
.ph-panel .kleg.grp .kcs{display:none}
.ph-panel .leg i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.ph-panel .rng{display:flex;align-items:center;gap:8px;padding:4px 0 2px;color:var(--qm-text)}
.ph-panel .rng span{flex:none}
.ph-panel .rng input{flex:1;min-width:0;margin:0}
.ph-panel .rng output{flex:none;width:38px;text-align:right;color:var(--qm-num);font-variant-numeric:tabular-nums;font-size:12px}
.ph-panel .grp small{margin-left:auto;color:var(--qm-text-faint)}
.ph-panel .sw{flex:none;width:12px;height:12px;border-radius:3px}
.ph-panel .note{color:var(--qm-text-dim);font-size:12px;margin:8px 0 0}
.ph-panel .src{color:var(--qm-text-faint);font-size:11px;margin:6px 0 0}
.ph-panel .ctl{display:flex;gap:6px}
.ph-panel select,.ph-panel .find{flex:1;min-width:0;font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#fff;color:var(--qm-text);padding:5px 6px}
.ph-panel .find{display:block;width:100%;box-sizing:border-box;margin-top:6px}
.ph-panel .list{list-style:none;margin:6px 0 0;padding:0;max-height:46vh;overflow:auto}
.ph-panel .list li{position:relative;display:flex;gap:6px;align-items:baseline;padding:4px 4px 6px;border-radius:6px;cursor:pointer}
.ph-panel .list li:hover{background:rgba(43,59,87,.06)}
.ph-panel .list li.on{background:rgba(215,38,61,.08)}
.ph-panel .list .i{flex:none;width:22px;text-align:right;color:var(--qm-text-faint);font-variant-numeric:tabular-nums}
.ph-panel .list .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-panel .list .n small{margin-left:6px;color:var(--qm-text-faint)}
.ph-panel .list .v{flex:none;color:var(--qm-num);font-variant-numeric:tabular-nums;font-size:12px}
.ph-panel .list .bar{position:absolute;left:32px;bottom:2px;height:2px;border-radius:2px;background:var(--qm-border-strong);opacity:.5;max-width:calc(100% - 36px)}
.ph-panel .detail{margin:10px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:rgba(43,59,87,.04);border:1px solid var(--qm-border-soft)}
.ph-panel .dh{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
.ph-panel .dh .sw{margin-top:4px}
.ph-panel .dh > div{flex:1;min-width:0}
.ph-panel .dh .nm{display:block;font-size:15px;color:var(--qm-ink)}
.ph-panel .dh small{color:var(--qm-text-dim)}
.ph-panel .m{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.ph-panel .m span{color:var(--qm-text-dim);min-width:92px}
.ph-panel .m b{color:var(--qm-ink);font-variant-numeric:tabular-nums}
.ph-panel .m small{margin-left:auto;color:var(--qm-text-faint)}
.ph-panel .dl{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--qm-text-faint)}
.ph-panel .dl a{color:var(--qm-ink)}
.ph-wiki{position:absolute;left:12px;top:12px;bottom:calc(40px + var(--qm-safe-b));z-index:31;width:min(560px,calc(100% - 356px));display:flex;flex-direction:column;overflow:hidden;
	border-radius:var(--qm-r-l);background:#fff;border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);color:var(--qm-text);font:13px/1.4 var(--qm-font)}
.ph-wiki[hidden]{display:none}
.ph-wiki .bar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--qm-border-soft)}
.ph-wiki .tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--qm-ink)}
.ph-wiki .nt,.ph-wiki .x{flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer;text-decoration:none}
.ph-wiki iframe{flex:1;min-height:0;width:100%;border:0;background:#fff}
.ph-chart{position:absolute;left:12px;right:344px;bottom:calc(40px + var(--qm-safe-b));z-index:29;height:300px;box-sizing:border-box;padding:8px 12px 10px;display:flex;flex-direction:column;
	border-radius:var(--qm-r-l);background:var(--qm-panel-solid);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);color:var(--qm-text);font:12px/1.4 var(--qm-font)}
.ph-chart[hidden]{display:none}
.ph-chart .ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.ph-chart .ch b{color:var(--qm-ink);font-size:13px}
.ph-chart .x{width:24px;height:24px;border-radius:6px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);cursor:pointer}
.ph-chart .cv{flex:1;min-height:0;overflow:hidden}
.ph-chart .cv.scroll{overflow:auto}
.ph-chart svg{display:block;font:11px var(--qm-font)}
.ph-chart .gl{stroke:rgba(90,100,120,.16);stroke-width:1}
.ph-chart .base{stroke:var(--qm-text-dim);stroke-width:1}
.ph-chart .ax{fill:var(--qm-text-dim);font-size:10px;paint-order:stroke;stroke:#fff;stroke-width:3px}
.ph-chart .mtn{fill:#8f4a14;fill-opacity:.78;stroke:#fff;stroke-width:1}
.ph-chart .vol{fill:#c2410c;fill-opacity:.78;stroke:#fff;stroke-width:1}
.ph-chart .val{fill:var(--qm-num);font-size:9.5px;text-anchor:middle;font-variant-numeric:tabular-nums}
.ph-chart .lb{fill:var(--qm-text);font-size:10px;text-anchor:middle}
.ph-chart .mh{fill:var(--qm-text-dim);font-weight:600}
.ph-chart .nm{fill:var(--qm-text);text-anchor:end}
.ph-chart .na{fill:var(--qm-text-faint)}
.ph-chart .bar{fill:#2f78c4;fill-opacity:.85}
.ph-chart .bar.b1{fill:#5a6472;fill-opacity:.7}
.ph-chart .val2{fill:var(--qm-num);font-size:10.5px;font-variant-numeric:tabular-nums}
.ph-chart .hit{fill:transparent;cursor:pointer}
.ph-chart .mk:hover .mtn,.ph-chart .mk:hover .vol,.ph-chart .mk:hover .bar{fill-opacity:1}
.ph-chart .mk.on .mtn,.ph-chart .mk.on .vol,.ph-chart .mk.on .bar{stroke:#d7263d;stroke-width:2;fill-opacity:1}
.ph-chart .mk.on .nm,.ph-chart .mk.on .lb{fill:#d7263d;font-weight:700}
.ph-chart .ctip{position:absolute;pointer-events:none;min-width:120px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.97);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-card);font-size:12px}
.ph-chart .ctip[hidden]{display:none}
@media (max-width:720px){
	.ph-wiki{left:8px;right:8px;top:8px;width:auto}
	.ph-panel{left:12px;right:12px;width:auto;max-height:44vh}
	.ph-chart{left:8px;right:8px;height:240px}
}`;
