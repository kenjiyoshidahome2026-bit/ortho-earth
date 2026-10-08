// 太陽と月の出入り・南中・薄明・月齢（2026-10-08・日めくりの段）。依存なし＝Node の検定（tests/t-astro.mjs）でも同じ式が走る。
//   太陽＝Meeus『Astronomical Algorithms』ch.25 の低精度式（黄経 0.01°）。月＝Schlyter の低精度月理論（0.3°＝出入りの時刻で 1 分弱）。
//   出入りの判定＝その日の現地 0 時〜24 時を 10 分刻みで追い、目標高度を跨いだ区間を二分法で詰める（極地の「出ない・沈まない」も自然に出る）。
//   目標高度（上端が地平線に接する時）＝−（大気差 34′）−（視半径）−（地平線の降下）。
//   地平線の降下（dip）＝観測者の標高 h[m] から 1.76′√h（地上の大気差込みの慣用値）＝海抜を「見える地平線までの高さ」とみなす近似
//   （海辺・山頂では妥当、内陸では実際の地平線はもっと高い＝出は遅く入りは早い側に外れる）。
//   月は中心で判定（国立天文台の慣例）＝地心高度から視差を引いた測心高度で見る。薄明（市民 −6°・航海 −12°・天文 −18°）は太陽の中心・降下なし。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const rev = x => ((x % 360) + 360) % 360;
const sin = x => Math.sin(x * D2R), cos = x => Math.cos(x * D2R);
export const jdOf = ms => ms / 864e5 + 2440587.5;
// ΔT（TT−UT・秒）＝Espenak–Meeus の 2005〜2050 の多項式（天体の位置は TT・時刻は UT）
export const deltaT = y => { const t = y - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; };
const yearOf = ms => 2000 + (jdOf(ms) - 2451545) / 365.25;
const jdTT = ms => jdOf(ms) + deltaT(yearOf(ms)) / 86400;

// グリニッジ平均恒星時（度）
export function gmst(ms) {
	const jd = jdOf(ms), T = (jd - 2451545) / 36525;
	return rev(280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T - T * T * T / 38710000);
}
// 黄道傾斜（度・日付の平均）
const obliquity = T => 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T;

// 太陽の視位置＝{ ra, dec（度）, lon（視黄経・度）, dist（AU）, sd（視半径・度）, eot（均時差・分）}
export function sun(ms) {
	const T = (jdTT(ms) - 2451545) / 36525;
	const L0 = rev(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
	const M = rev(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
	const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
	const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
	const trueLon = L0 + C, nu = M + C;
	const dist = 1.000001018 * (1 - e * e) / (1 + e * cos(nu));
	const Om = 125.04 - 1934.136 * T;
	const lon = rev(trueLon - 0.00569 - 0.00478 * sin(Om));
	const eps = obliquity(T) + 0.00256 * cos(Om);
	const ra = rev(Math.atan2(cos(eps) * sin(lon), cos(lon)) * R2D);
	const dec = Math.asin(sin(eps) * sin(lon)) * R2D;
	// 均時差（Meeus 28.3・分）
	const y = Math.tan(eps / 2 * D2R) ** 2;
	const E = y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M);
	return { ra, dec, lon, dist, sd: 959.63 / 3600 / dist, eot: E * R2D * 4 };
}

// 月の地心視位置＝{ ra, dec, lon, lat（度）, dist（km）, par（赤道地平視差・度）, sd（視半径・度）}（Schlyter）
export function moon(ms) {
	const d = jdTT(ms) - 2451543.5;
	const N = rev(125.1228 - 0.0529538083 * d), i = 5.1454, w = rev(318.0634 + 0.1643573223 * d);
	const a = 60.2666, e = 0.0549, M = rev(115.3654 + 13.0649929509 * d);
	let E = M + e * R2D * sin(M) * (1 + e * cos(M));
	for (let k = 0; k < 10; k++) { const dE = (E - e * R2D * sin(E) - M) / (1 - e * cos(E)); E -= dE; if (Math.abs(dE) < 1e-7) break; }
	const xv = a * (cos(E) - e), yv = a * Math.sqrt(1 - e * e) * sin(E);
	const v = Math.atan2(yv, xv) * R2D, r0 = Math.hypot(xv, yv);
	const u = v + w;
	const xh = r0 * (cos(N) * cos(u) - sin(N) * sin(u) * cos(i));
	const yh = r0 * (sin(N) * cos(u) + cos(N) * sin(u) * cos(i));
	const zh = r0 * sin(u) * sin(i);
	let lon = rev(Math.atan2(yh, xh) * R2D), lat = Math.asin(zh / r0) * R2D, r = r0;
	const ws = rev(282.9404 + 4.70935e-5 * d), Ms = rev(356.047 + 0.9856002585 * d);
	const Ls = rev(Ms + ws), Lm = rev(N + w + M), D = rev(Lm - Ls), F = rev(Lm - N);
	lon += -1.274 * sin(M - 2 * D) + 0.658 * sin(2 * D) - 0.186 * sin(Ms) - 0.059 * sin(2 * M - 2 * D)
		- 0.057 * sin(M - 2 * D + Ms) + 0.053 * sin(M + 2 * D) + 0.046 * sin(2 * D - Ms) + 0.041 * sin(M - Ms)
		- 0.035 * sin(D) - 0.031 * sin(M + Ms) - 0.015 * sin(2 * F - 2 * D) + 0.011 * sin(M - 4 * D);
	lat += -0.173 * sin(F - 2 * D) - 0.055 * sin(M - F - 2 * D) - 0.046 * sin(M + F - 2 * D) + 0.033 * sin(F + 2 * D) + 0.017 * sin(2 * M + F);
	r += -0.58 * cos(M - 2 * D) - 0.46 * cos(2 * D);
	lon = rev(lon);
	const T = (jdTT(ms) - 2451545) / 36525, eps = obliquity(T);
	const ra = rev(Math.atan2(sin(lon) * cos(eps) - Math.tan(lat * D2R) * sin(eps), cos(lon)) * R2D);
	const dec = Math.asin(sin(lat) * cos(eps) + cos(lat) * sin(eps) * sin(lon)) * R2D;
	const dist = r * 6378.14;
	return { ra, dec, lon, lat, dist, par: Math.asin(6378.14 / dist) * R2D, sd: Math.asin(1737.4 / dist) * R2D };
}

// 地平座標＝{ alt（度・地心）, az（度・北から東回り）, H（時角・度 −180〜180）}
export function altaz(ra, dec, ms, lat, lon) {
	const H = rev(gmst(ms) + lon - ra), Hs = H > 180 ? H - 360 : H;
	const alt = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H)) * R2D;
	const az = rev(Math.atan2(sin(H), cos(H) * sin(lat) - Math.tan(dec * D2R) * cos(lat)) * R2D + 180);
	return { alt, az, H: Hs };
}
// 地平線の降下（度）＝1.76′√h
export const dip = h => h > 0 ? 1.76 / 60 * Math.sqrt(h) : 0;
const REFR = 34 / 60;   // 地平の大気差

// 太陽の測心高度（度・大気差前）と、月の測心高度（視差を引く）
const sunAlt = (ms, lat, lon) => { const s = sun(ms); return altaz(s.ra, s.dec, ms, lat, lon).alt; };
const moonAlt = (ms, lat, lon) => { const m = moon(ms); const a = altaz(m.ra, m.dec, ms, lat, lon).alt; return a - m.par * cos(a); };

// f(ms) が target を跨ぐ時刻を [t0, t1] の中で全部返す（dir: +1＝上向き（出）, −1＝下向き（入り））。step＝粗い刻み（ms）
export function crossings(f, target, t0, t1, step = 600e3) {
	const out = [];
	let pa = f(t0) - target, ta = t0;
	for (let t = t0 + step; t <= t1 + 1; t += step) {
		const tb = Math.min(t, t1), pb = f(tb) - target;
		if ((pa < 0 && pb >= 0) || (pa >= 0 && pb < 0)) {
			let lo = ta, hi = tb, flo = pa;
			for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2, fm = f(mid) - target; if ((flo < 0) === (fm < 0)) { lo = mid; flo = fm; } else hi = mid; }
			out.push({ t: (lo + hi) / 2, dir: pb >= pa ? 1 : -1 });
		}
		pa = pb; ta = tb;
		if (tb === t1) break;
	}
	return out;
}
const first = (xs, dir) => xs.find(x => x.dir === dir)?.t ?? null;

// その現地日（t0＝現地 0 時の ms・t1＝翌 0 時）の太陽の一覧。h＝観測者の標高（m）
export function sunDay(t0, t1, lat, lon, h = 0) {
	const f = ms => sunAlt(ms, lat, lon);
	const d = dip(h);
	const horizon = t => -(REFR + sun(t).sd + d);   // 上端
	const mid = (t0 + t1) / 2;
	const rs = crossings(ms => f(ms) - horizon(ms), 0, t0, t1);
	const rs0 = h > 0 ? crossings(ms => f(ms) - horizon(ms) - d, 0, t0, t1) : rs;   // 標高 0 の時（差を見せる）
	const civ = crossings(f, -6, t0, t1), nau = crossings(f, -12, t0, t1), ast = crossings(f, -18, t0, t1);
	// 南中＝時角が 0 を跨ぐ（sin H の符号が − → ＋ … H は −180〜180 なので H の符号で見る）
	const noon = crossings(ms => { const s = sun(ms); return altaz(s.ra, s.dec, ms, lat, lon).H; }, 0, t0, t1, 1800e3).filter(x => x.dir === 1)[0]?.t ?? null;
	const noonAlt = noon != null ? f(noon) : null;
	const rise = first(rs, 1), set = first(rs, -1);
	const altMid = f(mid);
	return {
		rise, set, rise0: first(rs0, 1), set0: first(rs0, -1),
		noon, noonAlt, noonAz: noon != null ? altaz(sun(noon).ra, sun(noon).dec, noon, lat, lon).az : null,
		riseAz: rise != null ? altaz(sun(rise).ra, sun(rise).dec, rise, lat, lon).az : null,
		setAz: set != null ? altaz(sun(set).ra, sun(set).dec, set, lat, lon).az : null,
		dayLength: rise != null && set != null ? (set > rise ? set - rise : set + 864e5 - rise) : (altMid > 0 ? 864e5 : 0),   // 出も入りも無い日＝白夜（終日 >0）か極夜
		civil: { dawn: first(civ, 1), dusk: first(civ, -1) },
		nautical: { dawn: first(nau, 1), dusk: first(nau, -1) },
		astro: { dawn: first(ast, 1), dusk: first(ast, -1) },
		polar: rise == null && set == null ? (altMid > 0 ? "day" : "night") : null,
		dec: sun(mid).dec, eot: sun(mid).eot, dip: d,
	};
}
// 月の一覧（出・入り・南中・月齢・輝面比）。age＝正午の月齢（直前の朔からの日数）
export function moonDay(t0, t1, lat, lon, h = 0) {
	const d = dip(h), f = ms => moonAlt(ms, lat, lon);
	const rs = crossings(f, -(REFR + d), t0, t1);
	const transit = crossings(ms => { const m = moon(ms); return altaz(m.ra, m.dec, ms, lat, lon).H; }, 0, t0, t1, 1200e3).filter(x => x.dir === 1)[0]?.t ?? null;
	const noon = (t0 + t1) / 2;
	return { rise: first(rs, 1), set: first(rs, -1), transit, transitAlt: transit != null ? f(transit) : null,
		age: moonAge(noon), illum: illumination(noon), elong: elongation(noon), dist: moon(noon).dist };
}
// 離角（月の黄経 − 太陽の黄経・0〜360）
export const elongation = ms => rev(moon(ms).lon - sun(ms).lon);
export const illumination = ms => (1 - cos(elongation(ms))) / 2;
const SYNODIC = 29.530588853 * 864e5;
// 直前の朔（離角が 0 を上向きに跨いだ時刻）
export function lastNewMoon(ms) {
	const g = t => { const e = elongation(t); return e > 180 ? e - 360 : e; };   // −180〜180＝朔で 0 を上向きに跨ぐ
	const e0 = elongation(ms), guess = ms - e0 / 360 * SYNODIC;
	const xs = crossings(g, 0, guess - 3 * 864e5, guess + 3 * 864e5, 6 * 3600e3).filter(x => x.dir === 1 && x.t <= ms);
	return xs.length ? xs[xs.length - 1].t : guess;
}
export const moonAge = ms => (ms - lastNewMoon(ms)) / 864e5;
// 次の朔望（ms 以降 40 日の 0/90/180/270°）＝[{ phase: 0|1|2|3, t }]
export function nextPhases(ms, days = 40) {
	const out = [];
	for (const [phase, deg] of [[0, 0], [1, 90], [2, 180], [3, 270]]) {
		const g = t => { const e = rev(elongation(t) - deg + 180) - 180; return e; };
		for (const x of crossings(g, 0, ms, ms + days * 864e5, 6 * 3600e3)) if (x.dir === 1) out.push({ phase, t: x.t });
	}
	return out.sort((a, b) => a.t - b.t);
}
// 現地日の境＝その時間帯（IANA）の 0 時の UTC ms。tz を省けば実行環境の時間帯（Date のローカル）
export function dayBounds(y, m, d, tz) {
	if (!tz) { const a = new Date(y, m - 1, d).getTime(), b = new Date(y, m - 1, d + 1).getTime(); return [a, b]; }
	return [zonedMidnight(y, m, d, tz), zonedMidnight(y, m, d + 1, tz)];
}
// その時間帯の壁時計 y-m-d h:mi → UTC ms（Intl で時差を 2 回合わせる＝夏時間の境も通る）
export function zonedToUTC(y, m, d, h = 0, mi = 0, s = 0, tz) {
	const guess = Date.UTC(y, m - 1, d, h, mi, s);
	const off = t => offsetAt(t, tz);
	let t = guess - off(guess);
	t = guess - off(t);
	return t;
}
const zonedMidnight = (y, m, d, tz) => zonedToUTC(y, m, d, 0, 0, 0, tz);
const fmtCache = {};
export function offsetAt(ms, tz) {   // その瞬間の UTC からの時差（ms）
	const f = fmtCache[tz] ??= new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
	const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter(x => x.type !== "literal").map(x => [x.type, +x.value]));
	return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
