// WGS84 測地線（段階A＝計測値だけ楕円体）。表示は単位球のまま、利用者へ見せる「数字」だけ本物にする。
// 依存ゼロの純関数＝Node ハーネス（tests/geodesic.mjs）でそのまま検証できる。
// - 距離 geodesicDistance: Vincenty 逆解（収束時 0.5mm 級）。近対蹠（≈179.4°超＝日本域の計測ではまず出ない）
//   だけ収束しないので authalic 球の haversine へ退避（誤差 <0.6%・有限値を返すことを優先）。
// - 面積 geodesicArea: 緯度を authalic（等積）緯度 β＝asin(q(φ)/q_p) に写し、半径 R_A の球の上で
//   辺を大円とした球面過剰（辺ごとに tan(E/2)＝tan(Δλ/2)(t1+t2)/(1+t1·t2)、t＝tan(β/2)）の厳密和 × R_A²。
//   緯度依存の系統誤差（球比 最大0.5%）を吸収し、辺は計測の弧（measure.js の gcPoints＝大円）と同じ形。
//   GeographicLib（WGS84 の測地線多角形）との差：東京–大阪–札幌で 0.011%、100km の三角形で 0.00016%。
//   旧式（Chamberlain–Duquette の台形＝辺を (λ, sinβ) 平面の直線とみなす）は辺が長いほど系統的に小さく、
//   東京–大阪–札幌で −7.4%、100km の三角形で −0.37% だった（2026-09-25 交代）。
// - 曲率半径 N/M: 卯酉線 N(φ)＝東西の m/px 換算（スケールバー・印刷縮尺）、子午線 M(φ)＝南北。
//   東西と南北で最大0.5%違う（φ=35°: N≈6385.2km・M≈6356.4km）＝バーは横置き＝東西の N を使う。
const D2R = Math.PI / 180;
const A = 6378137, F = 1 / 298.257223563;               // WGS84 長半径・扁平率
const B = A * (1 - F), E2 = F * (2 - F), E = Math.sqrt(E2);

export const WGS84 = { a: A, b: B, f: F, e2: E2 };

// authalic（等積）緯度の道具立て：q(φ) と q_p。sin(β_authalic) = q/q_p、R_A² = a²·q_p/2。
function qOf(sinLat) {
	const s = sinLat;
	return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
}
const QP = qOf(1);
export const AUTHALIC_R = A * Math.sqrt(QP / 2);        // ≈ 6371007.18 m（面積等価球の半径）
// authalic 緯度 β（rad）：楕円体の面積を R_A の球へ正積に写す緯度（β(±90°)＝±π/2）。
function authalicLat(latDeg) { return Math.asin(Math.max(-1, Math.min(1, qOf(Math.sin(latDeg * D2R)) / QP))); }

// 卯酉線曲率半径 N(φ)：東西方向の「1radの地心経度差×cosφ が何mか」の芯。スケールバー・印刷縮尺用。
export function primeVerticalRadius(latDeg) {
	const s = Math.sin(latDeg * D2R);
	return A / Math.sqrt(1 - E2 * s * s);
}
// 子午線曲率半径 M(φ)：南北方向。
export function meridionalRadius(latDeg) {
	const s = Math.sin(latDeg * D2R);
	const w2 = 1 - E2 * s * s;
	return A * (1 - E2) / (w2 * Math.sqrt(w2));
}

// Vincenty 逆解：2点 [lon,lat](deg) → 測地線距離 m。収束時の誤差 0.5mm 級。
export function geodesicDistance(p1, p2) {
	const L = (p2[0] - p1[0]) * D2R;
	const U1 = Math.atan((1 - F) * Math.tan(p1[1] * D2R)), U2 = Math.atan((1 - F) * Math.tan(p2[1] * D2R));
	const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
	let lam = L, sSig = 0, cSig = 0, sig = 0, cos2Alpha = 0, cos2SigM = 0;
	for (let i = 0; i < 100; i++) {
		const sLam = Math.sin(lam), cLam = Math.cos(lam);
		sSig = Math.hypot(cU2 * sLam, cU1 * sU2 - sU1 * cU2 * cLam);
		if (sSig === 0) return 0;                                       // 同一点
		cSig = sU1 * sU2 + cU1 * cU2 * cLam;
		sig = Math.atan2(sSig, cSig);
		const sAlpha = cU1 * cU2 * sLam / sSig;
		cos2Alpha = 1 - sAlpha * sAlpha;
		cos2SigM = cos2Alpha !== 0 ? cSig - 2 * sU1 * sU2 / cos2Alpha : 0;   // 赤道上の測地線は cos2Alpha=0
		const C = F / 16 * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
		const prev = lam;
		lam = L + (1 - C) * F * sAlpha * (sig + C * sSig * (cos2SigM + C * cSig * (-1 + 2 * cos2SigM * cos2SigM)));
		if (Math.abs(lam - prev) <= 1e-12) {
			const u2 = cos2Alpha * (A * A - B * B) / (B * B);
			const kA = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
			const kB = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
			const dSig = kB * sSig * (cos2SigM + kB / 4 * (cSig * (-1 + 2 * cos2SigM * cos2SigM)
				- kB / 6 * cos2SigM * (-3 + 4 * sSig * sSig) * (-3 + 4 * cos2SigM * cos2SigM)));
			return B * kA * (sig - dSig);
		}
	}
	// 近対蹠のみここへ（Vincenty の既知の非収束域）。authalic 球 haversine＝有限で連続な近似を返す。
	const f1 = p1[1] * D2R, f2 = p2[1] * D2R, df = f2 - f1, dl = L;
	const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
	return 2 * AUTHALIC_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 楕円体の多角形面積 m²：閉リング（[lon,lat] の配列・末尾の重複閉点は有っても無くても可）。辺は大円（authalic 球の上）。
// 各辺の寄与＝Δλ（南極から測る帯の項）＋赤道と辺の間の球面過剰。Δλ を [-π,π] へ畳む（antimeridian 跨ぎ）。
// 極を囲むリングは南極側の面積が出るので、全球 4πR_A² との小さい方を返す（半球を超える多角形は扱わない）。
export function geodesicArea(ring) {
	if (ring.length < 3) return 0;
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
		let dl = (p2[0] - p1[0]) * D2R;
		if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI;
		const t1 = Math.tan(authalicLat(p1[1]) / 2), t2 = Math.tan(authalicLat(p2[1]) / 2);
		sum += dl + 2 * Math.atan2(Math.sin(dl / 2) * (t1 + t2), Math.cos(dl / 2) * (1 + t1 * t2));
	}
	const a = Math.abs(sum) * AUTHALIC_R * AUTHALIC_R, whole = 4 * Math.PI * AUTHALIC_R * AUTHALIC_R;
	return Math.min(a, whole - a);
}
