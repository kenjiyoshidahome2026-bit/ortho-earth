// カーソル追従の吹き出し：el の中の [data-tip] に指が乗ったら出す（japan の #tip と同じ意匠と挙動）。
// 意匠＝黒0.75・白文字・細い白枠・角丸4px／挙動＝即時表示・離れたら即消し・右端で左へ反転・タッチは指の上。
// data-tip の一行目は見出し（太字）。signal＝destroy時の解除。依存なし（CSS も自前で一度だけ差し込む）。
const CSS = `
.himekuri-tip {
	position: fixed; pointer-events: none; z-index: 1000; display: none;
	background: rgba(0, 0, 0, .75); color: #fff; font: 12px/1.6 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif;
	padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, .2);
	max-width: 280px;
}
.himekuri-tip > div:first-child { font-weight: 700; }
`;
export function tip(el, { signal } = {}) {
	if (!document.getElementById("himekuri-tip-css")) {
		const st = document.createElement("style");
		st.id = "himekuri-tip-css"; st.textContent = CSS;
		document.head.append(st);
	}
	const div = document.createElement("div");
	div.className = "himekuri-tip";
	document.body.append(div);
	signal?.addEventListener("abort", () => div.remove());
	let cur = null, size = { w: 0, h: 0 };
	const hide = () => { cur = null; div.style.display = "none"; };
	const set = text => {
		div.replaceChildren(...text.split("\n").map(t => Object.assign(document.createElement("div"), { textContent: t })));
		div.style.display = "block"; div.style.visibility = "hidden";   // 実寸を測ってから指先の脇へ
		const r = div.getBoundingClientRect(); size = { w: r.width, h: r.height };
		div.style.visibility = "";
	};
	const move = e => {
		const t = e.target.closest?.("[data-tip]");
		if (!t || !el.contains(t)) return hide();
		if (t !== cur) { cur = t; set(t.dataset.tip); }
		const touch = e.pointerType === "touch";
		const W = innerWidth, H = innerHeight, x = e.clientX, y = e.clientY, { w, h } = size;
		const osx = touch ? 40 : 15, osy = touch ? -(h + 30) : -h / 2;   // タッチは指の上に出す
		const left = (x + osx + w > W) ? Math.max(0, x - w - osx) : (x + osx);
		const top = Math.min(Math.max(0, y + osy), H - h);
		div.style.left = left + "px"; div.style.top = top + "px";
	};
	el.addEventListener("pointermove", move, { signal, passive: true });
	el.addEventListener("pointerdown", move, { signal, passive: true });
	el.addEventListener("pointerleave", hide, { signal });
	el.addEventListener("pointerup", e => { if (e.pointerType === "touch") hide(); }, { signal });
	el.addEventListener("pointercancel", hide, { signal });
	addEventListener("scroll", hide, { signal, passive: true });
	return hide;
}
