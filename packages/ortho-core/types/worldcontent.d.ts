// @ortho-earth/core/worldcontent — 世界の内容（Natural Earth の国・都市・空港・多言語名）。
/** 台帳・名前・検索の索引（ortho-data の GitHub Pages）。 */
export const WORLD_DATA: string;
export const culturalUrl: (g: string) => string;
export const culturalName: (g: string) => string;
export const WORLD_Z: Record<string, number>;
export const F: (p: Record<string, unknown>, k: string) => unknown;
export const stripJaCitySuffix: (s: string) => string;
export const fetchJsonMaybeGz: (url: string) => Promise<unknown>;
/** NationDB の 1 国（統計は [最新年, 値(最新年), 値(前年), …]＝member 名で引く）。 */
export interface Nation {
	key: string;
	name?: { en?: string; [lang: string]: string | undefined };
	wiki?: { en?: string; [lang: string]: string | undefined };
	/** 正式名の雛形（"People's Republic of _"＝_ に英語名） */
	official?: string;
	iso?: string[]; ioc?: string; qid?: string;
	/** 代表点 [lon, lat] */
	coord?: number[];
	/** 面積 km²（不明＝null） */
	area: number | null;
	region?: number;
	[stat: string]: unknown;
}
/** 国の台帳＝{ items, byKey（key → items の添字）, ja（日本語名表・CSV の名寄せ用）, updated }。 */
export interface NationDB { items: Nation[]; byKey: Map<string, number>; ja: Record<string, { name?: string; wiki?: string; official?: string }>; updated?: string }
export function loadNations(): Promise<NationDB>;
/** 言語別の名前表＝{ nations[key].name, cities[qid].name }（en＝null）。 */
export interface NameTable { nations?: Record<string, { name?: string }>; cities?: Record<string, { name?: string }>; [k: string]: unknown }
export const loadI18n: (lang: string) => Promise<NameTable | null>;
/** NE 由来の都市名（qid → 名前）。en・ja・th と失敗は null。 */
export function loadNeCities(lang: string): Promise<Record<string, string> | null>;
export const countryName: (n: Nation, i18n: NameTable | null | undefined, shortEn: Map<string, string> | null | undefined) => string;
export function cityName(p: Record<string, unknown>, lang: string, i18n: NameTable | null | undefined, neCities: Record<string, string> | null | undefined): string;
/** n＝件数・props(i)＝i 番目の属性。 */
export function shortEnNames(n: number, props: (i: number) => Record<string, unknown> | null): Map<string, string>;
export const WORLD_LABEL: { scale: number; pad: number };
export const labelSize: (px: number) => number;
/** 国名の規則（代表点・出すズーム・大きさ・優先）。coord 無し・面積 0 は null。 */
export function countryLabelRule(n: Nation): { lon: number; lat: number; minZoom: number; size: number; priority: number } | null;
/** 都市の規則（cap＝首都・dot＝点の半径）。 */
export function cityLabelRule(p: Record<string, unknown>): { cap: boolean; minZoom: number; priority: number; size: number; dot: number };
export const airportLabelRule: (p: Record<string, unknown>) => { minZoom: number; priority: number };
export const PLANE_PATH: string;
