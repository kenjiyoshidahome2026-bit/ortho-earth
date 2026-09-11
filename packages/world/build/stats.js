// 統計の一次ソース。すべて ISO3（nation.iso[1]）で結合＝名前の名寄せ無し。
//   World Bank API（CORS 開放・実績値）を主、IMF WEO（DBnomics ミラー）は WB に無い国の穴埋め、UNDP HDR は CSV、GPI は en.wikipedia の順位表。
//   格納形は [最新年, 最新年値, 前年値, …]（欠測は null）。出所は nation._src[項目] に残す
import { parseCSV } from "./csv.js";
const THIS_YEAR = new Date().getFullYear();
export const ISO3_ALIAS = { KSV: { wb: "XKX", imf: "UVK" } };   // コソボ＝ISO 3166 と符号が違う API
export const HDR_CSV = "https://hdr.undp.org/sites/default/files/2023-24_HDR/HDR23-24_Composite_indices_complete_time_series.csv";   // 年次更新はここ

function assign(nations, title, tub, end, src, { fillOnly = false, digits = 0 } = {}, env) {
	const round = v => digits ? +v.toFixed(digits) : Math.round(v);
	let latest = 0;
	Object.values(tub).forEach(years => Object.keys(years).forEach(y => { y = +y; if (y <= THIS_YEAR && y > latest) latest = y; }));
	if (!latest) return env.warn(`${title}: データなし`);
	let hit = 0;
	for (const t of nations) {
		if (!t.iso) continue;
		if (fillOnly && t[title]) continue;
		const d = tub[t.iso[1]] || tub[(ISO3_ALIAS[t.iso[1]] || {})[src]]; if (!d) continue;
		const a = []; for (let y = latest; y >= end; y--) a.push(d[y] == null ? null : round(d[y]));
		if (a.every(v => v === null)) continue;
		t[title] = [latest].concat(a); t._src[title] = src; hit++;
	}
	env.log(`${title}[${src}${fillOnly ? "/穴埋め" : ""}]: ${latest}..${end}（${hit}か国）`);
}
export async function worldbank(nations, env, title, indicator, end, { scale = 1, digits = 0 } = {}) {
	const v = await env.json(`https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=${end}:${THIS_YEAR}`).catch(() => null);
	if (!v || !v[1]) return env.warn(`${title}: World Bank(${indicator}) 取得失敗`);
	const tub = {};
	v[1].forEach(r => { if (r.value != null && r.countryiso3code) (tub[r.countryiso3code] = tub[r.countryiso3code] || {})[+r.date] = r.value * scale; });
	assign(nations, title, tub, end, "wb", { digits }, env);
}
export async function imf(nations, env, title, subject, end, { scale = 1 } = {}) {
	const url = `https://api.db.nomics.world/v22/series/IMF/WEO:latest?dimensions=${encodeURIComponent(JSON.stringify({ "weo-subject": [subject] }))}&observations=1&limit=1000`;
	const v = await env.json(url).catch(() => null);
	const docs = (v && v.series && v.series.docs) || [];
	if (!docs.length) return env.warn(`${title}: DBnomics(WEO/${subject}) 取得失敗（WB 主データは済・穴埋めのみ不可）`);
	const tub = {};
	docs.forEach(sr => { const years = {}; sr.period.forEach((y, i) => { const val = sr.value[i]; if (typeof val == "number") years[+y] = val * scale; }); tub[sr.series_code.split(".")[0]] = years; });
	assign(nations, title, tub, end, "imf", { fillOnly: true }, env);
}
export async function hdr(nations, env) {
	const text = await env.text(HDR_CSV, { proxy: true }).catch(() => null);
	if (!text) return env.warn("hdi: HDR CSV 取得失敗");
	const rows = parseCSV(text), cols = Object.keys(rows[0] || {}).filter(c => /^hdi_\d{4}$/.test(c)).sort().reverse();
	if (!cols.length) return env.warn("hdi: hdi_YYYY 列が見つからない（HDR の CSV 形式が変わった？）");
	const latest = +cols[0].slice(4), tub = {};
	rows.filter(r => /^[A-Z]{3}$/.test(r.iso3)).forEach(r => { const y = {}; cols.slice(0, 5).forEach(c => { const v = parseFloat(r[c]); if (!isNaN(v)) y[+c.slice(4)] = v; }); tub[r.iso3] = y; });
	assign(nations, "hdi", tub, latest - 4, "hdr", { digits: 3 }, env);
}
// GPI（IEP）: API が無く IEP 配布は非商用限定＝en.wikipedia の順位表（Rank/Country/Score）から。国リンクの記事名→QID で結合。値は最新年 1 本
export async function gpi(nations, env) {
	const v = await env.json(`https://en.wikipedia.org/w/api.php?format=json&origin=*&action=parse&page=Global_Peace_Index&prop=text&formatversion=2&_y=${THIS_YEAR}`).catch(() => null);
	const html = v && v.parse && v.parse.text; if (!html) return env.warn("gpi: en.wikipedia 取得失敗");
	const table = (html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/g) || []).find(t => /Score/.test(t));
	if (!table) return env.warn("gpi: 順位表が見つからない（表の構造が変わった？）");
	const m = html.replace(/<[^>]+>/g, "").match(/(\d{4})\s+Global Peace Index/), year = m ? +m[1] : THIS_YEAR;
	const rows = wikiRows(table).filter(r => r.cells.length >= 3 && r.links.length && /^\d+(\.\d+)?$/.test(r.cells[2])).map(r => ({ title: r.links[r.links.length - 1], score: +r.cells[2] }));
	const qidOf = await titlesToQid(rows.map(r => r.title), env);
	const byQ = {}; nations.forEach(t => byQ[t.qid] = t);
	let hit = 0; const miss = [];
	rows.forEach(({ title, score }) => { const t = byQ[qidOf[title]]; t ? (t.gpi = [year, score], t._src.gpi = "wikipedia-en", hit++) : miss.push(title); });
	miss.length && env.warn(`gpi: NationDB 未突合 ${miss.length}件: ${miss.join("|")}`);
	env.log(`gpi[wikipedia-en ${year}]: ${hit}か国`);
}
// en.wikipedia の記事名 → QID（redirect 解決・50 件束）
export async function titlesToQid(titles, env) {
	const out = {};
	for (let i = 0; i < titles.length; i += 50) {
		const b = titles.slice(i, i + 50);
		const q = await env.json(`https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(b.join("|"))}`).catch(() => null);
		const red = {}; ((q && q.query && q.query.redirects) || []).forEach(r => red[r.from] = r.to);
		const norm = {}; ((q && q.query && q.query.normalized) || []).forEach(r => norm[r.from] = r.to);
		const pages = {}; Object.values((q && q.query && q.query.pages) || {}).forEach(p => pages[p.title] = p);
		b.forEach(t => { const p = pages[red[norm[t] || t] || norm[t] || t]; out[t] = p && p.pageprops && p.pageprops.wikibase_item; });
	}
	return out;
}
// wikitable → 行ごとのセル文字列と国リンク（記事名）。GPI/国連加盟の表に共用
export function wikiRows(table) {
	const rows = [];
	for (const tr of table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
		const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(c => c.replace(/<[^>]+>/g, "").replace(/&#160;|&nbsp;/g, " ").replace(/\[[^\]]*\]/g, "").trim());
		const links = (tr.match(/href="\/wiki\/([^"#]+)"/g) || []).map(l => decodeURIComponent(l.slice(12, -1)).replace(/_/g, " "));
		rows.push({ cells, links });
	}
	return rows;
}
const MONTH = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const isoDate = s => { const m = s && s.match(/(\d{1,2}) (\w+) (\d{4})/); return m && MONTH[m[2]] ? `${m[3]}-${String(MONTH[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };
// 国連加盟日: en.wikipedia「Member states of the United Nations」の表（加盟国リンク＋Date of admission）。Wikidata P463 の開始日は継承国の扱いが揺れる（AZ/YE/EG…）
export async function unMembers(nations, env) {
	const v = await env.json(`https://en.wikipedia.org/w/api.php?format=json&origin=*&action=parse&page=Member_states_of_the_United_Nations&prop=text&formatversion=2&_y=${THIS_YEAR}`).catch(() => null);
	const html = v && v.parse && v.parse.text; if (!html) return env.warn("un: en.wikipedia 取得失敗");
	const table = (html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>[\s\S]*?<\/table>/g) || []).find(t => /Date of admission/.test(t));
	if (!table) return env.warn("un: 加盟国表が見つからない（表の構造が変わった？）");
	const rows = wikiRows(table).map(r => ({ title: r.links[0], date: isoDate(r.cells.find(c => isoDate(c))) })).filter(r => r.title && r.date);
	const qid = await titlesToQid(rows.map(r => r.title), env), byQ = {}; nations.forEach(t => byQ[t.qid] = t);
	let hit = 0; const miss = [];
	rows.forEach(r => { const t = byQ[qid[r.title]]; t ? (t.un = r.date, t._src.un = "wikipedia-en", hit++) : miss.push(r.title); });
	miss.length && env.warn(`un: NationDB 未突合 ${miss.length}件: ${miss.join("|")}`);
	env.log(`un[wikipedia-en]: ${hit}か国`);
}
export async function allStats(nations, env) {
	// API ごとに 1 レーン（同一バックエンドへの同時発射で 504 を誘発した実測 2026-08-31）。WB は頑丈なので並列可
	const lane = fs => (async () => { for (const f of fs) await f(); })();
	await Promise.all([
		worldbank(nations, env, "population", "SP.POP.TOTL", 2010),
		worldbank(nations, env, "gni", "NY.GNP.MKTP.CD", 2021, { scale: 1e-6 }),
		worldbank(nations, env, "gnipc", "NY.GNP.PCAP.CD", 2021),
		worldbank(nations, env, "homicide", "VC.IHR.PSRC.P5", 2015, { digits: 2 }),
		lane([
			() => worldbank(nations, env, "gdp", "NY.GDP.MKTP.CD", 2013, { scale: 1e-6 }), () => imf(nations, env, "gdp", "NGDPD", 2013, { scale: 1000 }),
			() => worldbank(nations, env, "gdppc", "NY.GDP.PCAP.CD", 2017), () => imf(nations, env, "gdppc", "NGDPDPC", 2017),
			() => worldbank(nations, env, "ppp", "NY.GDP.MKTP.PP.CD", 2022, { scale: 1e-6 }), () => imf(nations, env, "ppp", "PPPGDP", 2022, { scale: 1000 }),
			() => worldbank(nations, env, "ppppc", "NY.GDP.PCAP.PP.CD", 2022), () => imf(nations, env, "ppppc", "PPPPC", 2022),
		]),
		hdr(nations, env),
		lane([() => gpi(nations, env), () => unMembers(nations, env)]),
	]);
}
