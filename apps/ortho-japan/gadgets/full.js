// ガジェット：全画面トグル。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.full() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// #map 自身を requestFullscreen＝埋め込み先でも地図だけが画面いっぱいに（body ではなく容れ物を全画面に）。
// 非対応（iOS Safari 等）はボタンごと出さない＝出ない機能のボタンを見せない。signal＝destroy 時のリスナー解除。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { tr } from "../i18n.js";
const t = tr({ "全画面表示 ({0})": "Full screen ({0})", "全画面表示": "Full screen", "全画面を終了": "Exit full screen" });
const EXPAND = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
const COMPRESS = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`;
export function full({ signal } = {}) {
	const mapEl = this.mapEl;
	const enter = mapEl.requestFullscreen || mapEl.webkitRequestFullscreen;
	const exit = document.exitFullscreen || document.webkitExitFullscreen;
	if (!enter) return;   // 非対応はボタンごと出さない
	if (mapEl.querySelector("#full")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "full"; btn.dataset.tip = t("全画面表示 ({0})", "Z"); btn.setAttribute("aria-label", t("全画面表示"));
	btn.innerHTML = EXPAND;
	// 置き場所はスタック（搭載順＝縦の並び）。
	gadgetStack(mapEl).append(btn);
	const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
	const toggle = () => {
		if (fsEl()) exit?.call(document);
		else enter.call(mapEl).catch(() => {});   // ユーザー拒否等は黙って無視（ボタンは元のまま）
	};
	btn.addEventListener("click", toggle);
	// Z単キー＝全画面トグル（旧⌘/Ctrl+Z転用は geoedit の undo と衝突＝修飾なしへ移した・本人裁定 2026-08-20）。
	// 文字入力中は keyBusy が止める。修飾付きは素通し＝⌘Z(undo)/⌘⇧Z(redo)は編集系アプリのもの。
	window.addEventListener("keydown", e => {
		if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || (e.key !== "z" && e.key !== "Z")) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); toggle();
	}, { signal });
	const sync = () => {   // 全画面状態はブラウザ主導（Escでも抜ける）＝イベントで絵柄を合わせる
		const on = fsEl() === mapEl;
		btn.innerHTML = on ? COMPRESS : EXPAND;
		btn.dataset.tip = on ? t("全画面を終了") : t("全画面表示");
		btn.setAttribute("aria-label", btn.dataset.tip);
	};
	document.addEventListener("fullscreenchange", sync, { signal });
	document.addEventListener("webkitfullscreenchange", sync, { signal });
	sync();
	return btn;
}
