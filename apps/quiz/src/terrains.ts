// 地形モードの台帳＝World の TerrainDB（packages/world の生成物・GitHub Pages の ortho-data/globe/＝/globe/physical と同じ物）をそのまま食う。
//   TerrainDB.json＝qid・分類・NE scalerank・代表点・物理量／TerrainDB.i18n/<lang>.json＝名前（英語は TerrainDB の name.en）。分類名は World の ui-table（26 言語）。
//   ここでは 1 件をクイズの形（QuizCountry）に平らにするだけ。地域＝代表点に最も近い国の地域（大陸・大洋・プレート・海流は地域なし＝「世界」でだけ出る）。
import { ASSET_BASE } from "world-data/data";
import { fetchJsonMaybeGz } from "@ortho-earth/core/worldcontent";
import { categories as CATEGORY_NAMES } from "world-data/i18n/ui-table";
import { terrainTier, TERRAIN_GROUP } from "./quiz.ts";
import type { QuizCountry } from "./quiz.ts";

/** TerrainDB の 1 行（ここで読む欄だけ） */
interface Terrain { qid: string; category: string; rank?: number | null; name: { en: string }; coord?: number[]; area?: number; elevation?: number; length?: number; wiki?: { en?: string } }
type NameRow = { name?: string; wiki?: string };
const GLOBAL = new Set(["continent", "ocean"]);   // 地域に寄せない（どの地域にも属さない大きさ）

const dist2 = (a: number[], b: number[]): number => { const dx = ((a[0] - b[0] + 540) % 360) - 180, dy = a[1] - b[1], k = Math.cos((a[1] + b[1]) * Math.PI / 360); return dx * dx * k * k + dy * dy; };

/** 分類名（ui-table の訳・無ければ英語）。頭を大文字に（"mountain range" → "Mountain range"） */
export function categoryName(cat: string, lang: string): string {
	const row = (CATEGORY_NAMES as Record<string, Record<string, string> | undefined>)[cat], s = row?.[lang] || row?.en || cat;
	return s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
}

export async function loadTerrains(lang: string, countries: QuizCountry[]): Promise<QuizCountry[]> {
	const [db, i18n] = await Promise.all([
		fetchJsonMaybeGz(ASSET_BASE + "TerrainDB.json") as Promise<{ items?: Terrain[] } & Terrain[]>,
		lang === "en" ? null : (fetchJsonMaybeGz(`${ASSET_BASE}TerrainDB.i18n/${lang}.json`) as Promise<{ terrains?: Record<string, NameRow> }>).catch(e => (console.warn("[quiz] terrain names", lang, e), null)),
	]);
	const N = i18n?.terrains || {};
	// 近い国＝代表点（coord）どうしの距離。主権国家と大きな領土だけ（小島の領土に引っ張られない）
	const anchors = countries.filter(c => c.coord && c.region && c.region !== "0" && (c.un || c.area >= 1e5));
	const nearest = (pt: number[]): QuizCountry[] => anchors.map(c => [dist2(pt, c.coord!), c] as const).sort((a, b) => a[0] - b[0]).slice(0, 2).map(x => x[1]);
	return (db.items || db).filter(d => d.coord && TERRAIN_GROUP[d.category]).map((d): QuizCountry => {
		const near = GLOBAL.has(d.category) ? [] : nearest(d.coord!), e = N[d.qid] || {};
		return {
			key: d.qid, qid: d.qid, iso2: "", name: e.name || d.name.en, nameEn: d.name.en, capital: "", capitalEn: "",
			region: near[0]?.region || "", population: 0, area: d.area || 0, un: null, territory: null, conflict: null, flagKey: null, coord: d.coord!,
			wiki: e.wiki ? [lang, e.wiki] : d.wiki?.en ? ["en", d.wiki.en] : null,
			category: d.category, group: TERRAIN_GROUP[d.category], tier: terrainTier(d.rank), elevation: d.elevation ?? null, length: d.length ?? null, near: near.map(c => c.name),
		};
	});
}
