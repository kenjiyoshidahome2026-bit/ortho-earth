// 国別 DB v2 の組み立て（2026-09-11・Kenji「英語と ID 中心に・美しく」）。
//   正本＝seed/（key・QID・英語名・地域・帰属・例外）。取得＝Wikidata（構造化項目）＋統計 API（stats.js）。合成＝ここ 1 か所。
//   出力＝NationDB / CityDB / TerrainDB / LanguageDB / CurrencyDB / Conflicts / i18n/<lang>（英語以外の名前・記事名）/ rivers（川の形状 GeoJSON＝Natural Earth）/ ranges（山脈の軸線 GeoJSON）。
//   取得元ごとに独立（順番依存なし）・全て QID/ISO で結合（日本語名の名寄せ無し）・保存前に validate。
import { entities, ids, idsNational, strings, label, nameEn, sitelink, quantity, areaKm2, coord, latestByTime, membershipSince, anthemFile } from "./wikidata.js";
import { allStats } from "./stats.js";
import { validate } from "./validate.js";
import { buildI18N } from "./i18n.js";
import { rangeAxis, parseAxis } from "./geom.js";

const UN = "Q1065";
// 川の形状: Natural Earth 10m rivers_lake_centerlines_scale_rank（パブリックドメイン・版固定）。wikidataid で seed の川と結合
const NE_RIVERS = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_rivers_lake_centerlines_scale_rank.geojson";
// 山脈の軸線: Natural Earth 10m geography_regions_polys（Range/mtn ポリゴン・属性名は大文字）→ geom.js で 2〜4 点の軸線に
const NE_REGIONS = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_geography_regions_polys.geojson";
const wikis = langs => langs.map(l => l + "wiki");

export async function buildAll(seed, env) {
	const { langs } = seed, log = env.log, warn = env.warn;
	const opt = { props: "claims|labels|sitelinks", languages: langs, sites: wikis(langs) };
	// 1) 国の実体（Wikidata）
	log(`Wikidata: 国 ${seed.nations.length} 件`);
	const NE = await entities(seed.nations.map(t => t.qid), env, opt);
	seed.nations.forEach(t => NE[t.qid] || warn(`Wikidata に無い QID: ${t.key} ${t.qid}`));
	// 2) 言語・通貨（国の P37/P38 から）→ キー＝ISO 639-1 > 639-3 / ISO 4217
	const langQ = new Set(), curQ = new Set();
	Object.values(NE).forEach(e => { ids(e, "P37").forEach(q => langQ.add(q)); ids(e, "P38").forEach(q => curQ.add(q)); });
	log(`Wikidata: 言語 ${langQ.size} + 通貨 ${curQ.size} 件`);
	const LC = await entities([...langQ, ...curQ], env, opt);
	const langKey = {}, curKey = {}, LanguageDB = [], CurrencyDB = [];
	for (const q of langQ) {
		const e = LC[q], key = (seed.aliases.languages || {})[q] || strings(e, "P218")[0] || strings(e, "P220")[0];   // seed/aliases.json > ISO 639-1 > 639-3
		if (!key) { warn(`言語コード無し（除外）: ${q} ${label(e, "en")}`); continue; }
		langKey[q] = key;   // 同じコードを持つ複数項目（Greek と Modern Greek）は同じキーへ寄せる＝収蔵は先勝ち
		LanguageDB.some(l => l.key == key) || LanguageDB.push({ key, qid: q, name: { en: nameEn(e) }, wiki: { en: sitelink(e, "en") } });
	}
	for (const q of curQ) {
		const e = LC[q], key = strings(e, "P498")[0];
		if (!key) { warn(`通貨コード無し（除外）: ${q} ${label(e, "en")}`); continue; }
		curKey[q] = key;
		CurrencyDB.some(c => c.key == key) || CurrencyDB.push({ key, qid: q, name: { en: nameEn(e) }, wiki: { en: sitelink(e, "en") } });
	}
	LanguageDB.sort((a, b) => a.key < b.key ? -1 : 1); CurrencyDB.sort((a, b) => a.key < b.key ? -1 : 1);
	// 3) 国歌（P85 → 国歌項目 → P51 音源 → commons の mp3 派生）
	const anthemQ = {}; seed.nations.forEach(t => { const q = ids(NE[t.qid], "P85")[0]; q && (anthemQ[t.key] = q); });
	const AE = await entities(Object.values(anthemQ), env, { props: "claims" });
	const files = {}; seed.nations.forEach(t => { const f = anthemFile(NE[t.qid], AE[anthemQ[t.key]]); f && (files[t.key] = f); });
	const mp3 = await commonsMp3([...new Set(Object.values(files))], env);
	// Wikidata に音源が無い国（ID/UA/PT…17 か国）は en.wikipedia の記事の infobox にある音源（mp3 派生）で補う
	const anthemUrl = {}; seed.nations.forEach(t => { const f = files[t.key]; f && (anthemUrl[t.key] = mp3[f] || "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(f)); });
	for (const t of seed.nations) {
		if (anthemUrl[t.key]) continue;
		const title = sitelink(NE[t.qid], "en"); if (!title) continue;
		const v = await env.json(`https://en.wikipedia.org/w/api.php?format=json&origin=*&action=parse&page=${encodeURIComponent(title)}&prop=text&formatversion=2&section=0`).catch(() => null);
		const html = (v && v.parse && v.parse.text) || "", box = (html.match(/<table[^>]*class="[^"]*infobox[^"]*"[\s\S]*?<\/table>/) || [""])[0];
		const src = (box.match(/src="([^"]+\.mp3)"/) || box.match(/src="([^"]+\.(?:ogg|oga|wav|flac))"/) || [])[1];
		src && (anthemUrl[t.key] = src.replace(/^\/\//, "https://"));
	}
	// 4) 首都の解決（seed 明示 > Wikidata P36 の現在値）＋ 都市集合＝seed/cities ∪ 首都
	const capital = {};
	for (const t of seed.nations) {
		if (t.capital) { capital[t.key] = t.capital; continue; }
		const c = ids(NE[t.qid], "P36");
		if (c.length > 1) warn(`首都が複数（seed の capital 列で明示を推奨）: ${t.key} ${c.join(",")}＝先頭を採用`);
		c.length && (capital[t.key] = c[0]);
	}
	const cityRows = new Map(seed.cities.map(c => [c.qid, { ...c }]));
	Object.entries(capital).forEach(([k, q]) => { const c = cityRows.get(q); c ? (c.capital = true, c.nation.includes(k) || c.nation.push(k)) : cityRows.set(q, { qid: q, nation: [k], capital: true }); });
	log(`Wikidata: 都市 ${cityRows.size} 件`);
	const CE = await entities([...cityRows.keys()], env, opt);
	const CityDB = [...cityRows.values()].map(c => {
		const e = CE[c.qid]; e || warn(`Wikidata に無い都市 QID: ${c.qid}`);
		const pop = latestByTime(e, "P1082"), elev = quantity(e, "P2044", { Q11573: 1 }), xy = coord(e);
		return clean({ qid: c.qid, name: { en: nameEn(e) }, nation: c.nation, capital: c.capital || undefined, coords: xy ? (elev != null ? [...xy, Math.round(elev)] : xy) : null, population: pop, wiki: { en: sitelink(e, "en") } });
	}).sort((a, b) => a.name.en < b.name.en ? -1 : 1);
	// 4b) 地形（seed/terrains.csv＝QID・分類・英語名）→ 座標・面積・記事名は Wikidata。国と同じ i18n（ラベル＋サイトリンク）
	log(`Wikidata: 地形 ${seed.terrains.length} 件`);
	const TE = await entities(seed.terrains.map(t => t.qid), env, opt);
	const TerrainDB = seed.terrains.map(t => {
		const e = TE[t.qid]; e || warn(`Wikidata に無い地形 QID: ${t.qid} ${t.name_en}`);
		if (!sitelink(e, "en")) { warn(`地形: 英語版 Wikipedia の記事なし＝除外 ${t.qid} ${t.name_en}`); return null; }   // Kenji 2026-09-11「wiki に無いものはいらない」
		const a = areaKm2(e), h = quantity(e, "P2044", { Q11573: 1 }), L = quantity(e, "P2043", { Q828224: 1, Q11573: 0.001, Q253276: 1.609344 });   // 面積（島・砂漠・湖）・標高（単独峰）・長さ（川 km）は有るものだけ
		const xy = coord(e) || (t.lon != null && t.lat != null ? [t.lon, t.lat] : null);   // Wikidata P625 → 無ければ NE の代表点（seed の lon/lat）
		if (!xy) { warn(`地形: 位置なし＝除外 ${t.qid} ${t.name_en}`); return null; }   // 「場所が特定できないものはいらない」
		return clean({ qid: t.qid, category: t.category, rank: t.rank, name: { en: t.name_en || nameEn(e) }, coord: xy, area: a == null ? null : a > 10 ? Math.round(a) : +a.toFixed(2), elevation: h == null ? null : Math.round(h), length: L == null ? null : Math.round(L), wiki: { en: sitelink(e, "en") } });
	}).filter(Boolean);
	// 4c) 川の形状（Natural Earth）: seed の川 QID（＋ne_extra）に一致する wikidataid の線分を全部集めて 1 本の MultiLineString に（座標は小数 4 桁）
	const riverSeeds = seed.terrains.filter(t => t.category == "river");
	let rivers = null;
	if (riverSeeds.length) {
		log(`Natural Earth: 川の形状（${riverSeeds.length} 件）`);
		const ne = await env.json(NE_RIVERS), byQ = {}, byName = {};   // ne_extra の "~名前" は NE の name_en で結合（wikidataid が無い/壊れている線分）
		for (const f of ne.features) { const P = f.properties || {}, q = P.wikidataid, n = P.name_en || P.name; q && (byQ[q] = byQ[q] || []).push(f); n && (byName["~" + n] = byName["~" + n] || []).push(f); }
		const features = [];
		for (const t of riverSeeds) {
			const fs = [t.qid, ...t.ne_extra].flatMap(q => byQ[q] || byName[q] || []); if (!fs.length) continue;
			const lines = fs.flatMap(f => f.geometry.type == "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates]).map(l => l.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]));
			features.push({ type: "Feature", properties: { qid: t.qid, name: t.name_en, scalerank: Math.min(...fs.map(f => f.properties.scalerank)) }, geometry: { type: "MultiLineString", coordinates: lines } });
		}
		rivers = { type: "FeatureCollection", source: "Natural Earth 10m rivers_lake_centerlines_scale_rank v5.1.2 (public domain)", features };
	}
	// 4d) 山脈の軸線（2〜4 点の LineString）: seed の axis 列（手書き）＞ NE ポリゴン（qid＋ne_extra）から geom.js で自動抽出。表示側で spline＋幅でポリゴン化する
	const rangeSeeds = seed.terrains.filter(t => t.category == "range");
	let ranges = null;
	if (rangeSeeds.length) {
		log(`Natural Earth: 山脈の軸線（${rangeSeeds.length} 件）`);
		const ne = await env.json(NE_REGIONS), byQ = {}, byName = {};   // ne_extra の "~名前" は NE の NAME_EN で結合（東サヤンのように wikidataid が無い区画）
		for (const f of ne.features) { const P = f.properties || {}, q = P.WIKIDATAID || P.wikidataid, n = P.NAME_EN || P.name_en; q && (byQ[q] = byQ[q] || []).push(f); n && (byName["~" + n] = byName["~" + n] || []).push(f); }
		const features = [];
		for (const t of rangeSeeds) {
			const ax = t.axis ? parseAxis(t.axis) : rangeAxis([t.qid, ...t.ne_extra].flatMap(q => byQ[q] || byName[q] || []));
			if (!ax) continue;
			features.push({ type: "Feature", properties: clean({ qid: t.qid, name: t.name_en, width: ax.width, length: ax.length, source: t.axis ? "seed" : "ne" }), geometry: { type: "LineString", coordinates: ax.line } });
		}
		ranges = { type: "FeatureCollection", source: "axis lines derived from Natural Earth 10m geography_regions_polys v5.1.2 (public domain); some hand-drawn in seed", features };
	}
	// 5) 係争地（seed）→ Conflicts と 国側の sovereignt/claim
	const KE = await entities(seed.conflicts.map(c => c.qid), env, opt);
	const Conflicts = seed.conflicts.map(c => clean({ key: c.key, qid: c.qid, type: c.type, region: c.region, name: { en: c.name_en }, exist: c.exist, sovereignt: c.sovereignt || undefined, territory: c.territory || undefined, claim: c.claim && c.claim.length ? c.claim : undefined, wiki: { en: sitelink(KE[c.qid], "en") } }));
	const sov = {}, claim = {};
	for (const c of seed.conflicts) {
		const s = c.territory || c.sovereignt; s && (sov[s] = sov[s] || []).push(c.key);
		(c.claim || []).forEach(k => (claim[k] = claim[k] || []).push(c.key));
	}
	// 6) 国の組み立て
	const NationDB = seed.nations.map(t => {
		const e = NE[t.qid], src = {}, S = (f, v, s) => { if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return undefined; src[f] = s; return v; };
		const iso2 = strings(e, "P297")[0];
		const n = {
			key: t.key, qid: t.qid, name: { en: t.name_en }, official: t.official_en || undefined, region: t.region,
			iso: S("iso", iso2 ? [iso2, strings(e, "P298")[0] || null, +strings(e, "P299")[0] || null] : null, "wikidata"),
			ioc: S("ioc", strings(e, "P984")[0], "wikidata"),
			un: S("un", membershipSince(e, "P463", UN), "wikidata"),
			capital: capital[t.key], territory: t.territory || undefined, conflict: t.conflict || undefined,
			sovereignt: sov[t.key], claim: claim[t.key],
			coord: S("coord", coord(e), "wikidata"),
			area: S("area", (v => v == null ? null : v > 10 ? Math.round(v) : +v.toFixed(2))(areaKm2(e)), "wikidata"),   // 小国は小数 2 桁（バチカン 0.49）
			languages: S("languages", (a => a.length ? a : [...new Set(ids(e, "P37").map(q => langKey[q]).filter(Boolean))])([...new Set(idsNational(e, "P37").map(q => langKey[q]).filter(Boolean))]), "wikidata"),   // 国全体の公用語（P518/P1001 無し）→ 無ければ地域限定も含めて
			currency: S("currency", [...new Set(ids(e, "P38").map(q => curKey[q]).filter(Boolean))], "wikidata"),
			anthem: S("anthem", anthemUrl[t.key], files[t.key] ? "wikidata" : "wikipedia-en"),
			flag: S("flag", strings(e, "P41")[0], "wikidata"),
			wiki: { en: sitelink(e, "en") },
			capitalNote: seed.capitalNotes[t.key],
			_src: src,
		};
		const wp = latestByTime(e, "P1082"); wp && (n.population = wp, src.population = "wikidata");   // 統計 API に無い地域の予備（WB があれば上書き）
		return n;
	});
	// 7) 統計（WB 主・IMF 穴埋め・HDR・GPI）
	await allStats(NationDB, env);
	// 8) 例外の適用（seed/overrides.json＝最優先）
	for (const [key, ov] of Object.entries(seed.overrides)) {
		const t = NationDB.find(n => n.key == key); if (!t) { warn(`overrides: 無い key ${key}`); continue; }
		for (const [f, v] of Object.entries(ov)) { if (f == "_why") continue; t[f] = v; t._src[f] = "override"; }
	}
	// 海外領土で言語/通貨が空なら領有国から継承（GP/RE/… は Wikidata に P37 が無い）
	const byKey = {}; NationDB.forEach(t => byKey[t.key] = t);
	NationDB.forEach(t => { const p = t.territory && byKey[t.territory]; if (!p) return;
		["languages", "currency"].forEach(f => { if (!t[f] && p[f]) { t[f] = p[f]; t._src[f] = "territory"; } }); });
	NationDB.forEach(t => Object.keys(t).forEach(k => t[k] === undefined && delete t[k]));
	// 9) 検札
	const report = validate({ NationDB, CityDB, TerrainDB, LanguageDB, CurrencyDB, Conflicts, rivers: rivers && new Set(rivers.features.map(f => f.properties.qid)), ranges: ranges && new Set(ranges.features.map(f => f.properties.qid)) });
	report.warns.forEach(s => warn(s)); report.errors.forEach(s => warn("ERROR " + s));
	// 10) i18n（英語以外の名前・記事名。ja は読み・正式名も）
	const i18n = buildI18N(seed, { NE, CE, LC, KE, TE }, { NationDB, CityDB, TerrainDB, LanguageDB, CurrencyDB, Conflicts });
	return { NationDB, CityDB, TerrainDB, LanguageDB, CurrencyDB, Conflicts, i18n, rivers, ranges, report };
}
// commons のファイル名 → mp3 派生 URL（videoinfo.derivatives）。ogg 原本は Safari/iOS で鳴らない。50 件束
async function commonsMp3(files, env) {
	const out = {};
	for (let i = 0; i < files.length; i += 50) {
		const b = files.slice(i, i + 50);
		const v = await env.json(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=videoinfo&viprop=derivatives&titles=${encodeURIComponent(b.map(f => "File:" + f).join("|"))}`).catch(() => null);
		const norm = {}; ((v && v.query && v.query.normalized) || []).forEach(r => norm[r.to] = r.from);
		Object.values((v && v.query && v.query.pages) || {}).forEach(p => {
			const d = (p.videoinfo && p.videoinfo[0] && p.videoinfo[0].derivatives) || [];
			const m = d.find(x => /audio\/mpeg|mp3/.test(x.type || "") || /\.mp3$/.test(x.src || ""));
			const name = (norm[p.title] || p.title).replace(/^File:/, "");
			m && (out[name] = m.src.replace(/^\/\//, "https://"));
		});
	}
	return out;
}
const clean = o => { Object.keys(o).forEach(k => (o[k] === undefined || o[k] === null || o[k] === "") && delete o[k]); return o; };
