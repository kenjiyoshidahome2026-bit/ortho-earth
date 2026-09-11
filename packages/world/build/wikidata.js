// Wikidata の読み（wbgetentities 50 件束）と「現在の値」の取り出し。
//   current(): preferred rank があればそれだけ・無ければ終了日（P582）の無い normal rank ＝ 歴史値（旧首都・旧通貨）を落とす
const API = "https://www.wikidata.org/w/api.php?format=json&origin=*&action=wbgetentities";

export async function entities(qids, env, { props = "claims|labels|sitelinks", languages = null, sites = null } = {}) {
	const ids = [...new Set(qids.filter(Boolean))], out = {};
	for (let i = 0; i < ids.length; i += 50) {
		const url = `${API}&props=${props}` + (languages ? `&languages=${languages.join("|")}` : "") + (sites ? `&sitefilter=${sites.join("|")}` : "") + `&ids=${ids.slice(i, i + 50).join("|")}`;
		const v = await env.json(url);
		Object.assign(out, (v && v.entities) || {});
	}
	return out;
}
const claims = (e, p) => (e && e.claims && e.claims[p]) || [];
const value = c => c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : undefined;
export function current(e, p) {
	const all = claims(e, p), pref = all.filter(c => c.rank == "preferred");
	const use = pref.length ? pref : all.filter(c => c.rank == "normal" && !(c.qualifiers && c.qualifiers.P582));
	return use.map(value).filter(v => v !== undefined);
}
export const ids = (e, p) => current(e, p).map(v => v && v.id).filter(Boolean);
// 「部分にのみ適用」（P518 applies to part / P1001 applies to jurisdiction）の claim を除いた現在値＝国全体の値（公用語・面積）
export function national(e, p) {
	const all = claims(e, p).filter(c => c.rank != "deprecated" && !(c.qualifiers && (c.qualifiers.P518 || c.qualifiers.P1001)));
	const pref = all.filter(c => c.rank == "preferred"), use = pref.length ? pref : all.filter(c => !(c.qualifiers && c.qualifiers.P582));
	return use.map(value).filter(v => v !== undefined);
}
export const idsNational = (e, p) => national(e, p).map(v => v && v.id).filter(Boolean);
// 面積: 国全体の claim があればそれ・無ければ（部分値しか無い国＝BA）最大値＝総面積
export function areaKm2(e) {
	const conv = v => { const u = String(v.unit || "").split("/").pop(); return u in AREA_UNITS ? +v.amount * AREA_UNITS[u] : null; };
	const whole = national(e, "P2046").map(conv).filter(v => v != null); if (whole.length) return whole[0];
	const parts = claims(e, "P2046").filter(c => c.rank != "deprecated").map(value).map(conv).filter(v => v != null);
	return parts.length ? Math.max(...parts) : null;
}
const AREA_UNITS = { Q712226: 1, Q25343: 1e-6, Q35852: 0.01, Q232291: 2.589988 };   // km² / m² / ha / sq mi
// 国歌の音源: 国の P85 claim の修飾子 P51（音源）を優先（GB/ES 等は国歌項目側に P51 が無い）→ 無ければ国歌項目の P51
export function anthemFile(e, anthemEntity) {
	for (const c of claims(e, "P85")) {
		if (c.rank == "deprecated") continue;
		const q = c.qualifiers && c.qualifiers.P51 && c.qualifiers.P51[0].datavalue; if (q && typeof q.value == "string") return q.value;
	}
	return strings(anthemEntity, "P51")[0] || null;
}
// 英語名: label が無い項目（St. John's）は enwiki の記事名から（括弧・カンマ以降を落とす）
export const nameEn = e => label(e, "en") || sitelink(e, "en").replace(/ \(.*\)$/, "").split(", ")[0];
export const strings = (e, p) => current(e, p).filter(v => typeof v == "string");
export const label = (e, lang) => (e && e.labels && e.labels[lang] && e.labels[lang].value) || "";
export const sitelink = (e, lang) => (e && e.sitelinks && e.sitelinks[lang + "wiki"] && e.sitelinks[lang + "wiki"].title) || "";
export const year = t => t && t.time ? +t.time.slice(1, 5) : 0;   // "+1956-12-18T00:00:00Z"
export const date = t => t && t.time ? t.time.slice(1, 11).replace(/-00/g, "-01") : "";
// 数量（単位換算表: 単位 QID → 係数）。例 面積 { Q712226: 1 (km²), Q25343: 1e-6 (m²), Q35852: 0.01 (ha), Q232291: 2.589988 (sq mi) }
export function quantity(e, p, units) {
	for (const v of current(e, p)) { const u = String(v.unit || "").split("/").pop(); if (u in units) return +v.amount * units[u]; }
	return null;
}
export function coord(e) { const v = current(e, "P625")[0]; return v ? [+(+v.longitude).toFixed(4), +(+v.latitude).toFixed(4)] : null; }
// 時点（P585）付きの数量＝最新の時点のもの → [年, 値]。人口（P1082）用。rank は deprecated 以外すべて見る
export function latestByTime(e, p) {
	let best = null;
	for (const c of claims(e, p)) {
		if (c.rank == "deprecated") continue;
		const v = value(c); if (!v || v.amount === undefined) continue;
		const t = c.qualifiers && c.qualifiers.P585 && c.qualifiers.P585[0].datavalue ? year(c.qualifiers.P585[0].datavalue.value) : 0;
		if (!best || t > best[0]) best = [t, Math.round(+v.amount)];
	}
	return best;
}
// 所属（P463 等）の開始日: 対象 QID に一致する現在の claim の P580
export function membershipSince(e, p, target) {
	for (const c of claims(e, p)) {
		if (c.rank == "deprecated") continue;
		const v = value(c); if (!v || v.id != target) continue;
		if (c.qualifiers && c.qualifiers.P582) continue;   // 終了済み
		const st = c.qualifiers && c.qualifiers.P580 && c.qualifiers.P580[0].datavalue;
		return st ? date(st.value) : "?";
	}
	return null;
}
