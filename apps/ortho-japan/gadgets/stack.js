// ガジェットスタック：オプトインガジェットの容れ物（左上・意匠は quiet-mono #gadgets）。
// 搭載した順＝縦の並び。display:none のガジェットは flex の流れから抜ける＝下のガジェットが上へ詰まる（上詰め）。
// 初回の搭載で自作＝ガジェットを一つも載せない画面には存在しない。
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
