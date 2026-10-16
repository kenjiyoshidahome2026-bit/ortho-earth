// 星空劇場の惑星・月・太陽の地心 RA/Dec（表示用）。軌道の機械は @ortho-earth/ephem（JPL 近似軌道要素・Schlyter 月理論）を使う＝
// solarsky（太陽系圏）と同じ位置。旧＝この file に同じ表と級数の写しがあり、月は歳差の補正（ephem 2026-09-18）を欠いて年 0.014° ずつ流れていた。
// 精度は分（arcmin）オーダー＝点径数px の表示用途には十分。地心・幾何位置（光行差等は省略）。
import { bodyPos, moonGeo, AU_KM } from "@ortho-earth/ephem";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const EPS = 23.43928 * D2R;   // 黄道傾斜（J2000）
const E_RADII_AU = 6378.14 / AU_KM;   // 月の距離の単位（地球赤道半径）

// 等級 m = H + 5log10(rΔ) + 位相項(α=位相角deg)。係数は Meeus（天文アルゴリズム）＝内合の水星・金星が
// ちゃんと暗くなる（省略すると内合の水星が-3等の偽輝星になる）。土星の環の寄与(±0.5等)だけは省略。
const APPEAR = [
	["水星", "mercury", -0.42, a => 0.0380 * a - 0.000273 * a * a + 0.000002 * a * a * a, [0.85, 0.81, 0.77]],
	["金星", "venus", -4.40, a => 0.0009 * a + 0.000239 * a * a - 0.00000065 * a * a * a, [1.00, 0.97, 0.88]],
	["火星", "mars", -1.52, a => 0.016 * a, [1.00, 0.60, 0.40]],
	["木星", "jupiter", -9.40, a => 0.005 * a, [1.00, 0.91, 0.77]],
	["土星", "saturn", -8.88, a => 0.044 * a, [0.95, 0.89, 0.69]],
];

// 黄道→赤道、直交→RA/Dec(deg)
function toRaDec([x, y, z]) {
	const yq = y * Math.cos(EPS) - z * Math.sin(EPS), zq = y * Math.sin(EPS) + z * Math.cos(EPS);
	const r = Math.hypot(x, yq, zq);
	return { ra: Math.atan2(yq, x) * R2D, dec: Math.asin(zq / r) * R2D, dist: r };
}

// 肉眼惑星5つ＝[{name, ra, dec, mag, color}]（name は日本語名＝theater.js の PLANET_ID の鍵）
export function planetPositions(date = new Date()) {
	const E = bodyPos("earth", date);
	const R = Math.hypot(E[0], E[1], E[2]);   // 太陽-地球距離（位相角の余弦定理用）
	return APPEAR.map(([name, id, H, ph, color]) => {
		const P = bodyPos(id, date);
		const { ra, dec, dist } = toRaDec([P[0] - E[0], P[1] - E[1], P[2] - E[2]]);
		const r = Math.hypot(P[0], P[1], P[2]);
		const alpha = Math.acos(Math.max(-1, Math.min(1, (r * r + dist * dist - R * R) / (2 * r * dist)))) * R2D;   // 位相角
		const mag = Math.max(-4.7, Math.min(2.5, H + 5 * Math.log10(Math.max(r * dist, 1e-6)) + ph(alpha)));
		return { name, ra, dec, mag, color };
	});
}

// 太陽の地心方向：地球ベクトルの反転
export function sunPosition(date = new Date()) {
	const E = bodyPos("earth", date);
	return toRaDec([-E[0], -E[1], -E[2]]);
}

// 月（地心・J2000 黄道＝惑星と同じ系）。視点は宇宙（軌道上の劇場）なので地心でよい＝地上観測の視差（最大~1°）は適用しない
export function moonPosition(date = new Date()) {
	const m = moonGeo(date), q = toRaDec(m);
	return { name: "月", ra: q.ra, dec: q.dec, dist: q.dist / E_RADII_AU, eclLat: Math.asin(m[2] / Math.hypot(m[0], m[1], m[2])) * R2D };   // dist=地球半径単位、eclLat=検証用
}
