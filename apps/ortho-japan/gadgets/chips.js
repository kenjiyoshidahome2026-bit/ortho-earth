// ガジェット：テーマ・チップ（DOMのみ＝点火の配線は main.js）。日本の主題の語彙はここが持つ。
// keys＝orthoJapan({chips}) の起動パラメータ：true=全部（既定）／配列=選択的（並びは定義順で固定）。
// 空になったらチップ列ごと出さない（点火状態 layerState 自体は生きる＝UIが無いだけ）。
const CHIPS = [
	{ k: "chimei", label: "地名", title: "地名・行政界", on: true },
	{ k: "chikei", label: "地形", title: "地形の名前・等高線（真俯瞰時）・水系" },
	{ k: "rail", label: "鉄道" },
	{ k: "road", label: "道路" },
	{ k: "shisetsu", label: "施設" },
];
export function mountChips(mapEl, keys = true) {
	if (Array.isArray(keys)) {   // typo は黙って0個になる＝開発時の迷子防止に一声
		const known = new Set(CHIPS.map(c => c.k));
		for (const k of keys) if (!known.has(k)) console.warn(`[chips] 未知のキー "${k}"（有効: ${[...known].join(", ")}）`);
	}
	const list = keys === true ? CHIPS : CHIPS.filter(c => Array.isArray(keys) && keys.includes(c.k));
	if (!list.length) return;
	const chips = document.createElement("div");
	chips.id = "chips";
	chips.innerHTML = list.map(c =>
		`<button class="chip${c.on ? " on" : ""}" data-k="${c.k}" aria-pressed="${!!c.on}"${c.title ? ` title="${c.title}"` : ""}>${c.label}</button>`).join("\n");
	mapEl.append(chips);
}
