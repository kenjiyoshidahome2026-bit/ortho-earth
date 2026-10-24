// geoedit の地物一覧の表（initEditor({ table })）＝共有エンジンの common/bigtable（温泉・横浜の一覧と同じ仮想スクロール表）。
// 一覧を開いた時に初めて読む（編集を開いただけでは読まない）。単独ページ geoedit-page.ts と /japan/ の編集ボタン（site.ts）が共有
import type { ListTableFactory } from "geoedit";
export const geoeditTable: ListTableFactory = (box, opts) => import("common/bigtable").then(({ BigTable }) => new BigTable(box, opts));
