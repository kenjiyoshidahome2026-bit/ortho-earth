// 投影とカメラの検定（純関数＝Node）。落ちたら地図の「余白なし」「錨」「往復」が壊れている
import assert from "node:assert/strict";
import { yOfLat, latOfY, kOfLat, Y_MAX, X_MAX, halfWidthAtY, pxPerUnit, unproject, anchorView, clampView, minZoomFor, fullZoomFor, wrapLon } from "../src/equalearth.js";

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);

// 1) y(φ) の往復と単調性・極の高さ（Šavrič et al. 2018: y(90°)≈1.3174）
for (let lat = -90; lat <= 90; lat += 7.5) near(latOfY(yOfLat(lat)), lat, 1e-9, `latOfY∘yOfLat ${lat}`);
near(Y_MAX, 1.3173627591574, 1e-9, "Y_MAX");
near(X_MAX, Math.PI * kOfLat(0), 1e-12, "X_MAX");
let prev = -Infinity; for (let lat = -90; lat <= 90; lat += 1) { const y = yOfLat(lat); ok(y > prev, `y 単調 ${lat}`); prev = y; }
ok(kOfLat(90) > 0.4, "平極＝極でも横倍率が 0 にならない");
ok(halfWidthAtY(0) > halfWidthAtY(1.0) && halfWidthAtY(1.0) > halfWidthAtY(Y_MAX), "外形は凸＝半幅は |y| に単調減少");

// 2) 正積：緯度帯の面積が球と一致（∫ x·dy）。帯 [φ1,φ2] の投影面積 = 2·π·k(φ)·dy を数値積分 vs 球の 2π(sinφ2−sinφ1)
const bandArea = (a, b) => { let s = 0; const N = 2000; for (let i = 0; i < N; i++) { const l1 = a + (b - a) * i / N, l2 = a + (b - a) * (i + 1) / N; s += 2 * Math.PI * kOfLat((l1 + l2) / 2) * (yOfLat(l2) - yOfLat(l1)); } return s; };
for (const [a, b] of [[0, 30], [30, 60], [60, 89], [-45, 45]]) near(bandArea(a, b), 2 * Math.PI * (Math.sin(b * Math.PI / 180) - Math.sin(a * Math.PI / 180)), 2e-3, `正積 ${a}..${b}`);

// 3) 錨と unproject の往復：画面の点 (sx,sy) に (lon,lat) を置いたカメラで、そこを unproject すると同じ経緯度
for (const [lon, lat, sx, sy, z] of [[139.7, 35.7, 200, -100, 4], [-170, -40, -500, 300, 3], [10, 80, 0, -350, 2.6], [179.9, 0, 630, 0, 5]]) {
	const v = anchorView(lon, lat, sx, sy, z);
	const ll = unproject(v, sx, sy);
	ok(ll, `unproject ${lon},${lat}`); near(wrapLon(ll[0] - lon), 0, 1e-7, `錨 lon ${lon}`); near(ll[1], lat, 1e-7, `錨 lat ${lat}`);
}
ok(unproject({ lon: 0, lat: 0, zoom: 3 }, 0, 100000) === null, "外形の外（極の向こう）は null");
ok(unproject({ lon: 0, lat: 0, zoom: 3 }, 100000, 0) === null, "外形の外（裏経線の向こう）は null");

// 4) 縮小下限＝赤道の幅がちょうど画面幅・余白なしズームはその上
for (const [W, H] of [[1280, 720], [390, 844], [2560, 1440]]) {
	const zmin = minZoomFor(W); near(pxPerUnit(zmin) * 2 * X_MAX, W, 1e-6, `zmin ${W}`);
	ok(fullZoomFor(W, H) >= zmin - 1e-9, `full ≥ min ${W}x${H}`);
	// 余白なしズームでは画面矩形が外形の内側
	const zf = fullZoomFor(W, H), s = pxPerUnit(zf), hu = H / 2 / s, wu = W / 2 / s;
	ok(hu <= Y_MAX + 1e-9 && wu <= halfWidthAtY(hu) + 1e-9, `full の画面矩形 ⊂ 外形 ${W}x${H}`);
	// clampView：z の範囲・中心の可動域（余白なしズームで極線が画面に入らない・下限では中心 0）
	const c1 = clampView({ lon: 500, lat: 89, zoom: zf }, W, H, 8);
	ok(c1.lon > -180 && c1.lon <= 180, "lon 正規化");
	ok(yOfLat(c1.lat) + hu <= Y_MAX + 1e-6, `余白なしズームで極線が画面の外 ${W}x${H}`);
	const c2 = clampView({ lon: 0, lat: 89, zoom: -10 }, W, H, 8);
	near(c2.zoom, zmin, 1e-9, "z 下限"); 
	const c3 = clampView({ lon: 0, lat: 0, zoom: 99 }, W, H, 8); near(c3.zoom, 8, 1e-9, "z 上限");
}
console.log(`t-equalearth: ${n} ok`);
