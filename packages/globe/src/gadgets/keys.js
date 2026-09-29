// ガジェットのキーボード・ショートカット共通ガード。「今このキーを地図/ガジェットが拾ってよいか」を
// ここ一箇所で決める＝各ガジェットに手書き複製していた判定を廃す。判定は3つ：
//   ・文字入力系にフォーカス（isTypingTarget＝INPUT/TEXTAREA/SELECT/contentEditable・ortho-core と共有）
//   ・モーダルが開いている（印刷 #print.open／PLATEAU #pdb／右クリック #ctxmenu）
//   ・この地図がキーの持ち主でない（頁に地図が複数ある時・下の registerKeyOwner）
// どれかなら true＝ショートカットは素通し（背後の地図/ガジェットへ漏らさない）。
// ＊各ガジェットは自分のキー一致を先に確かめてから keyBusy を呼ぶ＝getComputedStyle は当たったキーだけで走る。
import { isTypingTarget } from "@ortho-earth/core";

const MODAL_SELECTORS = ["#print.open", "#pdb", "#ctxmenu", "#theme-picker.open", "#demo-bar.on"];   // 表示中なら地図ショートカットを止めるモーダル群（デモ中＝矢印を台本送りへ譲る・マウスは生きたまま）
export const modalOpen = mapEl => MODAL_SELECTORS.some(sel => {
	const el = mapEl.querySelector(sel); return el && getComputedStyle(el).display !== "none";
});
// キーの持ち主（#173 段 3・2026-09-30）：頁に地図が複数ある時、キーは「最後に触った地図」（押す・ホイール・フォーカス）だけが拾う。
// 起動直後は最初に起動した地図。1 枚なら常にその地図＝従来と同じ。矢印（core input の blocked）と各ガジェットの keyBusy が見る。
const keyMaps = [];      // 生きている地図の容れ物（起動順）
let keyActive = null;    // 最後に触った容れ物
export function registerKeyOwner(mapEl, signal) {
	keyMaps.push(mapEl);
	const touch = () => { keyActive = mapEl; };
	for (const ev of ["pointerdown", "wheel", "focusin"]) mapEl.addEventListener(ev, touch, { capture: true, passive: true, signal });
	signal.addEventListener("abort", () => {
		const i = keyMaps.indexOf(mapEl); if (i >= 0) keyMaps.splice(i, 1);
		if (keyActive === mapEl) keyActive = null;
	}, { once: true });
}
export const isKeyOwner = mapEl => keyMaps.length < 2 || (keyActive ?? keyMaps[0]) === mapEl;
export const keyBusy = mapEl => isTypingTarget() || modalOpen(mapEl) || !isKeyOwner(mapEl);
export { isTypingTarget };
