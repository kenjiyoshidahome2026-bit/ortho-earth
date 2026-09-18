// names.json（正本）→ 言語ごとのパック { c: {IAU 略号: 星座名}, m: {"M42": 通称}, b: {天体 id: 名前} }＝その言語に在るものだけ。
// 天体 id＝ephem の id（sun・mercury…・moon・io…・charon）
// 欠けは読む側が英語のパックで補う（星座＝IAU 名・メシエ＝英語の通称）。uploader がこれを bucket GIS/space/i18n/<lang>.json に置く。
// 読む側（solar・将来 japan）はコードを共有しない＝このファイルも import しない＝データ（bucket の JSON・gzip で置かれる＝native-bucket の get で読む）だけで繋がる
export const LANGS = ["en", "ja", "zh", "ko", "fr", "de", "es", "pt", "it", "nl", "pl", "ru", "uk", "hu", "sv", "tr", "el", "id", "vi", "th", "bn", "hi", "ar", "fa", "ur", "he"];
export const DIRE = "GIS/space";   // bucket の棚（world の GIS/world と同じ並び）
export function packs({ constellations, messier, bodies }) {
	const out = {};
	for (const l of LANGS) {
		const pick = tab => Object.fromEntries(Object.entries(tab).filter(([, v]) => v[l]).map(([k, v]) => [k, v[l]]));
		out[l] = { c: pick(constellations), m: pick(messier), b: pick(bodies) };
	}
	return out;
}

// ---- 月の地名（moon.json＝IAU 採択の主な地名 2,023）----
// GeoPBF の元＝英語（IAU 名）の点。properties＝{ id(GPN), name, code(IAU の地形記号), diameter(km), origin(由来・英語), approved(年) }
// ＝bucket の geopbf "moon_nomenclature"。座標は月面の経緯度（東経正・-180..180）＝地球の地図ではない（読む側が月の球へ貼る）
export const MOON_GEOPBF = "moon_nomenclature";
export function moonGeoJSON({ features }) {
	return {
		type: "FeatureCollection",
		features: features.map(f => ({
			type: "Feature", id: f.id,
			properties: { id: f.id, name: f.name, code: f.code, diameter: f.diameter, origin: f.origin, approved: f.approved },
			geometry: { type: "Point", coordinates: [f.lon, f.lat] },
		})),
	};
}
// 多言語＝言語ごとに { <id>: 名前 }（英名と違うものだけ）＝bucket GIS/space/i18n/moon/<lang>.json。en は持たない（GeoPBF の name が英語）
export function moonPacks({ features }) {
	const out = {};
	for (const l of LANGS.slice(1)) out[l] = Object.fromEntries(features.filter(f => f.names[l]).map(f => [f.id, f.names[l]]));
	return out;
}
