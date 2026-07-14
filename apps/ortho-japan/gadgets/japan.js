// ガジェット：日本全体へ戻る。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.japan() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押すと列島ビュー（本土四島が一枚）へ球面フライト＝真俯瞰(tilt=0)・北向き（flyTo が出発時に姿勢を倒す）。
// 着地点 view=[lon,lat,zoom] は本体の既定起動ビューと同一（登録側が JAPAN_VIEW を注入）。
// ショートカット＝⌘/Ctrl+J（球体まで回した所からワンキーで日本へ戻す狙い）。signal＝destroy時の解除。
import { gadgetStack } from "./stack.js";
export function japan({ view, signal } = {}) {
	const mapEl = this.mapEl, flyTo = this.flyTo;
	if (mapEl.querySelector("#japan-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "japan-btn"; btn.dataset.tip = "日本全体を表示（J）"; btn.setAttribute("aria-label", "日本全体を表示");
	// 手描きの列島ブロック図（画素トレース）を清書＝形はそのまま・段差の掃除と角丸だけ（感性は本人・清書は機械）。
	// 北海道=右上／本州=右柱＋南の足＋房の切り欠き＋左へ中国地方の帯／九州=左下（上線=帯・下線=四国と面）／四国=中央下。
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
			<rect x="16.8" y="1.6" width="6.2" height="5.8" rx="1"/>
			<path d="M17 8 H23 V22.4 H20 V20.7 H18.8 V22.4 H12.1 V18.2 H6 V14.1 H17 Z"/>
			<rect x="1" y="14.1" width="4" height="8.3" rx="1"/>
			<rect x="5.9" y="19.1" width="5.3" height="3.3" rx="0.9"/></svg>`;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	const go = () => flyTo(view[0], view[1], view[2], 0);   // tilt=0＝真俯瞰へ着地（bearingもflyToが北へ倒す）
	btn.addEventListener("click", go);
	// J＝日本へ戻る（修飾なし＝球体まで回した所からワンキーで）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (e.key !== "j" && e.key !== "J") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;   // 修飾つきは他操作に譲る
		const el = document.activeElement, tag = el && el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
		e.preventDefault(); go();
	}, { signal });
	return btn;
}
