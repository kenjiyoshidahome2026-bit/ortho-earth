// COPC の節の点を世界座標へ置く（点群計画 段 2-1・2026-10-15）。copc-worker.js から切り出した純関数（node で検定できる＝tests/t-copc-place.mjs）。
//   旧＝点ごとに投影（ll＝TM なら Krüger 6 次）と geoWorld を呼ぶ＝熱海の実測で 1 節 30 ms（LAZ の解読と同じだけ掛かっていた）。
//   新＝節の中で「原座標 → 世界座標」を二次式（中心・3×3 の一次の項・二次の項 6 つ×3 成分）で近似する。係数は節の中心まわりの差分（幅＝節の 1/4）で作り、
//   節の 8 隅＋面の中心 6 点で本物と比べる。ずれの最大が TOL_M（既定 1 cm）を超える節だけ従来の 1 点ずつに戻す（とても広い根の節）。
//   一次式だけでは熱海の根の節（400 m）で 1.07 cm ずれた（地球の丸み）＝二次の項が要る。
//   位置は Float32 の原点相対（原点＝節の中心の世界座標）・elev は m（高さは近似でなく素の z×単位＋dz＝段彩・分類の値を変えない）。
import { geoWorld } from "./meshdecode.js";

const D2R = Math.PI / 180;
export const TOL_M = 0.01;

/**
 * @param {{ x: Float64Array, y: Float64Array, z: Float64Array }} r  原座標（scale・offset を掛けた値）
 * @param {number} n  点の数
 * @param {{ ll: (p: number[]) => number[], vUnit: number, dz: number, EW: number, bounds: number[], tolM?: number }} o
 *   ll＝原座標 → 経緯度（度）・vUnit＝鉛直の単位（m）・dz＝高さに足す m（−N＋heightOffset）・EW＝世界 1 単位の m・bounds＝節の範囲（原座標）
 * @returns {{ pos: Float32Array, origin: number[], elev: Float32Array, affine: boolean, errM: number }}
 */
export function placeNode(r, n, { ll, vUnit, dz, EW, bounds: b, tolM = TOL_M }) {
	const pos = new Float32Array(n * 3), elev = new Float32Array(n), w = [0, 0, 0];
	const F = (x, y, z, out) => { const [lon, lat] = ll([x, y]); return geoWorld(lon * D2R, lat * D2R, (z * vUnit + dz) / EW, out); };
	const c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], h = [(b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2];
	const origin = F(c[0], c[1], c[2], [0, 0, 0]);
	for (let i = 0; i < n; i++) elev[i] = r.z[i] * vUnit + dz;
	// 二次式＝F(c+d) ≈ F0 + J·d + ½ dᵀ·H·d（成分ごと）。J・H は中心差分（幅 h/2）。曲率（地球の丸み・投影の歪み）は二次の項が持つ
	const e = h.map(v => v / 2 || 1), Fp = [], Fm = [], a = [0, 0, 0];
	for (let k = 0; k < 3; k++) { const p = c.slice(), m = c.slice(); p[k] += e[k]; m[k] -= e[k]; Fp.push(F(p[0], p[1], p[2], [0, 0, 0])); Fm.push(F(m[0], m[1], m[2], [0, 0, 0])); }
	const J = new Float64Array(9), H = new Float64Array(18);   // J[j*3+k]・H[j*6+(xx,yy,zz,xy,xz,yz)]（½ を含む係数）
	for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
		J[j * 3 + k] = (Fp[k][j] - Fm[k][j]) / (2 * e[k]);
		H[j * 6 + k] = (Fp[k][j] - 2 * origin[j] + Fm[k][j]) / (2 * e[k] * e[k]);
	}
	for (const [slot, k, l] of [[3, 0, 1], [4, 0, 2], [5, 1, 2]]) {
		const at = (sk, sl) => { const p = c.slice(); p[k] += sk * e[k]; p[l] += sl * e[l]; return F(p[0], p[1], p[2], [0, 0, 0]); };
		const pp = at(1, 1), pm = at(1, -1), mp = at(-1, 1), mm = at(-1, -1);
		for (let j = 0; j < 3; j++) H[j * 6 + slot] = (pp[j] - pm[j] - mp[j] + mm[j]) / (4 * e[k] * e[l]);
	}
	const model = (dx, dy, dz3, j) => { const q = j * 6;
		return J[j * 3] * dx + J[j * 3 + 1] * dy + J[j * 3 + 2] * dz3 + H[q] * dx * dx + H[q + 1] * dy * dy + H[q + 2] * dz3 * dz3 + H[q + 3] * dx * dy + H[q + 4] * dx * dz3 + H[q + 5] * dy * dz3; };
	// ずれの検査＝8 隅＋面の中心 6 点（差分に使っていない所）
	let err = 0;
	const probe = (sx, sy, sz) => {
		const dx = sx * h[0], dy = sy * h[1], dz3 = sz * h[2];
		F(c[0] + dx, c[1] + dy, c[2] + dz3, a);
		for (let j = 0; j < 3; j++) err = Math.max(err, Math.abs(origin[j] + model(dx, dy, dz3, j) - a[j]));
	};
	for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) probe(sx, sy, sz);
	for (const [sx, sy, sz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) probe(sx, sy, sz);
	const errM = err * EW;
	if (errM <= tolM) {
		const [j0, j1, j2, j3, j4, j5, j6, j7, j8] = J;
		for (let i = 0, o = 0; i < n; i++, o += 3) {
			const dx = r.x[i] - c[0], dy = r.y[i] - c[1], dzz = r.z[i] - c[2], xx = dx * dx, yy = dy * dy, zz = dzz * dzz, xy = dx * dy, xz = dx * dzz, yz = dy * dzz;
			pos[o] = j0 * dx + j1 * dy + j2 * dzz + H[0] * xx + H[1] * yy + H[2] * zz + H[3] * xy + H[4] * xz + H[5] * yz;
			pos[o + 1] = j3 * dx + j4 * dy + j5 * dzz + H[6] * xx + H[7] * yy + H[8] * zz + H[9] * xy + H[10] * xz + H[11] * yz;
			pos[o + 2] = j6 * dx + j7 * dy + j8 * dzz + H[12] * xx + H[13] * yy + H[14] * zz + H[15] * xy + H[16] * xz + H[17] * yz;
		}
		return { pos, origin, elev, affine: true, errM };
	}
	for (let i = 0, o = 0; i < n; i++, o += 3) {   // 従来＝1 点ずつ
		F(r.x[i], r.y[i], r.z[i], w);
		pos[o] = w[0] - origin[0]; pos[o + 1] = w[1] - origin[1]; pos[o + 2] = w[2] - origin[2];
	}
	return { pos, origin, elev, affine: false, errM };
}
