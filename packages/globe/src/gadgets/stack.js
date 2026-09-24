// ガジェットスタック：オプトインガジェットの容れ物（左上・意匠は quiet-mono #gadgets）。
// 搭載した順＝縦の並び。display:none のガジェットは flex の流れから抜ける＝下のガジェットが上へ詰まる（上詰め）。
// 初回の搭載で自作＝ガジェットを一つも載せない画面には存在しない。
// ★ここへボタンを積む時の約束（2026-09-24 裁定・並びが崩れた実例＝日影/可視域が素のボタンのまま出ていた）：
//   btn.className = "qm-panel-btn"（34px 角・ガラス・.on＝明パネル反転が一式）＋ btn.type = "button"。
//   アイコンは <svg viewBox="0 0 24 24" width="18" height="18" … stroke="#3f4757" stroke-width="1.8">（塗りの記号は fill="#3f4757"）。
//   地図のクリックや左下のパネルを握る道具は globe.js の「道具の排他」に onOpen/close で参加させる（同時に一つだけ）。
//   検定＝apps/ortho-japan/tests/t-gadgets.html（スタックの全ボタンが 34×34・左端が揃う）。
export function gadgetStack(mapEl) {
	let st = mapEl.querySelector("#gadgets");
	if (!st) { st = document.createElement("div"); st.id = "gadgets"; mapEl.append(st); }
	return st;
}

// 左下ドック：下辺左の読み物（#log・#pos 座標計器・読込トースト・#legend 凡例）の容れ物（意匠は quiet-mono #dock）。
// column-reverse＝最初に入った者が縁（最下段）・後から来た者は上へ積まれる。display:none は流れから
// 抜けて詰まる＝#gadgets と同じ掟。個々の bottom オフセット手打ちを廃し重なりを構造で排除（2026-09-03 被り総括）。
export function dockStack(mapEl) {
	let d = mapEl.querySelector("#dock");
	if (!d) { d = document.createElement("div"); d.id = "dock"; mapEl.append(d); }
	return d;
}
