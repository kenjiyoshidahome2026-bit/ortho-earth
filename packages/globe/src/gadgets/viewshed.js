// ガジェット：見える範囲（#44・2026-09-23）＝可視域と見通し線。ボタン（目）を押すと小さなパネル：
//   可視域＝地図をクリックした所を視点に、半径の中で見える所（緑）・見えない所（暗）を地面に貼る
//   見通し線＝1 回目のクリック＝視点・2 回目＝目標。見える区間を緑・遮られた先を赤の線で引き、遮った所までの距離を出す
//   目の高さ・半径（可視域のみ）
// 地表＝地形（外来 DEM を足していればそれ）＋建物（地域の建物台帳＝日本は PLATEAU）。地球の丸みと大気の屈折（k＝0.13）込み。
// 計算は日影と同じ model 役の worker。API＝map.viewshed / map.lineOfSight（UI なしでも使える）。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr();

const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>`;

// run＝{ viewshed(o), lineOfSight(a, b, o), clear() }（globe が注入）
export function viewshed({ run, onOpen, minZoom = 14, signal } = {}) {   // onOpen＝開いた瞬間の合図（globe の「道具の排他」）
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#viewshed-btn")) return () => {};
	const btn = document.createElement("button");
	btn.id = "viewshed-btn"; btn.className = "qm-panel-btn"; btn.type = "button"; btn.dataset.tip = t("Visibility"); btn.setAttribute("aria-label", t("Visibility"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);
	let panel = null, busy = false, first = null;
	const release = () => { map.setEditClick(null); mapEl.style.cursor = ""; };
	const build = () => {
		panel = document.createElement("div");
		panel.className = "qm-panel viewshed-panel";
		panel.style.cssText = "position:absolute;left:56px;bottom:12px;z-index:5;min-width:220px;padding:10px 12px;border-radius:8px;background:var(--qm-surface,#fff);color:var(--qm-text,#222);box-shadow:0 1px 6px rgba(0,0,0,.25);font:13px/1.5 system-ui,sans-serif";
		panel.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${t("Visibility")}</div>
			<label style="display:block"><input type="radio" name="vsmode" value="area" checked> ${t("Viewshed")}</label>
			<label style="display:block"><input type="radio" name="vsmode" value="los"> ${t("Line of sight")}</label>
			<label style="display:block;margin:4px 0">${t("Eye height")} <select class="vs-eye"><option value="1.6" selected>1.6 m</option><option value="10">10 m</option><option value="30">30 m</option><option value="100">100 m</option></select></label>
			<label class="vs-r" style="display:block;margin:4px 0">${t("Radius")} <select class="vs-rad"><option value="300">300 m</option><option value="1000" selected>1 km</option><option value="3000">3 km</option><option value="5000">5 km</option></select></label>
			<div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="vs-clear qm-btn">${t("Clear")}</button></div>
			<div class="vs-msg" style="margin-top:6px;opacity:.8"></div>`;
		mapEl.append(panel);
		const $ = s => panel.querySelector(s), msg = s => { $(".vs-msg").textContent = s || ""; };
		const mode = () => $("input[name=vsmode]:checked").value;
		const prompt = () => { first = null; msg(t("Click the viewpoint on the map")); $(".vs-r").style.display = mode() === "area" ? "" : "none"; };
		panel.querySelectorAll("input[name=vsmode]").forEach(r => r.addEventListener("change", prompt));
		$(".vs-clear").addEventListener("click", () => { run.clear(); prompt(); });
		const onClick = async (x, y) => {
			if (busy) return true;
			const p = map.unprojectXY(x, y); if (!p) return true;
			if (map.getZoom() < minZoom) { msg(t("Zoom in closer (z14+)")); return true; }
			const eyeH = +$(".vs-eye").value;
			if (mode() === "los" && !first) { first = p; msg(t("Click the target on the map")); return true; }
			busy = true; msg(t("Computing…"));
			try {
				if (mode() === "area") {
					const r = await run.viewshed({ observer: p, eyeH, radius: +$(".vs-rad").value });
					msg(t("Visible from here: $1%", Math.round(r.visibleRatio * 100)));
				} else {
					const a = first; first = null;
					const r = await run.lineOfSight(a, p, { eyeH, targetH: eyeH });
					if (r.visible) msg(t("Target visible · $1 m", Math.round(r.distance)));
					else { const k = Math.cos(a[1] * Math.PI / 180) * 111320; msg(t("Blocked $1 m from the viewpoint", Math.round(Math.hypot((r.blockAt[0] - a[0]) * k, (r.blockAt[1] - a[1]) * 111320)))); }
				}
			} catch (err) { console.error("[viewshed]", err); msg(String(err?.message || err)); }
			finally { busy = false; }
			return true;
		};
		panel._arm = () => { map.setEditClick(onClick); mapEl.style.cursor = "crosshair"; prompt(); };
	};
	const open = () => { if (!panel) build(); panel.hidden = false; btn.classList.add("on"); onOpen?.(); panel._arm(); return panel; };
	const close = () => { if (!panel || panel.hidden) return; panel.hidden = true; btn.classList.remove("on"); release(); };   // 結果（地面の画像・線）は「消す」まで残す
	btn.addEventListener("click", () => (panel && !panel.hidden ? close() : open()));
	signal?.addEventListener("abort", () => { release(); panel?.remove(); btn.remove(); }, { once: true });
	return Object.assign(() => {}, { open, close });
}
