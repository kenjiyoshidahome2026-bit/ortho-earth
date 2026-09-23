// ガジェット：地域の全体へ戻る（旧名 japan＝非推奨の別名）。標準装備でなくオプトイン＝map.gadget.home() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押すと地域宣言 home の視点へ球面フライト＝真俯瞰(tilt=0)・北向き（flyTo が出発時に姿勢を倒す）。
// 顔（icon＝SVG 文字列）・札（label＝t() の鍵）・DOM id は地域宣言が持つ（日本＝列島のブロック図・"Show all of Japan"・#japan-btn＝利用者 CSS の公開面）。
// 宣言が無い項目は汎用（家の形・"Home"・#home-btn）。ショートカット＝J（球体まで回した所からワンキーで戻す狙い）。signal＝destroy時の解除。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { tr } from "../i18n.js";
const t = tr();
const HOME_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="#3f4757" aria-hidden="true"><path d="M12 3 2.5 11.2h2.6V21h5.6v-6h2.6v6h5.6v-9.8h2.6Z"/></svg>`;
export function home({ view, icon, label, id, signal } = {}) {
	const mapEl = this.mapEl, flyTo = this.flyTo;
	const btnId = id || "home-btn";
	if (mapEl.querySelector("#" + btnId)) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	const name = t(label || "Home");
	btn.id = btnId; btn.dataset.tip = `${name} (J)`; btn.setAttribute("aria-label", name);
	btn.innerHTML = icon || HOME_ICON;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	const go = () => flyTo(view[0], view[1], view[2], 0);   // tilt=0＝真俯瞰へ着地（bearingもflyToが北へ倒す）
	btn.addEventListener("click", go);
	// J＝地域の全体へ戻る（修飾なし＝球体まで回した所からワンキーで）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (e.key !== "j" && e.key !== "J") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;   // 修飾つきは他操作に譲る
		if (keyBusy(mapEl)) return;
		e.preventDefault(); go();
	}, { signal });
	return btn;
}
