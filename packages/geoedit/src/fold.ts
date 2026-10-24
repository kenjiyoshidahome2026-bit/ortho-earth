// パネルを畳むボタン（スマホ＝下端のシートが地図の半分を覆う・2026-10-24）。畳む＝見出し行だけ残す。
// ボタンも畳んだ姿もスマホ幅（≤640px＝editor.scss の $mobile）だけ＝PC では何も変わらない（CSS が門）。
import { tr } from "./i18n.ts";
const t = tr();
const CHEVRON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';

/** head に畳むボタンを足す。state＝畳んだかの置き場（パネルを作り直しても引き継ぐ） */
export function addFold(panel: HTMLElement, head: HTMLElement, state: { min: boolean }): void {
	const b = Object.assign(document.createElement("button"), { className: "ge-icon-btn ge-fold", innerHTML: CHEVRON });
	const sync = (): void => { panel.classList.toggle("ge-min", state.min); const tip = state.min ? t("Expand") : t("Collapse"); b.dataset.tip = tip; b.setAttribute("aria-label", tip); b.setAttribute("aria-expanded", String(!state.min)); };
	b.onclick = () => { state.min = !state.min; sync(); };
	head.prepend(b);
	sync();
}
