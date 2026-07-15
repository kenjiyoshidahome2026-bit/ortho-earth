// ガジェット：現在地（GPS）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.cpos() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 押すと geolocation で現在地を得て球面フライトで寄り、点滅マーカーを置く。もう一度押すと消す。
// マーカーの画面追随は本体 render のフック＝この関数が返す update を本体（app.js の登録側）が掴んで毎フレ呼ぶ。
// projectLL＝経緯度→画面CSS座標（world→screen。実装は engine の project／注入は登録側）。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
export function cpos({ projectLL, signal } = {}) {
	const mapEl = this.mapEl, cam = this.cam, flyTo = this.flyTo;
	if (mapEl.querySelector("#cpos-btn")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "cpos-btn"; btn.dataset.tip = "現在地（GPS）へ移動（@）"; btn.setAttribute("aria-label", "現在地（GPS）へ移動");
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="2" aria-hidden="true">
			<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="#3f4757" stroke="none"/>
			<line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/>
			<line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>`;
	// 置き場所はスタック（搭載順＝縦の並び）。
	gadgetStack(mapEl).append(btn);
	// 点滅マーカーは #map 直下の後置要素（DOM順で上に描く。z-index不使用の掟）。位置は毎フレ projectLL で追随。
	const mark = document.createElement("div");
	mark.id = "cpos-mark"; mark.style.display = "none";
	mark.innerHTML = `
		<svg viewBox="0 0 50 50" width="34" height="34" aria-hidden="true">
			<circle cx="25" cy="25" r="20" fill="none" stroke="#c00" stroke-width="4">
				<animate attributeName="r" values="10;25;10" dur="2s" repeatCount="indefinite"/>
				<animate attributeName="opacity" values="1;0;1" dur="2s" repeatCount="indefinite"/></circle>
			<circle cx="25" cy="25" r="8" fill="#fff" stroke="#c00" stroke-width="2"/>
			<circle cx="25" cy="25" r="4" fill="#c00"/></svg>`;
	mapEl.append(mark);
	let on = false, pos = null;
	const off = () => { on = false; pos = null; btn.classList.remove("on"); mark.style.display = "none"; };
	const toggle = async () => {
		if (on) return off();
		on = true; btn.classList.add("on");
		const p = await getPosition();
		if (!on) return;   // 取得待ちの間にもう一度押して消していた＝結果は捨てる
		if (!p) { console.warn("[cpos] 現在地を取得できませんでした（許可なし/失敗）"); return off(); }
		pos = p; mark.style.display = "";
		flyTo(pos[0], pos[1], Math.max(cam.zoom, 14), cam.pitch * 180 / Math.PI);   // 傾きは今のまま・最低 z14 まで寄る
	};
	btn.addEventListener("click", toggle);
	// @＝現在地トグル（修飾なし）。入力欄フォーカス中は無効。@ はJIS配列では単独キー・US配列では⇧2＝どちらも e.key==="@"。
	window.addEventListener("keydown", e => {
		if (e.key !== "@" || e.ctrlKey || e.metaKey || e.altKey) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); toggle();
	}, { signal });
	return function update() {   // マーカーを現在地の画面座標へ（裏半球なら隠す）
		if (!on || !pos) return;
		const [x, y, front] = projectLL(pos[0], pos[1]);
		if (front < 0) return void (mark.style.display = "none");
		mark.style.display = ""; mark.style.left = x + "px"; mark.style.top = y + "px";
	};
	function getPosition() {
		return new Promise(resolve => {
			if (!navigator.geolocation) return resolve(null);
			navigator.geolocation.getCurrentPosition(
				q => resolve(q?.coords ? [q.coords.longitude, q.coords.latitude] : null),
				() => resolve(null),
				{ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
		});
	}
}
