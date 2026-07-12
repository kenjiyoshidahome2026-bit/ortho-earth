// ガジェット：地名・住所検索。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.search() で搭載する（v1 ortho-map の gadget 作法＝this が map）。DOM＋挙動配線をここで完結。
// input→button の順＝虫めがねが input の上に描かれる（DOM順の裁き・z-index不使用）。
// 検索本体（API・再ランク・履歴・IME）は search.js の createSearch＝ヒットで onGo（既定＝球面フライト）。
import { createSearch } from "../search.js";
import { gadgetStack } from "./stack.js";
export function search(opts = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#search")) return;   // 二重搭載は無害（搭載済みのまま）
	const box = document.createElement("div");
	box.id = "search";
	box.innerHTML = `
		<input id="search-in" type="search" placeholder="地名・住所を検索" aria-label="地名・住所を検索" autocomplete="off" spellcheck="false">
		<button id="search-btn" title="地名・住所を検索" aria-label="地名・住所を検索">
			<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="#3f4757" stroke-width="2.2"/><line x1="15.2" y1="15.2" x2="20.5" y2="20.5" stroke="#3f4757" stroke-width="2.2" stroke-linecap="round"/></svg>
		</button>`;
	gadgetStack(mapEl).append(box);   // 置き場所はスタック（搭載順＝縦の並び）
	// 候補リストは箱の外＝#map 直下の動的要素（後置＝スタック下段のガジェットより上に描く。z-index不使用の掟）。
	// 位置と幅は search.js が検索箱に追随させる。
	const list = document.createElement("div");
	list.id = "search-list";
	list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "検索候補");
	mapEl.append(list);
	createSearch({ onGo: opts.onGo || this.flyTo, signal: opts.signal });   // 飛び方は本体の領分（opts.onGoで差し替え可）。signal＝destroy時のリスナー解除
	return box;
}
