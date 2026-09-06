// ガジェット：衛星シーン検索の玄関スタブ。ボタンだけを常駐させ、本体（STAC 検索＋一覧＝stac.js）は
// 初回クリックで一度だけ import()＝初期バンドルから隔離（measure-stub と同じ作法）。
// 「STAC が見つけ、COG が運ぶ」＝Earth Search（公開 STAC API）を現在ビューの bbox で引き、
// 選んだシーンの COG（TCI）を map.gadget.cog へ渡す＝日付と雲量で選ぶ衛星画像の入口。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr({ "衛星画像を探す（日付・雲量）": "Find satellite imagery (date, clouds)" });

// 衛星グリフ（本体と共有＝スタブがボタンを作る担当）。線色は本線インク直書き＝quiet-mono の夜節が自動反転。
export const ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
		<rect x="9" y="9" width="6" height="6" rx="1" transform="rotate(45 12 12)"/>
		<path d="M4.5 7.5l3 3M16.5 13.5l3 3" />
		<rect x="1.5" y="4.5" width="4.5" height="4.5" rx="0.8" transform="rotate(45 3.75 6.75)"/>
		<rect x="18" y="15" width="4.5" height="4.5" rx="0.8" transform="rotate(45 20.25 17.25)"/>
		<path d="M9 17c-2.5 0-4.5-2-4.5-4.5" stroke-width="1.2"/></svg>`;

export function stac(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#stac-btn")) return () => {};   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "stac-btn"; btn.dataset.tip = t("衛星画像を探す（日付・雲量）"); btn.setAttribute("aria-label", t("衛星画像を探す（日付・雲量）"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<handle>＝一度だけ import（失敗時は null に戻して再挑戦可）
	let opening = false;
	btn.addEventListener("click", () => {
		if (opening) return;
		if (real) return;   // 本体搭載後はボタンへ本体のトグルが付いている（このリスナーは実質初回のみ）
		opening = true;
		real = import("./stac.js")
			.then(m => { const g = m.stac.call(map, { ...opts, btn }); g.toggle(); return g; })
			.catch(e => { real = null; console.error("[stac] failed to load module", e); })
			.finally(() => { opening = false; });
	}, { signal: opts.signal });
	return () => {};
}
