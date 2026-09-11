// 言語別テーブル i18n/<lang>.json＝{ updated, lang, rtl, nations:{key:{name,wiki[,official,yomi]}}, cities:{qid:…}, languages:{key:…}, currencies:{key:…}, conflicts:{key:…}, ui:{…} }
// 英語は基軸（DB 側の name.en / wiki.en）＝テーブルを作らない。欠けは書かない＝表示側が en へ落ちる
import { label, sitelink } from "./wikidata.js";
export function buildI18N(seed, { NE, CE, LC, KE }, { NationDB, CityDB, LanguageDB, CurrencyDB, Conflicts }) {
	const out = {}, today = new Date().toISOString().slice(0, 10);
	for (const lang of seed.langs) {
		if (lang == "en") continue;
		const one = (e, extra) => { const o = {}; const n = label(e, lang); n && (o.name = n); const w = sitelink(e, lang); w && (o.wiki = w); Object.assign(o, extra || {}); return Object.keys(o).length ? o : null; };
		const tbl = (items, ents, idOf, extra) => { const o = {}; items.forEach(t => { const v = one(ents[t.qid], extra && extra(t)); v && (o[idOf(t)] = v); }); return o; };
		const jaN = lang == "ja" ? seed.ja.nations : {}, jaC = lang == "ja" ? seed.ja.cities : {};
		out[lang] = {
			updated: today, lang, rtl: !!(seed.ui.langs.find(x => x.code == lang) || {}).rtl,
			nations: tbl(NationDB, NE, t => t.key, t => jaN[t.key]),
			cities: tbl(CityDB, CE, t => t.qid, t => jaC[t.qid]),
			languages: tbl(LanguageDB, LC, t => t.key),
			currencies: tbl(CurrencyDB, LC, t => t.key),
			conflicts: tbl(Conflicts, KE, t => t.key),
			ui: Object.fromEntries(Object.entries(seed.ui.ui).map(([k, v]) => [k, v[lang]]).filter(([, v]) => v)),
		};
	}
	return out;
}
