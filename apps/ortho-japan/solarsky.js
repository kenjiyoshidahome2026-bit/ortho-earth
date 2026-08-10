// 太陽系圏（z<1）：星空劇場のさらに外。256pxの梯子（z0=世界256px）をそのまま負へ延長し、
// ズームアウトの続きで太陽系が実スケールで現れる（別URLの ortho-solar と対＝あちらは時間機械つきの劇場）。
// 設計の芯：
//  - カメラは engine と同じ cameraState（純関数）を import＝mvp を共有＝星空・地球と寸分違わぬ整合
//  - 世界系＝engine と同じ「地球固定・単位球（1=地球半径）・y=北極」。天体は 黄道→赤道→GMST回転 で持ち込む
//    （STARS_VS が星にかけている回転と同式＝実時刻の空に惑星が正しく乗る）
//  - この深度では木星すら1px未満＝描くのは点・線・文字だけ＝Canvas2D で足りる（GL不要・依存ゼロ）
//  - 地球は engine の球がそのまま主役。約3px を切る z≈-4.8 からこちらの点表示が代打に立つ
//  - 実時刻のみ（星空劇場と同じ正直さ）。時間を巻きたければ左上の The Solar System から ortho-solar へ
import { cameraState } from "ortho-core";
import { BODIES, byId, bodyPos, moonGeo, orbitPointsThrough, jcT, EPS, AU_KM } from "ephem";

const KM_PER_UNIT = 6371;                    // engine 単位球＝地球半径
const AU_UNIT = AU_KM / KM_PER_UNIT;         // 1AU＝約23481単位
const NAMES_JA = { sun: "太陽", mercury: "水星", venus: "金星", earth: "地球", moon: "月",
	mars: "火星", jupiter: "木星", saturn: "土星", uranus: "天王星", neptune: "海王星", pluto: "冥王星" };
const cE = Math.cos(EPS), sE = Math.sin(EPS);

// 黄道XYZ(AU)→engine地球固定XYZ(単位球)。gmst=(cos,sin)。
// 手順：黄道→赤道（planets.js toRaDec と同式）→engine軸並べ替え（y=北極）→GMST回転（STARS_VS と同式）
function eclToWorld(p, cg, sg) {
	const yq = p[1] * cE - p[2] * sE, zq = p[1] * sE + p[2] * cE;
	const x = p[0] * AU_UNIT, y = zq * AU_UNIT, z = yq * AU_UNIT;
	return [x * cg + z * sg, y, z * cg - x * sg];
}

export function createSolarSky({ mapEl }) {
	const cv = document.createElement("canvas");
	cv.id = "solar-sky";
	cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
	const engineCv = mapEl.querySelector("canvas");   // engine 球の直上・ラベル/家具の下
	engineCv ? engineCv.insertAdjacentElement("afterend", cv) : mapEl.prepend(cv);
	const ctx = cv.getContext("2d");
	const orbitCache = {};   // id → { t, pts:[[x,y,z]…黄道AU・日心] }
	let moonCache = null, moonCacheT = -1;

	function orbitOf(id, now) {
		// 標本起点＝天体の現在位置（orbitPointsThrough）＝天体は常に折れ線の頂点＝「軌道から浮く」誤差ゼロ。
		// 起点は天体と一緒に動く＝1時間で焼き直し（地球で0.04°＝弦のたるみはサブピクセルに留まる。192点評価＝軽い）
		const o = orbitCache[id];
		if (o && Math.abs(now - o.t) < 36e5) return o.pts;
		const f = orbitPointsThrough(id, new Date(now), 192), pts = [];
		for (let i = 0; i < 192; i++) pts.push([f[i * 3], f[i * 3 + 1], f[i * 3 + 2]]);
		orbitCache[id] = { t: now, pts };
		return pts;
	}
	function moonOrbitGeo(now) {   // 地心黄道AUの1恒星月（±半月＝継ぎ目は月の対極。ortho-solar の裁きと同じ）
		if (moonCache && Math.abs(now - moonCacheT) < 216e5) return moonCache;
		const P = 27.321661 * 864e5, n = 96, raw = [];
		for (let i = 0; i < n; i++) raw.push(moonGeo(new Date(now - P / 2 + i / n * P)));
		const B = Math.round(n * 0.15), g = [raw[0][0] - raw[n - 1][0], raw[0][1] - raw[n - 1][1], raw[0][2] - raw[n - 1][2]];
		for (let k = 1; k <= B; k++) { const i = n - 1 - B + k, w = k / B; raw[i][0] += g[0] * w; raw[i][1] += g[1] * w; raw[i][2] += g[2] * w; }
		moonCache = raw; moonCacheT = now;
		return raw;
	}

	// 世界→デバイスpx。mvp は f64 のまま CPU で回す（点数百個＝軽い）。戻り null＝背面
	function proj(st, w) {
		const m = st.mvp;
		const cw = m[3] * w[0] + m[7] * w[1] + m[11] * w[2] + m[15];
		if (cw <= 1e-9) return null;
		const cx = m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12];
		const cy = m[1] * w[0] + m[5] * w[1] + m[9] * w[2] + m[13];
		return { x: (cx / cw * 0.5 + 0.5) * st.W, y: (1 - (cy / cw * 0.5 + 0.5)) * st.H, w: cw };
	}
	// 閉じた世界折れ線をニアクリップつきで stroke。点単位の背面捨てだと「片端だけ背面」の区間ごと消え、
	// カメラ直近を通る線（＝地球自身の公転軌道！）が画面を横切る肝心の一筆を失う。clip座標は世界に線形＝
	// w=ε 平面との交点は線形補間で厳密（交点の投影は画面外遠方に飛ぶ＝canvas が正しく切る）
	function strokeWorldLoop(st, pts) {
		const m = st.mvp, eps = st.camDist * 0.02, n = pts.length, C = new Array(n);
		for (let i = 0; i < n; i++) {
			const w = pts[i];
			C[i] = [m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12],
				m[1] * w[0] + m[5] * w[1] + m[9] * w[2] + m[13],
				m[3] * w[0] + m[7] * w[1] + m[11] * w[2] + m[15]];
		}
		const S = c => [(c[0] / c[2] * 0.5 + 0.5) * st.W, (1 - (c[1] / c[2] * 0.5 + 0.5)) * st.H];
		ctx.beginPath();
		let pen = false;
		for (let i = 0; i < n; i++) {
			let a = C[i], b = C[(i + 1) % n];
			const fa = a[2] > eps, fb = b[2] > eps;
			if (!fa && !fb) { pen = false; continue; }
			if (!fa || !fb) {
				const t = (a[2] - eps) / (a[2] - b[2]);
				const c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, eps];
				fa ? b = c : a = c;
			}
			const A = S(a), B = S(b);
			if (!pen || !fa) ctx.moveTo(A[0], A[1]);
			ctx.lineTo(B[0], B[1]);
			pen = fb;
		}
		ctx.stroke();
	}

	function frame(cam, W, H, active) {
		if (!active) { if (cv.style.display !== "none") { cv.style.display = "none"; } return; }
		if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
		cv.style.display = "";
		const fade = Math.max(0, Math.min(1, (1 - cam.zoom) / 0.5));   // z1→z0.5 で出現（星空劇場の作法）
		ctx.clearRect(0, 0, W, H);
		if (!fade) return;
		const now = Date.now(), date = new Date(now);
		const gmst = (((18.697374 + 24.0657098 * (now / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360) * Math.PI / 180;   // engine renderer と同式
		const cg = Math.cos(gmst), sg = Math.sin(gmst);
		const st = cameraState(cam, W, H); st.W = W; st.H = H;
		const dpr = cam.dpr || 1;
		const pE = bodyPos("earth", date);   // 日心黄道（AU）
		const geo = p => eclToWorld([p[0] - pE[0], p[1] - pE[1], p[2] - pE[2]], cg, sg);
		// 開帳の順序（本人裁定 2026-08-10）：まず自分の一本道（地球軌道）だけ。他の惑星の軌道は、
		// 地球の軌道が「円」として認識できる深さ（太陽が視野に入る頃＝1AUが画面高2.2倍→1.2倍）で開帳。
		// 肉眼惑星の点は常時（実際の夜空に見える光点＝正直）・望遠鏡級（天王星以遠）の点と名前は開帳と同時
		const auPx = AU_UNIT * st.focal / Math.max(st.camDist, 1e-9);
		const others = Math.max(0, Math.min(1, (2.2 * H - auPx) / H));
		const NAKED = { mercury: 1, venus: 1, mars: 1, jupiter: 1, saturn: 1 };

		// 1) 軌道線（日心楕円を地心へ平行移動＝地球の公転軌道は画面中心を貫く）。月軌道は寄っている時だけ
		ctx.lineWidth = Math.max(1, dpr);
		for (const b of BODIES) {
			if (b.id === "sun" || b.id === "moon") continue;
			const oa = (b.id === "earth" ? 1 : others) * 0.34 * fade;
			if (oa < 0.01) continue;
			ctx.strokeStyle = `rgba(${b.color.map(c => Math.round(c * 255)).join(",")},${oa})`;
			strokeWorldLoop(st, orbitOf(b.id, now).map(geo));
		}
		const moonR = 0.00257 * AU_UNIT;   // 月軌道の目安半径（単位球）
		const moonPx = moonR * st.focal / Math.max(st.camDist, 1e-9);
		if (moonPx > 14 && moonPx < H * 4) {
			ctx.strokeStyle = `rgba(200,200,200,${0.3 * fade})`;
			strokeWorldLoop(st, moonOrbitGeo(now).map(p => eclToWorld(p, cg, sg)));
		}

		// 2) 天体：太陽=グロー＋芯、惑星=最小px下駄つきの点。地球は engine 球が約3pxを切ってから代打
		const globePx = st.focal / Math.max(st.camDist, 1e-9);   // engine 地球の見かけ半径(device px)
		const labels = [];
		for (const b of BODIES) {
			const isEarth = b.id === "earth";
			// 点の点灯：太陽・地球・月・肉眼惑星=常時／望遠鏡級（天王星・海王星・冥王星）=軌道の開帳と同時
			const dotA = (isEarth || b.id === "sun" || b.id === "moon" || NAKED[b.id]) ? 1 : others;
			if (dotA < 0.02) continue;
			if (isEarth && globePx > 3) { const s = proj(st, [0, 0, 0]); if (s) labels.push({ s, b, r: globePx, a: 1 }); continue; }
			const pw = isEarth ? [0, 0, 0] : geo(bodyPos(b.id, date));
			const s = proj(st, pw);
			if (!s || s.x < -60 || s.x > W + 60 || s.y < -60 || s.y > H + 60) continue;
			const trueR = (b.radiusKm / KM_PER_UNIT) * st.focal / s.w;
			if (b.id === "sun") {
				const gr = Math.max(10 * dpr, trueR * 3);
				const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, gr);
				g.addColorStop(0, `rgba(255,225,170,${0.95 * fade})`);
				g.addColorStop(0.25, `rgba(255,200,120,${0.5 * fade})`);
				g.addColorStop(1, "rgba(255,190,110,0)");
				ctx.fillStyle = g;
				ctx.fillRect(s.x - gr, s.y - gr, gr * 2, gr * 2);
				ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(2.4 * dpr, trueR), 0, 7);
				ctx.fillStyle = `rgba(255,244,214,${fade})`; ctx.fill();
			} else {
				const r = Math.max((b.id === "moon" ? 1.0 : 1.3) * dpr, trueR);
				ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 7);
				ctx.fillStyle = `rgba(${b.color.map(c => Math.round(160 + c * 95)).join(",")},${0.95 * fade * dotA})`;
				ctx.fill();
			}
			// 名前：太陽・地球・月=常時／惑星は軌道の開帳と同時（近圏の空に名札を並べない＝実際の夜空の顔）
			labels.push({ s, b, r: Math.max(3 * dpr, trueR), a: (isEarth || b.id === "sun" || b.id === "moon") ? 1 : others });
		}

		// 3) 名前（星空家具の等幅・淡い星明かり色）。月は地球に埋まる間は無記名
		ctx.font = `${Math.round(11 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
		ctx.textBaseline = "middle";
		const placed = [];
		for (const L of labels) {
			if (L.a < 0.02) continue;
			if (L.b.id === "moon") {
				const e = labels.find(o => o.b.id === "earth");
				if (e && Math.hypot(e.s.x - L.s.x, e.s.y - L.s.y) < 12 * dpr) continue;
			}
			let x = L.s.x + L.r + 5 * dpr, y = L.s.y;
			for (let g = 0; g < 8 && placed.some(p => Math.abs(p.x - x) < 70 * dpr && Math.abs(p.y - y) < 13 * dpr); g++) y += 13 * dpr;
			placed.push({ x, y });
			ctx.fillStyle = `rgba(205,214,230,${0.85 * fade * L.a})`;
			ctx.fillText(NAMES_JA[L.b.id], x, y);
		}
	}
	return { frame };
}
