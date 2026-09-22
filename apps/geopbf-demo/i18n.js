// UI 文言の多言語化（英語キー・26 言語）。作法は equal / ortho-japan の i18n.js と同じ（キー＝英語＝既定値・訳が無ければ英語のまま）。
//   t("Read") / t("$1 features", n)（$1 書式）/ t("Open ##verb")（" ##" は文脈＝表示では捨てる）
// 辞書＝i18n/lang/<code>.json（正本 i18n/ui.json から scripts/i18n-build.mjs が焼く）。言語ごとに 1 本だけ遅延 import。
// 対象＝パネルの UI だけ。ログ（screenLogger・geoExec の進捗行）と地図の中身（カタログのデータ名・属性）は英語のまま＝console/HUD の掟。
import LANGS from "../../packages/world/i18n/langs.json";   // 言語一覧の正本＝world

const PACKS = import.meta.glob("./i18n/lang/*.json");
const CTX = " ##";
const CODES = new Set(LANGS.map(l => l.code));
const RTL = new Set(LANGS.filter(l => l.rtl).map(l => l.code));
let lang = "en", pack = null;

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

export async function setLang(code) {
	const c = norm(code) ?? "en";
	const k = Object.keys(PACKS).find(p => p.endsWith(`/${c}.json`));
	pack = c !== "en" && k ? await PACKS[k]().then(m => m.default, () => null) : null;
	lang = c;
	document.documentElement.lang = c;
	document.documentElement.dir = isRTL(c) ? "rtl" : "ltr";
	return c;
}

const display = key => { const i = key.indexOf(CTX); return i < 0 ? key : key.slice(0, i); };
export function t(key, ...args) {
	const s = pack?.[key] || display(key);
	return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
}
