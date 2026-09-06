// ガジェット：表示パネル（旧・テーマチップ帯のパネル化＝2026-09-02 本人裁定「右上の地名〜施設とテーマ等を
// 一つのパネルにまとめて、一つのアイコンで開閉。sky も入れる。右上スッキリ＝拡張もしやすく」）。
// DOMのみ＝点火の配線は main.js（.chip[data-k]＝レイヤ・#chip-sky＝星座・#theme-row＝main が充填）。
// keys＝orthoJapan({chips}) の起動パラメータ：true=全部（既定）／配列=選択的（並びは定義順で固定・非推奨）。
// fixed＝opts.layers で true/false 固定されたキー集合＝ボタンを出さない（状態は焼き付け済み＝客に触らせない）。
// 空になったらパネルごと出さない（点火状態 layerState 自体は生きる＝UIが無いだけ）。
// 置き場＝左上 #gadgets スタックの最上段（検索と同じ「押すと右へ開く」Netflix式＝右上は完全に空ける）。
import { tr } from "../i18n.js";
import { gadgetStack } from "./stack.js";
const t = tr({
	"表示・テーマ": "Layers & themes",
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
	"星空": "Sky",
	"基図": "Base map",
	"基図の濃さ（衛星画像の上で線・塗りを薄める）": "Base map opacity (fade lines/fills over imagery)",
	"星座線・星座名（引いた全球ビューで）": "Constellation lines and names (in the zoomed-out globe view)",
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
	// 重ね菱形＝「層」のアイコン。線は全部 本線ink #3f4757 の単色（夜反転・.on明パネル反転が1色で済む＝
	// 二階調(#9aa0ac)は反転規則と喧嘩して下線だけ色が浮いた 2026-09-02 本人指摘）
	chips.innerHTML = `
	<button id="layers-btn" aria-expanded="false" aria-controls="layers-panel" data-tip="${t("表示・テーマ")}">
		<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<path d="M10 2 L18 6.5 10 11 2 6.5 Z" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linejoin="round"/>
			<path d="M2 10.5 L10 15 18 10.5" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
			<path d="M2 14 L10 18.5 18 14" fill="none" stroke="#3f4757" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
	</button>
	<div id="layers-panel" hidden>
		${list.map(c =>
			`<button class="chip${c.on ? " on" : ""}" data-k="${c.k}" aria-pressed="${!!c.on}"${c.title ? ` data-tip="${t(c.title)}"` : ""}>${t(c.label)}</button>`).join("\n")}
		<button class="chip" id="chip-sky" aria-pressed="false" data-tip="${t("星座線・星座名（引いた全球ビューで）")}">${t("星空")}</button>
		<div id="alpha-row" style="display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 4px;" data-tip="${t("基図の濃さ（衛星画像の上で線・塗りを薄める）")}">
			<span>${t("基図")}</span><input type="range" id="base-alpha" min="15" max="100" value="100" style="flex:1;min-width:0;accent-color:#3f4757;">
		</div>
		<div id="theme-row"></div>
	</div>`;
	gadgetStack(mapEl).prepend(chips);   // 左上スタックの最上段へ（2026-09-02 本人裁定「右上は開ける＝アイコンは左・パネルは右へ開く」）
	// 開閉はここで自給（DOMだけの所作）。中身の点火配線は従来どおり main.js（独立の掟＝相互を知らない）
	const btn = chips.querySelector("#layers-btn"), panel = chips.querySelector("#layers-panel");
	const setOpen = open => {
		panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); btn.classList.toggle("on", open);
		// 検索とは排他（本人裁定 2026-09-02）：どちらも「右へ開く」同士＝重なる。畳むのは相手自身の所作
		//（#search-btn click＝searchのトグル）＝内部状態を直接触らない（ガジェット独立の掟の範囲内＝家具契約のidのみ）
		if (open) mapEl.querySelector("#search.open #search-btn")?.click();
	};
	btn.addEventListener("click", () => setOpen(panel.hidden));
	mapEl.addEventListener("click", e => {   // 逆方向＝検索を押したらパネルを閉じる（capture＝検索側の処理順に依存しない）
		if (!panel.hidden && e.target.closest?.("#search-btn")) setOpen(false);
	}, true);
	document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) setOpen(false); });
}
