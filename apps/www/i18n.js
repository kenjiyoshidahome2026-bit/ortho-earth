// www の UI 文言の多言語化（英語キー・26 言語）。芯は globe の i18n/core.js（createI18n）と 1 本（2026-10-03）＝キー＝英語＝既定値・訳が無ければ英語のまま。
// 辞書＝public/i18n/<code>.json（正本 i18n/ui.json から scripts/i18n-build.mjs が焼く）。言語ごとに 1 本だけ fetch。
// ⚠名前の決まった JSON にしてある＝index.html 先頭の小さなスクリプトが HTML と並行に preload する（CLS 対策・9/22 Lighthouse mobile 94→）。
// キャッチ（Equal to all, fair to the Earth …）は本人の文のまま訳さない＝下に小さく訳を添えるだけ。固有名詞（ortho-japan 等）も訳さない。
import LANGS from "../../packages/world/i18n/langs.json";   // 言語一覧の正本＝world
import { createI18n } from "@ortho-earth/globe/i18n/core.js";

const i18n = createI18n({ langs: LANGS, load: c => fetch(`/i18n/${c}.json`).then(r => r.ok ? r.json() : null, () => null) });   // 名前の決まった JSON＝index.html が preload した物をそのまま使う
export const { getLang, isRTL, LANGUAGES, norm, t, has } = i18n;
// 頁の lang / dir も合わせる（従来どおり setLang が面倒を見る）
export async function setLang(code) { const c = await i18n.setLang(norm(code) ?? "en"); i18n.applyHtml(); return c; }
