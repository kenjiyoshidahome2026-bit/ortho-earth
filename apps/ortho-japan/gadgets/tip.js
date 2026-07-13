// ガジェット：カーソル追従の吹き出し。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.tip() で搭載する（v1 ortho-map の gadget 作法＝this が map）。戻り値＝内容の setter。
// 呼び出し側が set(内容) でカーソル脇に出す／set(null) で消す（例：ホバー識別の即時表示）。
// ボタンの説明（data-tip）とは別物＝あちらは静的ラベル、こちらは動的な指先の注記。signal＝destroy時の解除。
export function tip({ signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#tip")) return () => {};   // 二重搭載は無害
	const div = document.createElement("div");
	div.id = "tip"; div.style.display = "none";
	mapEl.append(div);   // #map 直下の後置（DOM順で上・pointer-events は CSS で none）
	const coarse = window.matchMedia("(pointer: coarse)").matches;
	let size = { w: 0, h: 0 }, last = null;   // last＝最後のカーソル位置（内容更新時に即座にそこへ出す）
	const toHTML = s => Array.isArray(s) ? s.map(t => `<div>${t}</div>`).join("")
		: (typeof s === "string" && s.includes("\n")) ? toHTML(s.split(/\n/)) : s;
	const hide = () => { div.style.display = "none"; };
	mapEl.addEventListener("pointermove", e => {
		const r = mapEl.getBoundingClientRect();
		last = { x: e.clientX - r.left, y: e.clientY - r.top }; move();
	}, { signal, passive: true });
	mapEl.addEventListener("pointerleave", () => { last = null; hide(); }, { signal });
	function move() {
		if (!last || !size.w) return hide();
		const W = mapEl.clientWidth, H = mapEl.clientHeight, { x, y } = last, { w, h } = size;
		const osx = coarse ? 40 : 15, osy = coarse ? -(h + 30) : -h / 2;   // タッチは指の上に出す
		const left = (x + osx + w > W) ? (x - w - osx) : (x + osx);
		let top = y + osy; if (top < 0) top = 0; else if (top + h > H) top = H - h;
		div.style.left = left + "px"; div.style.top = top + "px"; div.style.display = "block";
	}
	return content => {   // 内容の setter（呼び出し側の手綱）
		if (!content) { div.innerHTML = ""; size = { w: 0, h: 0 }; return hide(); }
		div.innerHTML = toHTML(content);
		div.style.display = "block"; div.style.visibility = "hidden";   // 実寸を測ってからカーソル脇へ
		const r = div.getBoundingClientRect(); size = { w: r.width, h: r.height };
		div.style.visibility = ""; last ? move() : hide();
	};
}
