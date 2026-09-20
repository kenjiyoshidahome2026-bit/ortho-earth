// @ortho-earth/geoedit の文言（英語キー・26 言語）。ortho-japan の i18n.js と同じ作法（キー＝英語＝既定値・" ##"＝文脈・$1$2＝引数）だが
// 表は**このパッケージが持つ**（i18n/ui.json → npm run i18n:build → i18n/lang/<code>.json）。ホストは initEditor の前に await setLang(code)。
// 訳が無い／読めない＝英語のまま（UI は止めない）。
const CTX_SEP = " ##";
let lang = "en", pack = {};
const norm = c => { const s = String(c || "").trim().toLowerCase(); if (!s) return "en"; if (s === "jp") return "ja"; return s.split(/[-_]/)[0]; };
export const getLang = () => lang;
export async function setLang(code) {
	const c = norm(code);
	lang = c;
	if (c === "en") { pack = {}; return c; }
	try { pack = (await import(`../i18n/lang/${c}.json`)).default ?? {}; } catch { pack = {}; }   // 無い言語＝英語のまま
	return c;
}
const display = key => { const i = key.indexOf(CTX_SEP); return i < 0 ? key : key.slice(0, i); };
export function t(key, ...args) {
	const s = pack[key] || display(key);
	return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
}
export const tr = () => t;   // 各モジュールの口（const t = tr();）＝ortho-japan と同じ形
