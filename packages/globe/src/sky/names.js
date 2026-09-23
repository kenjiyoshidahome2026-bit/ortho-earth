// 天体の名前（星座・メシエ・太陽・惑星・月・衛星）＝bucket GIS/space/i18n/<lang>.json（正本 packages/space・uploader が焼く・
// ortho-solar と同じ JSON）を読む口。コードでなくデータで繋ぐ（2026-09-19 本人裁定）。UI の言語の 1 本＋英語・欠けは英語
// （星座＝IAU 名・メシエ＝英語の通称・天体＝英語名）。旧 skynames.js（日本語固定＝UI が英語でも「オリオン座」）の表は
// packages/space/names.json の ja 列へ移した。
// 読み口は native-bucket の get＝uploader の put は .json を gzip で置く＝素の fetch では読めない（solar と同じ）。
// 1 回だけ取る（memo）＝星空ドーム（sky/theater.js）と太陽系圏（solarsky.js）が同じ約束を共有
import { nativeBucket } from "native-bucket";
import { getLang } from "../i18n.js";

const fold = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
let load = null;
export function skyNames() {
	return load ??= (async () => {
		const lang = getLang();
		const space = nativeBucket("https://api.ortho-earth.com").Bucket("GIS/space", { lazy: true, silent: true });
		const get = l => space.then(b => b?.get(`i18n/${l}.json`, "json")).catch(() => null);
		const [p, en] = await Promise.all([lang === "en" ? null : get(lang), get("en")]);
		const E = { c: {}, m: {}, b: {}, ...en }, L = { ...E, ...p };
		// 星座キーは IAU 略号（"Ori"）でもラテン名（"Canis Major"・"Boötes"）でも引ける＝英語パックの値（IAU 名）から逆引き
		const abbr = new Map(Object.entries(E.c).flatMap(([a, latin]) => [[fold(a), a], [fold(latin), a]]));
		return {
			constellation: k => { const a = abbr.get(fold(k)) || k; return L.c?.[a] || E.c[a] || String(k ?? ""); },
			messierLabel: id => { const n = L.m?.[id] || E.m[id]; return n ? `${id} ${n}` : String(id); },
			// 天体 id（ephem の id）→名前。無い（読込前・古いパック）時は null＝呼び手が従来の名前で出す
			body: id => L.b?.[id] || E.b[id] || null,
		};
	})();
}
