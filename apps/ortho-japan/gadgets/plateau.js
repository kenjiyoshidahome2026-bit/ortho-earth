// ガジェット：建物3D（PLATEAU）データ管理ボタン。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.plateau() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// アイコンは Project PLATEAU（国土交通省）公式ロゴマーク（plateau.mlit.go.jp の logo_min そのまま・色はブランド紫）。
// 押した時の挙動（データ管理モーダル #pdb を開く）は本体が onOpen で注入＝モーダル実体は plateaudb.js の領分。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
export function plateau({ onOpen, signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#plateau-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
	const btn = document.createElement("button");
	btn.id = "plateau-btn"; btn.dataset.tip = `建物3D（PLATEAU）の管理 (${mac ? "⌘⇧P" : "Ctrl+⇧P"})`; btn.setAttribute("aria-label", "建物3D（PLATEAU）のプレロードと削除");
	btn.innerHTML = `
		<svg viewBox="0 0 20 30" width="14" height="21" fill="#463C64" aria-hidden="true">
			<path d="M9.70269 11.7457L7.49993 10.452L0 6.04688V17.4448L20 29.1918V17.7939L16.0001 15.4446L14.8514 14.7698L12 13.0951L9.70269 11.7457Z"/>
			<path d="M9.69941 0L0.293945 5.52444L7.34804 9.66773L9.69941 11.0487V0Z"/>
			<path d="M14.851 14.0728V8.37378L19.7023 5.52444L10.2969 0V11.3979L12.1185 12.4679L14.851 14.0728Z"/>
			<path d="M19.9994 17.0956V6.04688L15.4453 8.72162V14.4207L16.3562 14.9556L19.9994 17.0956Z"/>
		</svg>`;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	if (onOpen) {
		btn.addEventListener("click", onOpen);
		// ⌘/Ctrl+⇧+P＝データ管理モーダルを開く（印刷 ⌘P と ⇧ で区別）。入力欄フォーカス中は無効。
		window.addEventListener("keydown", e => {
			if (!((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "p" || e.key === "P"))) return;
			if (keyBusy(mapEl)) return;
			e.preventDefault(); onOpen();
		}, { signal });
	}
	return btn;
}
