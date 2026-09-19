// 世界の地震（USGS ComCat・1967〜・M2+）を ortho-japan の地球儀に立体表示する（quakes.html から遅延 import）。
//
// 表現の決め事
//   位置   … 震源＝震央 [経度, 緯度] から深さぶん地球の内側。地球（globe）を半透明にして地中を透かして見せる
//   色     … 深さ。浅い＝赤 → 橙 → 黄 → 緑 → 水色 → 深い＝青（色軸は √(深さ/700km)＝浅い側の差が見える）
//   大きさ … エネルギーの量を「球の体積」とみなす。E ∝ 10^(1.5M) ⇒ 半径 ∝ E^(1/3) ∝ 10^(0.5M)
//            M6 の半径を基準（既定 15 km＝「球の大きさ」で倍率）に、実寸（ワールド単位）で置く＝寄れば大きくなる
//   形     … M>6 は本物の 3D 球（インスタンス描画の多面体・陰影つき・深度つき）
//            M≤6 は 2D スプライト（球の陰影を描いた円＝点スプライト）。どちらも震源の 3D 位置に置くので、傾けると立体に見える
//   表示下限 … 実寸が 1px 未満の地震は最小サイズで描き、そのぶん薄くする（小さな地震は「雲」として見える）
//   透け   … 視線が地球の中を通る長さ L に応じて exp(−L/λ) で薄める＝地球の裏側は見えず、真下の深い震源は少し沈んで見える
//
// エンジンとの接点は公開面だけ：map.overlay（同一フレームのオーバーレイ・#13）・map.cam＋ ortho-core の cameraState（pick と札の投影）・
// onFrame（札の追従）・setOpacity・mapEl。GPU 描画は quakes-gl.js＝レンダーワーカー内で地球・注記と同じフレーム・同じ cam で描く
//（main の canvas に onFrame で描いていた頃は 1〜2 フレーム先行して見えた＝2026-09-19 本人指摘）。
import { cameraState, ellipsoidOn, worldRadiusM } from "ortho-core";
import glUrl from "./quakes-gl.js?url";   // worker が import() する URL＝vite はこのファイルをそのまま置く（⚠?worker&url は worker 入口扱いで export が tree-shake され 532B の殻になる・2026-09-20）＝モジュールは依存ゼロが掟
import { M_SPLIT, STOPS, depthT, depthColor, lambdaOf } from "./quakes-gl.js";   // 凡例・pick は同じ表を使う（正本は quakes-gl.js）
export { depthColor };

const Y_MIN = 1967;   // カタログの先頭年（USGS ComCat の網羅は 1967〜）
import { tr, setLang, getLang } from "./i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない
const t = tr();

const fmt = n => n.toLocaleString(getLang());
const pad = n => String(n).padStart(2, "0");
const fmtTime = (ms, offH = 0) => { const d = new Date(ms + offH * 3600000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountQuakes(map, { src, panelHost } = {}) {
	await setLang();   // 本番はこのチャンクの i18n.js が SDK と別実体＝自分で訳を用意してから UI を組む
	document.title = t("World earthquakes — ortho-japan");   // 器（quakes.html）の題名と説明もここで＝i18n の走査器は .js だけ読む
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("USGS earthquake catalog (1967–, M2+, about 1.5 million events) shown in 3D on the globe by hypocenter depth and energy."));
	const mapEl = map.mapEl;

	// 状態（パネルが書き換える）
	const st = {
		magMin: 2, magMax: 10, yearMin: Y_MIN, yearMax: new Date().getUTCFullYear(),
		size: 1,          // 球の大きさの倍率（M6 半径＝30km×size）
		faint: 0.22,      // 小さな地震の濃さ（表示下限に持ち上げた点の最低不透明度）
		clear: 0.6,       // 地球の透け具合 0..1
	};
	const EARTH_M = worldRadiusM();
	const M6_KM = 15;
	// GPU 描画＝レンダーワーカー内のオーバーレイ（quakes-gl.js）。ここは列の写しを持つ＝pick・件数・札の投影用
	const ov = map.overlay(glUrl, { name: "quakes", opts: { earthM: EARTH_M } });
	// 層（srcs の 1 本ずつ＝archive・USGS 直近分）。worker から届いたそばから差し替えて重ねて描く
	//   { n, nBig, pos, attr, lon, lat, time, place }
	const layers = [];
	const total = () => layers.reduce((a, L) => a + (L?.n ?? 0), 0);
	let dataYearMax = st.yearMax;

	const applyGlobe = () => map.setOpacity({ globe: 1 - 0.8 * st.clear, base: 1 - 0.35 * st.clear });
	// 再生（年・月ごとに発生した地震を順に見せる）。play.cur＝窓の先頭（小数年・[cur, cur+step)）。積み上げ＝期間の先頭から cur+step まで
	const play = { on: false, cur: 0, step: 1, accum: false, sps: 2, raf: 0, last: 0 };
	// 表示する年の範囲 [a, b)（小数年）＝再生中は再生の窓・それ以外は期間スライダー
	const yearRange = () => play.on ? [play.accum ? st.yearMin : play.cur, play.cur + play.step] : [st.yearMin, st.yearMax + 1];

	// ── 描画＝worker のオーバーレイへ状態を送るだけ（描くのは quakes-gl.js・地球と同じフレーム）──
	// pick と札の投影は main の cam から。1 フレーム遅らせる：地球はレンダーワーカーが次の rAF で描く（main の render は cam を送るだけ）ので、
	// onFrame の cam をそのまま使うと札だけ 1 フレーム先行する。前フレームに送った cam＝地球が今見せている姿。静止の最後の 1 枚は次の rAF で追いつかせる。
	let shownCam = null, catchUp = 0;
	const snapCam = () => ({ ...map.cam, center: [...map.cam.center] });
	const camState = () => {
		const c = shownCam ?? map.cam;
		const dpr = c.dpr || devicePixelRatio || 1;
		const W = Math.max(1, Math.round(mapEl.clientWidth * dpr)), H = Math.max(1, Math.round(mapEl.clientHeight * dpr));
		return { s: cameraState(c, W, H), dpr, W, H };
	};
	const syncState = () => ov.post({ type: "state", st: { magMin: st.magMin, magMax: st.magMax, size: st.size, faint: st.faint, clear: st.clear, m6km: M6_KM }, range: yearRange() });
	const offFrame = map.onFrame(() => {
		placeTags();
		shownCam = snapCam();
		if (!catchUp) catchUp = requestAnimationFrame(() => { catchUp = 0; placeTags(); });
	});
	const redraw = () => { syncState(); placeTags(); };

	// ── パネル ──
	const panel = document.createElement("div");
	panel.className = "quakes-panel";
	panel.innerHTML = `
<style>
.quakes-panel{position:absolute;top:12px;right:12px;z-index:30;width:292px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.quakes-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.quakes-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.quakes-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.quakes-panel.min .body{display:none}
.quakes-panel.min{padding-bottom:10px}
.quakes-panel .play{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.quakes-panel .play button{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#ff8c1a;color:#1a0d00;font-weight:700;padding:5px 12px;cursor:pointer;font:inherit;font-weight:700}
.quakes-panel .play button.on{background:#e7ecf5;color:#0b1021}
.quakes-panel .play select{font:inherit;font-size:12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:4px 6px}
.quakes-panel .play label.chk{display:inline-flex;align-items:center;gap:4px;color:#b9c3d6}
.quakes-panel .play .spd{flex:1 1 100%;display:flex;align-items:center;gap:8px;color:#b9c3d6}
.quakes-panel .play .spd input{flex:1;margin:0}
.quakes-clock{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);z-index:29;pointer-events:none;padding:8px 18px;border-radius:12px;
 background:rgba(12,17,32,.72);color:#fff;font:700 34px/1.2 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:.03em;
 border:1px solid rgba(255,255,255,.14);text-shadow:0 2px 12px rgba(0,0,0,.6);white-space:nowrap}
.quakes-tag{position:absolute;z-index:29;pointer-events:none;transform:translate(-50%,-100%);margin-top:-14px;padding:5px 9px;border-radius:9px;
 background:rgba(12,17,32,.9);color:#fff;border:1px solid rgba(255,140,26,.7);font:12px/1.4 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;white-space:nowrap;
 box-shadow:0 4px 16px rgba(0,0,0,.45)}
.quakes-tag b{font-size:14px;color:#ffb35c}
.quakes-tag small{display:block;color:#b9c3d6;font-size:11px}
.quakes-tag::after{content:"";position:absolute;left:50%;bottom:-6px;width:10px;height:10px;transform:translateX(-50%) rotate(45deg);background:rgba(12,17,32,.9);border-right:1px solid rgba(255,140,26,.7);border-bottom:1px solid rgba(255,140,26,.7)}
.quakes-clock small{display:block;font-size:12px;font-weight:400;color:#b9c3d6;text-align:center;margin-top:2px}
.quakes-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:10px}
.quakes-panel .row{margin:9px 0}
.quakes-panel label{display:flex;justify-content:space-between;color:#b9c3d6}
.quakes-panel label b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.quakes-panel input[type=range]{width:100%;margin:3px 0 0;accent-color:#ff8c1a}
.quakes-panel .dual{position:relative;height:22px}
.quakes-panel .dual input{position:absolute;left:0;top:0;pointer-events:none;background:none;-webkit-appearance:none;appearance:none;height:22px}
.quakes-panel .dual input::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#ff8c1a;border:2px solid #fff;cursor:pointer}
.quakes-panel .dual input::-moz-range-thumb{pointer-events:auto;width:12px;height:12px;border-radius:50%;background:#ff8c1a;border:2px solid #fff;cursor:pointer}
.quakes-panel .dual::before{content:"";position:absolute;left:0;right:0;top:10px;height:3px;border-radius:2px;background:rgba(255,255,255,.2)}
.quakes-panel .bar{height:10px;border-radius:5px;margin:4px 0 2px}
.quakes-panel .ticks{position:relative;height:14px;color:#9aa6bd;font-size:10.5px}
.quakes-panel .ticks span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.quakes-panel .ticks span:first-child{transform:none}.quakes-panel .ticks span:last-child{transform:translateX(-100%)}
.quakes-panel .sizes{display:flex;align-items:flex-end;justify-content:space-between;margin-top:6px}
.quakes-panel .sizes div{display:flex;flex-direction:column;align-items:center;gap:3px;color:#9aa6bd;font-size:10.5px}
.quakes-panel .ball{border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0,#ff3a2a 24%,#8a1208 100%)}
.quakes-panel .dot{border-radius:50%;background:#ff3a2a}
.quakes-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.quakes-panel .stat{font-variant-numeric:tabular-nums;color:#fff}
.quakes-panel details summary{cursor:pointer;color:#b9c3d6;margin-top:8px}
.quakes-info{position:absolute;z-index:31;pointer-events:none;min-width:180px;padding:9px 12px;border-radius:10px;
 background:rgba(12,17,32,.92);color:#e7ecf5;border:1px solid rgba(255,255,255,.16);
 font:12px/1.55 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);transform:translate(12px,-50%)}
.quakes-info b{font-size:15px}
.quakes-info .sw{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
@media (max-width:640px){.quakes-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:45%}.quakes-clock{bottom:auto;top:10px;font-size:24px;padding:6px 14px}}
</style>
<div class="head"><h1>${t("World earthquakes")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub">${t("USGS ANSS ComCat · M2+ · $1", `<span data-k="span">${t("$1– ##since year", Y_MIN)}</span>`)}</div>
<div class="row"><div data-k="status" class="stat">${t("Loading…")}</div></div>
<div class="body">
<div class="row">
 <label>${t("Period")} <b data-k="yearLab"></b></label>
 <div class="dual"><input type="range" data-k="y0" step="1"><input type="range" data-k="y1" step="1"></div>
</div>
<div class="row play">
 <button type="button" data-k="play">${t("▶ Play")}</button>
 <select data-k="unit"><option value="1">${t("1 year per step")}</option><option value="month">${t("1 month per step")}</option></select>
 <label class="chk"><input type="checkbox" data-k="accum">${t("Cumulative")}</label>
 <div class="spd">${t("Speed")} <input type="range" data-k="speed" min="0.5" max="24" step="0.5"><b data-k="speedLab"></b></div>
</div>
<div class="row">
 <label>${t("Magnitude")} <b data-k="magLab"></b></label>
 <div class="dual"><input type="range" data-k="m0" min="2" max="9.5" step="0.1"><input type="range" data-k="m1" min="2" max="9.5" step="0.1"></div>
</div>
<div class="row">
 <label>${t("Depth (color)")}</label>
 <div class="bar" data-k="bar"></div>
 <div class="ticks" data-k="ticks"></div>
</div>
<div class="row">
 <label>${t("Size = energy (sphere volume)")}</label>
 <div class="sizes" data-k="sizes"></div>
 <div class="note">${t("E ∝ 10$1, so radius ∝ 10$2. Two magnitudes up = 10× radius (1000× energy).", "<sup>1.5M</sup>", "<sup>0.5M</sup>")}<br>${t("M>6 are 3D spheres; M≤6 are 2D sprites.")}</div>
</div>
<details open>
 <summary>${t("Display")}</summary>
 <div class="row"><label>${t("Sphere size")} <b data-k="sizeLab"></b></label><input type="range" data-k="size" min="-1.5" max="1.5" step="0.05"></div>
 <div class="row"><label>${t("Opacity of small earthquakes")} <b data-k="faintLab"></b></label><input type="range" data-k="faint" min="0.02" max="1" step="0.01"></div>
 <div class="row"><label>${t("Earth transparency")} <b data-k="clearLab"></b></label><input type="range" data-k="clear" min="0" max="1" step="0.01"></div>
</details>
<div class="note">${t("Click an earthquake for details. Play steps through the period range by year or month (Esc to stop). Tilt (right-drag / two fingers) to see hypocenter depth in 3D.")}<br>${t("Source: $1", "U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog")}</div>
</div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	const info = document.createElement("div");
	info.className = "quakes-info"; info.style.display = "none";
	mapEl.appendChild(info);
	const clock = document.createElement("div");
	clock.className = "quakes-clock"; clock.style.display = "none";
	mapEl.appendChild(clock);
	// 再生中の巨大地震の札（窓の中の M≥TAG_MIN・大きい順に TAG_MAX 枚）
	const TAG_MIN = 7.5, TAG_MAX = 3;
	let tags = [];   // { L, i, el }
	const clearTags = () => { tags.forEach(t => t.el.remove()); tags = []; };
	const placeTags = () => {
		if (!tags.length) return;
		const { s, dpr, W, H } = camState();
		for (const t of tags) {
			const p = project(s, t.L, t.i, W, H);
			if (!p) { t.el.style.display = "none"; continue; }
			t.el.style.display = ""; t.el.style.marginTop = "";
			t.el.style.left = (p.x / dpr) + "px"; t.el.style.top = (p.y / dpr) + "px";
		}
		// 重なった札は上へ避ける（先に置いた札の上に積む）
		const placed = [];
		for (const t of tags) {
			if (t.el.style.display === "none") continue;
			let r = t.el.getBoundingClientRect(), lift = 0;
			for (const q of placed) {
				if (r.left < q.right + 4 && r.right > q.left - 4 && r.top < q.bottom + 4 && r.bottom > q.top - 4) {
					lift += r.bottom - q.top + 6;
					r = new DOMRect(r.left, r.top - (r.bottom - q.top + 6), r.width, r.height);
				}
			}
			if (lift) t.el.style.marginTop = (-14 - lift) + "px";
			placed.push(r);
		}
	};
	const refreshTags = () => {
		clearTags();
		const [y0, y1] = yearRange(), m0 = st.magMin - 1e-4, m1 = st.magMax + 1e-4;
		const found = [];
		for (const L of layers) {
			if (!L || !L.nBig) continue;
			for (let i = L.n - L.nBig; i < L.n; i++) {   // M>6 は末尾にまとまっている
				const mg = L.attr[i * 3], yr = L.attr[i * 3 + 2];
				if (mg >= TAG_MIN && mg >= m0 && mg <= m1 && yr >= y0 && yr <= y1) found.push({ L, i, mg });
			}
		}
		found.sort((a, b) => b.mg - a.mg);
		for (const f of found.slice(0, TAG_MAX)) {
			const el = document.createElement("div");
			el.className = "quakes-tag";
			el.innerHTML = tagHtml(f.L, f.i);
			mapEl.appendChild(el);
			tags.push({ L: f.L, i: f.i, el });
		}
		placeTags();
	};
	// 折り畳み：小さい画面は最初から畳む（見出し＋件数だけ残す）
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);

	// 凡例
	$("bar").style.background = `linear-gradient(90deg,${STOPS.map(([t, c]) => `rgb(${c}) ${(t * 100).toFixed(1)}%`).join(",")})`;
	$("ticks").innerHTML = [0, 30, 70, 150, 300, 700].map(d => `<span style="left:${(depthT(d) * 100).toFixed(1)}%">${d}${d === 700 ? " km" : ""}</span>`).join("");
	const drawSizes = () => {
		// M5〜M9：M6 を 6px 半径として相対（半径 ∝ 10^(0.5M)）。M>6 は球・M≤6 は平たい円
		const base = 5;
		$("sizes").innerHTML = [4, 5, 6, 7, 8, 9].map(m => {
			const r = Math.max(1, Math.min(34, base * Math.pow(10, 0.5 * (m - 6)) ** 0.62));   // 凡例だけ圧縮（そのままだと M9 が 30 倍）
			const cls = m > M_SPLIT ? "ball" : "dot";
			return `<div><span class="${cls}" style="width:${2 * r}px;height:${2 * r}px"></span>M${m}</div>`;
		}).join("");
	};
	drawSizes();

	const yearNow = new Date().getUTCFullYear();
	for (const k of ["y0", "y1"]) { $(k).min = Y_MIN; $(k).max = yearNow; }
	$("y0").value = Y_MIN; $("y1").value = yearNow;
	$("m0").value = 2; $("m1").value = 9.5;
	$("size").value = 0; $("faint").value = st.faint; $("clear").value = st.clear;
	$("speed").value = play.sps;

	let countTimer = 0;
	const syncLabels = () => {
		$("yearLab").textContent = st.yearMin === st.yearMax ? t("$1 ##year", st.yearMin) : t("$1–$2 ##years", st.yearMin, st.yearMax);
		$("magLab").textContent = t("M$1–$2", st.magMin.toFixed(1), st.magMax >= 9.5 ? "" : st.magMax.toFixed(1));
		$("sizeLab").textContent = t("×$1 (M6 radius $2 km)", st.size < 1 ? st.size.toFixed(2) : st.size.toFixed(1), Math.round(M6_KM * st.size));
		$("faintLab").textContent = Math.round(st.faint * 100) + "%";
		$("clearLab").textContent = Math.round(st.clear * 100) + "%";
		$("speedLab").textContent = play.step === 1 ? t("$1 years/s", play.sps) : t("$1 months/s", play.sps);
	};
	// ── 再生 ──
	const periodText = () => {
		const y = Math.floor(play.cur + 1e-6);
		if (play.step === 1) return t("$1 ##year", y);
		const mo = Math.round((play.cur - y) * 12) + 1;
		return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(getLang(), { year: "numeric", month: "long", timeZone: "UTC" });   // 年月＝Intl（2011年3月／March 2011）
	};
	const showClock = () => {
		clock.innerHTML = `${periodText()}<small>${play.accum ? t("Cumulative since $1", st.yearMin) : play.step === 1 ? t("Earthquakes this year") : t("Earthquakes this month")}</small>`;
		clock.style.display = "";
	};
	let countT = 0;
	const tick = now => {
		play.raf = requestAnimationFrame(tick);
		if (now - play.last < 1000 / play.sps) return;
		play.last = now;
		play.cur += play.step;
		if (play.cur >= st.yearMax + 1 - 1e-6) play.cur = st.yearMin;   // 端まで来たら先頭へ
		showClock(); refreshTags(); redraw();
		if (now - countT > 250) { countT = now; countVisible(); }
	};
	const startPlay = () => {
		if (play.on) return;
		play.on = true; play.cur = st.yearMin; play.last = 0;
		$("play").textContent = t("■ Stop"); $("play").classList.add("on");
		info.style.display = "none";
		showClock(); refreshTags(); redraw(); countVisible();
		play.raf = requestAnimationFrame(tick);
	};
	const stopPlay = () => {
		if (!play.on) return;
		play.on = false; cancelAnimationFrame(play.raf); play.raf = 0;
		$("play").textContent = t("▶ Play"); $("play").classList.remove("on");
		clock.style.display = "none"; clearTags();
		redraw(); countVisible();
	};
	$("play").addEventListener("click", () => play.on ? stopPlay() : startPlay());
	const onKey = e => { if (e.key === "Escape" && play.on) stopPlay(); };
	addEventListener("keydown", onKey);
	// 状況＝件数の行＋層ごとの進み具合（読み込み中は逐次・済んだ後も USGS の要約は残す）
	let countLine = "", notes = [], skippedNote = "";
	const esc = t => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
	const renderStatus = () => {
		$("status").innerHTML = [countLine, ...notes.filter(Boolean).map(n => `<span style="color:#9aa6bd">${esc(n.text)}</span>`), skippedNote].filter(Boolean).join("<br>");
	};
	// worker からの文言＝{ key, args }（args に { key, args } を入れ子にできる・数値はこの言語の桁区切り）。訳すのは main だけ
	const msgText = m => t(m.key, ...(m.args ?? []).map(a => a && typeof a === "object" && a.key ? msgText(a) : typeof a === "number" ? fmt(a) : a));
	const countVisible = () => {
		const n = total();
		if (!n) return;
		let c = 0, big = 0;
		const [y0, y1] = yearRange(), m0 = st.magMin - 1e-4, m1 = st.magMax + 1e-4;
		for (const L of layers) {
			if (!L) continue;
			const { attr } = L;
			for (let i = 0; i < L.n; i++) {
				const m = attr[i * 3], y = attr[i * 3 + 2];
				if (m >= m0 && m <= m1 && y >= y0 && y <= y1) { c++; if (m > M_SPLIT) big++; }
			}
		}
		countLine = `${t("Showing $1 ##count", `<b>${fmt(c)}</b>`)} <span style="color:#9aa6bd">${t("(of which $1 spheres above M6) / $2 total", fmt(big), fmt(n))}</span>`;
		renderStatus();
	};
	const onInput = () => {
		let y0 = +$("y0").value, y1 = +$("y1").value; if (y0 > y1) [y0, y1] = [y1, y0];
		let m0 = +$("m0").value, m1 = +$("m1").value; if (m0 > m1) [m0, m1] = [m1, m0];
		st.yearMin = y0; st.yearMax = y1 >= yearNow ? Math.max(y1, dataYearMax) : y1;
		st.magMin = m0; st.magMax = m1 >= 9.5 ? 10 : m1;
		st.size = Math.pow(10, +$("size").value);
		st.faint = +$("faint").value;
		const clear = +$("clear").value;
		if (clear !== st.clear) { st.clear = clear; applyGlobe(); }
		play.step = $("unit").value === "month" ? 1 / 12 : 1;
		play.accum = $("accum").checked;
		play.sps = +$("speed").value;
		if (play.on) play.cur = Math.min(Math.max(play.cur, st.yearMin), st.yearMax + 1 - play.step);
		syncLabels();
		clearTimeout(countTimer); countTimer = setTimeout(countVisible, 60);
		info.style.display = "none";
		redraw();
	};
	panel.addEventListener("input", onInput);
	syncLabels();
	applyGlobe();

	// ── クリックで詳細（CPU で最寄りを探す）──
	let down = null;
	mapEl.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; }, true);
	mapEl.addEventListener("pointerup", e => {
		if (!down || !total() || panel.contains(e.target)) return;
		const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
		if (moved > 4) return;
		const r = mapEl.getBoundingClientRect();
		const hit = pick(e.clientX - r.left, e.clientY - r.top);
		if (!hit) { info.style.display = "none"; return; }
		showInfo(hit, e.clientX - r.left, e.clientY - r.top);
	}, true);
	map.on("move", () => { info.style.display = "none"; });

	// 震源 → 画面（device px）。裏側（透けが薄い）や画面外は null
	function project(s, L, i, W, H) {
		const m = s.mvp, E = s.eye;
		const X = L.pos[i * 3], Y = L.pos[i * 3 + 1], Z = L.pos[i * 3 + 2];
		const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
		if (w <= 0) return null;
		const x = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W;
		const y = (1 - ((m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5)) * H;
		if (x < 0 || y < 0 || x > W || y > H) return null;
		const dx = X - E[0], dy = Y - E[1], dz = Z - E[2];
		const a = dx * dx + dy * dy + dz * dz, b = E[0] * dx + E[1] * dy + E[2] * dz, c = E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1;
		const disc = b * b - a * c;
		if (disc > 0) {
			const sq = Math.sqrt(disc), t0 = Math.min(1, Math.max(0, (-b - sq) / a)), t1 = Math.min(1, Math.max(0, (-b + sq) / a));
			if (Math.exp(-(t1 - t0) * Math.sqrt(a) / lambdaOf(st.clear)) < 0.05) return null;
		}
		return { x, y };
	}
	const coordText = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
	const tagHtml = (L, i) => {
		const mg = L.attr[i * 3], dp = L.attr[i * 3 + 1], tm = L.time[i], place = L.place?.get(i);
		return `<b>M${mg.toFixed(1)}</b>　${fmtTime(tm).slice(0, 10)}<small>${place ? esc(place) : coordText(L.lat[i], L.lon[i])}　${t("Depth $1 km", Math.round(dp))}</small>`;
	};
	function pick(x, y) {
		const { s, dpr, W, H } = camState();
		const m = s.mvp, E = s.eye;
		const px = x * dpr, py = y * dpr;
		const scale = M6_KM * 1000 * st.size / EARTH_M, lam = lambdaOf(st.clear);
		const [y0, y1] = yearRange(), m0 = st.magMin - 1e-4, m1 = st.magMax + 1e-4;
		let best = null, bestScore = Infinity;
		for (const L of layers) {
			if (!L) continue;
			const { pos, attr, n } = L;
			for (let i = 0; i < n; i++) {
				const mg = attr[i * 3], yr = attr[i * 3 + 2];
				if (mg < m0 || mg > m1 || yr < y0 || yr > y1) continue;
				const X = pos[i * 3], Y = pos[i * 3 + 1], Z = pos[i * 3 + 2];
				const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
				if (w <= 0) continue;
				const sx = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W;
				const sy = (1 - ((m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5)) * H;
				const d = Math.hypot(sx - px, sy - py);
				const rad = Math.max(scale * Math.pow(10, 0.5 * (mg - 6)) * s.focal / w, (mg > M_SPLIT ? 2.2 : 1.1) * dpr);
				const tol = Math.max(rad, 5 * dpr);
				if (d > tol) continue;
				// 透け（地球の裏側は拾わない）
				const dx = X - E[0], dy = Y - E[1], dz = Z - E[2];
				const a = dx * dx + dy * dy + dz * dz, b = E[0] * dx + E[1] * dy + E[2] * dz, c = E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1;
				const disc = b * b - a * c;
				if (disc > 0) {
					const sq = Math.sqrt(disc), t0 = Math.min(1, Math.max(0, (-b - sq) / a)), t1 = Math.min(1, Math.max(0, (-b + sq) / a));
					if (Math.exp(-(t1 - t0) * Math.sqrt(a) / lam) < 0.05) continue;
				}
				// 近さ（半径で正規化）を主に、同程度なら大きい地震を優先
				const score = d / tol - mg * 0.02;
				if (score < bestScore) { bestScore = score; best = { L, i }; }
			}
		}
		return best;
	}
	function showInfo({ L, i }, x, y) {
		const mg = L.attr[i * 3], dp = L.attr[i * 3 + 1], tm = L.time[i];
		const lat = L.lat[i], lon = L.lon[i];
		const [r, g, b] = depthColor(dp);
		info.innerHTML = `<b>M${mg.toFixed(1)}</b>　<span class="sw" style="background:rgb(${r},${g},${b})"></span>${t("Depth $1 km", dp.toFixed(1))}<br>
${L.place?.get(i) ? esc(L.place.get(i)) + "<br>" : ""}${fmtTime(tm)} UTC<br><span style="color:#9aa6bd">${fmtTime(tm, 9)} JST</span><br>
${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"}　${Math.abs(lon).toFixed(3)}°${lon >= 0 ? "E" : "W"}`;
		info.style.left = x + "px"; info.style.top = y + "px"; info.style.display = "block";
	}

	// ── データ読み込み ──
	const worker = new Worker(new URL("./quakes-worker.js", import.meta.url), { type: "module", name: "quakes" });
	const loaded = new Promise((resolve, reject) => {   // 失敗は status とconsole に出す（呼び手が await しなくても unhandled にしない＝下の catch）
		worker.onmessage = e => {
			const m = e.data;
			if (m.type === "progress") { notes[m.q] = { text: msgText(m.msg), keep: m.msg.keep }; renderStatus(); }
			else if (m.type === "part") setPart(m);
			else if (m.type === "error") { console.error("[quakes] worker error:", m.message, m.stack || ""); $("status").textContent = t("Failed to load: $1", m.key ? t(m.key) : m.message); reject(new Error(m.message)); }
			else if (m.type === "done") {
				notes = notes.map(n => n?.keep ? n : null);   // 済んだら要約（keep）だけ残す
				if (m.skipped?.length) skippedNote = `<span style="color:#ffb86b">${t("Could not read: $1 (reload to retry)", esc(m.skipped.join(t(", ##list separator"))))}</span>`;
				renderStatus(); resolve(m); worker.terminate();
			}
		};
	});
	loaded.catch(() => {});   // 呼び手が await しない使い方（quakes.html）で unhandled rejection にしない（エラーは status/console に出ている）
	// src＝URL・ArrayBuffer・{ usgs: 起点（日付か archive.json の URL）}、またはその配列（archive＋USGS 直取りを連結）
	const abs = s => new URL(s, location.href).href;
	const srcs = (Array.isArray(src) ? src : [src]).map(s => typeof s === "string" ? abs(s) : s?.usgs && !/^\d{4}-\d{2}-\d{2}$/.test(s.usgs) ? { usgs: abs(s.usgs) } : s);
	worker.postMessage({ srcs, rAx: ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, earthM: EARTH_M }, srcs.filter(s => s instanceof ArrayBuffer));

	// 層 q を差し替える（USGS 直近分は 1 か月届くごとに来る）。GPU へは写しを渡す＝main の列は pick・件数・札の投影に残す
	function setPart(m) {
		const { q, n, pos, attr } = m;
		// M>6 はマグニチュード昇順の末尾にまとまっている
		let k = n; while (k > 0 && attr[(k - 1) * 3] > M_SPLIT) k--;
		const gp = pos.slice(), ga = attr.slice();
		ov.post({ type: "layer", q, n, pos: gp, attr: ga }, [gp.buffer, ga.buffer]);
		layers[q] = { ...m, nBig: n - k };

		// 年の幅（全層）
		let minY = Infinity, maxY = -Infinity;
		for (const L of layers) if (L) for (let i = 0; i < L.n; i++) { const y = L.attr[i * 3 + 2]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
		if (Number.isFinite(maxY)) {
			dataYearMax = Math.floor(maxY);
			if (st.yearMax >= yearNow) st.yearMax = Math.max(st.yearMax, dataYearMax);
			$("span").textContent = t("$1–$2 ##year range", Math.floor(minY), dataYearMax);
		}
		syncLabels(); countVisible();
		redraw();
	}

	return {
		loaded, state: st, redraw,
		get count() { return total(); },
		get bigCount() { return layers.reduce((a, L) => a + (L?.nBig ?? 0), 0); },
		get layers() { return layers; },   // console 検証用（層ごとの pos/attr/lon/lat/time の列）
		pick: (x, y) => total() ? pick(x, y) : null,
		destroy() { stopPlay(); clearTags(); removeEventListener("keydown", onKey); clock.remove(); offFrame(); cancelAnimationFrame(catchUp); ov.remove(); panel.remove(); info.remove(); worker.terminate(); map.setOpacity({ globe: 1, base: 1 }); },
	};
}
