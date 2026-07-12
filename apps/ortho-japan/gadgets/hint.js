// ガジェット：操作方法カード＋「?」ボタン。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.hint() で搭載する（v1 ortho-map の gadget 作法＝this が map）。DOMと挙動をここで完結。
// マウス絵柄のSVGは width/height 属性を直書き＝CSS到着前でも巨大化しない（FOUC防波堤）。
import { gadgetStack } from "./stack.js";
export function hint() {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#hint")) return;   // 二重搭載は無害（搭載済みのまま）
	const card = document.createElement("div");
	card.id = "hint"; card.style.display = "none";   // 初期非表示＝起動の第一印象は地図だけ
	// タッチ端末は操作の語彙が別（2本指の対句＝ひらく/ひねる/たて）。pointer:coarse で出し分け＝マウス絵柄を見せない。
	const coarse = window.matchMedia("(pointer: coarse)").matches;
	card.innerHTML = coarse ? `
		<button id="hint-close" title="閉じる" aria-label="閉じる">×</button>
		<div class="hint-title">操作方法</div>
		<div class="hint-row"><span class="key">1本指</span><span>ドラッグ＝<b>移動</b></span></div>
		<div class="hint-row"><span class="key">2本指</span><span>ひらく・とじる＝<b>ズーム</b></span></div>
		<div class="hint-row"><span class="key">2本指</span><span>ひねる＝<b>回転</b></span></div>
		<div class="hint-row"><span class="key">2本指</span><span>上下にドラッグ＝<b>傾き</b></span></div>` : `
		<button id="hint-close" title="閉じる" aria-label="閉じる">×</button>
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
	btn.id = "hint-btn"; btn.title = "操作方法"; btn.textContent = "?"; btn.setAttribute("aria-label", "操作方法");
	// 置き場所はスタック（搭載順＝縦の並び）。カードと「?」は常にどちらか一方だけ表示＝同じ枠を分け合う。
	gadgetStack(mapEl).append(card, btn);

	// 挙動：起動時は出さない＝第一印象は地図だけ（マウス絵柄が視界に入らない）。
	// 6秒操作が無い（＝迷っているかもしれない）人にだけ、そっとフェードイン。先に触った人（ドラッグ/ホイール）
	// には出さない＝「?」だけが常に居る。×で畳んだ選択は記憶＝二度目からは完全に静か。
	const canvas = mapEl.querySelector("#c");
	function setHint(open, remember = true) {
		card.style.display = open ? "" : "none";
		btn.style.display = open ? "none" : "flex";
		if (remember) try { localStorage.setItem("oj.hint", open ? "" : "closed"); } catch { /* private mode 等 */ }
	}
	card.querySelector("#hint-close").addEventListener("click", () => setHint(false));
	btn.addEventListener("click", () => setHint(true));
	setHint(false, false);   // 起動は必ず「?」から（記憶には書かない＝初見の人の自動表示権を消費しない）
	try {
		if (localStorage.getItem("oj.hint") !== "closed") {   // まだ×で畳んだことがない人だけ自動表示の対象
			const t = setTimeout(() => setHint(true, false), 6000);
			const armed = () => { clearTimeout(t); canvas.removeEventListener("pointerdown", armed); canvas.removeEventListener("wheel", armed); };
			canvas.addEventListener("pointerdown", armed);   // 触れた＝操作を知っている人＝出さない
			canvas.addEventListener("wheel", armed);
		}
	} catch { /* private mode 等 */ }
	return { open: () => setHint(true), close: () => setHint(false) };   // 呼び出し側の手綱（プログラムから開閉）
}
