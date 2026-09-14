// 統計の本体（人口・基本集計・年齢階級・世帯・市区町村履歴＝合計約 3.2 MB の JSON）は入口チャンクに焼かない（2026-09-14）。
// 旧＝census/ui.js・choropleth.js・aggregate.js が静的 import していたため、起動時に全部を JS として読んでいた
// （census2020 の入口チャンク 3.8 MB の主因。エンジン（/japan/lib/ の SDK）は無関係）。
// 初回の描画／ドリル／コロプレスで ensureCensusData() を await し、以後は DATA から同期で引く（値関数は同期のまま）。
// manifest・e-Stat manifest・かな・小地域差分は起動時に要る小物なので静的 import のまま（ui.js）。
export const DATA = {
	CENSUS_2025_POP: null, CENSUS_2020_POP: null, CENSUS_2020_STATS: null, CENSUS_2015_STATS: null,
	CENSUS_2020_AGES: null, CENSUS_2015_AGES: null, CENSUS_2020_HOUSEHOLD: null, CENSUS_2015_HOUSEHOLD: null,
	CITY_HISTORY: null,
};
let _p = null;
export const censusDataReady = () => _p != null && DATA.CENSUS_2020_POP != null;
export function ensureCensusData() {
	// キャッシュ：Promise を 1 回だけ保持（成功後は DATA から同期で引く）。チャンクはハッシュ名の静的ファイル＝ブラウザの HTTP キャッシュに乗る。
	// 失敗（通信断）は Promise を捨てて次回に再試行＝壊れた Promise を握り続けない。
	return _p ??= Promise.all([
		import("./2025-pop.json", { with: { type: "json" } }),
		import("./2020-pop.json", { with: { type: "json" } }),
		import("./2020-stats.json", { with: { type: "json" } }),
		import("./2015-stats.json", { with: { type: "json" } }),
		import("./2020-ages.json", { with: { type: "json" } }),
		import("./2015-ages.json", { with: { type: "json" } }),
		import("./2020-household.json", { with: { type: "json" } }),
		import("./2015-household.json", { with: { type: "json" } }),
		import("../history.json", { with: { type: "json" } }),
	]).then(([p25, p20, s20, s15, a20, a15, h20, h15, hist]) => {
		Object.assign(DATA, { CENSUS_2025_POP: p25.default, CENSUS_2020_POP: p20.default, CENSUS_2020_STATS: s20.default, CENSUS_2015_STATS: s15.default,
			CENSUS_2020_AGES: a20.default, CENSUS_2015_AGES: a15.default, CENSUS_2020_HOUSEHOLD: h20.default, CENSUS_2015_HOUSEHOLD: h15.default, CITY_HISTORY: hist.default });
		return DATA;
	}).catch(err => { _p = null; throw err; });
}
