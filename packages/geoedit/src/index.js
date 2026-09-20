// @ortho-earth/geoedit ── 公開面。エディタ本体は controller.js（initEditor）。文言は自前の 26 言語表（i18n/ui.json → i18n/lang/<code>.json）。
export { initEditor } from "./controller.js";
export { setLang, getLang, tr } from "./i18n.js";
export { idbClear, idbSave } from "./io.js";   // 検定ページ（ortho-japan tests）と持ち主が使う
export { createModelWorker } from "./worker-rpc.js";   // 編集モデルの worker（検定ページが直接叩く・生成は worker-rpc の 1 箇所）
