// UI 文言の多言語化（英語キー・26 言語）。作法は ortho-japan の i18n.js と同じ（キー＝英語＝既定値・訳が無ければ英語のまま）。
//   const t = ...; t("Rivers") / t("Loading $1 …", name) / t("S ##size")（" ##" は文脈＝表示では捨てる）
// 辞書は 2 段：
//   ① 共有＝ortho-japan の i18n/lang/<code>.json（「Layers & themes」「Zoom in」「Roads」「Rail」「Opacity」「Lon」「Lat」
//      「Sources: 」「None」「Legend」…＝地図アプリ共通の語彙。同じ語を二度訳さない＝語彙を割らない）
//   ② equal 固有＝apps/equal/i18n/lang/<code>.json（Rivers/Graticule/Choropleth/Year/Disputed…）。同じキーは②が勝つ
// どちらも言語ごとに 1 本だけ遅延 import（英語の人に他言語の辞書を運ばせない）。将来 globe が増えたら
// ①を共有パッケージへ引き上げる（その時に 3 者で分ける）。
import LANGS from "../../ortho-japan/i18n/langs.js";   // 言語一覧は world が正本（japan が写しを持つ）＝ここは写しの写しを作らない

const SHARED = import.meta.glob("../../ortho-japan/i18n/lang/*.json");
const OWN = import.meta.glob("../i18n/lang/*.json");
const CTX = " ##";
const CODES = new Set(LANGS.map(l => l.code));
const RTL = new Set(LANGS.filter(l => l.rtl).map(l => l.code));
const packs = {};                // code → { 英語キー: 訳 }（en は持たない＝キーそのもの）
let lang = "en";

export const LANGUAGES = LANGS;
export const norm = c => {
	const s = String(c || "").trim().toLowerCase();
	if (!s) return null;
	if (s === "jp") return "ja";
	if (CODES.has(s)) return s;
	const base = s.split(/[-_]/)[0];
	return CODES.has(base) ? base : null;
};
export const getLang = () => lang;
export const isRTL = (code = lang) => RTL.has(code);

const grab = async (mods, code) => { const k = Object.keys(mods).find(p => p.endsWith(`/${code}.json`)); if (!k) return {}; try { return (await mods[k]()).default || {}; } catch { return {}; } };

export async function setLang(code) {
	const c = norm(code) ?? "en";
	lang = c;
	if (c !== "en" && !packs[c]) {
		const [shared, own] = await Promise.all([grab(SHARED, c), grab(OWN, c)]);
		packs[c] = { ...shared, ...own };   // equal 固有が共有を上書き
	}
	return c;
}

const display = key => { const i = key.indexOf(CTX); return i < 0 ? key : key.slice(0, i); };
export function t(key, ...args) {
	const p = packs[lang];
	const s = (p && p[key]) || display(key);
	return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
}
