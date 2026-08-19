// ガジェット：閉じる×（埋め込み用）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.close() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押す（or Esc）と mapEl から CustomEvent "ortho:close"（bubbles）を飛ばすだけ＝閉じる実務（モーダルを畳む・
// destroy を呼ぶ等）は埋め込み側の領分。単体ページでは載せない＝モーダル/ライトボックスに地図を出す画面のための×。
// 置き場所は右上（チップ列のさらに上ではなく #map 直下の後置＝スタック不参加。×は家具でなく「額縁の金具」）。
import { modalOpen, isTypingTarget } from "./keys.js";
import { tr } from "../i18n.js";
const t = tr({ "閉じる (Esc)": "Close (Esc)", "地図を閉じる": "Close map" });

export function close({ signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#close-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "close-btn"; btn.dataset.tip = t("閉じる (Esc)"); btn.setAttribute("aria-label", t("地図を閉じる"));
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#3f4757" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
			<path d="M6 6l12 12M6 18L18 6"/></svg>`;
	mapEl.append(btn);
	const dispatch = () => mapEl.dispatchEvent(new CustomEvent("ortho:close", { bubbles: true }));
	btn.addEventListener("click", dispatch);
	// Esc＝×と同じ。ただし「開いている物」（印刷モーダル・PLATEAUモーダル・右クリックメニュー・測距中・入力中）が
	// ある間は譲る＝Escはまずそれらを閉じる係（地図ごと閉じる事故を防ぐ）。モーダル/入力判定は keys.js と共有。
	const overlayOpen = () => mapEl.classList.contains("measuring") || modalOpen(mapEl) || isTypingTarget();
	window.addEventListener("keydown", e => { if (e.key === "Escape" && !overlayOpen()) dispatch(); }, { signal });
	return btn;
}
