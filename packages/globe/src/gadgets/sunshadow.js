// ガジェット：日影（#44・2026-09-23）＝建物の影を地面に描く。ボタン（☀）を押すと小さなパネル：
//   日影図＝冬至の真太陽時 8〜16 時に日影になる時間の段彩（1〜5 時間・2 時間以上は境目の線＝日影規制の確認の形）
//   瞬間の影＝指定した日時の影の範囲
//   測定面の高さ＝1.5 / 4 / 6.5 m（日影規制の測定面）
//   リアルタイムの影＝描画の中で太陽から建物の深度を描いて落とす（map.setShadows・WebGPU 専用＝GL2 では出さない）。時刻のスライダーを動かすと影がその場で動く
// 計算は model 役の worker（sunshadow.js）＝画面に見えている範囲（一辺 3km まで）の建物を 1 棟ずつ接地して読み、影を升目へ数える。
// 結果は四隅の画像として地面に貼る（map.raster の image＝ドレープ）。API＝map.sunShadow(opts)（UI なしでも使える）。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr();

const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
	<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>`;
const LEGEND = [["1", "#78b4ff"], ["2", "#508cf0"], ["3", "#3c5adc"], ["4", "#783cc8"], ["5", "#c82878"]];

// run＝(opts) => Promise<{ triangles, maxHours, …, probes }>＝map.sunShadow の戻り（stats を平たく展開した形）
export function sunShadow({ run, clear, live, canLive = () => true, minZoom = 15, signal } = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#sunshadow-btn")) return () => {};
	const btn = document.createElement("button");
	btn.id = "sunshadow-btn"; btn.dataset.tip = t("Sun & shadow"); btn.setAttribute("aria-label", t("Sun & shadow"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);
	let panel = null, busy = false;
	const now = new Date(), pad = n => String(n).padStart(2, "0");
	const build = () => {
		if (live && !canLive()) live = null;   // GL2（フォールバック）＝影をかけない仕様＝このモードを出さない
		panel = document.createElement("div");
		panel.className = "qm-panel sunshadow-panel";
		panel.style.cssText = "position:absolute;left:56px;bottom:12px;z-index:5;min-width:220px;padding:10px 12px;border-radius:8px;background:var(--qm-surface,#fff);color:var(--qm-text,#222);box-shadow:0 1px 6px rgba(0,0,0,.25);font:13px/1.5 system-ui,sans-serif";
		panel.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${t("Sun & shadow")}</div>
			<label style="display:block"><input type="radio" name="ssmode" value="duration" checked> ${t("Shadow hours")}</label>
			<label style="display:block"><input type="radio" name="ssmode" value="instant"> ${t("Shadow now")}</label>
			${live ? `<label style="display:block"><input type="radio" name="ssmode" value="live"> ${t("Live shadow")}</label>` : ""}
			<div class="ss-when" style="display:none;margin:4px 0"><label>${t("Date")} <input type="date" class="ss-date" value="${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}"></label>
				<label>${t("Time")} <input type="time" class="ss-time" step="600" value="${pad(now.getHours())}:${pad(now.getMinutes() - now.getMinutes() % 10)}"></label>
				<input type="range" class="ss-slide" min="240" max="1200" step="5" value="${now.getHours() * 60 + now.getMinutes()}" style="display:none;width:100%;margin-top:4px" aria-label="${t("Time")}"></div>
			<label class="ss-plane" style="display:block;margin:4px 0">${t("Plane height")} <select class="ss-h"><option value="1.5">1.5 m</option><option value="4" selected>4 m</option><option value="6.5">6.5 m</option></select></label>
			<div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="ss-run qm-btn">${t("Compute")}</button><button type="button" class="ss-clear qm-btn">${t("Clear")}</button></div>
			<div class="ss-msg" style="margin-top:6px;opacity:.8"></div>
			<div class="ss-legend" style="display:none;margin-top:4px">${LEGEND.map(([h, c]) => `<span style="display:inline-flex;align-items:center;gap:3px;margin-inline-end:6px"><i style="width:10px;height:10px;background:${c};display:inline-block;border-radius:2px"></i>${t("$1 h+", h)}</span>`).join("")}</div>`;
		mapEl.append(panel);
		const $ = s => panel.querySelector(s), msg = s => { $(".ss-msg").textContent = s || ""; };
		// リアルタイムの影：日付・時刻（と時刻のスライダー）が変わるたびに map.setShadows へ。別のモード・消す・パネルを閉じるで消灯
		const liveOn = () => $("input[name=ssmode]:checked").value === "live";
		const liveApply = () => { if (live && liveOn()) live({ on: true, time: new Date(`${$(".ss-date").value}T${$(".ss-time").value}`) }); };
		const liveOff = () => { if (live) live({ on: false }); };
		panel.querySelectorAll("input[name=ssmode]").forEach(r => r.addEventListener("change", () => {
			const m = $("input[name=ssmode]:checked").value;
			$(".ss-when").style.display = m === "duration" ? "none" : "";
			$(".ss-slide").style.display = m === "live" ? "" : "none";
			$(".ss-plane").style.display = $(".ss-run").style.display = m === "live" ? "none" : "";
			if (m === "live") { clear(); $(".ss-legend").style.display = "none"; msg(map.getZoom() < 13 ? t("Zoom in closer (z14+)") : ""); liveApply(); } else liveOff();
		}));
		$(".ss-slide").addEventListener("input", () => { const v = +$(".ss-slide").value; $(".ss-time").value = `${pad(Math.floor(v / 60))}:${pad(v % 60)}`; liveApply(); });
		$(".ss-time").addEventListener("input", () => { const [h, m] = $(".ss-time").value.split(":").map(Number); if (Number.isFinite(h)) $(".ss-slide").value = h * 60 + (m || 0); liveApply(); });
		$(".ss-date").addEventListener("input", liveApply);
		$(".ss-clear").addEventListener("click", () => { clear(); liveOff(); msg(""); $(".ss-legend").style.display = "none"; });
		$(".ss-run").addEventListener("click", async () => {
			if (busy) return;
			if (map.getZoom() < minZoom) { msg(t("Zoom in closer (z15+) to compute shadows")); return; }
			const mode = $("input[name=ssmode]:checked").value;
			const date = mode === "instant" ? new Date(`${$(".ss-date").value}T${$(".ss-time").value}`) : undefined;
			busy = true; msg(t("Computing…"));
			try {
				const r = await run({ mode, date, planeH: +$(".ss-h").value });
				if (!r.triangles) { msg(t("No buildings here")); return; }
				msg(mode === "duration" ? t("Max $1 h · winter solstice 8–16 (solar time)", r.maxHours) : "");
				$(".ss-legend").style.display = mode === "duration" ? "" : "none";
			} catch (err) { console.error("[sunshadow]", err); msg(String(err?.message || err)); }
			finally { busy = false; }
		});
	};
	btn.addEventListener("click", () => {
		if (!panel) build(); else panel.hidden = !panel.hidden;
		btn.classList.toggle("on", !panel.hidden);
		if (live && panel.querySelector("input[name=ssmode]:checked")?.value === "live") panel.hidden ? live({ on: false }) : panel.querySelector(".ss-slide").dispatchEvent(new Event("input"));   // 閉じたら影も消す・開き直したら戻す
	});
	signal?.addEventListener("abort", () => { panel?.remove(); btn.remove(); }, { once: true });
	return Object.assign(() => {}, { open: () => { if (!panel) build(); panel.hidden = false; return panel; } });
}
