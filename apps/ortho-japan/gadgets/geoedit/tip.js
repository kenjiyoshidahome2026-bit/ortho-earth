// @tip ホバーツールチップ＋ハンドルホバーのカーソル（grab）。
// 位置も内容も毎moveで即時（v1 tip.js の作法＝デバウンスの追従遅れ・消え残りを無くす）。
// 識別（identifyAt＝全走査）は「@tip を持つ要素が一つでもあるか」をモデル/編集世代ごとに一度だけ調べて、無ければ払わない。
import { sanitizeHTML } from "./overlay.js";

export function createTip(ed) {
	const { st, map, mapEl, signal, overlay } = ed;
	let tipEl = null, tipW = 0, tipH = 0;   // tipW/H＝内容確定時に測る器寸（毎moveのレイアウト読みを避ける）
	let cache = { model: null, gen: -1, has: false };
	const anyTip = () => {
		if (cache.model !== st.model || cache.gen !== st.editGen) {
			let has = false;
			for (const f of st.model.feats.values()) { const t = f.properties?.["@tip"]; if (t != null && t !== "") { has = true; break; } }
			cache = { model: st.model, gen: st.editGen, has };
		}
		return cache.has;
	};
	const hide = () => { tipEl?.remove(); tipEl = null; };
	const place = (x, y) => {   // pop の初期配置に合わせる（右＋12・縦中央）。画面端では内側へ寄せる。
		const W = mapEl.clientWidth, H = mapEl.clientHeight;
		const left = (x + 12 + tipW > W) ? (x - tipW - 12) : (x + 12);   // 右端では左側へ出す（見切れ防止）
		let top = y - tipH / 2; if (top < 0) top = 0; else if (top + tipH > H) top = H - tipH;
		tipEl.style.left = left + "px"; tipEl.style.top = top + "px";
	};
	mapEl.addEventListener("pointermove", e => {
		if (st.drag || st.sketch) return;   // ドラッグ/作図中は drag.js / sketch.js の担当
		const [x, y] = ed.localXY(e);
		if (st.selection != null && !st.busy)   // ハンドルにホバー＝掴めることをカーソルで示す
			mapEl.style.cursor = overlay.handleAt(x, y, e.pointerType === "touch") ? "grab" : "";
		if (st.busy || !st.model || !anyTip()) return hide();
		const eid = ed.pick(x, y);
		const tip = eid != null ? st.model.feats.get(eid)?.properties?.["@tip"] : null;
		if (tip == null || tip === "") return hide();
		if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "ge-tip"; mapEl.append(tipEl); }
		if (tipEl._raw !== String(tip)) { tipEl._raw = String(tip); tipEl.innerHTML = sanitizeHTML(tip); tipW = tipEl.offsetWidth; tipH = tipEl.offsetHeight; }   // @tip は HTML/画像可（消毒済）。内容変化時だけ器寸を測る
		place(x, y);
	}, { capture: true, signal });
	mapEl.addEventListener("pointerleave", hide, { signal });   // 地図の外へ離れたら即消す
	return { hide };
}
