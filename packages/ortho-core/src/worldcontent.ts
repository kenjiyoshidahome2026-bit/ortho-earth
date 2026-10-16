// 世界帯の中身＝規則の正本 1 本（2026-09-24・本人「equal に入れた情報は最終的に globe に同じ情報を入れるため」「同じデータを 2 つ持ちしない」）。
// 引く側：apps/equal（Equal Earth）・apps/world（国の地図パネル）・packages/globe（世界帯 z<8 の worldContent）。
// ここにあるのは「どのデータを・どの名前で・どのズームから・どの大きさで」という**規則**だけ＝描き方（GL の baker・gint・canvas2D）は各アプリの持ち物。
// 形状は bucket GIS/world/ の同じファイルを同じキャッシュ名で読む＝equal と globe が同じ IDB の実体を共有する（焼き直した配信物を作らない）。
//   ne-cultural-base.geopbf   … admin_1（州＝束ねれば国）・admin_0（係争主体）・populated_places（都市）
//   ne-cultural-detail.geopbf … roads / railroads / urban_areas / airports（国境で切って key ごと）
// 台帳と名前は GitHub Pages（リポ ortho-data の globe/・2026-10-13〜）＝置くのは git push だけ（bucket の鍵が要らない・packages/world/scripts/publish-pages.mjs）。
//   NationDB.json（国の台帳＝代表点 coord・面積 area）・<DB>.i18n/<lang>.json（DB の隣の名前表＝国名・台帳の都市名）・ne-cities/<lang>.json（NE の小さな都市の名前）
// 形状（全アプリが初回に読む 16MB）は Pages の帯域（月 100GB の目安）に載せない＝bucket に残す。
// 配色は worldstyle.js（同じ正本の作法）。
import { gunzip, isGzip } from "geopbf/gzip";

/** 地物の属性（NE の列は大小が揺れる＝F で引く） */
export type Props = Record<string, unknown>;
/** 国の台帳の 1 行（NationDB.items）。統計は member 名の列（[最新年, 値…]＝[k] の口）。
 *  area＝面積 km²（引く側は `> 0` で守る＝欠け・null は「面積なし」）・region＝地域の番号（equal の REGION_NAMES） */
export interface Nation {
	key: string;
	name?: { en?: string; [lang: string]: string | undefined };
	wiki?: { en?: string; [lang: string]: string | undefined };
	/** 正式名の雛形（"People's Republic of _"＝_ に英語名） */
	official?: string;
	iso?: string[]; ioc?: string; qid?: string;
	coord?: [number, number] | number[];
	area?: number | null;
	region?: number;
	[k: string]: unknown;
}
/** 日本語の国名表の 1 行（NationDB.i18n/ja.json の nations[key]＝CSV の名寄せ用・equal） */
export interface NationJa { name?: string; wiki?: string; official?: string; [k: string]: unknown }
/** 国の台帳＝{ items, byKey（key → items の添字）, ja（key → 日本語名）, updated } */
export interface NationDB { items: Nation[]; byKey: Map<string, number>; ja: Record<string, NationJa>; updated: unknown }
/** 言語別の名前表（loadI18n の戻り） */
export interface WorldI18n { nations?: Record<string, { name?: string; [k: string]: unknown }>; cities?: Record<string, { name?: string; [k: string]: unknown }>; [k: string]: unknown }

const WORLD_GIS = "https://api.ortho-earth.com/bucket/GIS/world/";                           // 形状（ne-cultural）
/** 台帳・名前・検索の索引（ortho-data の GitHub Pages）。 */
export const WORLD_DATA = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/globe/";           // 台帳・名前・検索の索引（全ファイルに access-control-allow-origin: *）
/** ne-cultural の配信物（group＝"base" | "detail"）の URL と、geopbf のキャッシュ名（IDB の鍵＝全アプリで同じ綴り） */
export const culturalUrl = (g: string): string => `${WORLD_GIS}ne-cultural-${g}.geopbf`;
export const culturalName = (g: string): string => `ne-cultural-${g}.geopbf`;

// ── 出しズーム（equal の LAYERS と globe の worldContent が同じ値を読む）──
export const WORLD_Z = {
	admin1: 4,        // 州境（同じ国の中の境）
	detailLoad: 5,    // detail（道路・鉄道・市街地・空港）を取りに行くズーム（本人 2026-09-24「道路・鉄道・市街地は z>5」＝見えない帯のために読まない・描かない）
	urban: 5,         // 市街地の塗り（旧 4＝本人裁定で道路・鉄道と揃える）
	roads: 5, rail: 5,
	detailMax: 8,     // 道路・鉄道・市街地を出す上限（本人 2026-09-24「道路・鉄道・市街地は 5〜8」＝その先は地域の基図の領分）
	airport: 5,       // 空港の ✈（本人 2026-09-18「空港の表示は z>5」）
	worldLines: 1.5,  // 川・海洋境界を取りに行くズーム（地物ごとの min_zoom はデータが持つ）
	riverDefault: 6, maritimeDefault: 4,   // min_zoom の無い地物の既定
};

// 属性名は大小無視（bucket 版と shp 版・NE の大文字列で揺れる）
export const F = (p: Props, k: string): unknown => p[k] ?? p[k.toUpperCase()] ?? p[k.toLowerCase()];
const num = (v: unknown, d: number): number => { const n = +(v as number); return Number.isFinite(n) ? n : d; };

// 日本語の都市名から「〜市」族を 1 つだけ落とす（東京都→東京・津市→津・四日市市→四日市）。
// 「都」は語幹が 2 文字以上の時だけ（東京都→東京・京都/成都はそのまま＝本人 2026-09-18）。
export const stripJaCitySuffix = (s: unknown): string => {
	const src = String(s ?? "");
	const t = src.replace(/(特別市|広域市|直轄市|市)$/, "");
	const u = /都$/.test(t) && [...t].length >= 3 ? t.slice(0, -1) : t;
	return u || t || src;
};

// ── 名前表の読み込み（言語ごと・1 ページ 1 回）──
// bucket は圧縮して置くことがある＝gzip の魔法の 2 バイトを見て要る時だけ解く（素の .json() では落ちる・2026-09-18 実測）
export const fetchJsonMaybeGz = async (url: string): Promise<unknown> => {
	const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const b = await r.blob();
	return JSON.parse(await (await isGzip(b) ? await gunzip(b) : b).text());
};
/** 国の台帳（NationDB）＝{ items, byKey, ja, updated }。ja＝日本語の国名表（CSV の名寄せ用・equal） */
export async function loadNations(): Promise<NationDB> {
	const [db, ja] = await Promise.all([fetchJsonMaybeGz(WORLD_DATA + "NationDB.json") as Promise<{ items?: Nation[]; updated?: unknown } & Nation[]>, fetchJsonMaybeGz(WORLD_DATA + "NationDB.i18n/ja.json").catch(() => null) as Promise<{ nations?: Record<string, NationJa> } | null>]);
	const items: Nation[] = db.items || db;
	return { items, byKey: new Map(items.map((n, i) => [n.key, i])), ja: ja?.nations || {}, updated: db.updated };
}
/** DB の隣の名前表（<DB>.i18n/<lang>.json＝{ updated, lang, <節>: { ID: { name, wiki… } } }）を重ねて 1 つに＝{ nations, cities, … }（dbs の分だけ） */
const loadNames = async (lang: string, dbs: string[]): Promise<WorldI18n> => Object.assign({}, ...await Promise.all(dbs.map(db => fetchJsonMaybeGz(`${WORLD_DATA}${db}.i18n/${lang}.json`) as Promise<WorldI18n>)));
/** 言語別の名前表＝{ nations[key].name, cities[qid].name }（国と台帳の都市）。英語は不要＝null。画面の文言（ui）は入らない＝packages/world/i18n/ui.json から */
export const loadI18n = (lang: string): Promise<WorldI18n | null> => lang === "en" ? Promise.resolve(null) : loadNames(lang, ["NationDB", "CityDB"]);
// NE 由来の都市名（言語別・約 6,600 の小さな都市）。en＝基軸・ja＝NAME_JA が配信 geopbf に同梱済み・th＝NE に列が無い＝取りに行かない。
// 失敗は null＝地名が英語で出るだけ（地図は止めない）
const NE_CITY_SKIP = new Set(["en", "ja", "th"]);
export async function loadNeCities(lang: string): Promise<Record<string, string> | null> {
	if (NE_CITY_SKIP.has(lang)) return null;
	try { return (await fetchJsonMaybeGz(`${WORLD_DATA}ne-cities/${lang}.json`) as { names?: Record<string, string> } | null)?.names || null; }
	catch (e) { console.warn(`[world] ne-cities/${lang}: ${(e as Error)?.message ?? e}（都市名は英語のまま）`); return null; }
}

// ── 名前の順（言語ごと）──
// 国：World DB の言語名 → NE admin_1 の短い英語名（shortEn）→ DB の英語名 → key
export const countryName = (n: Nation, i18n: WorldI18n | null | undefined, shortEn: Map<string, string> | null | undefined): string => i18n?.nations?.[n.key]?.name || shortEn?.get(n.key) || n.name?.en || n.key;
// 都市：ja＝NAME_JA（「〜市」族を落とす）／en＝NAME_EN／その他＝World DB の台帳名（564 都市）→ NE の言語別表 → NAME_EN
export function cityName(p: Props, lang: string, i18n: WorldI18n | null | undefined, neCities: Record<string, string> | null | undefined): string {
	if (lang === "ja") return stripJaCitySuffix(F(p, "name_ja") || "") || (F(p, "name_en") as string) || (F(p, "name") as string);
	if (lang === "en") return (F(p, "name_en") as string) || (F(p, "name") as string);
	const qid = F(p, "wikidataid") as string | undefined;
	return (qid && i18n?.cities?.[qid]?.name) || (qid && neCities?.[qid]) || (F(p, "name_en") as string) || (F(p, "name") as string);
}
/** base の admin_1 から国の短い英語名（NE admin＝"Afghanistan"）を集める。属領が主権国名に化ける物（同名が複数 key）は捨てる。
 *  props(i)＝i 番目の属性・n＝件数 */
export function shortEnNames(n: number, props: (i: number) => { layer?: string; admin?: string; key?: string } | null | undefined): Map<string, string> {
	const m = new Map<string, string>();
	for (let i = 0; i < n; i++) { const p = props(i); if (p?.layer === "admin_1" && p.admin && !m.has(p.key!)) m.set(p.key!, p.admin); }
	const cnt = new Map<string, number>(); for (const v of m.values()) cnt.set(v, (cnt.get(v) || 0) + 1);
	for (const [k, v] of m) if (cnt.get(v)! > 1) m.delete(k);
	m.set("US", "United States");   // DB "United States of America" は地図では長い
	return m;
}

// ── 注記の規則（大きさは CSS px の素の値。labelSize で縮尺を掛ける）──
// 縮尺と文字の周りの空き＝equal のラベル層の値そのもの（本人 2026-09-18「少しだけ小さく」＝0.92・衝突判定の pad 4）。
// globe の注記も同じ値で置く＝都市の密度が Equal Earth と揃う（本人 2026-09-24「都市密度は EE に合わせる」）
export const WORLD_LABEL = { scale: 0.92, pad: 4 };
export const labelSize = (px: number): number => Math.round(px * WORLD_LABEL.scale * 2) / 2;   // 0.5px 刻み＝字形が半端な小数でにじまない
/** 国名の注記の規則 */
export interface CountryLabelRule { lon: number; lat: number; minZoom: number; size: number; priority: number }
/** 都市の注記の規則 */
export interface CityLabelRule { cap: boolean; minZoom: number; priority: number; size: number; dot: number }
/** 国名：代表点（NationDB coord）・面積で出すズームと大きさ（大国＝下限から・小国＝寄ってから）。null＝置かない */
export function countryLabelRule(n: Nation): CountryLabelRule | null {
	if (!n.coord || !(n.area! > 0)) return null;
	const a = n.area!;
	const [minZoom, size] = a >= 2e6 ? [-9, 13] : a >= 5e5 ? [2.3, 12] : a >= 1e5 ? [3, 11.5] : a >= 2e4 ? [3.8, 11] : a >= 2e3 ? [4.6, 10.5] : [5.4, 10];
	return { lon: n.coord[0], lat: n.coord[1], minZoom, size, priority: 1 - Math.min(0.9, Math.log10(a) / 8) };
}
/** 都市（NE populated_places）：首都＝ADM0CAP・出すズーム＝MIN_ZOOM（首都は 3 まで下げる）・大きさと優先＝SCALERANK。点以外は null */
export function cityLabelRule(p: Props): CityLabelRule {
	const cap = +(F(p, "adm0cap") as number) === 1, sr = num(F(p, "scalerank"), 8), mz = num(F(p, "min_zoom"), 6);
	return { cap, minZoom: cap ? Math.min(mz, 3) : mz, priority: cap ? 0.2 + sr / 20 : 2 + sr / 20, size: cap ? 11.5 : sr <= 2 ? 11 : sr <= 4 ? 10.5 : 10, dot: cap ? 3 : 2.2 };
}
/** 空港（NE airports）：✈ だけ（名前は出さない）・出しズームは一律・大ハブほど先（scalerank は優先にだけ効かせる） */
export const airportLabelRule = (p: Props): { minZoom: number; priority: number } => ({ minZoom: WORLD_Z.airport, priority: 3 + num(F(p, "scalerank"), 8) / 20 });
// 空港の記号＝Material Icons "flight"（viewBox 24・上向き）＝equal・world・globe で同じ形
export const PLANE_PATH = "M21.5 15.5v-2l-8-5v-5.5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5l-8 5v2l8-2.5v5.5l-2 1.5v1.5l3.5-1 3.5 1v-1.5l-2-1.5v-5.5l8 2.5z";
