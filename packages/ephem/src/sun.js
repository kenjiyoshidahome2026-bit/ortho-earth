// 地球から見た太陽と空の向き（#42・2026-09-23）＝地図の夜の側（太陽直下点）と星空（恒星時）の正本。
// 描画（ortho-core の GL / WebGPU）と solar が同じ式で「その時刻」を描く（旧＝描画側に赤緯の正弦近似と別の恒星時の式が複製されていた）。
// 時刻は ms（UTC エポック）で受ける＝共通の時計（ephem/clock）の clockNow をそのまま渡せる。
import { bodyPos, D2R } from "./index.js";
import { gmst, jdOf } from "./sgp4.js";
const EPS = 23.43928 * D2R;
// グリニッジ平均恒星時（rad・IAU-82）
export const gmstAt = ms => gmst(jdOf(ms));
// 太陽直下点 [経度, 緯度]（rad）。地球の日心黄道位置（JPL 近似要素）の反対向き＝地心の太陽→黄経に歳差（1.397°/世紀）を足して今期の春分点へ→赤道→赤経−恒星時。
// 均時差も入る（旧の「UTC 時刻→経度」は最大 ±4° ずれた）。精度は約 0.05°（夜の側の境目には十分）
export function sunSubpoint(ms) {
	const e = bodyPos("earth", new Date(ms)), T = (ms / 864e5 + 2440587.5 - 2451545.0) / 36525;
	const x = -e[0], y = -e[1], z = -e[2];
	const lam = Math.atan2(y, x) + 1.396971 * T * D2R, beta = Math.atan2(z, Math.hypot(x, y));
	const cb = Math.cos(beta), ex = cb * Math.cos(lam), ey = cb * Math.sin(lam), ez = Math.sin(beta);
	const qy = ey * Math.cos(EPS) - ez * Math.sin(EPS), qz = ey * Math.sin(EPS) + ez * Math.cos(EPS);
	const ra = Math.atan2(qy, ex), dec = Math.asin(Math.max(-1, Math.min(1, qz)));
	let lon = ra - gmstAt(ms);
	lon = ((lon + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
	return [lon, dec];
}
