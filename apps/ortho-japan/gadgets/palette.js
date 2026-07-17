// ガジェット：配色テーマ・ピッカー（オプトイン＝orthoJapan() の戻り値から map.gadget.palette() で搭載。
// 呼ばなければ搭載されず、配色は共有URLの c=<name> に従うだけ＝UI は c= を書き替える手段にすぎない）。
// 左スタックにパレット・ボタン → 押すと中央に「自分以外」のテーマの地図見本をポップ（色で選ぶ＝配色テーマの本質）。
// 見本＝各テーマの実色で塗った簡易マップ（SVG・同じ絵を色だけ差し替え）。カード＝切替(onPick→reload)／ESC・外クリック＝取消。
// テーマの語彙（並び・短名・見本色）はここが持つ（chips.js が主題の語彙を持つのと同じ流儀）。★テーマ追加時はここにも1行。
import { gadgetStack } from "./stack.js";

// 見本色＝palettes.js / style-*.js の実色の代表値（paper=紙・ink=注記・water=水・bldg=建物・
// roads=[幹線1, 幹線2, 一般]・contour=等高線・admin=界線）。地図に見える最小構成の色だけ持つ。
const THEMES = [
	{ k: "mono", name: "白地図", paper: "#f6f6f4", ink: "#86867f", water: "#dde3e9", bldg: "#ececea", roads: ["#2f6cad", "#8fb2d6", "#cececb"], contour: "#b28f5e", admin: "#aa7878" },
	{ k: "dark", name: "夜", paper: "#191d24", ink: "#9aa1a9", water: "#0b0f17", bldg: "#21252d", roads: ["#5595dc", "#46688f", "#565c66"], contour: "#b89466", admin: "#a03a42" },
	{ k: "gsi", name: "地理院", paper: "#fefeff", ink: "#555555", water: "#bed2ff", bldg: "#ffe6be", roads: ["#3d9738", "#e69212", "#b8b8b8"], contour: "#c8a03c", admin: "#440080" },
	{ k: "sepia", name: "セピア", paper: "#f0e6d3", ink: "#6a5c46", water: "#d0d8d2", bldg: "#e6d7bd", roads: ["#5f82a0", "#93a8bd", "#cab896"], contour: "#8c6b45", admin: "#a4685a" },
];

// 簡易マップの見本（120×84）：紙→水→等高線→建物→道路→界線 の順に、その気配だけを描く。色は t で差し替わる。
const sampleSVG = t => `<svg viewBox="0 0 120 84" preserveAspectRatio="none" aria-hidden="true">
	<rect width="120" height="84" fill="${t.paper}"/>
	<path d="M0,84 L0,50 C16,55 29,66 33,84 Z" fill="${t.water}"/>
	<path d="M33,84 C40,63 60,57 67,40 C71,29 85,24 97,13" fill="none" stroke="${t.water}" stroke-width="3" stroke-linecap="round" opacity=".9"/>
	<path d="M74,8 C90,12 99,25 95,40" fill="none" stroke="${t.contour}" stroke-width="1" opacity=".75"/>
	<path d="M80,14 C90,17 95,26 92,37" fill="none" stroke="${t.contour}" stroke-width="1" opacity=".55"/>
	<g fill="${t.bldg}"><rect x="52" y="45" width="7" height="6"/><rect x="61" y="48" width="6" height="5"/><rect x="55" y="54" width="8" height="6"/><rect x="64" y="55" width="5" height="5"/></g>
	<path d="M6,22 C42,27 72,45 118,50" fill="none" stroke="${t.roads[2]}" stroke-width="1.4" stroke-linecap="round"/>
	<path d="M18,80 C34,54 54,45 112,29" fill="none" stroke="${t.roads[1]}" stroke-width="2.4" stroke-linecap="round"/>
	<path d="M2,42 C36,40 66,54 118,60" fill="none" stroke="${t.roads[0]}" stroke-width="3.2" stroke-linecap="round"/>
	<path d="M96,3 L90,28 L100,50 L91,82" fill="none" stroke="${t.admin}" stroke-width="1" stroke-dasharray="3 3" opacity=".85"/>
	<circle cx="46" cy="24" r="1.6" fill="${t.ink}"/>
</svg>`;

// 左スタックのパレット・アイコン（3つ重なる円＝配色の定番グリフ・線は currentColor でスタックの他アイコンと同調）。
// 上下＝1つ上・2つ下（三色の重なりが下で開く）。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
	<circle cx="12" cy="9" r="5"/><circle cx="9" cy="15" r="5"/><circle cx="15" cy="15" r="5"/></svg>`;

// opts.current＝いま焼き付いているテーマ名（見本から除く＝「自分以外」を出す）。opts.onPick(name)＝切替（app 側が reload）。
export function palette({ current, onPick, signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#palette-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "palette-btn"; btn.dataset.tip = "配色テーマ"; btn.setAttribute("aria-label", "配色テーマを選ぶ");
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）

	const picker = document.createElement("div");
	picker.id = "theme-picker";
	const others = THEMES.filter(t => t.k !== current);   // 自分以外
	picker.innerHTML = `<div class="tp-grid">` + others.map(t =>
		`<button class="tp-card" data-theme="${t.k}" aria-label="${t.name}に切替">${sampleSVG(t)}<span class="tp-name">${t.name}</span></button>`
	).join("") + `</div>`;
	mapEl.append(picker);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）

	const close = () => picker.classList.remove("open");
	btn.addEventListener("click", () => picker.classList.toggle("open"));
	picker.addEventListener("click", e => {
		const card = e.target.closest(".tp-card");
		if (card) onPick?.(card.dataset.theme);   // カード＝そのテーマへ切替（app が c= 差し替え＋reload）
		else close();                             // カード外（背景）＝取消
	});
	window.addEventListener("keydown", e => {   // ESC＝取消（開いている時だけ・他の Esc 消費と競合しない）
		if (e.key === "Escape" && picker.classList.contains("open")) { e.preventDefault(); close(); }
	}, { signal });
	return { open: () => picker.classList.add("open"), close };
}
