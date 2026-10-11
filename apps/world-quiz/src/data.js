// World（apps/world）の台帳をそのまま食う＝国名・国旗・首都・位置を重複して持たない（データは bucket GIS/world・IDB の写しで即起動）。
// 読込は World の data.js（loadWorld＝IDB 優先・裏で更新）。ここでは NationDB の 1 件をクイズ向けに平らにするだけ。
import { loadWorld, ASSET_BASE } from "../../world/src/data.js";

export const flagURL = key => `${ASSET_BASE}flags/${encodeURIComponent(key)}.svg`;
const latest = series => Array.isArray(series) ? (series.slice(1).find(v => v) || 0) : 0;   // [年, 最新, 前年…]（欠測は null）

export async function loadCountries(lang) {
	const data = await loadWorld(lang);
	const cities = new Map(data.cities.map(c => [c.qid, c]));
	const i18n = data.i18n || {}, N = i18n.nations || {}, C = i18n.cities || {}, UI = i18n.ui || {};
	const hasFlag = k => data.flags.has(k);
	const countries = data.nations.map(n => {
		const e = N[n.key] || {}, city = n.capital ? cities.get(n.capital) : null, ce = city ? (C[city.qid] || {}) : {};
		const flagKey = hasFlag(n.key) ? n.key : (n.territory && hasFlag(n.territory)) ? n.territory : (data.flags.size ? null : n.key);   // 一覧が取れていない時は自分の旗を信じる
		return {
			key: n.key, iso2: n.iso ? n.iso[0] : "", qid: n.qid,
			name: e.name || n.name?.en || n.key, nameEn: n.name?.en || n.key, yomi: e.yomi || "",
			capital: city ? (ce.name || city.name?.en || "") : "", capitalEn: city?.name?.en || "", capitalCoord: city?.coords || null,
			region: String(n.region ?? ""), population: latest(n.population), area: n.area || 0, un: n.un || null,
			territory: n.territory || null, conflict: n.conflict || null, flagKey, coord: n.coord || null, wiki: e.wiki ? [lang, e.wiki] : n.wiki?.en ? ["en", n.wiki.en] : null,
		};
	});
	return { countries, warm: data.warm, regionName: en => UI[en] || en };   // regionName＝World の UI 訳（Asia→アジア）をそのまま借りる
}
