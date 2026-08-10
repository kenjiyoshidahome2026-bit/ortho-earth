// 太陽系エフェメリス（ortho-solar 自蔵版）。母体は apps/ortho-japan/planets.js（proven organ＝
// 2026-08-12 皆既日食で月理論を検証済み）。ここでは地心 RA/Dec でなく**日心黄道 XYZ（J2000, AU）**を
// 直接返す＝3D シーンの世界座標そのもの。追加点：天王星・海王星の軌道要素、IAU 自転モデル（極+W）、
// 物理定数（半径・周期）。精度は JPL 近似軌道要素（Standish）の有効期間 1800–2050AD・分角オーダー。
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const EPS = 23.43928 * D2R;          // 黄道傾斜（J2000）
export const AU_KM = 149597870.7;
export const LIGHT_MIN_PER_AU = 8.3167;     // 1AU の光行時間（分）
const E_RADII_AU = 6378.14 / AU_KM;         // Schlyter 月理論の距離単位（地球赤道半径）→AU

// [a(au), e, I(deg), L(deg), ϖ(deg), Ω(deg)] と 1ユリウス世紀あたりの変化率（同順）＝JPL 1800–2050AD 表
const EL = {
	mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
		[0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
	venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
		[0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
	earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
		[0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
	mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
		[0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
	jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
		[-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
	saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
		[-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
	uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
		[-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
	neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
		[0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
	pluto: [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
		[-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]],
};

// 天体カタログ（描画順もこの順）。rot＝IAU 自転モデル：極(α,δ 赤道J2000, 世紀あたり raT/decT)と
// 本初子午線 W = W0 + Wd·d（deg, d=J2000からの日数）。負の Wd＝逆行自転（金星・天王星）。
// 微小振動項（海王星の sinN 等）は省略＝可視化には効かない。color＝軌道線・極小表示時の点の色。
export const BODIES = [
	{ id: "sun", name: "Sun", tex: "2k_sun.jpg", radiusKm: 695700, color: [1.0, 0.83, 0.55], emissive: true,
		rot: { ra: 286.13, dec: 63.87, W0: 84.176, Wd: 14.1844 } },
	{ id: "mercury", name: "Mercury", tex: "2k_mercury.jpg", radiusKm: 2439.7, color: [0.72, 0.68, 0.63],
		rot: { ra: 281.0103, dec: 61.4155, W0: 329.5988, Wd: 6.1385108 } },
	{ id: "venus", name: "Venus", tex: "2k_venus_atmosphere.jpg", radiusKm: 6051.8, color: [0.91, 0.86, 0.75],
		rot: { ra: 272.76, dec: 67.16, W0: 160.20, Wd: -1.4813688 } },
	{ id: "earth", name: "Earth", tex: "2k_earth_daymap.jpg", radiusKm: 6371.0, color: [0.42, 0.58, 0.84],
		rot: { ra: 0.0, dec: 90.0, raT: -0.641, decT: -0.557, W0: 190.147, Wd: 360.9856235 } },
	{ id: "moon", name: "Moon", tex: "2k_moon.jpg", radiusKm: 1737.4, color: [0.78, 0.78, 0.78],
		rot: { ra: 266.86, dec: 65.64, W0: 38.3213, Wd: 13.17635815 } },
	{ id: "mars", name: "Mars", tex: "2k_mars.jpg", radiusKm: 3389.5, color: [0.88, 0.48, 0.31],
		rot: { ra: 317.681, dec: 52.887, raT: -0.106, decT: -0.061, W0: 176.630, Wd: 350.89198226 } },
	{ id: "jupiter", name: "Jupiter", tex: "2k_jupiter.jpg", radiusKm: 69911, color: [0.85, 0.73, 0.60],
		rot: { ra: 268.056595, dec: 64.495303, W0: 284.95, Wd: 870.536 } },
	{ id: "saturn", name: "Saturn", tex: "2k_saturn.jpg", radiusKm: 58232, color: [0.90, 0.84, 0.65],
		rot: { ra: 40.589, dec: 83.537, W0: 38.90, Wd: 810.7939024 },
		ring: { tex: "2k_saturn_ring_alpha.png", inner: 1.239, outer: 2.330 } },   // C環内縁~74,658km / A環外縁~136,775km（半径比）
	{ id: "uranus", name: "Uranus", tex: "2k_uranus.jpg", radiusKm: 25362, color: [0.66, 0.85, 0.87],
		rot: { ra: 257.311, dec: -15.175, W0: 203.81, Wd: -501.1600928 } },
	{ id: "neptune", name: "Neptune", tex: "2k_neptune.jpg", radiusKm: 24622, color: [0.36, 0.50, 0.88],
		rot: { ra: 299.36, dec: 43.46, W0: 249.978, Wd: 541.1397757 } },
	// 2006年に惑星の座は降りたが JPL の軌道要素表には現役＝仲間はずれにしない。傾斜17°・海王星の内側に
	// 入り込む離心軌道は「軌道は円じゃない」の一番の教材。表面＝New Horizons 実写（NASA/JHUAPL/SwRI, PD）
	{ id: "pluto", name: "Pluto", note: "Dwarf planet", tex: "2k_pluto.jpg", radiusKm: 1188.3, color: [0.78, 0.65, 0.53],
		rot: { ra: 132.993, dec: -6.163, W0: 302.695, Wd: 56.3625225 } },
];
export const byId = Object.fromEntries(BODIES.map(b => [b.id, b]));
for (const b of BODIES) {
	b.radiusAU = b.radiusKm / AU_KM;
	// 公転周期（日）：惑星＝ケプラー第三法則、月＝恒星月。自転周期（時間）＝360/|Wd|·24
	b.periodDays = EL[b.id] ? 365.256898 * Math.pow(EL[b.id][0][0], 1.5) : (b.id === "moon" ? 27.321661 : 0);
	b.rotHours = b.rot ? Math.abs(360 / b.rot.Wd) * 24 : 0;
}

// ---- 時刻変換 ----
export const jd = date => date.getTime() / 864e5 + 2440587.5;
export const jcT = date => (jd(date) - 2451545.0) / 36525;   // J2000からのユリウス世紀

// ---- ケプラー機械（planets.js と同式） ----
function elements(id, T) {
	const [e0, dr] = EL[id];
	return { a: e0[0] + dr[0] * T, e: e0[1] + dr[1] * T, I: (e0[2] + dr[2] * T) * D2R,
		L: e0[3] + dr[3] * T, w1: e0[4] + dr[4] * T, Om: (e0[5] + dr[5] * T) * D2R };
}
function solveE(M, e) {   // ケプラー方程式（ニュートン反復）。M=rad
	let E = M + e * Math.sin(M);
	for (let i = 0; i < 8; i++) { const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-9) break; }
	return E;
}
function fromE(el, E) {   // 離心近点角→日心黄道XYZ（軌道面→3回転）
	const { a, e, I, w1, Om } = el;
	const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
	const w = w1 * D2R - Om;
	const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
	return [
		(cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
		(cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
		(sw * sI) * xp + (cw * sI) * yp,
	];
}
function helio(id, T) {
	const el = elements(id, T);
	const M = (((el.L - el.w1) % 360 + 540) % 360 - 180) * D2R;
	return fromE(el, solveE(M, el.e));
}

// 月の地心黄道XYZ（AU）：Schlyter 低精度月理論（主要摂動12+5項・誤差<0.3°＝月の視直径以下）。
// planets.js の moonPosition と同じ級数＝RA/Dec化の手前で止めて XYZ を返す。黄道は「日付の黄道」だが
// J2000黄道との差（歳差~0.4°/世紀）は可視化には効かない。
export function moonGeo(date) {
	const d = jd(date) - 2451543.5;   // Schlyter epoch (2000-01-00.0 TDT)
	const rev = x => ((x % 360) + 360) % 360;
	const N = rev(125.1228 - 0.0529538083 * d), inc = 5.1454 * D2R;
	const w = rev(318.0634 + 0.1643573223 * d);
	const a = 60.2666, e = 0.054900;   // 地球赤道半径単位
	const M = rev(115.3654 + 13.0649929509 * d);
	let E = M * D2R + e * Math.sin(M * D2R) * (1 + e * Math.cos(M * D2R));
	for (let k = 0; k < 8; k++) { const dE = (E - e * Math.sin(E) - M * D2R) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-9) break; }
	const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
	const v = Math.atan2(yv, xv), r0 = Math.hypot(xv, yv);
	const Nr = N * D2R, u = v + w * D2R;
	const xh = r0 * (Math.cos(Nr) * Math.cos(u) - Math.sin(Nr) * Math.sin(u) * Math.cos(inc));
	const yh = r0 * (Math.sin(Nr) * Math.cos(u) + Math.cos(Nr) * Math.sin(u) * Math.cos(inc));
	const zh = r0 * Math.sin(u) * Math.sin(inc);
	let lon = Math.atan2(yh, xh) * R2D, lat = Math.asin(zh / r0) * R2D, r = r0;
	const ws = rev(282.9404 + 4.70935e-5 * d), Ms = rev(356.0470 + 0.9856002585 * d);
	const Ls = rev(Ms + ws), Lm = rev(N + w + M), D = rev(Lm - Ls), F = rev(Lm - N);
	const S = x => Math.sin(x * D2R), C = x => Math.cos(x * D2R);
	lon += -1.274 * S(M - 2 * D) + 0.658 * S(2 * D) - 0.186 * S(Ms) - 0.059 * S(2 * M - 2 * D)
		- 0.057 * S(M - 2 * D + Ms) + 0.053 * S(M + 2 * D) + 0.046 * S(2 * D - Ms) + 0.041 * S(M - Ms)
		- 0.035 * S(D) - 0.031 * S(M + Ms) - 0.015 * S(2 * F - 2 * D) + 0.011 * S(M - 4 * D);
	lat += -0.173 * S(F - 2 * D) - 0.055 * S(M - F - 2 * D) - 0.046 * S(M + F - 2 * D)
		+ 0.033 * S(F + 2 * D) + 0.017 * S(2 * M + F);
	r += -0.58 * C(M - 2 * D) - 0.46 * C(2 * D);
	const cl = Math.cos(lat * D2R), s = r * E_RADII_AU;
	return [cl * Math.cos(lon * D2R) * s, cl * Math.sin(lon * D2R) * s, Math.sin(lat * D2R) * s];
}

// 天体の日心黄道位置（AU）。太陽＝原点、月＝地球+地心月
export function bodyPos(id, date) {
	if (id === "sun") return [0, 0, 0];
	if (id === "moon") {
		const e = helio("earth", jcT(date)), m = moonGeo(date);
		return [e[0] + m[0], e[1] + m[1], e[2] + m[2]];
	}
	return helio(id, jcT(date));
}

// 軌道線の頂点列：離心近点角を一周サンプル（純楕円＝要素は epoch T で凍結）。Float32Array(n*3)
// phase＝標本の起点（rad）。既定0＝近日点起点。
export function orbitPoints(id, T, n = 512, phase = 0) {
	const el = elements(id, T), out = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const p = fromE(el, phase + i / n * 2 * Math.PI);
		out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
	}
	return out;
}
// 「天体がいま居る点」を頂点に含む軌道線：現在の離心近点角を起点に一周サンプル。
// 折れ線の弦は真の楕円より内側を通る（192点で最大~3地球半径）＝カメラが軌道上の天体の傍に居ると
// 「自分が自分の軌道から浮いて見える」。起点を天体自身に切れば、天体は常に折れ線の頂点＝ズレゼロ。
export function orbitPointsThrough(id, date, n = 512) {
	const T = jcT(date), el = elements(id, T);
	const M = (((el.L - el.w1) % 360 + 540) % 360 - 180) * D2R;
	return orbitPoints(id, T, n, solveE(M, el.e));
}
// 月の軌道線：恒星月一周を時間サンプル（摂動込みの実形状）。中心＝渡された時刻の地球。
// 摂動（出没差＝引数が朔望月周期）で1恒星月後は同点に戻らない＝この曲線は本当は閉じない。
// 継ぎ目のカクつきを月の真横に置かないため「今を中心に±半月」でサンプル＝継ぎ目は月の対極（遠側）、
// 閉じ誤差（半径の数%）は末尾15%の弧へ線形に配って馴染ませる＝月の居る側の弧は生の摂動軌道のまま。
export function moonOrbitPoints(date, n = 128) {
	const e = helio("earth", jcT(date)), out = new Float32Array(n * 3);
	const t0 = date.getTime(), P = 27.321661 * 864e5;
	const raw = [];
	for (let i = 0; i < n; i++) {
		const m = moonGeo(new Date(t0 - P / 2 + i / n * P));
		raw.push([e[0] + m[0], e[1] + m[1], e[2] + m[2]]);
	}
	const B = Math.max(2, Math.round(n * 0.15));
	const gap = [raw[0][0] - raw[n - 1][0], raw[0][1] - raw[n - 1][1], raw[0][2] - raw[n - 1][2]];
	for (let k = 1; k <= B; k++) {
		const i = n - 1 - B + k, w = k / B;
		raw[i][0] += gap[0] * w; raw[i][1] += gap[1] * w; raw[i][2] += gap[2] * w;   // 末尾＝先頭と同点→LOOPの閉じ辺は零長
	}
	for (let i = 0; i < n; i++) { out[i * 3] = raw[i][0]; out[i * 3 + 1] = raw[i][1]; out[i * 3 + 2] = raw[i][2]; }
	return out;
}

// ---- IAU 自転：体固定→世界（黄道J2000）の 3×3 回転 ----
// v_eq = Rz(90°+α)·Rx(90°−δ)·Rz(W)·v_body（WGCCRE 標準）→ 黄道へ Rx(−ε)。体座標系＝z:北極, +x:本初子午線
const mul3 = (A, B) => {   // 3×3 行列積（行優先 [r][c]）
	const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
	return C;
};
const Rx = t => { const c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const Rz = t => { const c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
export function orientation(id, date) {
	const { rot } = byId[id];
	const T = jcT(date), d = jd(date) - 2451545.0;
	const ra = (rot.ra + (rot.raT || 0) * T) * D2R, dec = (rot.dec + (rot.decT || 0) * T) * D2R;
	const W = (rot.W0 + rot.Wd * d) * D2R;
	return mul3(Rx(-EPS), mul3(Rz(ra + Math.PI / 2), mul3(Rx(Math.PI / 2 - dec), Rz(W))));
}

// 赤道J2000 RA/Dec（deg）→黄道J2000 単位ベクトル（恒星の焼き込み用）
export function eqToEcl(raDeg, decDeg) {
	const ra = raDeg * D2R, dec = decDeg * D2R, cd = Math.cos(dec);
	const x = cd * Math.cos(ra), yq = cd * Math.sin(ra), zq = Math.sin(dec);
	return [x, yq * Math.cos(EPS) + zq * Math.sin(EPS), -yq * Math.sin(EPS) + zq * Math.cos(EPS)];
}
