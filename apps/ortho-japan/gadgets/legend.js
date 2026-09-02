// ガジェット：凡例パネル（左下）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.legend() で搭載する（v1 ortho-map の gadget 作法＝this が map）。戻り値＝内容の setter。
// 色・記号の対応表を左下に置く読み物の枠。set(html) で表示／set(null) で消す。
// ×で畳むと小さな「凡例」ボタン（スタック）に化ける＝地図面を広く（hint と同じ所作）。
// opts.permanent＝×ボタンを出さない（畳めない常設）。opts.width＝最大幅(px)。
import { gadgetStack, dockStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr({ "閉じる": "Close", "凡例を閉じる": "Close legend", "凡例": "Legend", "凡例を開く": "Open legend" });
export function legend({ permanent, width } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#legend")) return () => {};   // 二重搭載は無害
	const div = document.createElement("div");
	div.id = "legend"; div.style.display = "none";
	if (width) div.style.maxWidth = width + "px";
	const body = document.createElement("div");
	div.append(body);
	div.addEventListener("pointerdown", e => e.stopPropagation());
	dockStack(mapEl).append(div);   // 左下ドック＝座標計器(#pos)やトーストの上へ積まれる（旧・絶対配置は #pos と真被りだった）
	let reopen = null, hasContent = false;
	if (!permanent) {
		const close = document.createElement("button");
		close.className = "panel-close"; close.textContent = "×"; close.title = t("閉じる"); close.setAttribute("aria-label", t("凡例を閉じる"));
		close.addEventListener("click", () => collapse());
		div.append(close);
		// 畳んだ時の再表示ボタン＝スタック（搭載順＝縦の並び）。内容がある間だけ意味を持つ。
		reopen = document.createElement("button");
		reopen.id = "legend-btn"; reopen.textContent = t("凡例"); reopen.title = t("凡例"); reopen.setAttribute("aria-label", t("凡例を開く"));
		reopen.dataset.tip = t("凡例"); reopen.style.display = "none";
		reopen.addEventListener("click", () => expand());
		gadgetStack(mapEl).append(reopen);
	}
	const expand = () => { if (hasContent) { div.style.display = "block"; reopen && (reopen.style.display = "none"); } };
	const collapse = () => { div.style.display = "none"; reopen && hasContent && (reopen.style.display = "flex"); };
	function set(html) {
		if (typeof html === "function") { hasContent = true; return html(body); }
		if (!html) { hasContent = false; body.innerHTML = ""; div.style.display = "none"; reopen && (reopen.style.display = "none"); return; }
		hasContent = true; body.innerHTML = html; div.style.display = "block"; reopen && (reopen.style.display = "none");
	}
	return set;   // 呼び出し側の手綱
}
