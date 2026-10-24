// World（apps/world）の台帳をそのまま食う＝国名・国旗・首都・位置を重複して持たない（データは bucket GIS/world・IDB の写しで即起動）。
// 読込は World の data.js（loadWorld＝IDB 優先・裏で更新）。ここでは NationDB の 1 件をクイズ向けに平らにするだけ。
import { loadWorld, ASSET_BASE } from "world-data/data";
import type { QuizCountry } from "./quiz.ts";

// NationDB・CityDB の 1 件のうちここで読む欄（中身は JSON のまま＝WorldPack は unknown で渡す）
type En = { en?: string };
interface WorldNation { key: string; iso?: string[]; qid?: string; name?: En; capital?: string; region?: unknown; population?: unknown; area?: number; un?: unknown; territory?: string; conflict?: string; coord?: number[]; wiki?: En }
interface WorldCity { qid: string; name?: En; coords?: number[] }
type NameRow = { name?: string; wiki?: string };

export const flagURL = (key: string): string => `${ASSET_BASE}flags/${encodeURIComponent(key)}.svg`;
const latest = (series: unknown): number => Array.isArray(series) ? (series.slice(1).find((v: unknown) => v) || 0) : 0;   // [年, 最新, 前年…]（欠測は null）

export async function loadCountries(lang: string): Promise<{ countries: QuizCountry[]; warm: boolean; regionName: (en: string) => string }> {
	const data = await loadWorld(lang);
	const cities = new Map((data.cities as WorldCity[]).map(c => [c.qid, c]));
	const i18n = data.i18n || {}, N = (i18n.nations || {}) as Record<string, NameRow>, C = (i18n.cities || {}) as Record<string, NameRow>, UI = (i18n.ui || {}) as Record<string, string>;
	const hasFlag = (k: string): boolean => data.flags.has(k);
	const countries = (data.nations as WorldNation[]).map((n): QuizCountry => {
		const e: NameRow = N[n.key] || {}, city = n.capital ? cities.get(n.capital) : null, ce: NameRow = city ? (C[city.qid] || {}) : {};
		const flagKey = hasFlag(n.key) ? n.key : (n.territory && hasFlag(n.territory)) ? n.territory : (data.flags.size ? null : n.key);   // 一覧が取れていない時は自分の旗を信じる
		return {
			key: n.key, iso2: n.iso ? n.iso[0] : "", qid: n.qid,
			name: e.name || n.name?.en || n.key, nameEn: n.name?.en || n.key,
			capital: city ? (ce.name || city.name?.en || "") : "", capitalEn: city?.name?.en || "", capitalCoord: city?.coords || null,
			region: String(n.region ?? ""), population: latest(n.population), area: n.area || 0, un: n.un || null,
			territory: n.territory || null, conflict: n.conflict || null, flagKey, coord: n.coord || null, wiki: e.wiki ? [lang, e.wiki] : n.wiki?.en ? ["en", n.wiki.en] : null,
		};
	});
	return { countries, warm: data.warm, regionName: (en: string) => UI[en] || en };   // regionName＝World の UI 訳（Asia→アジア）をそのまま借りる
}
