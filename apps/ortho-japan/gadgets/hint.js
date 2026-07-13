// ガジェット：操作方法カード＋「?」ボタン。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.hint() で搭載する（v1 ortho-map の gadget 作法＝this が map）。DOMと挙動をここで完結。
import { gadgetStack } from "./stack.js";
export function hint() {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#hint")) return;   // 二重搭載は無害（搭載済みのまま）
	const card = document.createElement("div");
	card.id = "hint"; card.style.display = "none";
	// タッチ端末は操作の語彙が別（2本指の対句＝ひらく/ひねる/たて）。pointer:coarse で出し分け＝マウス絵柄を見せない。
	const coarse = window.matchMedia("(pointer: coarse)").matches;
	// マウス絵柄（左ボタン／右ボタン／ホイール）：width/height 直書き＝CSS到着前でも巨大化しない（FOUC防波堤）
	const BODY = '<rect x="2" y="2" width="20" height="28" rx="10" fill="rgba(255,255,255,.9)" stroke="#9aa0ac" stroke-width="1.6"/>';
	const CROSS = '<line x1="12" y1="2" x2="12" y2="14" stroke="#9aa0ac" stroke-width="1.2"/><line x1="2" y1="14" x2="22" y2="14" stroke="#9aa0ac" stroke-width="1.2"/>';
	const mi = (inner, cls = "") => `<svg class="mi${cls}" width="17" height="22" viewBox="0 0 24 32">${BODY}${inner}</svg>`;
	const MI_L = mi(`<path d="M12 2 a10 10 0 0 0 -10 10 v2 h10 Z" fill="#2b3b57"/>${CROSS}`);   // 左ボタン
	const MI_R = mi(`<path d="M12 2 a10 10 0 0 1 10 10 v2 h-10 Z" fill="#2b3b57"/>${CROSS}`);   // 右ボタン
	const MI_W = cls => mi(`<line x1="2" y1="14" x2="22" y2="14" stroke="#9aa0ac" stroke-width="1.2"/><rect x="9.5" y="5.5" width="5" height="10" rx="2.5" fill="#2b3b57"/>`, cls);   // ホイール
	card.innerHTML = coarse ? `
		<button id="hint-close" title="閉じる" aria-label="閉じる">×</button>
		<div class="hint-title">操作方法</div>
		<div class="hint-row"><span class="key">1本指</span><span>ドラッグ＝<b>移動</b></span></div>
		<div class="hint-row"><span class="key">2本指</span><span>ひらく・とじる＝<b>ズーム</b></span></div>
		<div class="hint-row"><span class="key">2本指</span><span>ひねる＝<b>回転</b></span></div>
		<div class="hint-row"><span class="key">2本指</span><span>上下に引っ張る＝<b>3D表示</b>（傾き）</span></div>
		<div class="hint-note">街に寄ると建物が3Dで現れます<br>（初回は読み込みに少し時間がかかります）</div>` : `
		<button id="hint-close" title="閉じる" aria-label="閉じる">×</button>
		<div class="hint-title">操作方法</div>
		<div class="hint-row">${MI_L}<span>ドラッグ＝<b>移動</b></span>${MI_W(" gap")}<span>ホイール＝<b>ズーム</b></span></div>
		<div class="hint-row"><span class="key">⌘/Ctrl</span><span class="hint-plus">＋</span>${MI_W("")}<span>＝<b>回転</b></span></div>
		<div class="hint-row"><span class="key">⇧/Shift</span><span class="hint-plus">＋</span>${MI_L}<span class="hint-plus">／</span>${MI_R}<span>右ドラッグ</span></div>
		<div class="hint-row"><span>引っ張る＝<b>3D表示</b>（傾き・回転）</span></div>
		<div class="hint-note">街に寄ると建物が3Dで現れます<br>（初回は読み込みに少し時間がかかります）</div>`;
	const btn = document.createElement("button");
	btn.id = "hint-btn"; btn.dataset.tip = "操作方法"; btn.textContent = "?"; btn.setAttribute("aria-label", "操作方法");
	// 置き場所はスタック（搭載順＝縦の並び）。カードと「?」は常にどちらか一方だけ表示＝同じ枠を分け合う。
	gadgetStack(mapEl).append(card, btn);

	// 挙動：初見には最初から開いておく＝操作方法は第一印象の一部（出し惜しみしない）。
	// ×で畳んだ選択は記憶＝二度目からは「?」だけの静かな起動。旧・6秒自動表示は廃止（新しい概念に入る時、古いものは捨てる）。
	function setHint(open, remember = true) {
		card.style.display = open ? "" : "none";
		btn.style.display = open ? "none" : "flex";
		if (remember) try { localStorage.setItem("oj.hint", open ? "" : "closed"); } catch { /* private mode 等 */ }
	}
	card.querySelector("#hint-close").addEventListener("click", () => setHint(false));
	btn.addEventListener("click", () => setHint(true));
	let closedOnce = false;
	try { closedOnce = localStorage.getItem("oj.hint") === "closed"; } catch { /* private mode 等 */ }
	setHint(!closedOnce, false);   // 初見＝開いた状態で起動／畳んだ人＝「?」から（どちらも記憶には書かない）
	return { open: () => setHint(true), close: () => setHint(false) };   // 呼び出し側の手綱（プログラムから開閉）
}
