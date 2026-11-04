// 計測の数値の表示整形（ortho-map の FIX/FIXA に合わせる）。measure と profile が同じ刻みを別々に持っていた＝一本化（2026-11-05）

/** 3 桁ごとの区切り */
export function comma(n: string | number): string { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

/** m 入力：<100m=小数1m ／ <1km=整数m ／ <10km=小数2km ／ <100km=小数1km ／ 以上=整数km */
export function fmtDist(m: number): string {
	const km = m / 1000, c = (v: number, n: number) => comma(v.toFixed(n));
	return km < 0.1 ? c(m, 1) + " m" : km < 1 ? c(Math.round(m), 0) + " m" : km < 10 ? c(km, 2) + " km" : km < 100 ? c(km, 1) + " km" : c(km, 0) + " km";
}
