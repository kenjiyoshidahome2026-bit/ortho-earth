// ガジェット：説明パネル（上・中央）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.explain() で搭載する（v1 ortho-map の gadget 作法＝this が map）。戻り値＝内容の setter。
// 主題の解説・お知らせなど、地図の上辺に静かに出す読み物の枠。set(html) で表示／set(null) で消す。
// opts.permanent＝×ボタンを出さない（消せない常設）。opts.width＝最大幅(px)。
import { tr } from "../i18n.js";
const t = tr({ "閉じる": "Close" });
export function explain({ permanent, width } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#explain")) return () => {};   // 二重搭載は無害
	const div = document.createElement("div");
	div.id = "explain"; div.style.display = "none";
	if (width) div.style.maxWidth = width + "px";
	const body = document.createElement("div");   // 内容の器（×ボタンと分ける）
	div.append(body);
	if (!permanent) {
		const close = document.createElement("button");
		close.className = "panel-close"; close.textContent = "×"; close.title = t("閉じる"); close.setAttribute("aria-label", t("閉じる"));
		close.addEventListener("click", () => set(null));
		div.append(close);
	}
	// 内容の上でのドラッグは地図パンに奪わせない（読み物として選択・スクロールできる）
	div.addEventListener("pointerdown", e => e.stopPropagation());
	mapEl.append(div);   // #map 直下の後置（DOM順で上）
	function set(html) {
		if (typeof html === "function") return html(body);   // DOMを組みたい呼び出し向け
		if (!html) { body.innerHTML = ""; div.style.display = "none"; return; }
		body.innerHTML = html; div.style.display = "block";
	}
	return set;   // 呼び出し側の手綱
}
