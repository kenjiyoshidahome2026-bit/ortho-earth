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
// 言語一覧は world と 1 本（packages/world/i18n/langs.json の写し＝i18n/langs.js）。
// 芯（norm・getLang・setLang・t …）は i18n/core.js の createI18n＝solar・equal・geopbf-demo・www と同じ 1 本（2026-10-03・裁定 2026-09-16「コードは共有しない」を改めた＝
// 共有エンジン（2026-09-30）で i18n.js は既に 7 アプリが同じ URL で読む物になっていた）。各アプリに残るのは辞書と読み方だけ。
//
// 語順の掟：文単位でキー化する（単語を連結しない）。"Source: " + name のような足し算は言語によって語順が壊れる。
import LANGS from "./i18n/langs.js";
import LOADERS from "./i18n/lang-loaders.js";
import { createI18n } from "./i18n/core.js";

// 表の読み口＝字面の import の表（i18n/lang-loaders.js＝i18n:build が焼く）。表が無い言語は {}
const i18n = createI18n({ langs: LANGS, load: async c => { const load = LOADERS[c]; return load ? (await load()).default : {}; } });
export const { getLang, setLang, loadLang, loadPage, registerPack, isRTL, langName, LANGUAGES, t, tr } = i18n;
