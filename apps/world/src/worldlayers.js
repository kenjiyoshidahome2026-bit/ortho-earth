// 国の形と中身＝world が自分で持っているデータで賄う（本人 2026-09-23「world の DB に全てデータがある・全て ISO で対応が取れる」）。
// 出所は equal（/equal/）と同じ 2 本＝packages/world が焼いた bucket の GIS/world/：
//   base   … admin_1（州＝束ねれば国の形）・admin_0（係争主体）・populated_places
//   detail … roads / railroads / urban_areas（国境で切って key ごとに 1 地物）
// 全地物が properties.key（world の国キー＝NationDB の key）と properties.layer を持つ＝
// **丸ごと 1 枚載せて式で絞る**（エンジンの addGint + setPaint(paint, filter)）。国ごとに焼き直した配信物は作らない。
// 初回だけ 16.5MB・以降は geopbf が IDB に持つ。
const BASE_URL = "https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-";

import { gunzip, isGzip } from "geopbf/gzip";   // bucket は圧縮して置く＝読む側で解く（equal と同じ作法）

// 色＝equal の PALETTE / labelColor（apps/equal/src/layers.js・themes.js mono）と同じ顔＝2 つのアプリで同じ世界に見える
const C = { admin1: "rgba(169,156,178,0.45)", disputed: "rgba(154,110,144,0.28)", disputedLine: "rgba(138,95,128,0.9)",
	road: "#d9a86c", rail: "#7d7f86", urban: "rgba(154,90,82,0.5)", city: "#2b3b57", halo: "rgba(255,255,255,0.88)" };
const LINES_Z = 5;   // 道路・鉄道を出すズーム（equal の roads/rail minZoom と同値）

// 都市名（equal と同じ出所の順・言語ごと）：ja＝配信 geopbf の NAME_JA（「〜市」族を落とす）／en＝NAME_EN／
// 他＝World DB の台帳名（i18n/<lang>.json の cities・564 都市）→ NE の言語別表（ne-cities/<lang>.json・約 6,600）→ NAME_EN
const WORLD = "https://api.ortho-earth.com/bucket/GIS/world/";
const stripJaCitySuffix = s => { const src = String(s ?? ""), t = src.replace(/(特別市|広域市|直轄市|市)$/, ""); const u = /都$/.test(t) && [...t].length >= 3 ? t.slice(0, -1) : t; return u || t || src; };
const F = (p, k) => p[k] ?? p[k.toUpperCase()] ?? p[k.toLowerCase()];
const jsonMaybeGz = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); const b = await r.blob(); return JSON.parse(await (await isGzip(b) ? await gunzip(b) : b).text()); };
const nameTables = {};   // lang → Promise<{ db, ne }>（en・ja は表を引かない）
const namesFor = lang => nameTables[lang] ||= (lang === "en" || lang === "ja") ? Promise.resolve({})
	: Promise.all([jsonMaybeGz(`${WORLD}i18n/${lang}.json`).then(j => j?.cities || {}).catch(() => ({})), lang === "th" ? {} : jsonMaybeGz(`${WORLD}ne-cities/${lang}.json`).then(j => j?.names || {}).catch(() => ({}))])
		.then(([db, ne]) => ({ db, ne }));
const cityName = (p, lang, t) => {
	if (lang === "ja") return stripJaCitySuffix(F(p, "name_ja") || "") || F(p, "name_en") || F(p, "name");
	if (lang === "en") return F(p, "name_en") || F(p, "name");
	const qid = F(p, "wikidataid");
	return (qid && t.db?.[qid]?.name) || (qid && t.ne?.[qid]) || F(p, "name_en") || F(p, "name");
};

const got = {};   // group → Promise<GeoPBF>（1 ページ 1 回）
const fetchGroup = (geopbf, g) => got[g] ||= geopbf(BASE_URL + g + ".geopbf", { name: `ne-cultural-${g}.geopbf` })
	.catch(e => { got[g] = null; console.warn("[world] ne-cultural", g, e); return null; });

// 寄り先の矩形＝国の形のうち中心の近くにある塊だけ。中心と広さは NationDB（coord・area）が持っている＝
// 「どこまでが本体か」を規則で書かずデータに決めさせる。許容＝広さから出した半径の 3 倍・最低 10°
// （France は海外県が外れ、日本は南鳥島が外れ、United States はアラスカが入る）。
const nearBbox = (feats, coord, area) => {
	const limit = Math.max(10, 3 * Math.sqrt((area || 0) / Math.PI) / 111.32);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	// ⚠ 地物ごとではなく**塊（ポリゴン）ごと**に測る：東京都は 1 地物で小笠原・南鳥島まで含む＝
	// 地物の外接矩形で見ると「本体の近く」と判定されて 154°E まで引っぱられる（2026-09-23 実測）。
	for (const f of feats) {
		const g = f.geometry;
		const parts = g?.type === "MultiPolygon" ? g.coordinates : g?.type === "Polygon" ? [g.coordinates] : [];
		for (const poly of parts) {
			const ring = poly?.[0]; if (!ring?.length) continue;
			let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, lon = null;
			for (const p of ring) {
				if (!p || p.length < 2) continue;
				lon = lon == null ? p[0] : p[0] + 360 * Math.round((lon - p[0]) / 360);   // 前の頂点に近い方へ解く
				if (lon < a) a = lon; if (lon > c) c = lon; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
			}
			if (a > c) continue;
			const shift = coord ? 360 * Math.round((coord[0] - (a + c) / 2) / 360) : 0;   // 矩形を中心の側へ寄せてから測る（日付変更線）
			if (coord && Math.hypot(Math.max(0, a + shift - coord[0], coord[0] - (c + shift)), Math.max(0, b - coord[1], coord[1] - d)) > limit) continue;
			x0 = Math.min(x0, a + shift); x1 = Math.max(x1, c + shift); y0 = Math.min(y0, b); y1 = Math.max(y1, d);
		}
	}
	return x0 <= x1 ? [x0, y0, x1, y1] : null;
};

/** 国の形（スポットライトへ渡す）と中身（州境・道路・鉄道・市街地）。shape(key,nation) / show(key) / clear() */
export function countryLayers(map, geopbf) {
	if (!geopbf || !map.addGint) return { shape: async () => null, show: async () => {}, clear: () => {} };   // 古いエンジン＝静かに何もしない
	const layer = {}, held = {};   // group → addGint のハンドル／原本
	let key = null, dotAdded = false;
	// 都市の丸（首都は大きく）＝equal の dot と同じ形。記号帳に一度だけ登録して icon-size で伸縮
	const dotBitmap = () => { const s = 16, cv = document.createElement("canvas"); cv.width = cv.height = s; const cx = cv.getContext("2d");
		cx.beginPath(); cx.arc(s / 2, s / 2, 5, 0, Math.PI * 2); cx.fillStyle = C.city; cx.fill(); cx.lineWidth = 2; cx.strokeStyle = "rgba(255,255,255,0.9)"; cx.stroke(); return cv; };
	const ensure = async g => {
		if (layer[g] !== undefined) return layer[g];
		layer[g] = null;   // 取得中の二重起動を止める
		const pbf = await fetchGroup(geopbf, g);
		if (!pbf) return null;
		held[g] = pbf;
		// fillMaxEdges＝面を塗る上限（市街地の塗りが要る detail だけ開ける）。interactive:false＝識別はスポットライトの領分
		const h = map.addGint(pbf, { order: g === "base" ? -6 : -5, interactive: false, minZoom: g === "base" ? 2.5 : LINES_Z });
		h?.setVisible(false);   // 国で絞るまで出さない＝焼き上がり直後の 1 枚で他国の市街地が閃くのを断つ
		// カメラが動いている間、gint はポリゴンを「単色のベタ塗り」に落とす（fid 別の塗りは止まる）。その色が既定スタイル
		// （#FF6B35＝オレンジ）で、しかも filter を見ない＝遷移中に全世界の面がオレンジに塗られる（本人指摘 2026-09-23）。
		// 層の fillColor を透明にすると、この単色塗りだけが消え、静止時の fid 別の塗り（市街地・係争地）は残る。
		h?.style({ fillColor: [0, 0, 0, 0] });
		return layer[g] = h;
	};
	// equal の層定義（countries の admin1 線・disputed の薄い塗り＋線・urban の塗り・roads/rail の線）をそのまま式に写す
	const paintOf = g => g === "base"
		? { "fill-color": ["case", ["==", ["get", "layer"], "admin_0"], C.disputed, "rgba(0,0,0,0)"],   // 係争主体＝薄く重ねる（州は塗らない）
			"line-color": ["case", ["==", ["get", "layer"], "admin_0"], C.disputedLine, C.admin1],
			"line-width": ["case", ["==", ["get", "layer"], "admin_0"], 0.8, 0.5] }
		: { "fill-color": ["case", ["==", ["get", "layer"], "urban_areas"], C.urban, "rgba(0,0,0,0)"],   // 市街地だけ塗る
			"line-color": ["match", ["get", "layer"], "roads", C.road, "railroads", C.rail, "rgba(0,0,0,0)"],
			"line-width": 0.8 };
	const filterOf = g => g === "base"
		? ["all", ["==", ["get", "key"], key], ["match", ["get", "layer"], ["admin_1", "admin_0"], true, false]]
		: ["all", ["==", ["get", "key"], key], ["match", ["get", "layer"], ["roads", "railroads", "urban_areas"], true, false]];
	return {
		/** その国の形（州を束ねたもの）と寄り先の矩形。nation＝一覧が持っている NationDB の 1 件（coord・area） */
		async shape(k, nation = {}) {
			await ensure("base");
			const pbf = held.base; if (!pbf) return null;
			const n = pbf.fmap?.length ?? 0, feats = [];
			for (let i = 0; i < n; i++) {
				const p = pbf.getProperties(i) || {};
				if (p.key !== k || (p.layer !== "admin_1" && p.layer !== "admin_0")) continue;   // admin_0＝admin_1 に形の無い係争主体
				const f = pbf.getFeature(i); if (f?.geometry) feats.push(f);
			}
			if (!feats.length) return null;
			return { fc: { type: "FeatureCollection", features: feats }, bbox: nearBbox(feats, nation.coord, nation.area) };
		},
		/** その国の都市（NE populated_places）を名前つきで置く。首都＝ADM0CAP・出すズーム＝NE の MIN_ZOOM・大きさ/優先＝SCALERANK（equal の cityLabels と同じ） */
		async labels(k, lang = "en") {
			await ensure("base");
			const pbf = held.base; if (!pbf) return;
			const t = await namesFor(lang);
			if (k !== key) return;
			const n = pbf.fmap?.length ?? 0, feats = [];
			for (let i = 0; i < n; i++) {
				const p = pbf.getProperties(i) || {};
				if (p.key !== k || p.layer !== "populated_places") continue;
				const f = pbf.getFeature(i); if (f?.geometry?.type !== "Point") continue;
				const cap = +F(p, "adm0cap") === 1, srv = +F(p, "scalerank"), sr = Number.isFinite(srv) ? srv : 8, mzv = +F(p, "min_zoom"), mz = Number.isFinite(mzv) ? mzv : 6;
				const name = cityName(p, lang, t); if (!name) continue;
				feats.push({ type: "Feature", geometry: f.geometry, properties: { name, cap, mz: cap ? Math.min(mz, 3) : mz, pri: cap ? 0.2 + sr / 20 : 2 + sr / 20, size: cap ? 11.5 : sr <= 2 ? 11 : sr <= 4 ? 10.5 : 10 } });
			}
			if (!map.hasImage?.("world-dot") && !dotAdded) { dotAdded = true; await map.addImage("world-dot", dotBitmap(), { pixelRatio: 2 }); }
			await map.gadget.symbols({ type: "FeatureCollection", features: feats }, {
				id: "world-cities", minzoom: 2.5,
				filter: ["<=", ["get", "mz"], ["zoom"]],   // NE の出しズーム（止まるたびに評価し直される）
				layout: { "icon-image": "world-dot", "icon-size": ["case", ["get", "cap"], 1, 0.75], "symbol-sort-key": ["get", "pri"],
					"text-field": ["get", "name"], "text-size": ["get", "size"], "text-anchor": "left", "text-offset": [0.55, 0] },
				paint: { "text-color": C.city, "text-halo-color": C.halo, "text-halo-width": 2 },
			});
		},
		/** その国の州境・係争地・道路・鉄道・市街地を出す（カメラが止まってから呼ぶ＝遷移中に他国が閃かない） */
		async show(k) {
			key = k;
			for (const g of ["base", "detail"]) {
				const h = await ensure(g);
				if (!h) continue;
				await h.ready;   // 焼き上がり（初回 ack）を待ってから塗る＝待たずに塗ると全件が既定色で出る
				await h.setPaint(paintOf(g), filterOf(g));
				if (k !== key) return;   // 待っている間に別の国が押された＝古い方は出さない
				h.setVisible(true);      // 絞り終えてから出す
			}
		},
		clear() { for (const h of Object.values(layer)) h?.setVisible(false); map.gadget.symbols(null, { id: "world-cities" }); },
	};
}
