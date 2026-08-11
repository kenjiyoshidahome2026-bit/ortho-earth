#!/usr/bin/env node
// geodesic.js（WGS84 測地線＝段階A）の検証ハーネス。外部データ不要＝決定的。
//   1. 距離: Vincenty の古典検定値（Flinders Peak–Buninyong）・赤道 1/4 周・子午線 1/4 周
//   2. 近対蹠フォールバック: 有限・連続（±1% 以内）
//   3. 面積: 八分円（球論値と厳密一致）・経緯線矩形を「楕円体面素 M·N·cosφ の数値積分」と突合（独立式）
//   4. 曲率半径: N(0)=a・N/M の緯度依存の向き
// 使い方: node packages/ortho-core/tests/geodesic.mjs
import { geodesicDistance, geodesicArea, primeVerticalRadius, meridionalRadius,
         AUTHALIC_R, WGS84 } from '../src/geodesic.js';

let fails = 0;
const ok = (cond, label, detail = '') => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label} ${detail}`); };
const near = (v, ref, tol) => Math.abs(v - ref) <= tol;

console.log('― 距離（Vincenty）―');
// 古典検定（Geoscience Australia の Vincenty 例題。GDA/GRS80 だが WGS84 との差は mm 未満）
const dFB = geodesicDistance([144.42486789, -37.95103342], [143.92649553, -37.65282114]);
ok(near(dFB, 54972.271, 0.05), `Flinders–Buninyong = ${dFB.toFixed(3)} m（期待 54972.271）`);
// 赤道 1/4 周 = πa/2（赤道上の測地線＝cos²α=0 の分岐も踏む）
const dEq = geodesicDistance([0, 0], [90, 0]);
ok(near(dEq, Math.PI * WGS84.a / 2, 0.01), `赤道1/4周 = ${dEq.toFixed(3)} m（期待 ${(Math.PI * WGS84.a / 2).toFixed(3)}）`);
// 子午線 1/4 周 = 10001965.729 m（WGS84 楕円弧の定数）
const dMe = geodesicDistance([0, 0], [0, 90]);
ok(near(dMe, 10001965.729, 0.01), `子午線1/4周 = ${dMe.toFixed(3)} m（期待 10001965.729）`);
// 東京駅–大阪駅（桁の妥当性＝約400km・球式との差が0.5%未満）
const dTO = geodesicDistance([139.7671, 35.6812], [135.4959, 34.7338]);
ok(dTO > 390e3 && dTO < 405e3, `東京–大阪 = ${(dTO / 1000).toFixed(3)} km（390–405km 帯）`);
// 対称性（浮動小数の丸め＝最終ulpの差だけ許す）
ok(near(geodesicDistance([135, 34], [140, 36]), geodesicDistance([140, 36], [135, 34]), 1e-8), '対称性 d(a,b)=d(b,a)');
ok(geodesicDistance([139, 35], [139, 35]) === 0, '同一点 = 0');

console.log('― 近対蹠フォールバック ―');
const dAnti = geodesicDistance([0, 0.1], [179.9, -0.1]);
ok(Number.isFinite(dAnti) && near(dAnti, 20003e3, 0.01 * 20003e3), `近対蹠 = ${(dAnti / 1e3).toFixed(0)} km（有限・±1%）`);

console.log('― 面積（authalic 線積分）―');
// 八分円（赤道1辺＋子午線2辺のリング）＝楕円体表面積の 1/8 = π·R_A²/2。
// 極は両経度の頂点 (90,90)・(0,90) で挟む＝線積分（(λ, sinβ) 平面の台形則）に「経度の跳び」を正しく渡す作法。
const octant = geodesicArea([[0, 0], [90, 0], [90, 90], [0, 90]]);
const octRef = Math.PI * AUTHALIC_R * AUTHALIC_R / 2;
ok(near(octant, octRef, octRef * 1e-12), `八分円 = ${(octant / 1e12).toFixed(6)}e12 m²（= π·R_A²/2）`);
// 経緯線矩形（日本域 139–140°E × 35–36°N）を楕円体面素 dA = M(φ)N(φ)cosφ dφdλ の Simpson 数値積分と突合。
// authalic 写像はこの矩形で厳密（縁が等 authalic-正弦線）＝実装が正しければ数値積分誤差の範囲で一致する。
function bandAreaNumeric(lat1, lat2, dLonDeg) {
	const n = 2000, h = (lat2 - lat1) / n, D2R = Math.PI / 180;
	let s = 0;
	for (let i = 0; i <= n; i++) {
		const lat = lat1 + i * h;
		const f = meridionalRadius(lat) * primeVerticalRadius(lat) * Math.cos(lat * D2R);
		s += f * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
	}
	return s * h * D2R / 3 * dLonDeg * D2R;
}
const rect = geodesicArea([[139, 35], [140, 35], [140, 36], [139, 36]]);
const rectRef = bandAreaNumeric(35, 36, 1);
ok(near(rect, rectRef, rectRef * 1e-9), `1°×1°@35N = ${(rect / 1e6).toFixed(3)} km²（数値積分 ${(rectRef / 1e6).toFixed(3)}）`);
// 球（R=6371008.8＝旧 measure.js）との比較＝楕円体化の向き：dA=M·N·cosφ で M は赤道最小・極大。
// 赤道帯は球より狭く、高緯度帯は広い（総面積は R_A で保存）。日本（φ≈35°）はほぼ交差点＝面積補正は微小。
const sphRectAt = lat1 => {   // 旧式そのまま（1°×1°）
	const sphR = 6371008.8, D2R = Math.PI / 180;
	const v = [[139, lat1], [140, lat1], [140, lat1 + 1], [139, lat1 + 1]];
	let sum = 0;
	for (let i = 0; i < v.length; i++) {
		const p1 = v[i], p2 = v[(i + 1) % v.length];
		let dl = (p2[0] - p1[0]) * D2R;
		if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI;
		sum += dl * (2 + Math.sin(p1[1] * D2R) + Math.sin(p2[1] * D2R));
	}
	return Math.abs(sum) * sphR * sphR / 2;
};
const eq = geodesicArea([[139, 0], [140, 0], [140, 1], [139, 1]]);
const hi = geodesicArea([[139, 79], [140, 79], [140, 80], [139, 80]]);
ok(eq < sphRectAt(0) && hi > sphRectAt(79),
	`赤道帯は球より狭く高緯度帯は広い（赤道 ${(eq / 1e6).toFixed(1)}<${(sphRectAt(0) / 1e6).toFixed(1)}・79N ${(hi / 1e6).toFixed(1)}>${(sphRectAt(79) / 1e6).toFixed(1)} km²）`);
// リングの向き・閉点重複に不変
const rev = geodesicArea([[139, 36], [140, 36], [140, 35], [139, 35]]);
const dup = geodesicArea([[139, 35], [140, 35], [140, 36], [139, 36], [139, 35]]);
ok(near(rev, rect, rect * 1e-12) && near(dup, rect, rect * 1e-12), '向き反転・閉点重複に不変');

console.log('― 曲率半径 ―');
ok(near(primeVerticalRadius(0), WGS84.a, 1e-6), `N(0°) = a = ${primeVerticalRadius(0).toFixed(1)}`);
const N35 = primeVerticalRadius(35), M35 = meridionalRadius(35);
ok(N35 > 6384e3 && N35 < 6386e3 && M35 > 6355e3 && M35 < 6358e3, `N(35°)=${(N35 / 1e3).toFixed(1)}km・M(35°)=${(M35 / 1e3).toFixed(1)}km`);
ok(primeVerticalRadius(90) > primeVerticalRadius(0), 'N は極で最大');
ok(near(AUTHALIC_R, 6371007.18, 0.01), `R_A = ${AUTHALIC_R.toFixed(2)}（期待 6371007.18）`);

console.log(fails ? `\n${fails} 件失敗` : '\n全件通過');
process.exit(fails ? 1 : 0);
