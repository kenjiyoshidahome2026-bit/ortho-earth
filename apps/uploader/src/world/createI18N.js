// ── i18n テーブル生成（2026-09-10）── 英語基軸・言語別テーブルを bucket に置く（クライアントは選択言語の1本だけ読む）
// en wiki id（NationDB/CityDB/LanguageDB/CurrencyDB の wiki.en）→ QID → Wikidata wbgetentities（labels=名前・sitelinks=記事名）
// UI 文言は packages/world/i18n/ui.json（英語キー→各言語）を同梱。出力: GIS/world/i18n/<lang>.json
import ui from "../../../../packages/world/i18n/ui.json";
import { wiki } from "common/wiki.js";

export async function createI18N(ctx, q) {
	const { db } = ctx;
	const LANGS = ui.langs.map(l => l.code);
	const [N, C, LG, CU] = await Promise.all([db.loadNationDB(), db.loadCityDB(), db.loadLanguageDB(), db.loadCurrencyDB()]);
	if (!N) throw new Error("NationDB が未収蔵");
	const items = [];   // [種別, キー, en pageid]
	N.forEach(t => t.wiki && t.wiki.en && items.push(["nations", t.key, t.wiki.en]));
	(C || []).forEach(c => c.wiki && c.wiki.en && items.push(["cities", String(c.wiki.ja), c.wiki.en]));
	(LG || []).forEach(l => l.wiki && l.wiki.en && items.push(["languages", l.key, l.wiki.en]));
	(CU || []).forEach(c => c.wiki && c.wiki.en && items.push(["currencies", c.key, c.wiki.en]));
	const ids = [...new Set(items.map(t => t[2]))];
	q.log(`対象 ${items.length} 件（en pageid ${ids.length}）→ QID 解決…`);
	const qids = await wiki.id2qid(ids, "en");
	const q2 = {}; ids.forEach((id, i) => qids[i] && (q2[id] = qids[i]));
	const qs = [...new Set(Object.values(q2))], ent = {};
	for (let i = 0; i < qs.length; i += 50) {
		const b = qs.slice(i, i + 50);
		const url = `https://www.wikidata.org/w/api.php?format=json&origin=*&action=wbgetentities&props=labels|sitelinks&languages=${LANGS.join("|")}&sitefilter=${LANGS.map(l => l + "wiki").join("|")}&ids=${b.join("|")}`;
		const v = await fetch(url).then(r => r.json()).catch(() => null);
		Object.assign(ent, (v && v.entities) || {});
		q.log(`wikidata ${Math.min(i + 50, qs.length)}/${qs.length}`);
	}
	const out = {}; LANGS.forEach(l => out[l] = { nations: {}, cities: {}, languages: {}, currencies: {} });
	items.forEach(([kind, key, pid]) => {
		const e = ent[q2[pid]]; if (!e) return;
		LANGS.forEach(l => {
			const lab = e.labels && e.labels[l] && e.labels[l].value, sl = e.sitelinks && e.sitelinks[l + "wiki"] && e.sitelinks[l + "wiki"].title;
			if (!(lab || sl)) return;
			const rec = { name: lab || sl }; sl && (rec.wiki = sl);
			out[l][kind][key] = rec;
		});
	});
	const today = new Date().toISOString().slice(0, 10);
	for (const l of LANGS) {
		const doc = { updated: today, lang: l, rtl: !!(ui.langs.find(x => x.code == l) || {}).rtl, ...out[l],
			ui: l == "en" ? {} : Object.fromEntries(Object.entries(ui.ui).map(([k, v]) => [k, v[l]])) };
		await db.saveJSON(`i18n/${l}`, doc);
		const missN = N.filter(t => !out[l].nations[t.key]).map(t => t.name.ja);
		q.log(`${l}: ${Object.values(out[l]).reduce((s, o) => s + Object.keys(o).length, 0)} 件${missN.length ? `／国名の欠け ${missN.length}: ${missN.slice(0, 12).join("・")}${missN.length > 12 ? "…" : ""}` : ""}`);
	}
	return LANGS;
}
