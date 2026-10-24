// @ortho-earth/geoedit ── 公開面。エディタ本体は controller.js（initEditor）。文言は自前の 26 言語表（i18n/ui.json → i18n/lang/<code>.json）。
export { initEditor } from "./controller.ts";
export { setWorkerFactory } from "./workerFactory.ts";   // worker の入口を差し替える（役割 "geoedit:model"・2026-09-22）
export { setLang, getLang, tr } from "./i18n.ts";
export { idbClear, idbSave } from "./io.ts";   // 検定ページ（ortho-japan tests）と持ち主が使う
export { createModelWorker } from "./worker-rpc.ts";   // 編集モデルの worker（検定ページが直接叩く・生成は worker-rpc の 1 箇所）
export type { ListTableFactory, ListTable, ListColumn } from "./list.ts";   // 地物一覧の表の注入（initEditor({ table })・2026-10-24）
