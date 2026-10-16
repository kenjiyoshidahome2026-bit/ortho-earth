// i18n/lang-loaders.js（npm run i18n:build の生成物＝JS のまま）の型。言語コード → その言語の表（英語キー → 訳）を読む関数。
// JS のままの理由：字面の import("./lang/<code>.json") は TS（module nodenext）だと import 属性 { with: { type: "json" } } が要る＝出力の JS が変わる（Vite 8 と npm の利用者のバンドラに渡る形を変えない）。
declare const LOADERS: Record<string, (() => Promise<{ default: Record<string, string> }>) | undefined>;
export default LOADERS;
