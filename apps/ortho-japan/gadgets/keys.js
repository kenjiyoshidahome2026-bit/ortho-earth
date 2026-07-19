// ガジェットのキーボード・ショートカット共通ガード。「今このキーを地図/ガジェットが拾ってよいか」を
// ここ一箇所で決める＝各ガジェットに手書き複製していた判定を廃す。判定は2つ：
//   ・文字入力系にフォーカス（isTypingTarget＝INPUT/TEXTAREA/SELECT/contentEditable・ortho-core と共有）
//   ・モーダルが開いている（印刷 #print.open／PLATEAU #pdb／右クリック #ctxmenu）
// どちらかなら true＝ショートカットは素通し（背後の地図/ガジェットへ漏らさない）。
// ＊各ガジェットは自分のキー一致を先に確かめてから keyBusy を呼ぶ＝getComputedStyle は当たったキーだけで走る。
import { isTypingTarget } from "ortho-core";

const MODAL_SELECTORS = ["#print.open", "#pdb", "#ctxmenu", "#theme-picker.open", "#demo-bar.on"];   // 表示中なら地図ショートカットを止めるモーダル群（デモ中＝矢印を台本送りへ譲る・マウスは生きたまま）
export const modalOpen = mapEl => MODAL_SELECTORS.some(sel => {
	const el = mapEl.querySelector(sel); return el && getComputedStyle(el).display !== "none";
});
export const keyBusy = mapEl => isTypingTarget() || modalOpen(mapEl);
export { isTypingTarget };
