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
	// 雲は焼き込まず別テクスチャ＝地表の少し上に張る半透明の殻（雲図は白黒＝輝度をアルファに使う）。
	// 焼き込むと縁で雲が地表に潰れ、昼夜境界も雲だけ立体に見えない＝寄った時の嘘が大きい
	// night＝夜面の街明かり（昼夜境界の外で加算）。地球だけが持つ2枚目・3枚目
	{ id: "earth", name: "Earth", tex: "2k_earth_daymap.jpg", clouds: "2k_earth_clouds.jpg", night: "2k_earth_nightmap.jpg",
		radiusKm: 6371.0, color: [0.42, 0.58, 0.84],
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
// planets.js の moonPosition と同じ級数＝RA/Dec化の手前で止めて XYZ を返す。黄経は末尾で J2000 黄道へ戻す（歳差 1.397°/世紀）。
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
	// 日付の黄道 → J2000 黄道：一般歳差 1.397°/世紀（Schlyter の epoch 補正 3.82394e-5°/日）を黄経から引く。
	// 惑星は J2000 系＝ここを揃えないと月だけが年 0.014° ずつ流れる（2026 年で 0.37°＝月の視半径超＝
	// 日食の月影が地表で約 2,500km ずれる。JPL Horizons との照合で発見 2026-09-18・1850 年では 2.1° だった）。
	lon -= 3.82394e-5 * (jd(date) - 2451545.0);
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
// 描画用の軌道線＝天体自身からの相対（AU）・天体の傍ほど密。orbitPointsThrough は日心のまま f32 に詰める＝冥王星（35AU）で
// 刻み ~600km、しかも等間隔 512 点の弦は楕円から最大 ~11 万 km 内側を通る＝寄ると線が天体から外れて見える（実測 2026-09-19）。
// ここでは離心近点角のずれを dE = π·s·|s|（s∈[-1,1)）で配る＝天体の傍は刻みが二次で細かい（弦の誤差は数 km）・裏側は等間隔の 2 倍。
// 頂点 n/2 が天体そのもの（原点）。使う側は「カメラ − 天体」を f64 で引いてシェーダへ渡す（RTE）
export function orbitPointsRel(id, date, n = 512) {
	const el = elements(id, jcT(date)), out = new Float32Array(n * 3);
	const M = (((el.L - el.w1) % 360 + 540) % 360 - 180) * D2R, E0 = solveE(M, el.e), p0 = fromE(el, E0);
	for (let i = 0; i < n; i++) {
		const sv = -1 + 2 * i / n, p = fromE(el, E0 + Math.PI * sv * Math.abs(sv));
		out[i * 3] = p[0] - p0[0]; out[i * 3 + 1] = p[1] - p0[1]; out[i * 3 + 2] = p[2] - p0[2];
	}
	return out;
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

// ---- 3×3 の道具（衛星と自転で共用） ----
const mul3 = (A, B) => {   // 3×3 行列積（行優先 [r][c]）
	const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
	return C;
};
const Rx = t => { const c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const Rz = t => { const c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };

// ---- 衛星：BODIES とは別の棚＝japan の太陽系圏（BODIES を総なめする）を 1 行も変えない ----
// 模型は一本：親の「Laplace 面」（極 lap＝赤道 J2000 の RA/Dec・既定は親の IAU 自転極＝親の赤道面）に対し、
//   平均黄経 λ = λ0 + n·d (+ quad·d² + 秤動 lib) ／ 近点黄経 ϖ = peri[0] + peri[1]·d ／ 昇交点 Ω = node[0] + node[1]·d
//   ／ 傾斜 inc ／ 離心率 e のケプラー楕円（d＝J2000 からの日数・角度は deg・率は deg/日）。
// 近点と昇交点がゆっくり回る＝親の扁平（J2）と太陽が軌道面を首振りさせる分。λ・ϖ・Ω の原点＝Laplace 面の
// ICRF 赤道に対する昇交点＝IAU 自転系の x 軸（orientation と同じ Rz(α+90°)·Rx(90°−δ)）。
// 値は全て JPL Horizons の親心ベクトル（1800–2050 の 5 段の時間窓・計約 2,600 標本/衛星）への最小二乗＝一次資料からの実測。
// 追加項は物理があるものだけ：フォボス quad＝潮汐で火星へ落ちていく永年加速（無いと 1800 年で 15° ずれる）／
// ミマス・テティス lib＝両者の 4:2 共鳴の秤動（周期 70.6 年・ミマス振幅 44°）＝[振幅, 位相, 角速度]＝A·sin(ν·d + φ)。
// 1800–2050 の実測最大誤差（方向）：ミランダ 1.97°・ミマス 1.22°・イアペトゥス 1.24°・他は 0.8° 以内（Horizons で検定）。
// ガリレオ衛星（第一版）＝円軌道・木星赤道面（e・inc・lap 省略＝既定）。捨てたのは離心率とラプラス共鳴の秤動
// ＝最大 イオ 0.50°・エウロパ 1.22°・ガニメデ 0.29°・カリスト 0.98°。
// rot＝IAU WGCCRE（ガリレオ衛星のみ）。rot の無い衛星＝同期自転を軌道から直に組む（面が常に親を向く・orientation）。
// 顔ぶれ＝各惑星の半径 ~200km 以上の主要衛星＋火星の二つ（小さいが「火星の月」として外せない）。
// 海王星のトリトンだけ逆行（親の自転と逆向きに公転）＝lap は海王星の極の対蹠に取り、inc 23° の順行として表す。
export const SATELLITES = [
	{ id: "io", name: "Io", parent: "jupiter", radiusKm: 1821.6, aKm: 421745, lambda0: 19.9484, n: 203.4889578, color: [0.93, 0.85, 0.45],
		rot: { ra: 268.05, dec: 64.50, W0: 200.39, Wd: 203.4889538 } },
	{ id: "europa", name: "Europa", parent: "jupiter", radiusKm: 1560.8, aKm: 670965, lambda0: 214.5108, n: 101.3747263, color: [0.86, 0.80, 0.70],
		rot: { ra: 268.08, dec: 64.51, W0: 36.022, Wd: 101.3747235 } },
	{ id: "ganymede", name: "Ganymede", parent: "jupiter", radiusKm: 2631.2, aKm: 1070480, lambda0: 221.7728, n: 50.3176070, color: [0.66, 0.61, 0.55],
		rot: { ra: 268.20, dec: 64.57, W0: 44.064, Wd: 50.3176081 } },
	{ id: "callisto", name: "Callisto", parent: "jupiter", radiusKm: 2410.3, aKm: 1882567, lambda0: 80.9859, n: 21.5710713, color: [0.45, 0.41, 0.37],
		rot: { ra: 268.72, dec: 64.83, W0: 259.51, Wd: 21.5710715 } },
	{ id: "phobos", name: "Phobos", parent: "mars", radiusKm: 11.08, color: [0.46, 0.41, 0.37],
		aKm: 9375, lambda0: 215.1621, n: 1128.8447562, e: 0.0151, peri: [25.56, 0.43518], inc: 1.069, node: [169.36, -0.43578], lap: [317.703, 52.91], quad: 9.4442e-9 },
	{ id: "deimos", name: "Deimos", parent: "mars", radiusKm: 6.27, color: [0.58, 0.53, 0.47],
		aKm: 23458, lambda0: 259.3521, n: 285.1618864, e: 0.000258, peri: [245.26, 0.017584], inc: 1.793, node: [54.01, -0.018075], lap: [316.684, 53.551] },
	{ id: "mimas", name: "Mimas", parent: "saturn", radiusKm: 198.2, color: [0.76, 0.76, 0.75],
		aKm: 185542, lambda0: 160.4822, n: 381.9944987, e: 0.0197, peri: [145.71, 1.0009], inc: 1.571, node: [172.98, -0.9995], lap: [40.602, 83.537], quad: -6.1169e-11, lib: [43.561, 140.42, 0.0139411] },
	{ id: "enceladus", name: "Enceladus", parent: "saturn", radiusKm: 252.1, color: [0.96, 0.97, 0.99],
		aKm: 238037, lambda0: 182.3243, n: 262.7318984, e: 0.00475, peri: [172.13, 0.33797], inc: 0.006, node: [329.22, -0.41147], lap: [40.582, 83.538] },
	{ id: "tethys", name: "Tethys", parent: "saturn", radiusKm: 531.1, color: [0.88, 0.88, 0.86],
		aKm: 294673, lambda0: 188.3969, n: 190.6979109, e: 0.000132, peri: [292.93, 0.19675], inc: 1.091, node: [259.87, -0.19785], lap: [40.585, 83.54], quad: -2.8157e-11, lib: [2.099, 320.49, 0.0139472] },
	{ id: "dione", name: "Dione", parent: "saturn", radiusKm: 561.4, color: [0.83, 0.82, 0.8],
		aKm: 377415, lambda0: 176.9416, n: 131.534931, e: 0.00224, peri: [214.15, 0.084232], inc: 0.027, node: [301.54, -0.083428], lap: [40.558, 83.542] },
	{ id: "rhea", name: "Rhea", parent: "saturn", radiusKm: 763.5, color: [0.78, 0.77, 0.75],
		aKm: 527069, lambda0: 52.37, n: 79.6900469, e: 0.000553, peri: [208.57, 0.026138], inc: 0.335, node: [351.44, -0.027458], lap: [40.396, 83.56] },
	{ id: "titan", name: "Titan", parent: "saturn", radiusKm: 2574.7, color: [0.9, 0.68, 0.34],
		aKm: 1221865, lambda0: 10.837, n: 22.5769762, e: 0.0288, peri: [207.34, 0.0013965], inc: 0.26, node: [12.22, -0.0014229], lap: [37.291, 83.963] },
	{ id: "iapetus", name: "Iapetus", parent: "saturn", radiusKm: 734.5, color: [0.62, 0.55, 0.46],
		aKm: 3560890, lambda0: 264.5725, n: 4.5379524, e: 0.0284, peri: [56.04, 0.00030392], inc: 17.026, node: [119.32, -0.00014511], lap: [224.097, 82.42] },
	{ id: "miranda", name: "Miranda", parent: "uranus", radiusKm: 235.8, color: [0.7, 0.7, 0.7],
		aKm: 129867, lambda0: 328.221, n: 254.6906637, e: 0.00134, peri: [253.78, 0.054609], inc: 4.433, node: [100.65, -0.055417], lap: [77.289, 15.204] },
	{ id: "ariel", name: "Ariel", parent: "uranus", radiusKm: 578.9, color: [0.76, 0.75, 0.73],
		aKm: 190930, lambda0: 203.1485, n: 142.8356644, e: 0.00112, peri: [43.29, 0.014593], inc: 0.006, node: [176.43, -0.01284], lap: [77.312, 15.171] },
	{ id: "umbriel", name: "Umbriel", parent: "uranus", radiusKm: 584.7, color: [0.46, 0.46, 0.46],
		aKm: 265984, lambda0: 251.2364, n: 86.8688747, e: 0.00339, peri: [333.53, 0.0060585], inc: 0.047, node: [229.99, -0.0040555], lap: [77.332, 15.177] },
	{ id: "titania", name: "Titania", parent: "uranus", radiusKm: 788.9, color: [0.67, 0.63, 0.59],
		aKm: 436285, lambda0: 281.5805, n: 41.3514151, e: 0.00161, peri: [219.22, 0.00071653], inc: 0.176, node: [7.93, -0.00071232], lap: [77.28, 15.251] },
	{ id: "oberon", name: "Oberon", parent: "uranus", radiusKm: 761.4, color: [0.61, 0.56, 0.52],
		aKm: 583447, lambda0: 352.6029, n: 26.7394825, e: 0.00106, peri: [183.18, 0.00025769], inc: 0.23, node: [82.06, -0.00025737], lap: [77.185, 15.067] },
	{ id: "triton", name: "Triton", parent: "neptune", radiusKm: 1352.6, color: [0.86, 0.81, 0.78],
		aKm: 354759, lambda0: 60.7598, n: 61.2572605, e: 0.000117, peri: [69.47, 0], inc: 23.087, node: [182.28, -0.0014392], lap: [119.419, -43.375] },
	{ id: "charon", name: "Charon", parent: "pluto", radiusKm: 606, color: [0.61, 0.58, 0.56],
		aKm: 19596, lambda0: 304.1219, n: 56.3625303, e: 0.000161, peri: [155.33, 0], inc: 0.083, node: [9.02, 0], lap: [132.993, -6.163] },
];
export const satById = Object.fromEntries(SATELLITES.map(b => [b.id, b]));
// Laplace 面の座標系（x＝昇交点・z＝極）→ 黄道 J2000
function lapFrame(b) {
	const [ra, dec] = b.lap || [byId[b.parent].rot.ra, byId[b.parent].rot.dec];
	return mul3(Rx(-EPS), mul3(Rz(ra * D2R + Math.PI / 2), Rx(Math.PI / 2 - dec * D2R)));
}
// d（J2000 からの日数）での角度（rad）：平均黄経・近点黄経・昇交点
function satAngles(b, d) {
	let lam = b.lambda0 + b.n * d;
	if (b.quad) lam += b.quad * d * d;
	if (b.lib) lam += b.lib[0] * Math.sin((b.lib[2] * d + b.lib[1]) * D2R);
	const peri = b.peri ? b.peri[0] + b.peri[1] * d : 0, node = b.node ? b.node[0] + b.node[1] * d : 0;
	return [lam * D2R, peri * D2R, node * D2R];
}
// 楕円上の点（AU・黄道 J2000）。lam＝平均黄経（軌道線は ϖ・Ω を止めて lam だけ一周回す）
function satLocal(b, lam, varpi, Om) {
	const e = b.e || 0, a = b.aKm / AU_KM, inc = (b.inc || 0) * D2R, F = b.F;
	const E = solveE(lam - varpi, e);
	const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
	const w = varpi - Om, cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), ci = Math.cos(inc), si = Math.sin(inc);
	const X = xp * cw - yp * sw, Y = xp * sw + yp * cw;
	const v = [X * cO - Y * sO * ci, X * sO + Y * cO * ci, Y * si];
	return [F[0][0] * v[0] + F[0][1] * v[1] + F[0][2] * v[2], F[1][0] * v[0] + F[1][1] * v[1] + F[1][2] * v[2], F[2][0] * v[0] + F[2][1] * v[1] + F[2][2] * v[2]];
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const parentPole = b => eqToEcl(byId[b.parent].rot.ra, byId[b.parent].rot.dec);
// 軌道面の極（公転の角運動量の向き・黄道 J2000 単位ベクトル）
function satPole(b, Om) {
	const inc = (b.inc || 0) * D2R, F = b.F, v = [Math.sin(Om) * Math.sin(inc), -Math.cos(Om) * Math.sin(inc), Math.cos(inc)];
	return [F[0][0] * v[0] + F[0][1] * v[1] + F[0][2] * v[2], F[1][0] * v[0] + F[1][1] * v[1] + F[1][2] * v[2], F[2][0] * v[0] + F[2][1] * v[1] + F[2][2] * v[2]];
}
for (const b of SATELLITES) {
	b.F = lapFrame(b);
	b.radiusAU = b.radiusKm / AU_KM; b.periodDays = 360 / b.n;
	// 同期自転の衛星＝自転周期＝公転周期。向き（順行/逆行）＝公転の極が親の IAU 極と同じ側か＝親と同じ約束で読む
	// （惑星は「北極＝黄道の北側」・冥王星は右手系＝天王星の衛星は天王星と同じく逆行・トリトンは逆行・カロンは冥王星と同じ）
	if (!b.rot) b.rot = { Wd: dot3(satPole(b, satAngles(b, 0)[2]), parentPole(b)) < 0 ? -b.n : b.n };
	b.rotHours = Math.abs(360 / b.rot.Wd) * 24;
}
// 衛星の親心位置（AU・黄道 J2000）と日心位置
export function satRel(id, date) {
	const b = satById[id];
	return satLocal(b, ...satAngles(b, jd(date) - 2451545.0));
}
export function satPos(id, date) {
	const p = bodyPos(satById[id].parent, date), r = satRel(id, date);
	return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
}
// 衛星の軌道線（その時刻の楕円）＝中心は渡された時刻の親。起点＝衛星の今の位置＝衛星は常に折れ線の頂点（orbitPointsThrough と同じ理屈）。
// relative＝親心のまま返す（描画用）。日心で f32 に詰めると冥王星（35AU）では刻みが ~600km＝カロン軌道（半径 2 万 km）がギザギザになる
export function satOrbitPoints(id, date, n = 192, relative = false) {
	const b = satById[id], c = relative ? [0, 0, 0] : bodyPos(b.parent, date), out = new Float32Array(n * 3);
	const [lam0, varpi, Om] = satAngles(b, jd(date) - 2451545.0);
	for (let i = 0; i < n; i++) { const p = satLocal(b, lam0 + i / n * 2 * Math.PI, varpi, Om); out[i * 3] = c[0] + p[0]; out[i * 3 + 1] = c[1] + p[1]; out[i * 3 + 2] = c[2] + p[2]; }
	return out;
}
// 同期自転の向き：z＝公転の極（Wd が負なら反対側＝親と同じ約束の「北」）、x＝親の方向（本初子午線が親を向く＝IAU の同期衛星と同じ約束）
function syncOrientation(b, date) {
	const d = jd(date) - 2451545.0, ang = satAngles(b, d), r = satLocal(b, ...ang);
	let z = satPole(b, ang[2]); if (b.rot.Wd < 0) z = z.map(v => -v);
	const rl = Math.hypot(...r), x0 = r.map(v => -v / rl), k = x0[0] * z[0] + x0[1] * z[1] + x0[2] * z[2];
	let x = x0.map((v, i) => v - k * z[i]); const xl = Math.hypot(...x); x = x.map(v => v / xl);
	const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
	return [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
}

// ---- IAU 自転：体固定→世界（黄道J2000）の 3×3 回転 ----
// v_eq = Rz(90°+α)·Rx(90°−δ)·Rz(W)·v_body（WGCCRE 標準）→ 黄道へ Rx(−ε)。体座標系＝z:北極, +x:本初子午線
export function orientation(id, date) {
	const { rot } = byId[id] ?? satById[id];
	if (rot.ra === undefined) return syncOrientation(satById[id], date);   // IAU 表を持たない衛星＝同期自転を軌道から
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
