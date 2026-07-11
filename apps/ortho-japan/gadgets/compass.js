// ガジェット：コンパス兼リセット（DOMのみ＝針の追従とリセットアニメは main.js が配線）。
export function mountCompass(mapEl) {
	const btn = document.createElement("button");
	btn.id = "reset"; btn.title = "北向き・水平に戻す";
	btn.innerHTML = `
		<svg viewBox="0 0 40 40" width="26" height="26">
			<polygon points="20,4 26,20 20,16.5 14,20" fill="#2b3b57"/>
			<polygon points="20,36 26,20 20,23.5 14,20" fill="#ffffff" stroke="#9aa0ac" stroke-width="1"/>
		</svg>`;
	mapEl.append(btn);
}
