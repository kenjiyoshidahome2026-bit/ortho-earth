// 天体の名前（星座・メシエ・太陽・惑星・月・衛星）＝GitHub Pages の ortho-data/globe/sky/names/<lang>.json（正本 packages/world/sky・sky/data.js・
// ortho-solar と同じ JSON）を読む口。コードでなくデータで繋ぐ（2026-09-19 本人裁定）。UI の言語の 1 本＋英語・欠けは英語
// （星座＝IAU 名・メシエ＝英語の通称・天体＝英語名）。旧 skynames.js（日本語固定＝UI が英語でも「オリオン座」）の表は
// packages/world/sky/names.json の ja 列へ移した。
// 2026-10-13 まで bucket GIS/space/i18n/（uploader が gzip で置く＝native-bucket の get で読んでいた）。Pages は素の JSON。
// 1 回だけ取る（memo）＝星空ドーム（sky/theater.js）と太陽系圏（solarsky.js）が同じ約束を共有
import { skyJson } from "./data.js";
import { getLang } from "../i18n.js";

const fold = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
let load = null;
export function skyNames() {
	return load ??= (async () => {
		const lang = getLang();
		const get = l => skyJson(`names/${l}.json`);
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
