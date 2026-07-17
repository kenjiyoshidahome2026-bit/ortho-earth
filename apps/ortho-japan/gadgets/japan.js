// ガジェット：日本全体へ戻る。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.japan() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押すと列島ビュー（本土四島が一枚）へ球面フライト＝真俯瞰(tilt=0)・北向き（flyTo が出発時に姿勢を倒す）。
// 着地点 view=[lon,lat,zoom] は本体の既定起動ビューと同一（登録側が JAPAN_VIEW を注入）。
// ショートカット＝⌘/Ctrl+J（球体まで回した所からワンキーで日本へ戻す狙い）。signal＝destroy時の解除。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
export function japan({ view, signal } = {}) {
	const mapEl = this.mapEl, flyTo = this.flyTo;
	if (mapEl.querySelector("#japan-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "japan-btn"; btn.dataset.tip = "日本全体を表示（J）"; btn.setAttribute("aria-label", "日本全体を表示");
	// 筆致4画の列島（輪郭を描き切らない＝18pxで「日本」と読める最小表現）。
	// 丸端ストローク＝北海道の短画・本州の弧（太平洋側に膨らむ）・四国の点・九州の短画。旧ブロック図はgit履歴に。
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M18.4 5.6 L20.9 3.8"/>
			<path d="M17.7 8.6 C16.5 12.4 12.7 14.7 8.4 15.4"/>
			<path d="M10.7 18.8 h.01"/>
			<path d="M6.1 18.3 L5.1 21.1"/></svg>`;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	const go = () => flyTo(view[0], view[1], view[2], 0);   // tilt=0＝真俯瞰へ着地（bearingもflyToが北へ倒す）
	btn.addEventListener("click", go);
	// J＝日本へ戻る（修飾なし＝球体まで回した所からワンキーで）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (e.key !== "j" && e.key !== "J") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;   // 修飾つきは他操作に譲る
		if (keyBusy(mapEl)) return;
		e.preventDefault(); go();
	}, { signal });
	return btn;
}
