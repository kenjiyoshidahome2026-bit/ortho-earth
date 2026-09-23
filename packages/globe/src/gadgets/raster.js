// ガジェット：画像タイル（ラスタ）の切替＝v1 ortho-map の基図ドロップダウン（Layers/setBase）の v2 後継（2026-09-21）。
// 標準装備でなくオプトイン＝map.gadget.raster() で搭載（v1 の gadget 作法＝this が map）。
// 四戒：独立（エンジンへは注入 raster API＝map.raster のみ）／遅延（本体は小さい＝そのまま）／抽象アクセス／表示宣言（搭載側の zoom 域）。
// 中身＝カタログ（地域パックの rasters＝外から定義）を並べる小さな一覧：
//   ・under（基図）＝ラジオ：ベクタ地図（既定）／地理院 標準・淡色・写真・色別標高…（塗りを伏せ、線と注記は残す）
//   ・over（重ね）＝チェック：陰影起伏・洪水浸水想定…（塗りの後・線の前・半透明）
// 状態の正本は map.raster（select/toggle/selected/onChange）＝URL ?r= と同期するのは app.js 側。ここは表示と操作だけ。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr();

// 画像グリフ（額縁＋山＋太陽＝写真/ラスタ）。積層の菱形は表示チップの #layers-btn と被るので使わない。線色は本線インク直書き＝夜節が自動反転。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
	<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3.5 17 L9 11 L13 15 L15.5 12.5 L20.5 17.5"/><circle cx="16" cy="9" r="1.6"/></svg>`;

export function raster({ raster, catalog = [], signal } = {}) {
	const mapEl = this.mapEl;
	if (!raster) { console.warn("[raster gadget] map.raster is not available"); return; }
	if (mapEl.querySelector("#raster")) return;   // 二重搭載は無害（搭載済みのまま）
	const box = document.createElement("div");
	box.id = "raster";
	const btn = document.createElement("button");
	btn.id = "raster-btn"; btn.className = "qm-panel-btn"; btn.type = "button";
	btn.dataset.tip = t("Imagery & raster maps"); btn.setAttribute("aria-label", t("Imagery & raster maps")); btn.setAttribute("aria-expanded", "false");
	btn.innerHTML = ICON;
	const panel = document.createElement("div");
	panel.id = "raster-panel"; panel.setAttribute("role", "menu");
	box.append(btn, panel);
	gadgetStack(mapEl).append(box);   // 置き場所はスタック（搭載順＝縦の並び）。パネルはボタンの右へ開く（#search と同じ流儀）

	const unders = catalog.filter(c => (c.order || "under") !== "over"), overs = catalog.filter(c => c.order === "over");
	const label = c => c.key ? t(c.key) : (c.name || c.id);
	function render() {
		const sel = raster.selected();
		const li = (c, kind) => {
			const on = kind === "radio" ? (c ? sel.base === c.id : !sel.base) : sel.overs.includes(c.id);
			return `<label class="raster-item${on ? " on" : ""}"><input type="${kind}" name="${kind === "radio" ? "raster-base" : "raster-over-" + c.id}" value="${c ? c.id : ""}"${on ? " checked" : ""}> <span>${c ? label(c) : t("Vector map")}</span></label>`;
		};
		panel.innerHTML =
			`<div class="raster-sec">${t("Base map")}</div>` + li(null, "radio") + unders.map(c => li(c, "radio")).join("") +
			(overs.length ? `<div class="raster-sec">${t("Overlays")}</div>` + overs.map(c => li(c, "checkbox")).join("") : "");
	}
	panel.addEventListener("change", e => {
		const inp = e.target; if (!(inp instanceof HTMLInputElement)) return;
		if (inp.type === "radio") raster.select(inp.value || null).catch(err => console.warn("[raster gadget] select", err));
		else raster.toggle(inp.value, inp.checked).catch(err => console.warn("[raster gadget] toggle", err));
	}, { signal });
	const open = on => { box.classList.toggle("open", on); btn.setAttribute("aria-expanded", on ? "true" : "false"); if (on) render(); };
	btn.addEventListener("click", () => open(!box.classList.contains("open")), { signal });
	document.addEventListener("pointerdown", e => { if (box.classList.contains("open") && !box.contains(e.target)) open(false); }, { signal, capture: true });
	window.addEventListener("keydown", e => { if (e.key === "Escape" && box.classList.contains("open")) open(false); }, { signal });
	const off = raster.onChange(() => { btn.classList.toggle("on", !!raster.selected().base || raster.selected().overs.length > 0); if (box.classList.contains("open")) render(); });
	signal?.addEventListener("abort", () => { off(); box.remove(); }, { once: true });
	btn.classList.toggle("on", !!raster.selected().base || raster.selected().overs.length > 0);
	return { open: () => open(true), close: () => open(false), el: box };
}
