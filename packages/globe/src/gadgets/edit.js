// ガジェット：編集（GeoPBF エディタ＝geoedit（npm）（packages/geoedit）の入口ボタン）。オプトイン＝map.gadget.edit({ zoom:[2.5,99], narrow:false })。
// 押す＝エディタ本体（遅延chunk）を部品として搭載＝持ち主（app）が渡す「編集中の図形」を編集する。
// 終わり＝エディタのツールバー右端の「×」かこのボタンをもう一度＝結果（editor.result()）を持ち主へ返してから destroy
//（チルト上限・ズーム下限・右クリック項目・ドロップの所有を搭載前へ戻す）。持ち主は結果で自分の図形を置き換える（onResult）。
// 出現域（z>2.5）は搭載側の zoom 宣言＝レジストリの門（他ガジェットと同じ流儀）。編集中はエディタがズーム下限 2.5 を敷く＝門の下へは落ちない。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr();
const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13 6.5l4.5 4.5"/></svg>`;

export function edit({ mount, onResult, signal } = {}) {   // mount＝({ onClose }) => Promise<editor>（app が map.gadget.geoedit を注入）・onResult＝(buf|null) => 持ち主の図形を置き換える
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#edit-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "edit-btn"; btn.innerHTML = ICON;
	btn.dataset.tip = t("Edit GeoPBF (topological editing of points, lines, polygons)"); btn.setAttribute("aria-label", t("Edit")); btn.setAttribute("aria-pressed", "false");
	let editor = null, busy = false;
	const sync = () => { btn.classList.toggle("on", !!editor); btn.setAttribute("aria-pressed", String(!!editor)); btn.dataset.tip = editor ? t("Finish editing") : t("Edit GeoPBF (topological editing of points, lines, polygons)"); };
	// 終える＝結果を受け取ってから外す（外してから置き換える＝エディタの層と持ち主の層が二重に出ない）
	const finish = async () => {
		if (busy || !editor) return;
		busy = true; btn.classList.add("busy");
		const ed = editor;
		let buf = null;
		try { buf = await ed.result?.() ?? null; } catch (e) { console.error("[edit] result failed", e); }
		ed.destroy(); editor = null;
		try { await onResult?.(buf); } catch (e) { console.error("[edit] apply result failed", e); }
		finally { busy = false; btn.classList.remove("busy"); sync(); }
	};
	const toggle = async () => {
		if (busy) return editor;
		if (editor) { await finish(); return null; }
		busy = true; btn.classList.add("busy");
		try { editor = await mount({ onClose: finish }); } catch (e) { console.error("[edit] editor mount failed", e); }
		finally { busy = false; btn.classList.remove("busy"); sync(); }
		return editor;
	};
	btn.addEventListener("click", toggle, { signal });
	gadgetStack(mapEl).append(btn);
	return { toggle, get editor() { return editor; } };
}
