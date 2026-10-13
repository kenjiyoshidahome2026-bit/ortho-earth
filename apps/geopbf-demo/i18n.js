// UI 文言の多言語化（英語キー・26 言語）。芯は globe の i18n/core.js（createI18n）と 1 本（2026-10-03）＝キー＝英語＝既定値・訳が無ければ英語のまま。
//   t("Read") / t("$1 features", n)（$1 書式）/ t("Open ##verb")（" ##" は文脈＝表示では捨てる）
// 辞書＝i18n/lang/<code>.json（正本 i18n/ui.json から scripts/i18n-build.mjs が焼く）。言語ごとに 1 本だけ遅延 import。
// 対象＝パネルの UI だけ。ログ（screenLogger・geoExec の進捗行）と地図の中身（カタログのデータ名・属性）は英語のまま＝console/HUD の掟。
import LANGS from "../../packages/world/i18n/langs.json";   // 言語一覧の正本＝world
import { createI18n } from "@ortho-earth/globe/i18n/core.js";

const PACKS = import.meta.glob("./i18n/lang/*.json");
const i18n = createI18n({ langs: LANGS, load: async c => { const k = Object.keys(PACKS).find(p => p.endsWith(`/${c}.json`)); return k ? (await PACKS[k]()).default : {}; } });
export const { getLang, isRTL, LANGUAGES, norm, t } = i18n;
// 頁の lang / dir も合わせる（この頁は html が UI＝従来どおり setLang が面倒を見る）
export async function setLang(code) { const c = await i18n.setLang(norm(code) ?? "en"); i18n.applyHtml(); return c; }
