// ガジェット：操作方法カード＋「?」ボタン（DOMのみ＝挙動は main.js の6秒ロジックが配線）。
// マウス絵柄のSVGは width/height 属性を直書き＝CSS到着前でも巨大化しない（FOUC防波堤）。
export function mountHint(mapEl) {
	const hint = document.createElement("div");
	hint.id = "hint"; hint.style.display = "none";   // 初期非表示＝起動の第一印象は地図だけ
	hint.innerHTML = `
		<button id="hint-close" title="閉じる">×</button>
		<div class="hint-title">操作方法</div>
		<div class="hint-row">
			<svg class="mi" width="17" height="22" viewBox="0 0 24 32"><rect x="2" y="2" width="20" height="28" rx="10" fill="rgba(255,255,255,.9)" stroke="#9aa0ac" stroke-width="1.6"/><path d="M12 2 a10 10 0 0 0 -10 10 v2 h10 Z" fill="#2b3b57"/><line x1="12" y1="2" x2="12" y2="14" stroke="#9aa0ac" stroke-width="1.2"/><line x1="2" y1="14" x2="22" y2="14" stroke="#9aa0ac" stroke-width="1.2"/></svg>
			<span>ドラッグ＝<b>移動</b></span>
		</div>
		<div class="hint-row">
			<svg class="mi" width="17" height="22" viewBox="0 0 24 32"><rect x="2" y="2" width="20" height="28" rx="10" fill="rgba(255,255,255,.9)" stroke="#9aa0ac" stroke-width="1.6"/><path d="M12 2 a10 10 0 0 1 10 10 v2 h-10 Z" fill="#2b3b57"/><line x1="12" y1="2" x2="12" y2="14" stroke="#9aa0ac" stroke-width="1.2"/><line x1="2" y1="14" x2="22" y2="14" stroke="#9aa0ac" stroke-width="1.2"/></svg>
			<span>右ドラッグ＝<b>傾き・回転</b></span>
		</div>
		<div class="hint-row">
			<svg class="mi" width="17" height="22" viewBox="0 0 24 32"><rect x="2" y="2" width="20" height="28" rx="10" fill="rgba(255,255,255,.9)" stroke="#9aa0ac" stroke-width="1.6"/><line x1="2" y1="14" x2="22" y2="14" stroke="#9aa0ac" stroke-width="1.2"/><rect x="9.5" y="5.5" width="5" height="10" rx="2.5" fill="#2b3b57"/></svg>
			<span>ホイール＝<b>ズーム</b></span>
		</div>
		<div class="hint-row">
			<span class="key">⌘/Ctrl</span><span class="hint-plus">＋</span>
			<svg class="mi" width="17" height="22" viewBox="0 0 24 32"><rect x="2" y="2" width="20" height="28" rx="10" fill="rgba(255,255,255,.9)" stroke="#9aa0ac" stroke-width="1.6"/><line x1="2" y1="14" x2="22" y2="14" stroke="#9aa0ac" stroke-width="1.2"/><rect x="9.5" y="5.5" width="5" height="10" rx="2.5" fill="#2b3b57"/></svg>
			<span>＝<b>回転</b></span>
		</div>`;
	const btn = document.createElement("button");
	btn.id = "hint-btn"; btn.title = "操作方法"; btn.textContent = "?";
	mapEl.append(hint, btn);
}
