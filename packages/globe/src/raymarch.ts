// 光線を手前から奥へ歩いて最初に地面をまたぐ所を二分で詰める（地形の上の unproject・2026-11-02）。
// 旧＝球の半径を当たった点の持ち上げで置き直す不動点の反復は、急斜面で視線と斜面の角が浅いと別の斜面へ飛んだ
//（公式例 display-a-hybrid-satellite-map-with-terrain-elevation で戻りの誤差の中央値 2 km・傾斜 20° 以上の 69% が外れ）。
// 歩く量＝球の半径 R：大きい球の手前の交点ほど目に近い＝R を上から 1 へ下げると交点が光線を奥へ進む。
// f(R)＝R − 当たった点の持ち上げ（lift(h)）。正＝地面より上。上限＝目の半径か 9000 m の持ち上げの小さい方
import type { LonLat } from "@ortho-earth/core";

export const RAY_STEPS = 96, RAY_BISECT = 24;
type St = { eye: number[] };
export function marchRay(st: St, _sx: number, _sy: number, at: (R: number) => LonLat | null, lift: (h: number) => number, hOf: (lon: number, lat: number) => number): LonLat | null {
	const top = Math.min(Math.hypot(st.eye[0], st.eye[1], st.eye[2]), lift(9000));
	if (!(top > 1)) return at(1);
	const fOf = (R: number, P: LonLat) => R - lift(hOf(P[0], P[1]));   // 正＝地面より上
	const P0 = at(top);
	if (!P0) return at(1);
	if (fOf(top, P0) <= 0) return P0;   // 目が地面の下（一番手前でもう地中）
	// 上（f>0）の R と下（f≤0）の R の間を二分で詰める
	const bisect = (hiR: number, loR: number, loP: LonLat) => {
		for (let j = 0; j < RAY_BISECT; j++) { const mR = (hiR + loR) / 2, mP = at(mR); if (!mP) break; if (fOf(mR, mP) > 0) hiR = mR; else { loR = mR; loP = mP; } }
		return loP;
	};
	// かすめる尾根：標本の間で f が谷を作って 0 を下回る（標本では正のまま）＝三分探索で谷の底を探し、0 以下なら手前から二分
	const dip = (aR: number, bR: number): [number, LonLat] | null => {
		let lo = bR, hi = aR;   // hi＞lo（R は奥ほど小さい）
		for (let j = 0; j < 30; j++) {
			const m1 = hi - (hi - lo) / 3, m2 = lo + (hi - lo) / 3, p1 = at(m1), p2 = at(m2); if (!p1 || !p2) return null;
			const f1 = fOf(m1, p1), f2 = fOf(m2, p2);
			if (f1 <= 0) return [m1, p1]; if (f2 <= 0) return [m2, p2];
			if (f1 < f2) lo = m2; else hi = m1;
		}
		return null;
	};
	const dR = (1 - top) / RAY_STEPS;
	let pR = top, pF = fOf(top, P0), qR = NaN, qF = Infinity, lastP = P0;   // p＝一つ前・q＝二つ前
	for (let i = 1; i <= RAY_STEPS; i++) {
		const R = top + dR * i, P = at(R);
		if (!P) { const d = dip(pR, pR + (R - pR) * 0.999); return d ? bisect(pR, d[0], d[1]) : null; }   // 光線が球の下を通らなくなった＝その手前にかすめが無いか
		const f = fOf(R, P);
		if (f <= 0) return bisect(pR, R, P);
		if (pF < qF && pF < f && pF < -dR * 2) {   // 一つ前が谷（f が小さく、前後より低い）
			const d = dip(qR, R); if (d) return bisect(qR, d[0], d[1]);
		}
		qR = pR; qF = pF; pR = R; pF = f; lastP = P;
	}
	return lastP;
}
