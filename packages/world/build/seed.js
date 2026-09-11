// seed（人が手で持つ正本）の読み込み。read(name) はファイル名 → テキストを返す関数（Node=fs・ブラウザ=fetch）
import { parseCSV } from "./csv.js";
export const SEED_FILES = ["nations.csv", "cities.csv", "terrains.csv", "conflicts.json", "overrides.json", "capital-notes.json", "aliases.json", "ja.json"];
export async function loadSeed(read) {
	const J = async n => JSON.parse(await read(n));
	const nations = parseCSV(await read("nations.csv")).map(r => ({ ...r, region: +r.region }));
	const cities = parseCSV(await read("cities.csv")).map(r => ({ qid: r.qid, nation: r.nation.split("|").filter(Boolean), capital: r.capital === "1" }));
	const terrains = parseCSV(await read("terrains.csv")).map(r => ({ qid: r.qid, category: r.category, name_en: r.name_en, ne_extra: (r.ne_extra || "").split("|").filter(Boolean), axis: r.axis || "", rank: r.rank === "" || r.rank === undefined ? null : +r.rank, lon: r.lon ? +r.lon : null, lat: r.lat ? +r.lat : null }));   // 地形＝scripts/terrains-from-ne.py が Natural Earth から生成（rank=NE scalerank・lon/lat=NE の代表点＝Wikidata に座標が無い時の位置）（山脈・半島・砂漠・平原・海嶺・海溝・島・諸島）＝QID 基軸
	const [conflicts, overrides, capitalNotes, aliases, ja, ui] = await Promise.all([J("conflicts.json"), J("overrides.json"), J("capital-notes.json"), J("aliases.json"), J("ja.json"), J("../i18n/ui.json")]);
	return { nations, cities, terrains, conflicts, overrides, capitalNotes, aliases, ja, ui, langs: ui.langs.map(l => l.code) };
}
