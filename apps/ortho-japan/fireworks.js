// 打ち上げ花火の案内板と配線（fireworks.html から遅延 import）。シーンの深度（#47）の見本＝実寸の花火が手前のビル・スカイツリーの陰に隠れる。
// quakes/sats と同じ骨格：器＝fireworks.html／UI と合図＝ここ／描画＝fireworks-gl.js（レンダーワーカー内・地球と同じフレーム・同じ cam）。
// 発射地点＝隅田川（桜橋の下流・隅田川花火大会の第一会場のあたり）。視点は南から北を見る＝東京スカイツリー（634 m）が花火の手前に立つ。
import { worldRadiusM } from "@ortho-earth/core";
import glUrl from "./fireworks-gl.js?url";   // worker が import() する URL＝vite はこのファイルをそのまま置く
import { SHELLS, COLORS } from "./fireworks-gl.js";   // 玉の表（正本は fireworks-gl.js）
import { tr, setLang, loadPage } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない
const t = tr();

export const SITE = { lon: 139.8065, lat: 35.7195 };   // 桜橋のすぐ下流（隅田川）
const VIEW = { lon: 139.8092, lat: 35.7138, zoom: 15.4, tilt: 63, bearing: 340 };   // 南南東から＝スカイツリー（発射地点の南南東 1.1 km）が花火の手前に立つ

export async function mountFireworks(map, { panelHost, quiet = false, fly = true } = {}) {   // quiet＝最初の 1 発を上げない・fly=false＝視点へ飛ばない（検定）
	await setLang(); await loadPage(c => import(`./i18n/lang/fireworks/${c}.json`));   // 本番はこのチャンクの i18n.js が SDK と別実体＝自分で訳を用意してから UI を組む
	document.title = t("Fireworks over Sumida — ortho-japan");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Full-scale fireworks (a 10-inch shell opens 320 m wide at 330 m) launched over the Sumida River, hidden by the buildings and Tokyo Skytree in front of them."));
	const EARTH_M = worldRadiusM();
	const ov = map.overlay(glUrl, { name: "fireworks", opts: { earthM: EARTH_M, depth: true } });
	ov.post({ type: "site", lon: SITE.lon, lat: SITE.lat });

	const st = { go: 10, auto: false, color: -1 };
	let autoT = 0, count = 0;
	const launch = (go = st.go) => {
		const dx = (Math.random() - 0.5) * 60, dy = (Math.random() - 0.5) * 30;   // 台船の並び＝少しばらける
		ov.post({ type: "launch", go, color: st.color >= 0 ? st.color : undefined, now: map.clock.time, dx, dy });
		count++; upd();
	};
	const autoTick = () => { if (!st.auto) return; launch(SHELLS[(Math.random() * SHELLS.length) | 0].go); autoT = setTimeout(autoTick, 900 + Math.random() * 1800); };

	// ── パネル（quakes/sats と同じ意匠＝暗いガラス）──
	const panel = document.createElement("div");
	panel.className = "fw-panel";
	panel.innerHTML = `
<style>
.fw-panel{position:absolute;top:12px;right:12px;z-index:30;width:292px;max-width:calc(100% - 24px);box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;
 background:rgba(12,17,32,.86);color:#e7ecf5;border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.fw-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.fw-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:10px}
.fw-panel .row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.fw-panel .row label{width:100%;color:#b9c3d6}
.fw-panel button{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:5px 10px;cursor:pointer;font:inherit}
.fw-panel button.on{background:#ff8c1a;color:#1a0d00;font-weight:700;border-color:#ff8c1a}
.fw-panel button.big{flex:1;padding:8px 12px;background:#ff8c1a;color:#1a0d00;font-weight:700;border-color:#ff8c1a;font-size:14px}
.fw-panel .sw{width:22px;height:22px;border-radius:50%;padding:0;border:2px solid transparent}
.fw-panel .sw.on{border-color:#fff}
.fw-panel .note{color:#9aa6bd;font-size:11px;margin-top:8px}
.fw-panel .cnt{color:#fff;font-variant-numeric:tabular-nums}
</style>
<h1>${t("Fireworks over Sumida")}</h1>
<div class="sub">${t("Real size. A 10-inch shell opens about 320 m wide at 330 m up.")}</div>
<div class="row shells"><label>${t("Shell")}</label>${SHELLS.map(s => `<button data-go="${s.go}" class="${s.go === st.go ? "on" : ""}">${t("$1-go", s.go)}<br><small>⌀${s.diam} m</small></button>`).join("")}</div>
<div class="row colors"><label>${t("Colour")}</label><button class="sw on" data-c="-1" title="${t("Random")}" style="background:conic-gradient(#f55,#fd5,#5e6,#5af,#f5f,#f55)"></button>${COLORS.map((c, i) => `<button class="sw" data-c="${i}" style="background:rgb(${c.map(v => Math.round(v * 255)).join(",")})"></button>`).join("")}</div>
<div class="row"><button class="big launch">${t("Launch")}</button><button class="auto">${t("Auto")}</button><button class="clear">${t("Clear")}</button></div>
<div class="row"><button class="view">${t("Back to the river")}</button></div>
<div class="note">${t("Launched: $1", '<span class="cnt">0</span>')}. ${t("Stars behind a building or the Skytree are hidden by the scene depth (#47). Tilt and orbit to see it.")}</div>`;
	(panelHost || map.mapEl).appendChild(panel);
	const upd = () => { panel.querySelector(".cnt").textContent = String(count); };
	panel.querySelector(".shells").addEventListener("click", e => { const b = e.target.closest("button[data-go]"); if (!b) return; st.go = +b.dataset.go; for (const x of panel.querySelectorAll(".shells button")) x.classList.toggle("on", x === b); launch(); });
	panel.querySelector(".colors").addEventListener("click", e => { const b = e.target.closest("button[data-c]"); if (!b) return; st.color = +b.dataset.c; for (const x of panel.querySelectorAll(".colors button")) x.classList.toggle("on", x === b); });
	panel.querySelector(".launch").addEventListener("click", () => launch());
	const autoBtn = panel.querySelector(".auto");
	const setAuto = on => { st.auto = on; autoBtn.classList.toggle("on", on); autoBtn.textContent = on ? t("Stop") : t("Auto"); clearTimeout(autoT); if (on) autoTick(); };   // 連発中は「止める」
	autoBtn.addEventListener("click", () => setAuto(!st.auto));
	panel.querySelector(".clear").addEventListener("click", () => { setAuto(false); ov.post({ type: "clear" }); });   // 消す＝連発も止める
	panel.querySelector(".view").addEventListener("click", () => map.flyTo(VIEW.lon, VIEW.lat, VIEW.zoom, VIEW.tilt, VIEW.bearing));
	// 地図のクリック＝その場所から 1 発（発射地点は変えない＝台船は川の上）
	const onKey = e => { if (e.key === " " && !e.target.closest("input,textarea,button")) { e.preventDefault(); launch(); } };
	window.addEventListener("keydown", onKey);

	// 最初の 1 発＝視点に着いてから（読み込みの準備時間＝遷移の時間）
	if (fly) await map.flyTo(VIEW.lon, VIEW.lat, VIEW.zoom, VIEW.tilt, VIEW.bearing);
	if (!quiet) setTimeout(() => launch(10), 800);

	return {
		launch, site: SITE, view: VIEW, overlay: ov,
		get count() { return count; },
		destroy() { setAuto(false); window.removeEventListener("keydown", onKey); panel.remove(); ov.remove(); },
	};
}
