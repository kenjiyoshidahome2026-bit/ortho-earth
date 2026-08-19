// ガジェット：距離・面積の計測。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.measure() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// ★ortho-map は d3 の createPolygon(measure:true) に頼ったが、japan は編集系を持たない＝描画ごと新設。
//   仕様は ortho-map に合わせ込む＝辺の中点に区間距離・重心に L=総距離/S=面積・線色#880000・
//   塗り rgba(136,0,0,.1)・頂点r=4/中点r=2 の白丸(#880000縁)・ラベルは白＋黒影。
//   頂点は経緯度で持ち（球に貼り付く）、線は大圏弧を細分して球面追従、描画は専用canvas＋frameフック。
// 距離＝WGS84 Vincenty／面積＝WGS84 authalic 球面過剰（ortho-core geodesic.js・3点以上で閉じて算出・
// antimeridian対策込み）。※描画の弧・中点・重心は表示球（単位球）のまま＝見た目の道具。数字だけ楕円体。
// 操作：クリックで頂点／最終点＋カーソルで閉じプレビュー／ダブルクリック or Esc で確定／ボタンOFFで全消去。
// 注入（登録側）：makeProjector・unprojectXY・setClick（クリック横取り）・requestDraw・signal。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { geodesicDistance, geodesicArea } from "ortho-core";
import { tr } from "../i18n.js";
const t = tr({
	"距離・面積を測る（M）": "Measure distance and area (M)",
	"距離・面積を測る": "Measure distance and area",
	"クリックで計測を開始": "Click to start measuring",
	"Escで消去・ボタンで終了": "Esc to clear, button to exit",
	"クリックで頂点・ダブルクリックで確定": "Click to add a vertex, double-click to finish"
});

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const LINE = "#880000", FILL = "rgba(136,0,0,0.1)", DOT = "#fff", W = 2, R_VERT = 4;

export function measure({ makeProjector, unprojectXY, setClick, requestDraw, signal, btn } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#measure-lines")) return () => {};   // 二重搭載は無害
	const dpr = window.devicePixelRatio || 1;
	const font = (getComputedStyle(document.documentElement).getPropertyValue("--qm-font") || "system-ui").trim();

	if (!btn) {   // 直搭載（measure-stub 非経由＝単体でも動く＝独立）＝自前でボタン生成。stub 経由は btn 持参で再利用
		btn = document.createElement("button");
		btn.id = "measure-btn"; btn.dataset.tip = t("距離・面積を測る（M）"); btn.setAttribute("aria-label", t("距離・面積を測る"));
		btn.innerHTML = `
			<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
				<rect x="2.5" y="7" width="19" height="10" rx="1.5" transform="rotate(-20 12 12)"/>
				<path d="M6.6 8.2l1 2.4M10 6.9l1.4 3.2M13.4 5.6l1 2.4M16.8 4.3l1.4 3.2" stroke-width="1.3"/></svg>`;
		gadgetStack(mapEl).append(btn);
	}

	const canvas = document.createElement("canvas");
	canvas.id = "measure-lines"; mapEl.append(canvas);   // #map 直下の後置（DOM順で上・pointerは素通し）
	const ctx = canvas.getContext("2d");
	const out = document.createElement("div");
	out.id = "measure-readout"; out.style.display = "none"; mapEl.append(out);

	let active = false, finished = false, verts = [], cursorLL = null, cw = 0, ch = 0;
	let lastTotal = 0, lastArea = 0;   // 直近の計測値（アプリ/テストが読む＝stats()）

	btn.addEventListener("click", () => (active ? stop() : start()));
	// M＝計測モードのトグル（修飾なし＝OS衝突を避けた選択）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (e.key !== "m" && e.key !== "M") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); active ? stop() : start();
	}, { signal });
	function start() {
		active = true; finished = false; verts = []; cursorLL = null;
		btn.classList.add("on"); mapEl.classList.add("measuring");
		setClick(addVertex); draw();
	}
	function stop() {
		active = false; verts = []; cursorLL = null; finished = false;
		btn.classList.remove("on"); mapEl.classList.remove("measuring");
		setClick(null); draw();
	}
	function addVertex(x, y) {   // x,y＝canvasローカルCSS座標（input.onClick と同座標系）
		const ll = unprojectXY(x, y); if (!ll) return;   // 宇宙（球外）クリックは無視
		if (finished) { verts = []; finished = false; }   // 確定後の最初のクリック＝新規計測
		verts.push(ll); draw();
	}
	function finish() { if (verts.length >= 1) verts.pop(); finished = true; cursorLL = null; draw(); }   // ダブルクリックの二打目（重複頂点）を落として確定

	mapEl.addEventListener("pointermove", e => {
		if (!active || finished) return;
		const r = mapEl.getBoundingClientRect();
		cursorLL = unprojectXY(e.clientX - r.left, e.clientY - r.top); draw();
	}, { signal, passive: true });
	mapEl.addEventListener("dblclick", e => { if (active && !finished) { e.preventDefault(); finish(); } }, { signal });
	window.addEventListener("keydown", e => {
		if (!active || e.key !== "Escape") return;
		if (!finished && verts.length) finish();       // 描画中Esc＝確定
		else { verts = []; finished = false; draw(); }  // 確定後Esc＝消去（モードは維持）
	}, { signal });

	const _update = () => {   // 毎フレ：計測中だけ再投影して引き直す（パン/ズーム/3Dで球に追従）。
		if (active) draw();   // 非アクティブは即return＝全画面canvasの消去・合成とレイアウト読みを毎フレ積まない（PLATEAU時のカクツキ対策）。最後の消去は stop() の draw()、寸法合わせは draw() 冒頭の syncSize が担う
	};
	// 戻り値＝no-op（作法の対称）＋制御ハンドル。stats()＝現在の総距離(m)/面積(m²)/頂点数（アプリが読める）。
	// open/close＝start/stop の別名＝遅延スタブ（measure-stub）の共通IF（open で本体到着→計測開始）に相乗り。
	return Object.assign(() => {}, { _update, start, stop, open: start, close: stop, stats: () => ({ total: lastTotal, area: lastArea, points: verts.length }) });

	// ---- 幾何 ----
	// 距離・面積は WGS84（geodesic.js）。旧・球（R=6371008.8）の haversine/球面過剰は 2026-08-11 に交代＝
	// 東西/南北で最大0.5%あった系統誤差を解消（値だけの交代＝描画の弧は下の to3/gcPoints＝表示球のまま）。
	// ※この区画は return 文の後ろ＝関数宣言（巻き上げ）でないと draw() から見えない（const は TDZ で死ぬ）。
	function dist(a, b) { return geodesicDistance(a, b); }
	function areaOf(v) { return geodesicArea(v); }
	function to3(lon, lat) { const a = lon * D2R, b = lat * D2R, cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; }
	function toLL(v) { return [Math.atan2(v[2], v[0]) * R2D, Math.asin(Math.max(-1, Math.min(1, v[1]))) * R2D]; }
	function gcPoints(a, b) {   // 大圏弧を約0.5°刻みで細分（近ければ2点）
		const A = to3(a[0], a[1]), B = to3(b[0], b[1]);
		let dot = A[0] * B[0] + A[1] * B[1] + A[2] * B[2]; dot = Math.max(-1, Math.min(1, dot));
		const om = Math.acos(dot), n = Math.max(1, Math.min(128, Math.round(om * R2D / 0.5)));
		if (om < 1e-6 || n <= 1) return [a, b];
		const so = Math.sin(om), pts = [];
		for (let i = 0; i <= n; i++) {
			const t = i / n, s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so;
			pts.push(toLL([A[0] * s0 + B[0] * s1, A[1] * s0 + B[1] * s1, A[2] * s0 + B[2] * s1]));
		}
		return pts;
	}
	function midGc(a, b) {   // 大圏の中点＝2点の3D中点を正規化（短い辺で終点に化けない＝辺の真ん中に置く）
		const A = to3(a[0], a[1]), B = to3(b[0], b[1]);
		let m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
		const len = Math.hypot(m[0], m[1], m[2]) || 1;
		return toLL([m[0] / len, m[1] / len, m[2] / len]);
	}

	// ---- 描画 ----
	function syncSize() {
		const w = mapEl.clientWidth, h = mapEl.clientHeight;
		if (w !== cw || h !== ch) { cw = w; ch = h; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + "px"; canvas.style.height = h + "px"; }
	}
	function strokeArc(pr, a, b) {   // 大圏弧を投影して描く（裏半球へ回る点で線を切る）
		const pts = gcPoints(a, b);
		ctx.beginPath(); let pen = false;
		for (const p of pts) {
			const [x, y, front] = pr(p[0], p[1]);
			if (front < 0) { pen = false; continue; }
			pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
		}
		ctx.stroke();
	}
	function dot(pr, ll, r) {
		const [x, y, front] = pr(ll[0], ll[1]); if (front < 0) return;
		ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = DOT; ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = W; ctx.stroke();
	}
	function textAt(pr, ll, text, dy) {   // 白文字＋黒影（ortho-map と同じ体裁）
		const [x, y, front] = pr(ll[0], ll[1]); if (front < 0) return;
		ctx.fillText(text, x, y + dy);
	}

	function draw() {
		syncSize();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
		if (!active) { lastTotal = lastArea = 0; return readout(""); }
		if (!verts.length) { lastTotal = lastArea = 0; return readout(hint()); }
		const pr = makeProjector();

		// 表示点列 pp を組む：確定前はカーソルを仮頂点に。閉じる（塗り/面積/閉じ辺）のは
		// 確定後の3頂点以上、または描画中にカーソルがあり合計3点以上（＝「ここで閉じたら」のプレビュー）＝ortho-map と同じ。
		let pp = verts.slice();
		if (!finished && cursorLL) pp.push(cursorLL);
		const closed = finished ? verts.length >= 3 : (!!cursorLL && pp.length >= 3);
		if (closed) pp = pp.concat([pp[0]]);

		// 面積の塗り（閉じている時）：境界は辺と同じ大圏弧に沿わせる＝弦で結ぶと弧との隙間が白帯になる
		// （大領域ほど顕著＝辺の弧が膨らみ塗りの直線境界が内側に残る）。gcPoints で各辺を細分し、共有端点は重複させない。
		if (closed) {
			ctx.fillStyle = FILL; ctx.beginPath(); let pen = false;
			for (let i = 0; i + 1 < pp.length; i++) {
				const arc = gcPoints(pp[i], pp[i + 1]);
				for (let k = i === 0 ? 0 : 1; k < arc.length; k++) {   // 2辺目以降は先頭（前辺の終点）を飛ばす
					const [x, y, f] = pr(arc[k][0], arc[k][1]);
					if (f < 0) { pen = false; continue; }
					pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
				}
			}
			ctx.closePath(); ctx.fill();
		}
		// 辺（大圏弧・実線）
		ctx.strokeStyle = LINE; ctx.lineWidth = W; ctx.lineJoin = "round"; ctx.lineCap = "round";
		for (let i = 0; i + 1 < pp.length; i++) strokeArc(pr, pp[i], pp[i + 1]);

		// ラベル体裁（白＋黒影・中央）
		ctx.font = `12px ${font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
		ctx.shadowColor = "#000"; ctx.shadowBlur = 5; ctx.fillStyle = "#fff";
		// 各辺の区間距離を中点に／総距離を積む
		let total = 0;
		for (let i = 0; i + 1 < pp.length; i++) {
			const d = dist(pp[i], pp[i + 1]); total += d;
			textAt(pr, midGc(pp[i], pp[i + 1]), fmtDist(d), 0);
		}
		lastTotal = total; lastArea = 0;
		// 重心に L=総距離 / S=面積（閉じている時）
		if (closed) {
			const ring = pp.slice(0, -1), c = centroid(ring);
			lastArea = areaOf(ring);
			textAt(pr, c, "L= " + fmtDist(total), -8);
			textAt(pr, c, "S= " + fmtArea(lastArea), 8);
		}
		ctx.shadowBlur = 0;

		// 点（頂点r=4のみ）。※v1の中点r=2は辺途中に頂点を挿す編集ハンドル＝編集なしの本実装では出さない
		for (const v of pp) dot(pr, v, R_VERT);

		readout(hint());
	}
	// 重心＝頂点の単位ベクトル平均を正規化して経緯度へ戻す。経緯度の単純平均は極付近（経度が意味を失う）や
	// 子午線跨ぎ（経度平均が破綻）でラベルが飛ぶ＝北極跨ぎで実測。3Dなら極も子午線も透過。
	function centroid(ring) {
		let x = 0, y = 0, z = 0;
		for (const p of ring) { const v = to3(p[0], p[1]); x += v[0]; y += v[1]; z += v[2]; }
		const len = Math.hypot(x, y, z);
		return len < 1e-9 ? ring[0] : toLL([x / len, y / len, z / len]);   // 対蹠相殺で原点化した時は先頭頂点へ
	}
	function hint() {
		if (!verts.length) return `<span class="mr-hint">${t("クリックで計測を開始")}</span>`;
		return finished ? `<span class="mr-hint">${t("Escで消去・ボタンで終了")}</span>` : `<span class="mr-hint">${t("クリックで頂点・ダブルクリックで確定")}</span>`;
	}
	function readout(html) { out.innerHTML = html; out.style.display = html ? "block" : "none"; }
}

// ---- 表示整形（ortho-map の FIX/FIXA に合わせる）----
function comma(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtDist(m) {   // m入力：<100m=小数1m ／ <1km=整数m ／ <10km=小数2km ／ <100km=小数1km ／ 以上=整数km
	const km = m / 1000, c = (v, n) => comma(v.toFixed(n));
	return km < 0.1 ? c(m, 1) + " m" : km < 1 ? c(Math.round(m), 0) + " m" : km < 10 ? c(km, 2) + " km" : km < 100 ? c(km, 1) + " km" : c(km, 0) + " km";
}
function fmtArea(m2) {   // <1e6=整数m² ／ <1e9=小数3km² ／ 以上=整数km²
	const c = (v, n) => comma((+v).toFixed(n));
	return m2 < 1e6 ? c(Math.round(m2), 0) + " m²" : m2 < 1e9 ? c(m2 / 1e6, 3) + " km²" : c(m2 / 1e6, 0) + " km²";
}
