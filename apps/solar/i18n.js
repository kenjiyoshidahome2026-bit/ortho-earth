// UI 文言の多言語化（英語キー・26 言語）。ortho-japan の i18n.js と同じ契約＝形だけ合わせ、コードは自前で持つ
// （裁定 2026-09-16「world との共有モジュール化は不要」）。天体名もここ＝太陽系では惑星名が UI 文言そのもの。
//
// 作法（キー＝英語＝既定値。訳が無ければ英語のまま出る＝欠落は隠れない）：
//   import { tr } from "./i18n.js";
//   const t = tr();
//   el.title = t("Faster");
//   el.textContent = t("Visit $1", name);     // $1$2… ＝引数差し込み（japan / world と同じ書式）
//   t("Earth ##exit")                          // " ##…" ＝文脈＝同じ英語を別の語として分けるための印。表示では捨てる
//
// 訳の在り処：正本は i18n/ui.json（英語キー → 26 言語）。実行時が読むのは i18n/lang/<code>.json（npm run i18n:build で焼く）。
//   全言語とも遅延 import で 1 本だけ取る＝英語の人に日本語を運ばせない。ちらつかない理由＝main.js が
//   UI を触る前に await setLang() を通す＋html の .i18n-ready が立つまで文言を伏せる（en は同じ tick で立つ＝無風）。
//   取れなければ英語のまま（UI は止めない）。ja も同じ道＝「母語だけ特別扱い」を持たない。
// 言語一覧は world と 1 本（packages/world/i18n/langs.json の写し＝i18n/langs.js＝生成物）。
//
// 語順の掟：文単位でキー化する（単語を連結しない）。"Radius " + n + " km" のような足し算は言語によって語順が壊れる。
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

// 言語を決め、その訳を用意して返す（en は待たない＝同期同然）。main.js が UI を組む前に await する。
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

export const isRTL = (code = getLang()) => RTL.has(code);
export const langName = code => (LANGS.find(l => l.code === norm(code)) || {}).name || "";
export const LANGUAGES = LANGS;

const display = key => { const i = key.indexOf(CTX_SEP); return i < 0 ? key : key.slice(0, i); };

export function t(key, ...args) {
	const p = packs[getLang()];
	const s = (p && p[key]) || display(key);                      // 訳が無い／"" ＝英語（キー）へ落ちる＝欠落も「意図して英語」も同じ道
	return args.length ? s.replace(/\$(\d)/g, (_, i) => { const v = args[Number(i) - 1]; return v === undefined ? "$" + i : String(v); }) : s;
}

export const tr = () => t;      // japan と同じ口（const t = tr();）

// index.html に置いた英語（＝キー）をその場で訳に差し替える。data-t＝本文・data-t-title＝title 属性。
// 原文が HTML に残る＝キーと表示が同じ行に並ぶ（solar が data-ja 併記で得ていた読みやすさを英語キーのまま引き継ぐ）。
export function applyDom(root = document) {
	for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t || el.textContent.trim());
	for (const el of root.querySelectorAll("[data-t-title]")) el.title = t(el.dataset.tTitle || el.title);
}
