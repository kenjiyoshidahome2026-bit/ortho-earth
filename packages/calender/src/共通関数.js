const div = (m, n) => Math.floor(m / n);
const mod = (m, n) => (m + n) % n;
const isLeap = Y => !(Y % 400) || !(Y % 4) && (Y % 100);

export const r360 = r => { while (r < 0) r += 360; while (r >= 360) r -= 360; return r; };
export const date2ymd = (dt = new Date()) => [dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes(), dt.getSeconds()];
export const yearLength = Y => isLeap(Y) ? 366 : 365;
export const monthLength = YM => [31, isLeap(YM[0]) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][YM[1] - 1];
export const dayAfter = (YMD, n) => jdn2ymd(ymd2jdn(YMD) + n);
export const dayNumber = YMD => ymd2jdn(YMD) - ymd2jdn([YMD[0], 1, 1]);
export const ymdComp = (d1, d2) => ymd2jdn(d1) - ymd2jdn(d2 ? d2 : date2ymd().slice(0, 3));
export const yearDay = (Y, n) => dayAfter([Y, 1, 1], n);
export const ymd2day = YMD => (ymd2jdn(YMD) + 3) % 7;

export function ymd2jdn(YMD, flag=false) {
	const y = YMD[0] + div((YMD[1] - 3), 12);
	const m = mod(YMD[1] - 3, 12), d = YMD[2] - 1;
	return d + div((153 * m + 2), 5) + 365 * y + div(y, 4) - div(y, 100) + div(y, 400) - 678881 + (flag ? 2400001 : 0);
}

export function jdn2ymd(n, flag=false) {
	n = n + (flag ? 0 : 2400001);
	const a = 4 * (n + 1401 - 38 + div(div(4 * n + 274277, 146097) * 3, 4)) + 3;
	const b = 5 * div(mod(a, 1461), 4) + 2;
	const d = div(mod(b, 153), 5) + 1;
	const m = mod((div(b, 153) + 2), 12) + 1;
	const y = div(a, 1461) - 4716 + div(12 + 2 - m, 12);
	return [y, m, d];
}

export function initAngle(Y, tdiff = 9) { return (58 + 0.44 * (Y - 1990)) / 86400 - (tdiff / 24); }

export function SunDegree(T) {
	T /= 36525;
	const p180 = Math.PI / 180;
	const sl = [
		[0.0004, 31557, 161], [0.0004, 29930, 48], [0.0005, 2281, 221], [0.0005, 155, 118], [0.0006, 33718, 316], [0.0007, 9038, 64],
		[0.0007, 3035, 110], [0.0007, 65929, 45], [0.0013, 22519, 352], [0.0015, 45038, 254], [0.0018, 445267, 208], [0.0018, 19, 159],
		[0.002, 32964, 158], [-0.0048, 35999, 268], [0.02, 71998.1, 265.1], [1.9147, 35999.05, 267.52], [280.4659, 0, 0], [36000.7695, 0, 0]];
	const sum = sl.reduce((acc, t, i) => acc + t[0] * Math.cos((t[1] * T + t[2]) * p180) * (((i == 17) || (i == 13)) ? T : 1), 0);
	const d = -0.0057 + 0.0048 * Math.cos((1934 * T + 145) * p180);
	return r360(sum + d);
}

export function SunDegreeDay(year, degree) {
	let t0 = ymd2jdn([year, 1, 0]) - ymd2jdn([2000, 1, 1.5]);
	let r0 = SunDegree(t0);
	const ofs = (degree < r0) ? 360 : 0;
	let t = Math.floor((degree - r0 + ofs) * 0.9);
	while (1) {
		let r = SunDegree(t0 + t); 
		if (r < r0) r0 -= ofs;
		if ((r0 < degree) && (degree <= r)) {
			t += (degree - r) / (r - r0);
			return t + (degree - SunDegree(t0 + t)) / (r - r0);
		}
		r0 = r; 
		t++;
	}
}

