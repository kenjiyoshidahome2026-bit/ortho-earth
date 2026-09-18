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
