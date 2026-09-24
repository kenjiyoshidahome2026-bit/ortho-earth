// ガジェット：建物3Dデータ管理ボタン。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.mesh() で搭載する（旧名 map.gadget.plateau() は非推奨の別名・v1 ortho-map の gadget 作法＝this が map）。
// アイコンは地域宣言が持つ（日本＝Project PLATEAU 公式ロゴマーク・@ortho-earth/jp の buildings.icon）。宣言が無い地域は汎用の建物の形。
// DOM id は #plateau-btn のまま（quiet-mono と利用者の CSS が当てる公開面・2026-09-22 の改名でも据え置き）。
// 押した時の挙動（データ管理モーダル #pdb を開く）は本体が onOpen で注入＝モーダル実体は meshdb.js の領分。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { tr } from "../i18n.js";
const t = tr();
// 汎用の建物の形（地域がアイコンを宣言しない時）＝34px 規格・単色（夜テーマは quiet-mono が fill を差し替える）
const GENERIC_ICON = `<svg viewBox="0 0 20 24" width="15" height="18" fill="#463C64" aria-hidden="true"><path d="M1 23V9l7-3v17H1Zm8 0V2l10 4v17H9Zm2-15v2h2V8h-2Zm4 1v2h2V9h-2Zm-4 4v2h2v-2h-2Zm4 1v2h2v-2h-2ZM3 12v2h3v-2H3Zm0 5v2h3v-2H3Z"/></svg>`;
export function mesh({ onOpen, signal, icon = null, labels = {} } = {}) {   // labels＝地域の申告（出所の名を出す文言の i18n キー）
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#plateau-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
	const btn = document.createElement("button");
	btn.id = "plateau-btn"; const key = mac ? "⌘⇧P" : "Ctrl+⇧P";
	btn.dataset.tip = labels.manage ? t(labels.manage, key) : t("Manage 3D buildings ($1)", key);
	btn.setAttribute("aria-label", labels.aria ? t(labels.aria) : t("Preload and delete 3D buildings"));
	btn.innerHTML = icon || GENERIC_ICON;
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
