// ガジェット：テーマ・チップ（DOMのみ＝点火の配線は main.js）。日本の主題の語彙はここが持つ。
export function mountChips(mapEl) {
	const chips = document.createElement("div");
	chips.id = "chips";
	chips.innerHTML = `
		<button class="chip on" data-k="chimei" title="地名・行政界">地名</button>
		<button class="chip" data-k="chikei" title="地形の名前・等高線（真俯瞰時）・水系">地形</button>
		<button class="chip" data-k="rail">鉄道</button>
		<button class="chip" data-k="road">道路</button>
		<button class="chip" data-k="shisetsu">施設</button>
		<button class="chip tool" id="btn-3ddata" title="建物3D（PLATEAU）のプレロードと削除">Plateau</button>`;
	mapEl.append(chips);
}
