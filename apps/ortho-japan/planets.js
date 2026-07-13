// 惑星の地心位置（低精度ケプラー近似）：JPL 近似軌道要素（Standish, 有効期間 1800–2050AD）から
// 肉眼惑星5つの RA/Dec と概算等級を計算する。精度は分（arcmin）オーダー＝点径数px の表示用途には十分。
// 太陽方向は地球要素の反転で同じ機械から出る＝renderer の夜面（nightJSON式）と突合できる（検証済み）。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const EPS = 23.43928 * D2R;   // 黄道傾斜（J2000）

// [a(au), e, I(deg), L(deg), ϖ(deg), Ω(deg)] と 1ユリウス世紀あたりの変化率（同順）
const EL = {
	水星: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
		[0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
	金星: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
		[0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
	地球: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
		[0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
	火星: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
		[0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
	木星: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
		[-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
	土星: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
		[-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
};
// 等級 m = H + 5log10(rΔ) + 位相項(α=位相角deg)。係数は Meeus（天文アルゴリズム）＝内合の水星・金星が
// ちゃんと暗くなる（省略すると内合の水星が-3等の偽輝星になる）。土星の環の寄与(±0.5等)だけは省略。
const APPEAR = {
	水星: { H: -0.42, ph: a => 0.0380 * a - 0.000273 * a * a + 0.000002 * a * a * a, color: [0.85, 0.81, 0.77] },
	金星: { H: -4.40, ph: a => 0.0009 * a + 0.000239 * a * a - 0.00000065 * a * a * a, color: [1.00, 0.97, 0.88] },
	火星: { H: -1.52, ph: a => 0.016 * a, color: [1.00, 0.60, 0.40] },
	木星: { H: -9.40, ph: a => 0.005 * a, color: [1.00, 0.91, 0.77] },
	土星: { H: -8.88, ph: a => 0.044 * a, color: [0.95, 0.89, 0.69] },
};

// 日心黄道座標（J2000）。T＝J2000からのユリウス世紀
function helio(name, T) {
	const [e0, dr] = EL[name];
	const a = e0[0] + dr[0] * T, e = e0[1] + dr[1] * T, I = (e0[2] + dr[2] * T) * D2R;
	const L = e0[3] + dr[3] * T, w1 = e0[4] + dr[4] * T, Om = (e0[5] + dr[5] * T) * D2R;
	const M = ((L - w1) % 360 + 540) % 360 - 180;   // 平均近点角 (-180,180]
	const w = w1 * D2R - Om;                        // 近日点引数 ω = ϖ - Ω
	let E = M * D2R + e * Math.sin(M * D2R);        // ケプラー方程式（ニュートン反復）
	for (let i = 0; i < 8; i++) { const dE = (E - e * Math.sin(E) - M * D2R) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-8) break; }
	const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);   // 軌道面
	const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
	return [
		(cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
		(cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
		(sw * sI) * xp + (cw * sI) * yp,
	];
}

// 黄道→赤道、直交→RA/Dec(deg)
function toRaDec([x, y, z]) {
	const yq = y * Math.cos(EPS) - z * Math.sin(EPS), zq = y * Math.sin(EPS) + z * Math.cos(EPS);
	const r = Math.hypot(x, yq, zq);
	return { ra: Math.atan2(yq, x) * R2D, dec: Math.asin(zq / r) * R2D, dist: r };
}

// 肉眼惑星5つ＝[{name, ra, dec, mag, color}]（地心・視位置ではなく幾何位置＝光行差等は省略）
export function planetPositions(date = new Date()) {
	const T = (date.getTime() / 864e5 + 2440587.5 - 2451545.0) / 36525;
	const E = helio("地球", T);
	const R = Math.hypot(E[0], E[1], E[2]);   // 太陽-地球距離（位相角の余弦定理用）
	const out = [];
	for (const name of ["水星", "金星", "火星", "木星", "土星"]) {
		const P = helio(name, T);
		const g = [P[0] - E[0], P[1] - E[1], P[2] - E[2]];
		const { ra, dec, dist } = toRaDec(g);
		const r = Math.hypot(P[0], P[1], P[2]);
		const alpha = Math.acos(Math.max(-1, Math.min(1, (r * r + dist * dist - R * R) / (2 * r * dist)))) * R2D;   // 位相角
		const mag = Math.max(-4.7, Math.min(2.5, APPEAR[name].H + 5 * Math.log10(Math.max(r * dist, 1e-6)) + APPEAR[name].ph(alpha)));
		out.push({ name, ra, dec, mag, color: APPEAR[name].color });
	}
	return out;
}

// 太陽の地心方向（検証・将来の表示用）：地球ベクトルの反転＝夜面の太陽直下点式と同じ答えが出るはず
export function sunPosition(date = new Date()) {
	const T = (date.getTime() / 864e5 + 2440587.5 - 2451545.0) / 36525;
	const E = helio("地球", T);
	return toRaDec([-E[0], -E[1], -E[2]]);
}
