// ガジェット：断面図（標高プロファイル）。オプトイン＝map.gadget.profile()（地理院地図「断面図」の趣を本歌取り）。
// 操作：ボタンで経路指定モード→クリックで頂点（n点の折れ線）→ダブルクリック or Esc で確定→
//   経路を等間隔サンプルした標高を下辺のグラフパネルへ（取得しながら描き足す＝進捗が見える）。
//   確定後のクリック＝新しい経路／パネル×＝グラフだけ閉じる（線は残る）／ボタンOFF＝全消去。
// 標高：注入 sampleHeight（app が altpbf createGetHeight を zoom=99 で叩く＝日本は R01=DEM10B 10m格子、
//   海外は ALOS/GEBCO へ自動フォールバック）。サンプル間隔は10m床・120〜1000点（総距離に応じ可変）。
// 幾何：頂点は経緯度で持ち線は大圏弧で球に追従（measure と同流儀）。距離は WGS84（geodesicDistance）＝数字だけ楕円体。
// グラフ：縦軸基準（最低標高/0m）切替・縦横比（縦誇張）表示・ホバーで地図上に対応点マーカー・PNG/GeoJSON保存。
// 注入（登録側）：makeProjector・unprojectXY・setClick（クリック横取り）・sampleHeight・signal。
import { gadgetStack } from "./stack.js";
import { geodesicDistance } from "ortho-core";
import { tr } from "../i18n.js";
const t = tr({
	"断面図（クリックで経路指定）": "Elevation profile (click a route)",
	"断面図": "Elevation profile",
	"クリックで経路の指定を開始": "Click to start a route",
	"クリックで頂点・ダブルクリックで確定": "Click to add a vertex, double-click to finish",
	"クリックで新しい経路・Escで閉じる": "Click for a new route, Esc to close",
	"最低標高": "Lowest",
	"グラフを保存": "Save graph",
	"経路を保存": "Save route",
	"閉じる": "Close",
	"標高取得中… {0}/{1}": "Sampling elevation… {0}/{1}",
	"総距離 {0}": "Length {0}",
	"最低 {0}m・最高 {1}m": "Min {0}m / Max {1}m",
	"縦横比 約{0}:1": "V-exag. ≈{0}:1",
});

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const LINE = "#c9691e", DOT = "#fff", W = 2, R_VERT = 4;   // 経路＝橙（計測の暗赤と区別・グラフの塗りと同族）
const FILL_CH = "rgba(235,153,85,.5)", LINE_CH = "#c9691e";   // グラフの塗り/線（地理院の断面図に寄せた橙）

export function profile({ makeProjector, unprojectXY, setClick, sampleHeight, signal, btn } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#profile-lines")) return () => {};   // 二重搭載は無害
	const dpr = window.devicePixelRatio || 1;
	const font = (getComputedStyle(document.documentElement).getPropertyValue("--qm-font") || "system-ui").trim();

	if (!btn) {   // 直搭載（profile-stub 非経由＝単体でも動く＝独立）＝自前でボタン生成。stub 経由は btn 持参で再利用
		btn = document.createElement("button");
		btn.id = "profile-btn"; btn.dataset.tip = t("断面図（クリックで経路指定）"); btn.setAttribute("aria-label", t("断面図"));
		btn.innerHTML = ICON;
		gadgetStack(mapEl).append(btn);
	}

	const canvas = document.createElement("canvas");
	canvas.id = "profile-lines"; mapEl.append(canvas);   // #map 直下の後置（DOM順で上・pointerは素通し）
	const ctx = canvas.getContext("2d");
	const out = document.createElement("div");
	out.id = "profile-readout"; out.style.display = "none"; mapEl.append(out);   // 意匠は #measure-readout と相乗り

	// グラフパネル（下辺中央）。×＝グラフだけ閉じる（経路の線は残す＝もう一度見たければ引き直す）
	const panel = document.createElement("div");
	panel.id = "profile-panel";
	panel.innerHTML = `
		<div class="pf-head">
			<span class="pf-title">${t("断面図")}</span>
			<span class="pf-stats"></span>
			<span class="pf-base">
				<label><input type="radio" name="pf-base" value="min" checked>${t("最低標高")}</label>
				<label><input type="radio" name="pf-base" value="zero">0m</label>
			</span>
			<button class="pf-act pf-save">${t("グラフを保存")}</button>
			<button class="pf-act pf-route">${t("経路を保存")}</button>
			<button class="panel-close" aria-label="${t("閉じる")}">✕</button>
		</div>
		<canvas class="pf-chart"></canvas>`;
	mapEl.append(panel);
	const chart = panel.querySelector(".pf-chart"), cctx = chart.getContext("2d");
	const statsEl = panel.querySelector(".pf-stats");

	let active = false, finished = false, verts = [], cursorLL = null, cw = 0, ch = 0;
	let samples = [], sampled = 0, total = 0, runId = 0;   // samples[i]={s,ll,h}（取得済みだけ非null）
	let hoverI = -1;   // グラフのホバー位置（サンプル添字）＝地図上マーカーと連動

	btn.addEventListener("click", () => (active ? stop() : start()));
	panel.querySelector(".panel-close").addEventListener("click", closePanel);
	panel.querySelectorAll(".pf-base input").forEach(r => r.addEventListener("change", renderChart));
	panel.querySelector(".pf-save").addEventListener("click", () => chart.toBlob(b => b && download(b, "profile.png")));
	panel.querySelector(".pf-route").addEventListener("click", () => {   // 経路＝標高付き LineString（[lon,lat,標高m]）＝GISへそのまま持ち出せる
		const coords = samples.filter(Boolean).map(p => [+p.ll[0].toFixed(6), +p.ll[1].toFixed(6), Math.round(p.h * 10) / 10]);
		if (coords.length < 2) return;
		const gj = { type: "Feature", properties: { length_m: Math.round(total) }, geometry: { type: "LineString", coordinates: coords } };
		download(new Blob([JSON.stringify(gj)], { type: "application/geo+json" }), "profile.geojson");
	});
	chart.addEventListener("pointermove", e => {
		const r = chart.getBoundingClientRect(), n = samples.length - 1;
		if (n < 1 || !r.width) return;
		const f = (e.clientX - r.left - plot.l) / Math.max(1, plot.w);
		const i = Math.max(0, Math.min(n, Math.round(f * n)));
		if (i !== hoverI) { hoverI = i; renderChart(); draw(); }
	}, { passive: true });
	chart.addEventListener("pointerleave", () => { if (hoverI >= 0) { hoverI = -1; renderChart(); draw(); } }, { passive: true });

	function start() {
		active = true; finished = false; verts = []; cursorLL = null;
		btn.classList.add("on"); mapEl.classList.add("profiling");
		setClick(addVertex); draw();
	}
	function stop() {
		active = false; verts = []; cursorLL = null; finished = false; runId++;
		btn.classList.remove("on"); mapEl.classList.remove("profiling");
		closePanel(); setClick(null); draw();
	}
	function addVertex(x, y) {   // x,y＝canvasローカルCSS座標（input.onClick と同座標系）
		const ll = unprojectXY(x, y); if (!ll) return;   // 宇宙（球外）クリックは無視
		if (finished) { verts = []; finished = false; runId++; closePanel(); }   // 確定後の最初のクリック＝新しい経路
		verts.push(ll); draw();
	}
	function finish() {   // ダブルクリックの二打目（重複頂点）を落として確定→サンプル開始
		if (verts.length >= 1) verts.pop();
		finished = true; cursorLL = null;
		if (verts.length >= 2) sample();
		draw();
	}

	mapEl.addEventListener("pointermove", e => {
		if (!active || finished) return;
		const r = mapEl.getBoundingClientRect();
		cursorLL = unprojectXY(e.clientX - r.left, e.clientY - r.top); draw();
	}, { signal, passive: true });
	mapEl.addEventListener("dblclick", e => { if (active && !finished) { e.preventDefault(); finish(); } }, { signal });
	window.addEventListener("keydown", e => {
		if (!active || e.key !== "Escape") return;
		if (!finished && verts.length) finish();                                // 描画中Esc＝確定
		else if (panel.classList.contains("open")) closePanel();                // 確定後Esc＝グラフを閉じる（モードは維持）
	}, { signal });

	const plot = { l: 48, r: 14, t: 20, b: 22, w: 0, h: 0 };   // グラフの余白＝軸ラベルの席。t=20＝「(m)」が最上段の目盛数字と重ならない（★return文より前＝後置の const/var は実行されない：measure.js の教訓）
	const _update = () => { if (active) draw(); };   // 毎フレ：モード中だけ再投影（パン/ズーム/3Dで球に追従）。非アクティブは即return
	// 戻り値＝no-op（作法の対称）＋制御ハンドル。stats()＝総距離(m)/頂点数/サンプル進捗/最低最高（アプリ/テストが読む）。
	return Object.assign(() => {}, {
		_update, start, stop, open: start, close: stop,
		stats: () => {
			const hs = samples.filter(Boolean).map(p => p.h);
			return { points: verts.length, total, sampled, samples: samples.length, min: hs.length ? Math.min(...hs) : 0, max: hs.length ? Math.max(...hs) : 0 };
		},
	});

	// ---- サンプリング ----
	// 経路を等間隔（10m床・120〜1000点）で分割し、各点の標高を直列 await で取る＝altpbf の単タイルキャッシュに
	// 素直（経路は空間的に連続＝セル跨ぎでだけ再ロード）。取得しながら 16点毎にグラフを描き足す＝進捗が見える。
	async function sample() {
		const run = ++runId, pts = verts.slice();
		const segs = []; let L = 0;
		for (let i = 0; i + 1 < pts.length; i++) { const d = geodesicDistance(pts[i], pts[i + 1]); segs.push({ a: pts[i], b: pts[i + 1], d0: L, d }); L += d; }
		if (!(L > 0)) return;
		const n = Math.max(120, Math.min(1000, Math.ceil(L / 10)));
		samples = new Array(n + 1).fill(null); sampled = 0; total = L; hoverI = -1;
		openPanel(); renderChart();
		for (let i = 0; i <= n; i++) {
			const s = L * i / n;
			let seg = segs[segs.length - 1];
			for (const g of segs) if (s <= g.d0 + g.d) { seg = g; break; }
			const ll = slerp(seg.a, seg.b, seg.d ? (s - seg.d0) / seg.d : 0);
			let h = 0;
			try { h = +await sampleHeight(ll[0], ll[1]) || 0; } catch { h = 0; }
			if (run !== runId) return;   // 新しい経路/OFF＝この走者は静かに降りる
			samples[i] = { s, ll, h }; sampled = i + 1;
			if ((i & 15) === 15 || i === n) renderChart();
		}
	}

	// ---- 幾何（measure と同流儀＝表示球の大圏。数字だけ WGS84）----
	function to3(lon, lat) { const a = lon * D2R, b = lat * D2R, cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; }
	function toLL(v) { return [Math.atan2(v[2], v[0]) * R2D, Math.asin(Math.max(-1, Math.min(1, v[1]))) * R2D]; }
	function slerp(a, b, f) {   // 大圏に沿った内分点（f=0..1）
		const A = to3(a[0], a[1]), B = to3(b[0], b[1]);
		let dot = A[0] * B[0] + A[1] * B[1] + A[2] * B[2]; dot = Math.max(-1, Math.min(1, dot));
		const om = Math.acos(dot);
		if (om < 1e-9) return a;
		const so = Math.sin(om), s0 = Math.sin((1 - f) * om) / so, s1 = Math.sin(f * om) / so;
		return toLL([A[0] * s0 + B[0] * s1, A[1] * s0 + B[1] * s1, A[2] * s0 + B[2] * s1]);
	}
	function gcPoints(a, b) {   // 大圏弧を約0.5°刻みで細分（近ければ2点）
		const A = to3(a[0], a[1]), B = to3(b[0], b[1]);
		let dot = A[0] * B[0] + A[1] * B[1] + A[2] * B[2]; dot = Math.max(-1, Math.min(1, dot));
		const om = Math.acos(dot), n = Math.max(1, Math.min(128, Math.round(om * R2D / 0.5)));
		if (om < 1e-6 || n <= 1) return [a, b];
		const pts = [];
		for (let i = 0; i <= n; i++) pts.push(slerp(a, b, i / n));
		return pts;
	}

	// ---- 地図面の描画（経路の線・頂点・グラフ連動マーカー）----
	function syncSize() {
		const w = mapEl.clientWidth, h = mapEl.clientHeight;
		if (w !== cw || h !== ch) { cw = w; ch = h; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + "px"; canvas.style.height = h + "px"; }
	}
	function strokeArc(pr, a, b) {
		const pts = gcPoints(a, b);
		ctx.beginPath(); let pen = false;
		for (const p of pts) {
			const [x, y, front] = pr(p[0], p[1]);
			if (front < 0) { pen = false; continue; }
			pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
		}
		ctx.stroke();
	}
	function dotAt(pr, ll, r, fill) {
		const [x, y, front] = pr(ll[0], ll[1]); if (front < 0) return;
		ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = W; ctx.stroke();
	}
	function draw() {
		syncSize();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
		if (!active) return readout("");
		if (!verts.length) return readout(hint());
		const pr = makeProjector();
		let pp = verts.slice();
		if (!finished && cursorLL) pp.push(cursorLL);
		ctx.strokeStyle = LINE; ctx.lineWidth = W; ctx.lineJoin = "round"; ctx.lineCap = "round";
		for (let i = 0; i + 1 < pp.length; i++) strokeArc(pr, pp[i], pp[i + 1]);
		for (const v of pp) dotAt(pr, v, R_VERT, DOT);
		if (hoverI >= 0 && samples[hoverI]) dotAt(pr, samples[hoverI].ll, R_VERT + 2, LINE);   // グラフのホバー位置＝地図に対応点
		readout(hint(pp));
	}
	function hint(pp) {
		if (!verts.length) return `<span class="mr-hint">${t("クリックで経路の指定を開始")}</span>`;
		if (finished) return `<span class="mr-hint">${t("クリックで新しい経路・Escで閉じる")}</span>`;
		let L = 0; for (let i = 0; pp && i + 1 < pp.length; i++) L += geodesicDistance(pp[i], pp[i + 1]);
		return `<b>${fmtDist(L)}</b><span class="mr-sep">･</span><span class="mr-hint">${t("クリックで頂点・ダブルクリックで確定")}</span>`;
	}
	function readout(html) { out.innerHTML = html; out.style.display = html ? "block" : "none"; }

	// ---- グラフパネル ----
	function openPanel() { panel.classList.add("open"); }
	function closePanel() { panel.classList.remove("open"); hoverI = -1; draw(); }

	function renderChart() {
		const cssW = Math.max(200, panel.clientWidth - 22), cssH = 210;   // パネル内寸に追従（22＝左右padding）
		chart.width = Math.round(cssW * dpr); chart.height = Math.round(cssH * dpr);
		chart.style.width = cssW + "px"; chart.style.height = cssH + "px";
		cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const cs = getComputedStyle(panel);
		const ink = (cs.getPropertyValue("--qm-text") || "#333").trim() || "#333";
		const faint = (cs.getPropertyValue("--qm-border-soft") || "rgba(0,0,0,.12)").trim() || "rgba(0,0,0,.12)";
		const bg = (cs.getPropertyValue("--qm-panel-solid") || "#fff").trim() || "#fff";
		cctx.fillStyle = bg; cctx.fillRect(0, 0, cssW, cssH);   // PNG保存で透過にならないよう地色を敷く
		const got = samples.filter(Boolean);
		plot.w = cssW - plot.l - plot.r; plot.h = cssH - plot.t - plot.b;
		if (got.length < 2) { statsEl.textContent = t("標高取得中… {0}/{1}", sampled, samples.length); return; }

		// 縦レンジ：基準＝最低標高（既定）or 0m。高低差10m未満（海上等）は10mに広げる＝平線が枠に貼り付かない
		const zero = panel.querySelector('.pf-base input[value="zero"]').checked;
		let hs = got.map(p => p.h), minH = Math.min(...hs), maxH = Math.max(...hs);
		let yLo = zero ? Math.min(0, minH) : minH, yHi = Math.max(maxH, yLo + 10);
		const ys = niceStep((yHi - yLo) / 5);
		yLo = Math.floor(yLo / ys) * ys; yHi = Math.ceil(Math.max(yHi, yLo + ys) / ys) * ys;
		const totKm = total / 1000, xs = niceStep(totKm / 6);
		const X = s => plot.l + (s / total) * plot.w;
		const Y = h => plot.t + (1 - (h - yLo) / (yHi - yLo)) * plot.h;

		// 目盛（横罫＝標高・縦目盛＝距離km）
		cctx.font = `11px ${font}`; cctx.fillStyle = ink; cctx.strokeStyle = faint; cctx.lineWidth = 1;
		cctx.textAlign = "right"; cctx.textBaseline = "middle";
		for (let v = yLo; v <= yHi + ys / 2; v += ys) {
			const y = Y(v);
			cctx.beginPath(); cctx.moveTo(plot.l, y); cctx.lineTo(plot.l + plot.w, y); cctx.stroke();
			cctx.fillText(fmtNum(v), plot.l - 5, y);
		}
		cctx.textAlign = "center"; cctx.textBaseline = "top";
		for (let v = 0; v <= totKm + xs / 2; v += xs) cctx.fillText(fmtNum(v), X(v * 1000), plot.t + plot.h + 4);
		cctx.textAlign = "left"; cctx.fillText("(m)", 4, 2);
		cctx.textAlign = "right"; cctx.fillText("(km)", cssW - 2, plot.t + plot.h + 4);

		// 断面の塗り＋稜線（取得済みの範囲だけ＝進捗がそのまま見える）
		cctx.beginPath();
		got.forEach((p, i) => i ? cctx.lineTo(X(p.s), Y(p.h)) : cctx.moveTo(X(p.s), Y(p.h)));
		const last = got[got.length - 1];
		cctx.lineTo(X(last.s), Y(yLo)); cctx.lineTo(X(got[0].s), Y(yLo)); cctx.closePath();
		cctx.fillStyle = FILL_CH; cctx.fill();
		cctx.beginPath();
		got.forEach((p, i) => i ? cctx.lineTo(X(p.s), Y(p.h)) : cctx.moveTo(X(p.s), Y(p.h)));
		cctx.strokeStyle = LINE_CH; cctx.lineWidth = 1.5; cctx.stroke();
		// 外枠
		cctx.strokeStyle = ink; cctx.lineWidth = 1; cctx.strokeRect(plot.l, plot.t, plot.w, plot.h);

		// ホバー：縦線＋点＋読み（距離・標高）
		const hv = hoverI >= 0 ? samples[hoverI] : null;
		if (hv) {
			const x = X(hv.s), y = Y(hv.h);
			cctx.strokeStyle = ink; cctx.setLineDash([3, 3]);
			cctx.beginPath(); cctx.moveTo(x, plot.t); cctx.lineTo(x, plot.t + plot.h); cctx.stroke(); cctx.setLineDash([]);
			cctx.beginPath(); cctx.arc(x, y, 3.5, 0, Math.PI * 2); cctx.fillStyle = LINE_CH; cctx.fill();
			cctx.fillStyle = ink; cctx.textAlign = x < plot.l + plot.w / 2 ? "left" : "right"; cctx.textBaseline = "bottom";
			cctx.fillText(`${(hv.s / 1000).toFixed(2)} km  ${Math.round(hv.h)} m`, x + (x < plot.l + plot.w / 2 ? 6 : -6), plot.t + 14);
		}

		// 頭書き：総距離・最低/最高・縦横比（縦の誇張率）。取得中は進捗を添える
		const exag = Math.max(1, Math.round((total / plot.w) / ((yHi - yLo) / plot.h)));
		const prog = sampled < samples.length ? `　${t("標高取得中… {0}/{1}", sampled, samples.length)}` : "";
		statsEl.textContent = `${t("総距離 {0}", fmtDist(total))}　${t("最低 {0}m・最高 {1}m", fmtNum(Math.round(minH)), fmtNum(Math.round(maxH)))}　${t("縦横比 約{0}:1", exag)}${prog}`;
	}
}

// ボタングリフ（軸＋山なみ）。線色は本線インク直書き＝quiet-mono の夜節が自動反転（measure と同流儀）。
const ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
		<path d="M3.5 4v16h17"/>
		<path d="M5 17.5l4-8 3 3.5 4-6.5 3.5 11" stroke-width="1.6"/></svg>`;

// ---- 表示整形 ----
function niceStep(raw) {   // 目盛の刻み＝1-2-5系列へ切り上げ（軸が汚い端数にならない）
	const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))), m = raw / p;
	return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtNum(v) { return comma(Math.round(v * 100) / 100); }
function fmtDist(m) {   // measure と同じ刻み（<100m=小数1m/<1km=整数m/<10km=小数2km/<100km=小数1km/以上=整数km）
	const km = m / 1000, c = (v, n) => comma(v.toFixed(n));
	return km < 0.1 ? c(m, 1) + " m" : km < 1 ? c(Math.round(m), 0) + " m" : km < 10 ? c(km, 2) + " km" : km < 100 ? c(km, 1) + " km" : c(km, 0) + " km";
}
function download(blob, name) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob); a.download = name; a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
