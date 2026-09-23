// ガジェット：時計（#42・2026-09-23）＝共通の時計（map.clock＝ephem/clock・ortho-solar と同じ部品）の操作盤。
// ボタン（時計）で下端に時間バーを出す＝◀◀（遅く・押し続けると逆再生）／▶・❚❚／▶▶（速く）・速さの表示・日時の入力・「今」。
// 並びと記号は solar の時間バーと同じ（再生の三つ組は RTL でも鏡像にしない＝dir="ltr"）。
// 時計が実時間でない（過去・未来・止めた・早送り）時は、開いていなくてもバーを出す（起動時・後から今を離れた時）＝共有リンクで開いた人に「今ではない」を見せる。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr();

const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
	<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`;
// 速さの表示＝ephem/clock の CLOCK_SPEEDS の英語の鍵を訳す。鍵をここに字で並べる＝i18n の走査（t("…") の字面）に見せる
const speedLabel = k => ({ "Paused": t("Paused"), "Real time": t("Real time"), "1 sec/s": t("1 sec/s"), "1 min/s": t("1 min/s"), "1 hour/s": t("1 hour/s"),
	"6 hours/s": t("6 hours/s"), "1 day/s": t("1 day/s"), "10 days/s": t("10 days/s"), "1 month/s": t("1 month/s"), "1 year/s": t("1 year/s") })[k] ?? t(k);
const pad = n => String(n).padStart(2, "0");
const fmtLocal = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function clockGadget({ signal } = {}) {
	const map = this, mapEl = this.mapEl, clock = map.clock;
	if (!clock || mapEl.querySelector("#clock-btn")) return () => {};
	const btn = document.createElement("button");
	btn.id = "clock-btn"; btn.dataset.tip = t("Time"); btn.setAttribute("aria-label", t("Time"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);
	let bar = null, editing = false, shown = "", uiAt = 0, wantOpen = false;
	const build = () => {
		bar = document.createElement("div");
		bar.className = "qm-panel clock-bar";
		bar.style.cssText = "position:absolute;left:50%;bottom:56px;transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;max-width:calc(100% - 32px);padding:6px 10px;border-radius:8px;background:var(--qm-surface,#fff);color:var(--qm-text,#222);box-shadow:0 1px 6px rgba(0,0,0,.25);font:13px/1.4 system-ui,sans-serif";
		const b = "min-width:30px;padding:2px 6px;border:1px solid rgba(0,0,0,.15);border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer";
		bar.innerHTML = `<span dir="ltr" style="display:inline-flex;gap:4px">
				<button type="button" class="ck-slower" style="${b}" title="${t("Slower — keep pressing to run time backwards")}">◀◀</button>
				<button type="button" class="ck-play" style="${b}" title="${t("Play / pause")}">❚❚</button>
				<button type="button" class="ck-faster" style="${b}" title="${t("Faster")}">▶▶</button></span>
			<span class="ck-speed" style="min-width:6.5em;text-align:center;opacity:.85"></span>
			<input class="ck-dt" type="datetime-local" min="1800-01-01T00:00" max="2049-12-31T23:59" step="60" title="${t("Set date & time (valid 1800–2050)")}" style="font:inherit">
			<button type="button" class="ck-now" style="${b}" title="${t("Back to the present")}">${t("Now")}</button>`;
		mapEl.append(bar);
		const $ = s => bar.querySelector(s), dt = $(".ck-dt");
		$(".ck-slower").onclick = () => clock.slower();
		$(".ck-faster").onclick = () => clock.faster();
		$(".ck-play").onclick = () => clock.toggle();
		$(".ck-now").onclick = () => clock.live();
		dt.addEventListener("focus", () => editing = true);
		dt.addEventListener("blur", () => editing = false);
		dt.addEventListener("change", () => { const v = new Date(dt.value).getTime(); if (Number.isFinite(v)) clock.setTime(v); });
		sync(true);
	};
	// 表示を時計に追わせる（段・日時）。再生中は最大 4 回/秒
	function sync(force) {
		if (!bar) return;
		const now = performance.now(); if (!force && now - uiAt < 250) return; uiAt = now;
		bar.querySelector(".ck-speed").textContent = clock.label(speedLabel);
		bar.querySelector(".ck-play").textContent = clock.playing ? "❚❚" : "▶";
		const v = fmtLocal(clock.time), dt = bar.querySelector(".ck-dt");
		if (!editing && v !== shown) dt.value = shown = v;
		btn.classList.toggle("off-now", !clock.isLive());   // 「今ではない」の印（ボタン）
	}
	// 時計が「今」を離れた（共有リンクの t=・API・台本）＝バーを出す。利用者が自分で閉じた後は出しゃばらない
	let userClosed = false;
	const onTime = e => { if (!e.ticking && !e.live && !wantOpen && !userClosed) open(); sync(!e.ticking); };
	map.on("time", onTime);
	// 表示域（opts.zoom）でボタンが畳まれたらバーも一緒に退く（開いた状態は覚えておく）
	const follow = () => { if (!bar) return; const vis = btn.offsetParent !== null; bar.style.display = vis && wantOpen ? "flex" : "none"; };
	map.on("move", follow);
	const liveTimer = setInterval(() => { if (wantOpen && clock.isLive()) sync(false); }, 1000);   // 実時間の間も分が進む
	const open = () => { if (!bar) build(); wantOpen = true; btn.classList.add("on"); sync(true); follow(); return bar; };   // 見せる/隠すは display 一本（style の display:flex が hidden 属性に勝つ）
	btn.addEventListener("click", () => { if (!wantOpen) open(); else { wantOpen = false; userClosed = true; btn.classList.remove("on"); follow(); } });
	if (!clock.isLive()) open();
	signal?.addEventListener("abort", () => { clearInterval(liveTimer); map.off("time", onTime); map.off("move", follow); bar?.remove(); btn.remove(); }, { once: true });
	return Object.assign(() => {}, { open });
}
