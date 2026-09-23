// UI 文言の多言語化（英語キー・26 言語）。地図の中身（地名等の描画テキスト）は対象外＝かなピボット戦線（別戦線）。
//
// 作法（キー＝英語＝既定値。訳が無ければ英語のまま出る＝欠落は隠れない）：
//   import { tr } from "../i18n.js";
//   const t = tr();
//   el.title = t("Start measuring");
//   el.textContent = t("$1 items", n);       // $1$2… ＝引数差し込み（world の trans と同じ書式）
//   t("S ##size")                             // " ##…" ＝文脈＝同じ英語を別の語として分けるための印。表示では捨てる
//
// 訳の在り処：正本は i18n/ui.json（英語キー → 26 言語）。実行時が読むのは i18n/lang/<code>.json（npm run i18n:build で焼く）。
//   全言語とも遅延 import で 1 本だけ取る＝英語の人に日本語 31KB を運ばせない。ちらつかない理由＝orthoJapan() が
//   最初に await setLang() を通す＝UI を組む前に訳が揃う（モジュール評価時に t() を呼ばない掟とセット）。
//   取れなければ英語のまま（UI は止めない）。ja も同じ道＝「母語だけ特別扱い」を持たない（裁定 2026-09-16 の実装）。
// 言語一覧は world と 1 本（packages/world/i18n/langs.json の写し＝i18n/langs.json）。コードは共有しない（裁定 2026-09-16）。
//
// 語順の掟：文単位でキー化する（単語を連結しない）。"Source: " + name のような足し算は言語によって語順が壊れる。
import LANGS from "./i18n/langs.js";

const CTX_SEP = " ##";
const CODES = new Set(LANGS.map(l => l.code));
const RTL = new Set(LANGS.filter(l => l.rtl).map(l => l.code));
const packs = {};                // code → { 英語キー: 訳 }。en は持たない＝キーそのもの
let lang = null;                 // 未解決＝最初の getLang() で判定（setLang が先に来ればそちらが勝つ）

const norm = c => {
	const s = String(c || "").trim().toLowerCase();
	if (!s) return null;
	if (s === "jp") return "ja";                                  // 歴史的別名
	if (CODES.has(s)) return s;
	const base = s.split(/[-_]/)[0];                              // "ja-JP" / "pt_BR" → 基底
	return CODES.has(base) ? base : null;
};

export function getLang() {
	if (!lang) {
		const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
		lang = norm(q) ?? norm(typeof navigator !== "undefined" ? navigator.language : null) ?? "en";
	}
	return lang;
}

// 言語を決め、その訳を用意して返す（ja/en は待たない＝同期同然）。orthoJapan() が最初に await する。
export async function setLang(code) {
	const n = norm(code);
	if (n) lang = n;
	return loadLang(getLang());
}

export async function loadLang(code) {
	const c = norm(code) ?? "en";
	if (c === "en" || packs[c]) return c;
	try { packs[c] = (await import(`./i18n/lang/${c}.json`)).default; }
	catch { packs[c] = {}; }                                      // 訳が無い＝英語のまま（読めない時も同じ＝UI を止めない）
	return c;
}

// showcase ページの辞書（i18n/lang/<page>/<code>.json＝正本 i18n/pages/<page>.json）を本体の表に足す。ページの chunk が setLang() の後に一度呼ぶ：
//   await loadPage(c => import(`./i18n/lang/models/${c}.json`));
// import はページ側が書く＝vite の glob はそのページの 25 本だけを chunk にし、本体（SDK）はページの訳を運ばない（本人 2026-09-20「i18n は分けたほうがいい」）。en は表を持たない
export async function loadPage(importer, code = getLang()) {
	const c = norm(code) ?? "en";
	if (c === "en") return c;
	try { registerPack(c, (await importer(c)).default); }
	catch { /* 表が無い＝英語のまま */ }
	return c;
}
export function registerPack(code, table) { const c = norm(code); if (c) packs[c] = { ...packs[c], ...table }; }   // 外部から訳を差し替える口

export const isRTL = (code = getLang()) => RTL.has(code);
export const langName = code => (LANGS.find(l => l.code === norm(code)) || {}).name || "";
export const LANGUAGES = LANGS;

const display = key => { const i = key.indexOf(CTX_SEP); return i < 0 ? key : key.slice(0, i); };

export function t(key, ...args) {
	const p = packs[getLang()];
	const s = (p && p[key]) || display(key);                      // 訳が無い／"" ＝英語（キー）へ落ちる＝欠落も「意図して英語」も同じ道
	return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
}

export const tr = () => t;      // 各モジュールの口は据え置き（const t = tr();）＝持参辞書は Phase 1 で畳んだ
