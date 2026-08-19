// ガジェット：テーマ・チップ（DOMのみ＝点火の配線は main.js）。日本の主題の語彙はここが持つ。
// keys＝orthoJapan({chips}) の起動パラメータ：true=全部（既定）／配列=選択的（並びは定義順で固定・非推奨）。
// fixed＝opts.layers で true/false 固定されたキー集合＝ボタンを出さない（状態は焼き付け済み＝客に触らせない）。
// 空になったらチップ列ごと出さない（点火状態 layerState 自体は生きる＝UIが無いだけ）。
import { tr } from "../i18n.js";
const t = tr({
	"地名": "Places",
	"地名・行政界": "Place names and administrative boundaries",
	"地形": "Terrain",
	"地形の名前・等高線（真俯瞰時）・水系": "Terrain names, contours (top-down view) and water systems",
	"鉄道": "Rail",
	"鉄道路線・駅／港・空港名": "Rail lines, stations / port and airport names",
	"道路": "Roads",
	"道路・IC/JCT・国道/高速番号・航路": "Roads, IC/JCT, route and expressway numbers, ferry routes",
	"施設": "Facilities",
	"各種施設・ランドマーク名": "Facility and landmark names",
});
const LEGACY = { chimei: "place", chikei: "terrain", shisetsu: "facility" };   // 旧romajiキーの読み替え（後方互換）
const CHIPS = [
	{ k: "place", label: "地名", title: "地名・行政界", on: true },
	{ k: "terrain", label: "地形", title: "地形の名前・等高線（真俯瞰時）・水系" },
	{ k: "rail", label: "鉄道", title: "鉄道路線・駅／港・空港名" },
	{ k: "road", label: "道路", title: "道路・IC/JCT・国道/高速番号・航路" },
	{ k: "facility", label: "施設", title: "各種施設・ランドマーク名" },
];
export function mountChips(mapEl, keys = true, fixed = {}) {
	let sel = keys;
	if (Array.isArray(keys)) {   // typo は黙って0個になる＝開発時の迷子防止に一声
		sel = keys.map(k => LEGACY[k] || k);
		const known = new Set(CHIPS.map(c => c.k));
		for (const k of sel) if (!known.has(k)) console.warn(`[chips] unknown key "${k}" (valid: ${[...known].join(", ")})`);
	}
	const list = CHIPS.filter(c => !(c.k in fixed))   // 固定キーはボタン自体を出さない
		.filter(c => sel === true || (Array.isArray(sel) && sel.includes(c.k)));
	if (!list.length) return;
	const chips = document.createElement("div");
	chips.id = "chips";
	chips.innerHTML = list.map(c =>
		`<button class="chip${c.on ? " on" : ""}" data-k="${c.k}" aria-pressed="${!!c.on}"${c.title ? ` data-tip="${t(c.title)}"` : ""}>${t(c.label)}</button>`).join("\n");
	mapEl.append(chips);
}
