// ガジェット：日本全体へ戻る。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.japan() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押すと列島ビュー（本土四島が一枚）へ球面フライト＝真俯瞰(tilt=0)・北向き（flyTo が出発時に姿勢を倒す）。
// 着地点 view=[lon,lat,zoom] は本体の既定起動ビューと同一（登録側が JAPAN_VIEW を注入）。
// ショートカット＝⌘/Ctrl+J（球体まで回した所からワンキーで日本へ戻す狙い）。signal＝destroy時の解除。
import { gadgetStack } from "./stack.js";
export function japan({ view, signal } = {}) {
	const mapEl = this.mapEl, flyTo = this.flyTo;
	if (mapEl.querySelector("#japan-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
	const keyLabel = mac ? "⌘J" : "Ctrl+J";
	const btn = document.createElement("button");
	btn.id = "japan-btn"; btn.dataset.tip = `日本全体を表示 (${keyLabel})`; btn.setAttribute("aria-label", "日本全体を表示");
	// 手描きの列島ブロック図を画素から輪郭ベクトル化（内部塗り→クラック追跡→24箱に正規化）した4島の線画。
	// 北海道=右上／本州=Γ＋房／九州=左下／四国=中央下。解釈でなく元絵の忠実トレース（元pngは焼き込み後に破棄）。
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
			<path d="M17.06 1.63 L17.06 1.76 L16.8 1.76 L16.8 7.32 L16.93 7.32 L16.93 7.45 L22.87 7.45 L22.87 7.2 L23 7.2 L23 1.89 L22.87 1.89 L22.87 1.63 Z"/>
			<path d="M17.18 7.95 L17.18 8.08 L16.93 8.08 L16.93 8.21 L16.8 8.21 L16.8 14.15 L6.06 14.15 L6.06 14.28 L5.93 14.28 L5.93 18.07 L6.18 18.07 L6.18 18.2 L12.13 18.2 L12.13 22.24 L12.38 22.24 L12.38 22.37 L18.7 22.37 L18.7 22.24 L18.83 22.24 L18.83 20.6 L19.97 20.6 L19.97 22.11 L20.09 22.11 L20.09 22.24 L20.22 22.24 L20.22 22.37 L22.87 22.37 L22.87 22.11 L23 22.11 L23 8.21 L22.87 8.21 L22.87 8.08 L22.75 8.08 L22.75 7.95 Z"/>
			<path d="M1.13 14.15 L1.13 14.28 L1 14.28 L1 22.11 L1.13 22.11 L1.13 22.37 L4.92 22.37 L4.92 22.24 L5.05 22.24 L5.05 14.15 Z"/>
			<path d="M6.06 19.08 L6.06 19.21 L5.93 19.21 L5.93 22.24 L6.06 22.24 L6.06 22.37 L11.11 22.37 L11.11 22.24 L11.24 22.24 L11.24 19.08 Z"/></svg>`;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	const go = () => flyTo(view[0], view[1], view[2], 0);   // tilt=0＝真俯瞰へ着地（bearingもflyToが北へ倒す）
	btn.addEventListener("click", go);
	// ⌘/Ctrl+J＝日本へ戻る（ブラウザのダウンロード表示を転用）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (!((e.ctrlKey || e.metaKey) && (e.key === "j" || e.key === "J"))) return;
		const el = document.activeElement, tag = el && el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
		e.preventDefault(); go();
	}, { signal });
	return btn;
}
