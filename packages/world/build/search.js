// 世界の地名検索の索引（#175・maplibre-gl-geocoder 相当の既定の問い合わせ先）＝国・州・都市・地形を 1 本の軽い表に焼く。
// 引く側＝packages/globe/src/worldsearch.js（検索窓の世界の既定）。置き場＝bucket GIS/world/search/（本人裁定 2026-09-30）。
// Node（scripts/search-index.mjs）と uploader（国別DB節）で共用＝依存なし・純関数（入力は既に読んだ物だけ）。
//
// 形（v1・列ごと＝gzip が効く並び）：
//   search/base.json   … { v, updated, source, n, kinds, kindNames, kind, lon, lat, imp, nation, parent, view, qid, en, alt }
//     列はどれも長さ n（i 番目＝1 件）：
//       kind   ＝ kinds の添字（"country"・"state"＝州・"city"＝都市・地形の 35 分類）
//       lon/lat＝ 代表点（0.01° の整数・前の件との差分＝同じ国の件が並ぶので差が小さい）
//       imp    ＝ 重み（大きいほど先に並ぶ整数）。国 1000 台・都市/州 0〜100・大陸/大洋 1100
//       nation ＝ その国の添字（-1＝無し）／parent ＝ 州の添字（都市だけ・-1＝無し）
//       view   ＝ 着地：数＝zoom（点）／[zoom, tilt]（山＝地形を斜めから）／[w, s, e, n]（国・州＝範囲に寄る・代表点からの 0.01° の整数・±180 は畳まない）
//       qid    ＝ Wikidata の QID の番号（0＝無し）＝外から突き合わせる鍵
//     en[i] ＝ 英語の名前（表示と照合）・alt ＝ [[i, 別名…]…]（ISO コード・略称・現地名・旧名＝照合だけ）
//     kindNames ＝ 分類の英語名（kinds と同じ並び・国/州/都市は ""）
//   search/<lang>.json … { v, lang, names, alt, kindNames }（英語以外の 25 言語）
//     names[i] ＝ その言語の名前（英語と同じ・無い＝0）＝英語へ落ちる
//   読み手（packages/globe/src/worldsearch.js の decodeBase）はこの形を知っている＝変えたら v を上げて両方を直す。
//
// 材料（本番で既に読んでいる物＋NE の原本）：
//   NationDB（国・代表点・面積・人口）・CityDB（台帳の都市 564）・TerrainDB（地形・代表点）・i18n/<lang>.json（26 言語の名前・ja の読み）
//   NE admin_1（州＝key 付き・name_xx 24 言語）・NE populated_places（都市＝key 付き・NAME_XX 24 言語）・NE admin_0_countries（国の略称・別名）
//   th は NE に列が無い＝World DB の i18n（国・台帳の都市・地形）だけ。州と小さな都市は英語で引く。

export const SEARCH_VERSION = 1;

const r2 = x => Math.round(x * 1e2) / 1e2, c100 = x => Math.round(x * 100);
const num = (v, d = 0) => { const n = +v; return Number.isFinite(n) ? n : d; };
const splitAlt = s => String(s ?? "").split("|").map(x => x.trim()).filter(Boolean);

// 日本語の都市名から「〜市」族を 1 つだけ落とす（地図の注記と同じ規則＝ortho-core worldcontent の stripJaCitySuffix と同じ式）
const stripJaCitySuffix = s => {
	const src = String(s ?? "");
	const t = src.replace(/(特別市|広域市|直轄市|市)$/, "");
	const u = /都$/.test(t) && [...t].length >= 3 ? t.slice(0, -1) : t;
	return u || t || src;
};

// 面の塊（ポリゴン）ごとの外接矩形と面積（km²・cos(lat) の平面近似）
function partsOf(geometry) {
	const polys = geometry?.type === "MultiPolygon" ? geometry.coordinates : geometry?.type === "Polygon" ? [geometry.coordinates] : [];
	const out = [];
	for (const poly of polys) {
		const ring = poly?.[0]; if (!ring?.length) continue;
		let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, lon = null, area = 0, px = null, py = null;
		for (const p of ring) {
			if (!p || p.length < 2) continue;
			lon = lon == null ? p[0] : p[0] + 360 * Math.round((lon - p[0]) / 360);   // 前の頂点に近い方へ解く（日付変更線）
			if (lon < a) a = lon; if (lon > c) c = lon; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
			if (px != null) area += (lon - px) * (p[1] + py);
			px = lon; py = p[1];
		}
		if (a > c) continue;
		const km2 = Math.abs(area / 2) * 111.32 * 110.57 * Math.cos(((b + d) / 2) * Math.PI / 180);
		out.push({ bbox: [a, b, c, d], km2 });
	}
	return out;
}
// 寄り先の矩形＝形のうち中心の近くにある塊だけ（apps/world の国の地図パネルと同じ規則：許容＝広さから出した半径の 3 倍・最低 10°）。
// France は海外県が外れ、東京都は小笠原が外れ、United States はアラスカが入る。
function nearBbox(parts, coord, area, minDeg = 10) {
	const limit = Math.max(minDeg, 3 * Math.sqrt((area || 0) / Math.PI) / 111.32);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const { bbox: [a, b, c, d] } of parts) {
		const shift = coord ? 360 * Math.round((coord[0] - (a + c) / 2) / 360) : 0;
		if (coord && Math.hypot(Math.max(0, a + shift - coord[0], coord[0] - (c + shift)), Math.max(0, b - coord[1], coord[1] - d)) > limit) continue;
		x0 = Math.min(x0, a + shift); x1 = Math.max(x1, c + shift); y0 = Math.min(y0, b); y1 = Math.max(y1, d);
	}
	return x0 <= x1 ? [x0, y0, x1, y1] : null;
}
// 形の無い国（係争主体の一部）＝代表点と面積から正方形
const squareBbox = ([lon, lat], area) => {
	const h = Math.max(0.05, Math.sqrt(area || 100) / 2 / 111.32), w = h / Math.max(0.2, Math.cos(lat * Math.PI / 180));
	return [lon - w, Math.max(-90, lat - h), lon + w, Math.min(90, lat + h)];
};
const qidNum = q => { const m = /^Q(\d+)$/.exec(q || ""); return m ? +m[1] : 0; };

// 着地の倍率（点）：横幅 ≈ 1100 px の画面に広がり ext 度が収まる zoom（z の 1 周＝256×2^z px＝WORLD_PX=256）
const zoomForDeg = ext => Math.max(1.5, Math.min(12, Math.log2(1100 * 360 / 256 / Math.max(0.01, ext)) - 0.5));   // −0.5＝縁に余白
const cityZoom = pop => pop >= 5e6 ? 9.5 : pop >= 1e6 ? 10 : pop >= 1e5 ? 11 : 11.5;
const PEAKS = new Set(["peak", "volcano", "pass", "waterfall"]);   // 地形を斜めから見る着地（地理院の自然地名＝z12.8・55° と同じ扱い）
function terrainView(t) {
	if (PEAKS.has(t.category)) return [11, 55];
	const ext = t.area > 0 ? Math.sqrt(t.area) / 111.32 : t.length > 0 ? t.length / 111.32 * 0.7 : null;
	if (ext) return r2(zoomForDeg(ext));
	return t.category === "continent" || t.category === "ocean" ? 2.5 : 8;
}
const terrainImp = t => t.category === "continent" || t.category === "ocean" ? 1100 : Math.round(80 - 5 * Math.min(10, t.rank ?? 6) + (t.area > 0 ? Math.min(10, Math.log10(t.area)) : 0));

/**
 * 索引を焼く。
 * @param {object} a
 * @param {object[]} a.features  NE の地物（properties.layer＝"admin_1" | "populated_places"・properties.key＝world の国 key）＝build/ne-cultural.js の all
 * @param {object[]} a.nations   NationDB の items
 * @param {object[]} a.cities    CityDB の items
 * @param {object[]} a.terrains  TerrainDB の items
 * @param {Record<string, object>} a.i18n  言語 → i18n/<lang>.json（英語以外）
 * @param {Record<string, object>} a.categories  ui.json の categories（分類 → { en, ja, … }）
 * @param {object[]} [a.admin0]  NE admin_0_countries の地物（国の略称・別名を足す・無くてもよい）
 * @param {string[]} a.langs     言語コード（26・en を含む）
 * @param {(i: number, en: string, kind: string) => boolean} [a.keep]  部分集合（検定の試料）＝真の件と参照先だけ残す
 * @returns {{ base: object, tables: Record<string, object>, report: object }}
 */
export function buildSearchIndex({ features, nations, cities = [], terrains = [], i18n = {}, categories = {}, admin0 = [], langs, updated = new Date().toISOString().slice(0, 10), source = "", keep = null }) {
	const LANGS = langs.filter(l => l !== "en");
	const kinds = ["country", "state", "city", ...Object.keys(categories).filter(k => !["country", "state", "city"].includes(k))];   // 地形の分類に "region"（地域＝サヘル等）がある＝州は "state"
	const KIND = new Map(kinds.map((k, i) => [k, i]));
	const items = [], en = [], alt = new Map(), names = Object.fromEntries(LANGS.map(l => [l, []])), lalt = Object.fromEntries(LANGS.map(l => [l, new Map()]));
	const addAlt = (m, i, arr, primary) => {
		const seen = new Set([primary, ...(m.get(i) || [])].filter(Boolean));
		const v = arr.map(s => String(s ?? "").trim()).filter(s => s && !seen.has(s) && (seen.add(s), true));
		if (v.length) m.set(i, [...(m.get(i) || []), ...v]);
	};
	// 1 件足す：nm＝{ en, alts, [lang]: { name, alts } }
	const push = (row, nm) => {
		const i = items.length;
		items.push(row); en.push(nm.en);
		addAlt(alt, i, nm.alts || [], nm.en);
		for (const l of LANGS) {
			const x = nm[l] || {}, name = x.name && x.name !== nm.en ? x.name : 0;
			names[l].push(name);
			addAlt(lalt[l], i, x.alts || [], name || nm.en);
		}
		return i;
	};
	const report = { countries: 0, states: 0, cities: 0, citydb: 0, terrains: 0, statesMergedIntoCity: 0, citiesWithState: 0 };

	// ── 国 ──
	const byKey = new Map(), admin1ByKey = new Map();
	for (const f of features) if (f.properties?.layer === "admin_1") { const k = f.properties.key; let a = admin1ByKey.get(k); if (!a) admin1ByKey.set(k, a = []); a.push(f); }
	const a0ByQid = new Map(), a0ByIso = new Map();
	for (const f of admin0) { const p = f.properties || {}; if (p.WIKIDATAID) a0ByQid.set(p.WIKIDATAID, p); const iso = /^[A-Z]{2}$/.test(p.ISO_A2) ? p.ISO_A2 : p.ISO_A2_EH; if (/^[A-Z]{2}$/.test(iso || "") && !a0ByIso.has(iso)) a0ByIso.set(iso, p); }
	const official = (tpl, name) => tpl && tpl.includes("_") ? tpl.replace("_", name) : tpl;
	for (const n of nations) {
		if (!n.coord || !n.key) continue;
		const parts = (admin1ByKey.get(n.key) || []).flatMap(f => partsOf(f.geometry));
		const bb = parts.length ? nearBbox(parts, n.coord, n.area) : null;
		const view = bb || squareBbox(n.coord, n.area);
		const a0 = a0ByQid.get(n.qid) || a0ByIso.get(n.iso?.[0]) || {};
		const nameEn = n.name?.en || n.key;
		const nm = {
			en: nameEn,
			alts: [official(n.official, nameEn), ...(n.iso || []).filter(x => typeof x === "string"), n.ioc, a0.NAME, a0.NAME_LONG, a0.BRK_NAME, a0.FORMAL_EN, a0.NAME_ALT, a0.ABBREV && String(a0.ABBREV).replace(/\./g, "")],
		};
		for (const l of LANGS) {
			const t = i18n[l]?.nations?.[n.key], ne = a0["NAME_" + l.toUpperCase()];
			nm[l] = { name: t?.name || ne || null, alts: [t?.official && official(t.official, t.name), t?.yomi, ne, l === "zh" ? a0.NAME_ZHT : null] };
		}
		const imp = 1000 + Math.round(10 * Math.log10((n.area || 1) + 1));
		byKey.set(n.key, push([KIND.get("country"), n.coord[0], n.coord[1], imp, -1, -1, view, qidNum(n.qid)], nm));
		report.countries++;
	}

	// ── 都市（先に集める＝州と QID が同じなら州を落とす：パリ県＝パリ・東京都＝東京）──
	const places = features.filter(f => f.properties?.layer === "populated_places" && f.geometry?.type === "Point");
	const placeQids = new Set(places.map(f => f.properties.WIKIDATAID).filter(Boolean));

	// ── 州 ──
	const mergedState = new Map();   // QID → 都市に畳んだ州の属性
	const regionIdx = new Map();   // key + "\n" + 名前（英語・別名） → items 添字（都市の ADM1NAME と突き合わせる）
	for (const [key, fs] of admin1ByKey) {
		const ni = byKey.get(key); if (ni == null) continue;
		for (const f of fs) {
			const p = f.properties;
			if (p.wikidataid && placeQids.has(p.wikidataid)) {   // 州＝都市（パリ県・東京都）＝都市 1 件に畳み、州の名前は都市の別名へ（「Tokio」「東京都」で引ける）
				mergedState.set(p.wikidataid, p); report.statesMergedIntoCity++; continue;
			}
			const parts = partsOf(f.geometry); if (!parts.length) continue;
			const km2 = parts.reduce((s, x) => s + x.km2, 0);
			const coord = Number.isFinite(+p.longitude) && Number.isFinite(+p.latitude) ? [+p.longitude, +p.latitude] : null;
			const bb = nearBbox(parts, coord, km2, 2) || nearBbox(parts, null, km2);
			if (!bb) continue;
			const c = coord || [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
			const nameEn = p.name_en || p.name;
			const nm = { en: nameEn, alts: [p.name, p.name_local, ...splitAlt(p.name_alt)] };
			for (const l of LANGS) nm[l] = { name: p["name_" + l] || null, alts: l === "zh" ? [p.name_zht] : [] };
			const i = push([KIND.get("state"), c[0], c[1], Math.round(10 * Math.log10(km2 + 1)), ni, -1, bb, qidNum(p.wikidataid)], nm);
			for (const s of [nameEn, p.name, ...splitAlt(p.name_alt)]) if (s) { const k = key + "\n" + s.toLowerCase(); if (!regionIdx.has(k)) regionIdx.set(k, i); }
			report.states++;
		}
	}

	// ── 都市（NE populated_places）──
	const placeAt = new Map();   // key＋英語名 → 位置（台帳の都市の重複を落とす：CityDB の「Tokyo Proper」＝NE の Tokyo と同じ所）
	const cityI18n = qid => Object.fromEntries(LANGS.map(l => [l, i18n[l]?.cities?.[qid]?.name || null]));
	for (const f of places) {
		const p = f.properties, key = p.key, ni = byKey.get(key) ?? -1;
		const [lon, lat] = f.geometry.coordinates;
		const pop = num(p.POP_MAX), cap = +p.ADM0CAP === 1;
		const pi = p.ADM1NAME ? regionIdx.get(key + "\n" + String(p.ADM1NAME).toLowerCase()) ?? -1 : -1;
		if (pi >= 0) report.citiesWithState++;
		const nameEn = p.NAME_EN || p.NAME;
		const cur = p.WIKIDATAID ? cityI18n(p.WIKIDATAID) : {};
		const st = mergedState.get(p.WIKIDATAID) || {};
		const nm = { en: nameEn, alts: [p.NAME, p.NAMEASCII, ...splitAlt(p.NAMEALT), st.name_en, st.name, st.name_local, ...splitAlt(st.name_alt)] };
		for (const l of LANGS) {
			const ne = p["NAME_" + l.toUpperCase()] || null, db = cur[l];
			// 表示名＝地図の注記と同じ順（ja＝NAME_JA の「〜市」族落とし／他＝World DB の台帳名→NE の言語名）
			const shown = l === "ja" ? (ne ? stripJaCitySuffix(ne) : db) : db || ne;
			nm[l] = { name: shown, alts: [ne, db, l === "zh" ? p.NAME_ZHT : null, l === "ja" ? i18n.ja?.cities?.[p.WIKIDATAID]?.yomi : null, st["name_" + l]] };
		}
		const nk = key + "\n" + String(nameEn).toLowerCase(); let a = placeAt.get(nk); if (!a) placeAt.set(nk, a = []); a.push([lon, lat]);
		const imp = Math.round(10 * Math.log10(pop + 1)) + (cap ? 15 : 0) + (+p.WORLDCITY === 1 ? 3 : 0);
		push([KIND.get("city"), lon, lat, imp, ni, pi, cityZoom(pop), qidNum(p.WIKIDATAID)], nm);
		report.cities++;
	}
	// 台帳の都市（CityDB）で NE に無い物
	for (const c of cities) {
		if (!c.qid || placeQids.has(c.qid) || !c.coords) continue;
		const near = placeAt.get(c.nation?.[0] + "\n" + String(c.name?.en || "").toLowerCase())?.some(([x, y]) => Math.hypot((x - c.coords[0]) * Math.cos(y * Math.PI / 180), y - c.coords[1]) < 0.3);
		if (near) { report.citydbDup = (report.citydbDup || 0) + 1; continue; }
		const pop = num(c.population?.[1]);
		const nm = { en: c.name?.en || c.qid, alts: [] };
		for (const l of LANGS) { const t = i18n[l]?.cities?.[c.qid]; nm[l] = { name: t?.name || null, alts: [l === "ja" ? t?.yomi : null] }; }
		push([KIND.get("city"), c.coords[0], c.coords[1], Math.round(10 * Math.log10(pop + 1)) + (c.capital ? 15 : 0), byKey.get(c.nation?.[0]) ?? -1, -1, cityZoom(pop), qidNum(c.qid)], nm);
		report.citydb++;
	}

	// ── 地形 ──
	for (const t of terrains) {
		if (!t.coord || !KIND.has(t.category)) continue;
		const nm = { en: t.name?.en || t.qid, alts: [t.wiki?.en] };
		for (const l of LANGS) { const x = i18n[l]?.terrains?.[t.qid]; nm[l] = { name: x?.name || null, alts: [x?.wiki] }; }
		push([KIND.get(t.category), t.coord[0], t.coord[1], terrainImp(t), -1, -1, terrainView(t), qidNum(t.qid)], nm);
		report.terrains++;
	}

	report.items = items.length;
	report.langs = Object.fromEntries(LANGS.map(l => [l, names[l].filter(Boolean).length]));
	// 部分集合（検定の試料）＝keep(i, 英語名, kind) が真の件と、それが参照する国・州だけ。添字は詰め直す
	let order = items.map((_, i) => i);
	if (keep) {
		const want = new Set();
		items.forEach((row, i) => { if (keep(i, en[i], kinds[row[0]])) { want.add(i); if (row[4] >= 0) want.add(row[4]); if (row[5] >= 0) want.add(row[5]); } });
		order = [...want].sort((a, b) => a - b);
	}
	const at = new Map(order.map((o, j) => [o, j]));
	const altList = m => [...m].filter(([i]) => at.has(i)).map(([i, v]) => [at.get(i), ...v]);
	const kindNames = l => kinds.map(k => categories[k]?.[l] || "");
	const delta = a => a.map((v, i) => i ? v - a[i - 1] : v);
	const rows = order.map(i => items[i]);
	const encView = (v, lon, lat) => Array.isArray(v) && v.length === 4 ? [c100(v[0] - lon), c100(v[1] - lat), c100(v[2] - lon), c100(v[3] - lat)] : Array.isArray(v) ? v.map(r2) : r2(v);
	const base = {
		v: SEARCH_VERSION, updated, source, n: rows.length, kinds, kindNames: kindNames("en"),
		kind: rows.map(r => r[0]), lon: delta(rows.map(r => c100(r[1]))), lat: delta(rows.map(r => c100(r[2]))), imp: rows.map(r => r[3]),
		nation: rows.map(r => r[4] >= 0 ? at.get(r[4]) : -1), parent: rows.map(r => r[5] >= 0 ? at.get(r[5]) : -1),
		view: rows.map(r => encView(r[6], c100(r[1]) / 100, c100(r[2]) / 100)), qid: rows.map(r => r[7]),
		en: order.map(i => en[i]), alt: altList(alt),
	};
	const tables = Object.fromEntries(LANGS.map(l => [l, { v: SEARCH_VERSION, lang: l, updated, names: order.map(i => names[l][i]), alt: altList(lalt[l]), kindNames: kindNames(l) }]));
	return { base, tables, report };
}
