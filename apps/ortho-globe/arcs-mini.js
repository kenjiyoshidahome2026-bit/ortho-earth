// 弧の頁（arcs.html）の右下の小さなメルカトル図（本人 2026-10-12「右下に globe ではなく mercator の小さな地図を置き、表示されている領域・選択されている路線を表示すると違いがわかって面白い」）。
// 球の上で真っすぐな大円は、ここでは曲がって見える。等角航路はここで真っすぐ＝同じ 2 点の 2 本の道の違いが一目で分かる。
// 描くもの：陸（NE admin_0 50m＝エンジンが読むのと同じ geopbf・同じキャッシュ）・地球儀に今見えている所（画面の格子を逆投影して塗る）・頁が渡す線。
// 中心の経度は地球儀の中心に合わせて回す（見えている所が図の端で割れない）。緯度は ±80°まで。canvas 2D・依存は arcs-data.js だけ。
import { mercY, wrap180 } from "./arcs-data.js";

const LAT_MAX = 80, Y_MAX = mercY(LAT_MAX);
const GX = 36, GY = 24;   // 見えている所の格子（画面を GX×GY に割って逆投影）

export function createMini(map, { host, label = "Mercator", hideLabel = "Hide map", showLabel = "Show map" } = {}) {
	const el = document.createElement("div");
	el.className = "arcs-mini";
	el.innerHTML = `<canvas></canvas><span class="cap"></span><button type="button" class="tog" aria-expanded="true">−</button>`;
	(host || map.mapEl).appendChild(el);
	const cv = el.querySelector("canvas"), ctx = cv.getContext("2d"), cap = el.querySelector(".cap"), tog = el.querySelector(".tog");
	cap.textContent = label;
	const setOpen = on => { el.classList.toggle("min", !on); tog.textContent = on ? "−" : "＋"; tog.setAttribute("aria-expanded", on); tog.setAttribute("aria-label", on ? hideLabel : showLabel); if (on) draw(); };
	tog.addEventListener("click", () => setOpen(el.classList.contains("min")));

	let W = 0, H = 0, dpr = 1, land = null, landStrip = null, lines = [], marks = [], foot = null, footKey = "", centerLon = 0;
	const xOf = lon => (wrap180(lon - centerLon) / 360 + 0.5) * W;           // 図の中の x（中心の経度が真ん中）
	const yOf = lat => (1 - (mercY(Math.max(-LAT_MAX, Math.min(LAT_MAX, lat))) + Y_MAX) / (2 * Y_MAX)) * H;
	const resize = () => {
		const w = Math.round(el.clientWidth) || 240;
		dpr = Math.min(2, devicePixelRatio || 1);
		W = w; H = Math.round(w * (2 * Y_MAX) / (2 * Math.PI));
		cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px";
		landStrip = null; footKey = "";
	};
	// 陸を 360° 幅の帯に一度だけ焼く（経度 −180..180 が x 0..W）＝毎回は位置をずらして 2 回貼るだけ
	const bakeLand = () => {
		if (!land || !W) return;
		const c = document.createElement("canvas"); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
		const g = c.getContext("2d"); g.scale(dpr, dpr); g.fillStyle = "#3a4560";
		const X = lon => (lon + 180) / 360 * W;
		g.beginPath();
		for (const ring of land) { ring.forEach((p, i) => i ? g.lineTo(X(p[0]), yOf(p[1])) : g.moveTo(X(p[0]), yOf(p[1]))); g.closePath(); }
		g.fill("evenodd");
		landStrip = c;
	};
	// 地球儀に今見えている所。引いている時＝経緯度の格子（STEP 度）の升の中心を投影し、手前の半球で画面の中にある升を塗る。
	// 寄っている時（当たる升が少ない）＝画面の格子を逆投影し、4 隅が全部地球に当たる升をメルカトルの四辺形にして塗る
	const STEP = 3;
	const footprint = () => {
		const mw = map.mapEl.clientWidth, mh = map.mapEl.clientHeight, prj = map.makeProjector(), cells = [];
		for (let lat = -LAT_MAX; lat < LAT_MAX; lat += STEP) for (let lon = -180; lon < 180; lon += STEP) {
			const p = prj(lon + STEP / 2, lat + STEP / 2);
			if (p[2] > 0 && p[0] >= 0 && p[1] >= 0 && p[0] <= mw && p[1] <= mh) cells.push(lon, lat);
		}
		if (cells.length >= 12) return { cells };
		const ll = new Array((GX + 1) * (GY + 1));
		for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) { const p = map.unproject([i / GX * mw, j / GY * mh]); ll[j * (GX + 1) + i] = p ? [p.lng, p.lat] : null; }
		return { ll };
	};
	const drawFoot = (g, F) => {
		if (F.cells) {
			const c = F.cells, w = STEP / 360 * W + 0.6;
			for (let k = 0; k < c.length; k += 2) { const y0 = yOf(c[k + 1] + STEP), y1 = yOf(c[k + 1]); g.fillRect(xOf(c[k]) - 0.3, y0 - 0.3, w, y1 - y0 + 0.6); }
			return;
		}
		const ll = F.ll;
		const quad = (a, b, c, d) => {
			const base = a[0], pts = [a, b, c, d].map(p => [base + wrap180(p[0] - base), p[1]]);   // 升の中は連続に（日付変更線）
			for (const off of [-360, 0, 360]) {
				g.beginPath();
				pts.forEach((p, k) => { const x = (wrap180(pts[0][0] - centerLon) + (p[0] - pts[0][0]) + off) / 360 * W + W / 2, y = yOf(p[1]); k ? g.lineTo(x, y) : g.moveTo(x, y); });
				g.closePath(); g.fill(); g.stroke();
			}
		};
		for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
			const a = ll[j * (GX + 1) + i], b = ll[j * (GX + 1) + i + 1], c = ll[(j + 1) * (GX + 1) + i + 1], d = ll[(j + 1) * (GX + 1) + i];
			if (a && b && c && d) quad(a, b, c, d);
		}
	};
	const footCanvas = document.createElement("canvas");
	const draw = () => {
		if (el.classList.contains("min")) return;
		if (!W || el.clientWidth !== W) resize();
		if (!landStrip) bakeLand();
		const c = map.getCenter(); centerLon = c.lng;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = "#0e1526"; ctx.fillRect(0, 0, W, H);
		// 経緯線（30° ごと）
		ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.lineWidth = 1; ctx.beginPath();
		for (let lat = -60; lat <= 60; lat += 30) { const y = Math.round(yOf(lat)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
		for (let lon = -180; lon < 180; lon += 30) { const x = Math.round(xOf(lon)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
		ctx.stroke();
		if (landStrip) { const x0 = W / 2 - (centerLon + 180) / 360 * W; for (const o of [-W, 0, W]) ctx.drawImage(landStrip, x0 + o, 0, W, H); }
		// 見えている所（重なりで濃くならないよう、別の canvas に不透明で塗ってから薄く重ねる）
		if (foot) {
			footCanvas.width = cv.width; footCanvas.height = cv.height;
			const g = footCanvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = "#fff"; g.strokeStyle = "#fff"; g.lineWidth = 0.6; g.lineJoin = "round";
			drawFoot(g, foot);
			ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.22; ctx.drawImage(footCanvas, 0, 0); ctx.restore();
		}
		// 線（頁が渡す）＝経度は連続の点列。図の中心に寄せてから −W/0/+W の 3 回描く（日付変更線を跨いでも途切れない）
		ctx.lineCap = "round"; ctx.lineJoin = "round";
		for (const L of lines) {
			if (!L.pts?.length) continue;
			const shift = wrap180(L.pts[0][0] - centerLon) - (L.pts[0][0] - centerLon);
			ctx.strokeStyle = L.color; ctx.globalAlpha = L.alpha ?? 1; ctx.lineWidth = L.width ?? 1.5;
			if (L.dash) ctx.setLineDash(L.dash); else ctx.setLineDash([]);
			for (const o of [-W, 0, W]) {
				ctx.beginPath();
				L.pts.forEach((p, k) => { const x = (p[0] - centerLon + shift) / 360 * W + W / 2 + o, y = yOf(p[1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
				ctx.stroke();
			}
		}
		ctx.setLineDash([]); ctx.globalAlpha = 1;
		for (const m of marks) { ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(xOf(m.pos[0]), yOf(m.pos[1]), m.r ?? 3, 0, 2 * Math.PI); ctx.fill(); }
		ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
	};
	// 視点が動いた時だけ（間引き 80ms）
	let tm = 0, pend = false;
	const schedule = () => {
		if (pend) return; pend = true;
		const go = () => {
			pend = false; tm = performance.now();
			const cm = map.cam, key = cm ? `${cm.center[0].toFixed(3)},${cm.center[1].toFixed(3)},${cm.zoom.toFixed(3)},${(cm.bearing || 0).toFixed(1)},${(cm.pitch || 0).toFixed(1)},${map.mapEl.clientWidth}x${map.mapEl.clientHeight}` : "";
			if (key !== footKey) { footKey = key; foot = footprint(); draw(); }
		};
		const wait = Math.max(0, 80 - (performance.now() - tm));
		wait ? setTimeout(go, wait) : requestAnimationFrame(go);
	};
	setOpen(!matchMedia("(max-height:700px) and (min-width:641px)").matches);   // 背の低い画面＝案内板と重なる＝最初は畳む
	const offFrame = map.onFrame(schedule);
	const ro = new ResizeObserver(() => { footKey = ""; schedule(); }); ro.observe(el);
	schedule();
	return {
		el,
		/** 陸の環（[[lon, lat], …] の配列） */
		setLand(rings) { land = rings; landStrip = null; draw(); },
		/** 線 [{ pts: [[lon, lat], …]（経度は連続）, color, width, alpha, dash }] と点 [{ pos, color, r }] */
		setLines(ls, ms = []) { lines = ls || []; marks = ms || []; draw(); },
		setOpen,
		destroy() { offFrame(); ro.disconnect(); el.remove(); },
	};
}
