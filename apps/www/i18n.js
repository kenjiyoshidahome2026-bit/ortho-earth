// www の UI 文言の多言語化（英語キー・26 言語）。作法は geopbf-demo / equal の i18n.js と同じ（キー＝英語＝既定値・訳が無ければ英語のまま）。
// 辞書＝i18n/lang/<code>.json（正本 i18n/ui.json から scripts/i18n-build.mjs が焼く）。言語ごとに 1 本だけ遅延 import。
// キャッチ（Equal to all, fair to the Earth …）は本人の文のまま訳さない＝下に小さく訳を添えるだけ。固有名詞（ortho-japan 等）も訳さない。
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
export const has = key => !!pack?.[key];   // 訳がある（英語のまま出ていない）
export function t(key, ...args) {
	const s = pack?.[key] || display(key);
	return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
}
