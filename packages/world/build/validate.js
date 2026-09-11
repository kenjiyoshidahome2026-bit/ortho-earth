// 保存前の機械検札。errors があれば保存しない・warns は報告だけ
// 地形の分類（scripts/terrains-from-ne.py の ORDER と対）
const TERRAIN_CATEGORIES = new Set(["continent", "ocean", "region", "shield", "sea", "bay", "strait", "reef", "island", "islands", "peninsula", "cape", "isthmus", "range", "peak", "pass", "plateau", "plain", "basin", "valley", "desert", "delta", "wetland", "ice", "lake", "river", "waterfall", "canal", "trench", "ridge", "pole"]);
export function validate({ NationDB, CityDB, TerrainDB = [], LanguageDB, CurrencyDB, Conflicts, rivers = null, ranges = null }) {
	const errors = [], warns = [];
	const E = s => errors.push(s), W = s => warns.push(s);
	const keys = new Set(), qids = new Set(), iso2 = new Set();
	const keySet = new Set(NationDB.map(t => t.key)), cityQ = new Set(CityDB.map(c => c.qid)), langK = new Set(LanguageDB.map(l => l.key)), curK = new Set(CurrencyDB.map(c => c.key)), confK = new Set(Conflicts.map(c => c.key));
	for (const t of NationDB) {
		if (!t.key) E(`key なし: ${t.qid}`); else if (keys.has(t.key)) E(`key 重複: ${t.key}`); else keys.add(t.key);
		if (!t.qid) E(`qid なし: ${t.key}`); else if (qids.has(t.qid)) E(`qid 重複: ${t.key} ${t.qid}`); else qids.add(t.qid);
		if (!t.name || !t.name.en) E(`name.en なし: ${t.key}`);
		if (!(t.region >= 1 && t.region <= 6)) E(`region 不正: ${t.key} ${t.region}`);
		if (t.iso) { if (t.iso[0] != t.key && !t.key.startsWith(t.iso[0])) W(`key≠iso2: ${t.key} ${t.iso[0]}`); if (iso2.has(t.iso[0])) E(`iso2 重複: ${t.iso[0]}`); iso2.add(t.iso[0]); }
		if (t.capital && !cityQ.has(t.capital)) E(`capital が CityDB に無い: ${t.key} ${t.capital}`);
		(t.languages || []).forEach(k => langK.has(k) || W(`言語キー未収蔵: ${t.key} ${k}`));
		(t.currency || []).forEach(k => curK.has(k) || W(`通貨キー未収蔵: ${t.key} ${k}`));
		(t.sovereignt || []).forEach(k => confK.has(k) || keySet.has(k) || W(`sovereignt が Conflicts にも国にも無い: ${t.key} ${k}`));   // 国 key も可（AFX→AF 全域）
		(t.claim || []).forEach(k => confK.has(k) || keySet.has(k) || W(`claim が Conflicts にも国にも無い: ${t.key} ${k}`));
		if (!t.capital && !t.territory && t.key != "AQ") W(`首都なし: ${t.key}`);   // 南極（AQ）は首都が存在しない＝warn 対象外（2026-09-11）
		if (!t.population) W(`人口なし: ${t.key}`);
		if (!t.area) W(`面積なし: ${t.key}`);
	}
	for (const t of NationDB) {
		t.territory && !keys.has(t.territory) && E(`territory 参照切れ: ${t.key} → ${t.territory}`);
		t.conflict && !keys.has(t.conflict) && E(`conflict 参照切れ: ${t.key} → ${t.conflict}`);
	}
	const cq = new Set();
	for (const c of CityDB) {
		if (cq.has(c.qid)) E(`city qid 重複: ${c.qid}`); cq.add(c.qid);
		c.nation.forEach(k => keys.has(k) || E(`city の国が無い: ${c.qid} → ${k}`));
		if (!c.name || !c.name.en) W(`city name.en なし: ${c.qid}`);
		if (!c.coords) W(`city 座標なし: ${c.qid} ${c.name && c.name.en}`);
	}
	const tq = new Set();
	for (const t of TerrainDB) {
		if (tq.has(t.qid)) E(`terrain qid 重複: ${t.qid}`); tq.add(t.qid);
		TERRAIN_CATEGORIES.has(t.category) || E(`terrain category 不正: ${t.qid} ${t.category}`);
		if (!t.name || !t.name.en) W(`terrain name.en なし: ${t.qid}`);
		if (!t.coord) W(`terrain 座標なし: ${t.qid} ${t.name && t.name.en}`);
		if (t.category == "peak" && t.elevation == null) W(`peak 標高なし: ${t.qid} ${t.name && t.name.en}`);
		if (t.category == "range" && ranges && !ranges.has(t.qid)) W(`range 軸線なし（NE ポリゴンも seed の axis も無い）: ${t.qid} ${t.name && t.name.en}`);
		if (t.category == "river" && rivers && !rivers.has(t.qid)) W(`river 形状なし（Natural Earth に wikidataid が無い）: ${t.qid} ${t.name && t.name.en}`);
	}
	return { errors, warns };
}
