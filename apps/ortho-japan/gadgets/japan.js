// ガジェット：日本全体へ戻る。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.japan() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押すと列島ビュー（本土四島が一枚）へ球面フライト＝真俯瞰(tilt=0)・北向き（flyTo が出発時に姿勢を倒す）。
// 着地点 view=[lon,lat,zoom] は本体の既定起動ビューと同一（登録側が JAPAN_VIEW を注入）。
// ショートカット＝⌘/Ctrl+J（球体まで回した所からワンキーで日本へ戻す狙い）。signal＝destroy時の解除。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { tr } from "../i18n.js";
const t = tr({ "日本全体を表示（J）": "Show all of Japan (J)", "日本全体を表示": "Show all of Japan" });
export function japan({ view, signal } = {}) {
	const mapEl = this.mapEl, flyTo = this.flyTo;
	if (mapEl.querySelector("#japan-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "japan-btn"; btn.dataset.tip = t("日本全体を表示（J）"); btn.setAttribute("aria-label", t("日本全体を表示"));
	// 手描きの列島ブロック図（画素トレース）の塗り潰し版＝シルエットで面として読ませる（形は本人・塗りは機械）。
	// 北海道=右上／本州=右柱＋南の足＋房の切り欠き＋左へ中国地方の帯／九州=左下／四国=中央下。
	// 各島は原図より一回り小さく＝海峡（白い隙間）を確保。細いstroke同色＝角の丸み用。旧案（輪郭線・筆致4画・矩形のみ）はgit履歴に。
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="#3f4757" stroke="#3f4757" stroke-width=".8" stroke-linejoin="round" aria-hidden="true">
			<rect x="17.2" y="1.6" width="5.8" height="5.2" rx="1"/>
			<path d="M17.2 8.8 H23 V22.4 H20.1 V20.5 H18.6 V22.4 H13 V18 H6.8 V14.6 H17.2 Z"/>
			<rect x="1" y="15" width="3.6" height="7.4" rx="1"/>
			<rect x="6.6" y="19.8" width="4.6" height="2.6" rx="0.9"/></svg>`;
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
