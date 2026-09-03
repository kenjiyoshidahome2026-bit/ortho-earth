// ガジェット：編集（GeoPBF エディタ＝gadgets/geoedit の入口ボタン）。オプトイン＝map.gadget.edit({ zoom:[2.5,99], narrow:false })。
// 押す＝エディタ本体（遅延chunk）を搭載＝表示中のデータ（ドロップ/?g=）があればそれを編集へ取り込む（adopt）。
// もう一度押す＝destroy（チルト上限・ズーム下限・右クリック項目・ドロップの所有を搭載前へ戻す）。
// 出現域（z>2.5）は搭載側の zoom 宣言＝レジストリの門（他ガジェットと同じ流儀）。編集中はエディタがズーム下限 2.5 を敷く＝門の下へは落ちない。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr({ "GeoPBF を編集（点・線・面のトポロジカル編集）": "Edit GeoPBF (topological editing of points, lines, polygons)", "編集を終える": "Finish editing", "編集": "Edit" });
const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13 6.5l4.5 4.5"/></svg>`;

export function edit({ mount, signal } = {}) {   // mount＝() => Promise<editor>（app が map.gadget.geoedit を注入）
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#edit-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "edit-btn"; btn.innerHTML = ICON;
	btn.dataset.tip = t("GeoPBF を編集（点・線・面のトポロジカル編集）"); btn.setAttribute("aria-label", t("編集")); btn.setAttribute("aria-pressed", "false");
	let editor = null, busy = false;
	const sync = () => { btn.classList.toggle("on", !!editor); btn.setAttribute("aria-pressed", String(!!editor)); btn.dataset.tip = editor ? t("編集を終える") : t("GeoPBF を編集（点・線・面のトポロジカル編集）"); };
	const toggle = async () => {
		if (busy) return editor;
		if (editor) { editor.destroy(); editor = null; sync(); return null; }
		busy = true; btn.classList.add("busy");
		try { editor = await mount(); } catch (e) { console.error("[edit] editor mount failed", e); }
		finally { busy = false; btn.classList.remove("busy"); sync(); }
		return editor;
	};
	btn.addEventListener("click", toggle, { signal });
	gadgetStack(mapEl).append(btn);
	return { toggle, get editor() { return editor; } };
}
