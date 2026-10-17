// 国勢調査の表（計 4 MB 余の JSON）＝JS の束に焼かず、content-hash 名の別アセットとして並行に取る（2026-10-17）。
// 旧＝ui.js・aggregate.js・choropleth.js・bind.js が `import … with { type: "json" }` で直に読み、入口チャンクが 3.7 MB
// （gzip 1.2 MB）になっていた＝エンジンの取得が入口の解析の後ろに並び、コードを 1 行直すたびに表ごと取り直していた。
// 今＝main.js はこの表を引く側を import() で後から読む（エンジンと並走）。表は hash 名＝sw.js の assets/ cache-first で
// 版を跨いで握る（表が変わった時だけ取り直す）。使う側は同期のまま＝ここの top-level await が揃うまで評価を待つ。
import manifestUrl from "@ortho-earth/jp/census/manifest.json?url";
import pop2025Url from "@ortho-earth/jp/census/2025-pop.json?url";
import pop2020Url from "@ortho-earth/jp/census/2020-pop.json?url";
import stats2020Url from "@ortho-earth/jp/census/2020-stats.json?url";
import stats2015Url from "@ortho-earth/jp/census/2015-stats.json?url";
import ages2020Url from "@ortho-earth/jp/census/2020-ages.json?url";
import ages2015Url from "@ortho-earth/jp/census/2015-ages.json?url";
import household2020Url from "@ortho-earth/jp/census/2020-household.json?url";
import household2015Url from "@ortho-earth/jp/census/2015-household.json?url";
import kanaUrl from "@ortho-earth/jp/census/kana.json?url";
import historyUrl from "../history.json?url";
import estatManifestUrl from "../estat/manifest.json?url";

// 表の形（JSON の中身・キー＝市区町村コード 5 桁／県 2 桁）
/** manifest.json の 1 行 */
export interface CensusManifestEntry { code: string; pref: string; prefName: string; name: string; pop: number; male: number; female: number; hh: number; area: number; density: number }
/** 2025-pop.json の 1 件（pop＝[総数, 男, 女]） */
export interface CensusPop2025 { pop: number[]; pop2020: number; popChange: number; hh: number; hh2020: number }
/** 20xx-stats.json の 1 件（2015 は pop・hh も持つ） */
export interface CensusStats { pop?: number[]; hh?: number; ind?: number[]; occ?: number[]; eco?: number[] }
/** 2015-stats.json の 1 件（pop・hh は必ずある） */
export interface CensusStats2015 extends CensusStats { pop: number[]; hh: number }
/** 20xx-household.json の 1 件 */
export interface CensusHousehold { fam?: number[]; own?: number[]; dwell?: number[] }
/** estat/manifest.json の 1 行 */
export interface EstatManifestEntry { code: string; prefCode: string; name: string; size: number }
/** history.json の 1 行＝[YYYYMMDD, コード, 説明] */
export type CityHistoryRow = [number, string, string];

const getJson = async (url: string): Promise<unknown> => {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`[census] ${url} ${r.status}`);
	return r.json();
};

export const [
	CENSUS_MANIFEST, CENSUS_2025_POP, CENSUS_2020_POP, CENSUS_2020_STATS, CENSUS_2015_STATS,
	CENSUS_2020_AGES, CENSUS_2015_AGES, CENSUS_2020_HOUSEHOLD, CENSUS_2015_HOUSEHOLD,
	CENSUS_KANA, CITY_HISTORY, ESTAT_MANIFEST,
] = await Promise.all([
	manifestUrl, pop2025Url, pop2020Url, stats2020Url, stats2015Url,
	ages2020Url, ages2015Url, household2020Url, household2015Url,
	kanaUrl, historyUrl, estatManifestUrl,
].map(getJson)) as [
	CensusManifestEntry[], Record<string, CensusPop2025>, Record<string, number[]>, Record<string, CensusStats>, Record<string, CensusStats2015>,
	Record<string, number[]>, Record<string, number[]>, Record<string, CensusHousehold>, Record<string, CensusHousehold>,
	Record<string, string>, CityHistoryRow[], EstatManifestEntry[],
];
