// 画面の文言の言語別の表＝ui.json（正本）から。データに結びつく名前（国・都市…）は DB の隣（<DB>.i18n/<lang>.json＝配信）・文言はプログラム（本人裁定 2026-10-13）。
// 旧＝配信の i18n/<lang>.json に ui・categories・plateBoundaries の節として同梱（build/i18n.js が同じ切り方で作る）＝頁はそれを読んでいた。
import UI from "./ui.json" with { type: "json" };

/** 英語キー → { 言語: 訳 } */
export type UiLangTable = Record<string, Record<string, string>>;
/** 英語キー → その言語の訳（未訳は入らない） */
export type UiSlice = Record<string, string>;
export interface UiTable { ui: UiSlice; categories: UiSlice; plateBoundaries: UiSlice }

const slice = (table: UiLangTable | undefined, lang: string): UiSlice => Object.fromEntries(Object.entries(table || {}).map(([k, v]) => [k, v[lang]]).filter(([, v]) => v));
/** { ui, categories, plateBoundaries }＝英語キー → その言語（未訳は入らない＝読む側が英語キーへ落とす）。en は空 */
/** 分類名の全言語の表（英語キー → { 言語: 名前 }）＝地形の頁が直に引く（共有エンジンの入口 world-data/i18n/ui-table 越しに・2026-10-15） */
export const categories: UiLangTable = UI.categories;
export const uiTable = (lang: string): UiTable => ({ ui: slice(UI.ui, lang), categories: slice(UI.categories, lang), plateBoundaries: slice(UI.plateBoundaries, lang) });
