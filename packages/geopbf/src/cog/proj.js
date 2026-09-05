// COG の源 CRS ⇄ WGS84 経緯度。対応は 4326 / 3857 / UTM(EPSG:326xx 北・327xx 南) のみ＝公共 COG の実勢。
// UTM は Krüger n-series 6次（係数は Karney 2011 "Transverse Mercator with an accuracy of a few nanometers"
// の α/β 展開・標準ゾーン内で nm 級）。共形緯度→測地緯度は打ち切り級数でなく Newton 反復＝機械精度で往復が閉じる。
// 依存ゼロ・DOM 無し（Node でそのまま動く＝CLI/テスト共用）。

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// WGS84
const A_ = 6378137, F = 1 / 298.257223563;
const N_ = F / (2 - F);                       // 第三扁平率 n
const E2 = F * (2 - F), E_ = Math.sqrt(E2);   // 離心率
const K0 = 0.9996, FE = 500000;
// 有理メリジアン半径 A = a/(1+n)·(1 + n²/4 + n⁴/64 + n⁶/256)
const AR = A_ / (1 + N_) * (1 + N_ * N_ / 4 + N_ ** 4 / 64 + N_ ** 6 / 256);
// Krüger α（forward）・β（inverse）係数（n の6次まで）
const n = N_, n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
const AL = [
	n / 2 - 2 / 3 * n2 + 5 / 16 * n3 + 41 / 180 * n4 - 127 / 288 * n5 + 7891 / 37800 * n6,
	13 / 48 * n2 - 3 / 5 * n3 + 557 / 1440 * n4 + 281 / 630 * n5 - 1983433 / 1935360 * n6,
	61 / 240 * n3 - 103 / 140 * n4 + 15061 / 26880 * n5 + 167603 / 181440 * n6,
	49561 / 161280 * n4 - 179 / 168 * n5 + 6601661 / 7257600 * n6,
	34729 / 80640 * n5 - 3418889 / 1995840 * n6,
	212378941 / 319334400 * n6,
];
const BE = [
	n / 2 - 2 / 3 * n2 + 37 / 96 * n3 - 1 / 360 * n4 - 81 / 512 * n5 + 96199 / 604800 * n6,
	1 / 48 * n2 + 1 / 15 * n3 - 437 / 1440 * n4 + 46 / 105 * n5 - 1118711 / 3870720 * n6,
	17 / 480 * n3 - 37 / 840 * n4 - 209 / 4480 * n5 + 5569 / 90720 * n6,
	4397 / 161280 * n4 - 11 / 504 * n5 - 830251 / 7257600 * n6,
	4583 / 161280 * n5 - 108847 / 3991680 * n6,
	20648693 / 638668800 * n6,
];

// 測地緯度 tan → 共形緯度 tan
const tauPrime = (tau) => {
	const sig = Math.sinh(E_ * Math.atanh(E_ * tau / Math.hypot(1, tau)));
	return tau * Math.hypot(1, sig) - sig * Math.hypot(1, tau);
};
// 共形緯度 tan → 測地緯度 tan（Newton・2〜3回で機械精度収束）
const tauOf = (taup) => {
	let tau = taup / (1 - E2);   // 初期値
	for (let i = 0; i < 5; i++) {
		const d = taup - tauPrime(tau);
		if (Math.abs(d) < 1e-15 * Math.max(1, Math.abs(taup))) break;
		const dt = (Math.hypot(1, tauPrime(tau)) * Math.hypot(1, tau) * (1 - E2)) / (1 + (1 - E2) * tau * tau) || 1;
		tau += d / dt;
	}
	return tau;
};

const tmForward = (lonDeg, latDeg, lon0Deg) => {
	const lam = (lonDeg - lon0Deg) * D2R, phi = latDeg * D2R;
	const taup = tauPrime(Math.tan(phi));
	const xip = Math.atan2(taup, Math.cos(lam));
	const etap = Math.asinh(Math.sin(lam) / Math.hypot(taup, Math.cos(lam)));
	let xi = xip, eta = etap;
	for (let j = 1; j <= 6; j++) {
		xi += AL[j - 1] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
		eta += AL[j - 1] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
	}
	return [K0 * AR * eta, K0 * AR * xi];   // [東距(FE無し), 北距(FN無し)]
};

const tmInverse = (x, y, lon0Deg) => {
	const eta0 = x / (K0 * AR), xi0 = y / (K0 * AR);
	let xip = xi0, etap = eta0;
	for (let j = 1; j <= 6; j++) {
		xip -= BE[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
		etap -= BE[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
	}
	const taup = Math.sin(xip) / Math.hypot(Math.sinh(etap), Math.cos(xip));
	const phi = Math.atan(tauOf(taup));
	const lam = Math.atan2(Math.sinh(etap), Math.cos(xip));
	return [lon0Deg + lam * R2D, phi * R2D];
};

const RM = 6378137;   // 3857 の球半径（WGS84 長半径）

// EPSG → {forward([lon,lat])→[x,y], inverse([x,y])→[lon,lat]}。非対応は null（呼び出し側が明示エラー）。
export function projFor(epsg) {
	if (epsg === 4326 || epsg === 4258 || epsg === 4019) return {   // 経緯度系はそのまま（度）
		forward: ([lon, lat]) => [lon, lat],
		inverse: ([x, y]) => [x, y],
	};
	if (epsg === 3857 || epsg === 3785 || epsg === 900913) return {
		forward: ([lon, lat]) => [lon * D2R * RM, Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)) * RM],
		inverse: ([x, y]) => [x / RM * R2D, (2 * Math.atan(Math.exp(y / RM)) - Math.PI / 2) * R2D],
	};
	const utm = /^32([67])(\d\d)$/.exec(String(epsg));
	if (utm) {
		const south = utm[1] === "7", zone = +utm[2];
		if (zone >= 1 && zone <= 60) {
			const lon0 = (zone - 30.5) * 6;                 // 中央経線
			const fn = south ? 10000000 : 0;
			return {
				forward: ([lon, lat]) => { const [e, nn] = tmForward(lon, lat, lon0); return [e + FE, nn + fn]; },
				inverse: ([x, y]) => tmInverse(x - FE, y - fn, lon0),
			};
		}
	}
	return null;
}
