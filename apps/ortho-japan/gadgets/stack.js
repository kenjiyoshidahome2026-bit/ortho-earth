// ガジェットスタック：オプトインガジェットの容れ物（左上・意匠は quiet-mono #gadgets）。
// 搭載した順＝縦の並び。display:none のガジェットは flex の流れから抜ける＝下のガジェットが上へ詰まる（上詰め）。
// 初回の搭載で自作＝ガジェットを一つも載せない画面には存在しない。
export function gadgetStack(mapEl) {
	let st = mapEl.querySelector("#gadgets");
	if (!st) { st = document.createElement("div"); st.id = "gadgets"; mapEl.append(st); }
	return st;
}
