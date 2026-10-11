// UI 文言の多言語化（英語キー・26 言語）。芯は globe の i18n/core.js（createI18n）と 1 本・辞書（i18n/ui.json）は solar 自前
// （2026-10-03・裁定 2026-09-16「共有モジュール化は不要」を改めた＝契約が同じ 5 本を 1 本に）。天体名もここ＝太陽系では惑星名が UI 文言そのもの。
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
// 言語一覧は world と 1 本（packages/world/i18n/langs.json の写し＝globe の i18n/langs.js＝生成物を読む）。
//
// 語順の掟：文単位でキー化する（単語を連結しない）。"Radius " + n + " km" のような足し算は言語によって語順が壊れる。
import LANGS from "@ortho-earth/globe/i18n/langs.js";
import { createI18n } from "@ortho-earth/globe/i18n/core.js";

// 言語ごとに 1 本だけ遅延 import（i18n/lang/<code>.json＝i18n:build が焼く）
const i18n = createI18n({ langs: LANGS, load: async c => (await import(`./i18n/lang/${c}.json`)).default });
export const { getLang, setLang, loadLang, isRTL, langName, LANGUAGES, t, tr, applyDom } = i18n;
