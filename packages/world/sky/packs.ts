// names.json（正本）→ 言語ごとのパック { c: {IAU 略号: 星座名}, m: {"M42": 通称}, b: {天体 id: 名前} }＝その言語に在るものだけ。
// 天体 id＝ephem の id（sun・mercury…・moon・io…・charon）
// 欠けは読む側が英語のパックで補う（星座＝IAU 名・メシエ＝英語の通称）。packages/world/scripts/sky.mjs がこれを out/sky/names/<lang>.json に焼き、publish:pages が GitHub Pages へ置く。
// 読む側（globe の星空・solar）はコードを共有しない＝このファイルも import しない＝データ（Pages の素の JSON）だけで繋がる
/** 名前の表＝id → { 言語: 名前 } */
export type SkyNameTable = Record<string, Record<string, string>>;
export interface SkyNames { constellations: SkyNameTable; messier: SkyNameTable; bodies: SkyNameTable }
/** 1 言語のパック */
export interface SkyPack { c: Record<string, string>; m: Record<string, string>; b: Record<string, string> }
export const LANGS: string[] = ["en", "ja", "zh", "ko", "fr", "de", "es", "pt", "it", "nl", "pl", "ru", "uk", "hu", "sv", "tr", "el", "id", "vi", "th", "bn", "hi", "ar", "fa", "ur", "he"];
export function packs({ constellations, messier, bodies }: SkyNames): Record<string, SkyPack> {
	const out: Record<string, SkyPack> = {};
	for (const l of LANGS) {
		const pick = (tab: SkyNameTable): Record<string, string> => Object.fromEntries(Object.entries(tab).filter(([, v]) => v[l]).map(([k, v]) => [k, v[l]]));
		out[l] = { c: pick(constellations), m: pick(messier), b: pick(bodies) };
	}
	return out;
}

// ---- 月の地名（moon.json＝IAU 採択の主な地名 2,023）----
// GeoPBF の元＝英語（IAU 名）の点。properties＝{ id(GPN), name, code(IAU の地形記号), diameter(km), origin(由来・英語), approved(年) }
// ＝sky/moon_nomenclature.geopbf。座標は月面の経緯度（東経正・-180..180）＝地球の地図ではない（読む側が月の球へ貼る）
/** moon.json の 1 件 */
export interface MoonFeature { id: number | string; name: string; code: string; diameter: number; origin: string; approved: number; lon: number; lat: number; names: Record<string, string> }
export interface MoonProperties { id: number | string; name: string; code: string; diameter: number; origin: string; approved: number }
export interface MoonPointFeature { type: "Feature"; id: number | string; properties: MoonProperties; geometry: { type: "Point"; coordinates: [number, number] } }
export interface MoonFeatureCollection { type: "FeatureCollection"; features: MoonPointFeature[] }
export const MOON_GEOPBF = "moon_nomenclature";
export function moonGeoJSON({ features }: { features: MoonFeature[] }): MoonFeatureCollection {
	return {
		type: "FeatureCollection",
		features: features.map(f => ({
			type: "Feature", id: f.id,
			properties: { id: f.id, name: f.name, code: f.code, diameter: f.diameter, origin: f.origin, approved: f.approved },
			geometry: { type: "Point", coordinates: [f.lon, f.lat] },
		})),
	};
}
// 多言語＝言語ごとに { <id>: 名前 }（英名と違うものだけ）＝sky/moon_nomenclature.i18n/<lang>.json。en は持たない（GeoPBF の name が英語）
export function moonPacks({ features }: { features: MoonFeature[] }): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	for (const l of LANGS.slice(1)) out[l] = Object.fromEntries(features.filter(f => f.names[l]).map(f => [f.id, f.names[l]]));
	return out;
}
