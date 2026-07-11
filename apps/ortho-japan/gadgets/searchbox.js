// ガジェット：地名検索の箱（DOMのみ＝挙動は search.js の createSearch が配線）。
// input→button の順＝虫めがねが input の上に描かれる（DOM順の裁き・z-index不使用）。
export function mountSearchBox(mapEl) {
	const box = document.createElement("div");
	box.id = "search";
	box.innerHTML = `
		<input id="search-in" type="search" placeholder="地名・住所を検索" autocomplete="off" spellcheck="false">
		<button id="search-btn" title="地名・住所を検索">
			<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="#3f4757" stroke-width="2.2"/><line x1="15.2" y1="15.2" x2="20.5" y2="20.5" stroke="#3f4757" stroke-width="2.2" stroke-linecap="round"/></svg>
		</button>
		<div id="search-list"></div>`;
	mapEl.append(box);
}
