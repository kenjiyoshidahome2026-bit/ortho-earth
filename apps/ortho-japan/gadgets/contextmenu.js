// ガジェット：右クリックメニュー。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.contextmenu() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 右クリック（タッチは長押しの contextmenu）で #map 上の指した地点にメニューを出す。
// 項目は本体が差し替え可＝戻り値の setter に配列を渡す（各項目 {name, icon?, onClick(ctx)}）。
// 未設定なら既定メニュー（この地点へ寄る／座標をコピー）＝搭載しただけで使える。
// ctx＝{ lng, lat, x, y, map }。lng/lat は指した画面座標の逆投影（screen→world。裏半球や宇宙なら undefined）。
// unprojectAt＝画面座標→経緯度（実装は engine の unproject／注入は登録側）。signal＝destroy 時のリスナー解除。
export function contextmenu({ unprojectAt, signal, items } = {}) {
	const mapEl = this.mapEl, cam = this.cam, flyTo = this.flyTo, map = this;
	if (mapEl.querySelector("#ctxmenu")) return () => {};   // 二重搭載は無害
	const DEFAULT = [
		{ name: "この地点へ寄る", onClick: c => c.lng != null && flyTo(c.lng, c.lat, Math.max(cam.zoom, 14), cam.pitch * 180 / Math.PI) },
		{ name: "座標をコピー", onClick: c => c.lng != null && navigator.clipboard?.writeText(`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`) },
	];
	let list = items || DEFAULT;
	const menu = document.createElement("div");
	menu.id = "ctxmenu"; menu.style.display = "none";
	// 後置＝#map 直下（DOM順で上に描く。z-index不使用の掟）。
	mapEl.append(menu);
	const hide = () => { menu.style.display = "none"; };
	const ctx = e => {
		const r = mapEl.getBoundingClientRect();
		const ll = unprojectAt(e.clientX, e.clientY);   // 球に当たらなければ null
		return { lng: ll?.[0], lat: ll?.[1], x: e.clientX - r.left, y: e.clientY - r.top, map };
	};
	mapEl.addEventListener("contextmenu", e => {
		e.preventDefault();
		const c = ctx(e);
		const arr = typeof list === "function" ? list(c) : list;
		if (!Array.isArray(arr) || !arr.length) return hide();
		menu.replaceChildren();
		for (const it of arr) {
			const p = document.createElement("button");
			p.className = "ctxmenu-item";
			p.innerHTML = (it.icon || "") + `<span>${it.name}</span>`;
			p.addEventListener("click", ev => { ev.stopPropagation(); hide(); it.onClick?.(c); });
			menu.append(p);
		}
		const r = mapEl.getBoundingClientRect();
		let cx = c.x, cy = c.y;
		menu.style.display = ""; menu.style.left = cx + "px"; menu.style.top = cy + "px";
		const m = menu.getBoundingClientRect();   // 実寸を測って端で見切れないよう内側へ寄せる
		if (cx + m.width > r.width) menu.style.left = Math.max(0, r.width - m.width - 4) + "px";
		if (cy + m.height > r.height) menu.style.top = Math.max(0, r.height - m.height - 4) + "px";
	}, { signal });
	// 閉じる：地図クリック・ドラッグ開始（押したまま動く＝パン/回転）・Esc（メニュー内クリックは項目ハンドラが閉じる）。
	// 押下だけでは閉じない（メニューは瞬間に消えない）＝ボタンを押したまま動いた時に解除＝地図を掴んだ合図。
	mapEl.addEventListener("click", hide, { signal });
	mapEl.addEventListener("pointermove", e => { if (e.buttons !== 0 && !menu.contains(e.target)) hide(); }, { signal, passive: true });
	window.addEventListener("keydown", e => { if (e.key === "Escape") hide(); }, { signal });
	return set => { list = set; };   // 呼び出し側の手綱（項目の差し替え。配列 or e→配列 の関数）
}
