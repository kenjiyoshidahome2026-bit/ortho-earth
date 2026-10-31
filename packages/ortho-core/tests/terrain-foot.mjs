// 足元層（fine・2026-10-31）：画面下端の視線が目から 1.5 km 以内で地面に当たる時だけ、当たり所を含む 1/512°〜1/32° の窓を返す（terrain.ts footWindow）。
// fog（Cesium 例）：目 3,639 m・画面下端の山は 174 m 先（Cesium の pickPosition）＝近景層（13 m/texel）では団子＝足元層 1/64°（≈1.7 m/texel）が要る
import { cameraState } from "../src/camera.ts";
import { footWindow } from "../src/terrain.ts";
import { TERRAIN_FS, BUILDING_VS } from "../src/gl/glsl.ts";
import { TERRAIN_WGSL } from "../src/gpu/wgsl.ts";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails++; };
const D2R = Math.PI / 180, W = 640, H = 480, fovy = 2 * Math.atan(Math.tan(30 * D2R) * H / W), earthM = 6371000;
const cam = { center: [-119.37102309016926, 37.976781000181134], zoom: 14.806762303379891, pitch: 74.63 * D2R, bearing: 257.3648 * D2R, roll: 0, dpr: 1, near: 1, fovy, centerAlt: 2836.25 };
const st = cameraState(cam, W, H), size = { w: W, h: H };
const hEye = (Math.hypot(st.eye[0], st.eye[1], st.eye[2]) - 1) * earthM;
ok(Math.abs(hEye - 3639) < 30, `目の高さ ${hEye.toFixed(0)} m（Cesium 3,639 m）`);
{
	const w = footWindow(st, size, cam, earthM, () => 3500);   // 平らな 3,500 m の地面＝目の 139 m 下＝下端の視線（水平から 38.8° 下）は約 220 m 先で当たる
	ok(w && w.dist > 150 && w.dist < 300, `3,500 m の地面：${w ? w.dist.toFixed(0) : "-"} m 先で当たる`);
	ok(w && w.span === 1 / 64, `窓は 1/64°（${w?.span}）`);
	ok(w && w.lng0 <= -119.34 && w.lng0 + w.span >= -119.34 && w.lat0 <= 37.98 && w.lat0 + w.span >= 37.98, `窓は当たり所（−119.34, 37.98）を含む（${w?.lng0.toFixed(4)}..${(w.lng0 + w.span).toFixed(4)} × ${w?.lat0.toFixed(4)}..${(w.lat0 + w.span).toFixed(4)}）`);
	ok(Math.abs(w.lng0 / (w.span / 8) - Math.round(w.lng0 / (w.span / 8))) < 1e-9, "原点は幅/8 の格子");
}
{
	const w = footWindow(st, size, cam, earthM, () => 1000);   // 地面が 2.6 km 下＝下端の視線は 4 km 先＝足元層なし
	ok(w === null, `1,000 m の地面：窓なし（${JSON.stringify(w)}）`);
}
{
	const w = footWindow(st, size, cam, earthM, () => NaN);   // 標高が無い（NaN）＝当たらない＝なし
	ok(w === null, "標高なし：窓なし");
}
{
	const w = footWindow(st, size, cam, earthM, () => 3630);   // 目の 9 m 下の地面＝当たり所は十数 m 先＝最小の 1/512°
	ok(w && w.span === 1 / 512 && w.dist < 40, `目のすぐ下の地面：1/512°（${w?.span}・${w?.dist.toFixed(0)} m）`);
}
{
	// high-dynamic-range：中央下の視線は谷底（1.1 km）・左下の視線は崖（222 m）＝近い方（崖）で窓を決める。地面＝目の西側（崖）だけ高い
	const camH = { center: [-111.82636351289267, 36.26944167032575], zoom: 14.010310524673507, pitch: 87.5697 * D2R, bearing: 353.282 * D2R, roll: 0.1249 * D2R, dpr: 1, near: 1, fovy, centerAlt: 1054.62 };
	const stH = cameraState(camH, W, H);
	const ground = (lon) => lon < -111.8201 ? 1240 : 820;   // 崖の上（西）1,240 m・谷底 820 m（Cesium の pickPosition）
	const w = footWindow(stH, size, camH, earthM, ground);
	ok(w && w.dist < 400 && w.span <= 1 / 64, `左下の崖（${w ? w.dist.toFixed(0) : "-"} m）で窓を決める（${w?.span}）`);
	const wc = footWindow(stH, size, camH, earthM, () => 820);   // 崖が無ければ谷底（1.1 km）＝1/32°
	ok(wc && wc.dist > 900 && wc.span === 1 / 32, `谷底だけなら ${wc ? wc.dist.toFixed(0) : "-"} m・1/32°（${wc?.span}）`);
}
// シェーダ：足元層は近景テクスチャの右半分・近景は左半分（u×0.5）・近景メッシュパスは足元窓の内側を discard・足元パス（3）は足元 1 texel の歩幅
ok(/elevFine\(/.test(TERRAIN_FS) && /vec2\(0\.5 \+ uv\.x \* 0\.5, uv\.y\)/.test(TERRAIN_FS) && /vec2\(uv\.x \* 0\.5, uv\.y\)/.test(TERRAIN_FS), "GLSL ELEV：右半分＝足元層・左半分＝近景層");
ok(/u_hasFine > 0\.5[^\n]*win = u_fineBounds/.test(BUILDING_VS), "GLSL QELEV（建物の VS）：足元窓の内側は足元の格子");
ok(/u_farPass > 1\.5 && u_farPass < 2\.5 && u_hasFine > 0\.5/.test(TERRAIN_FS) && /u_farPass > 2\.5 \? u_fineBounds\.w : u_nearBounds\.w/.test(TERRAIN_FS), "GLSL TERRAIN_FS：近景パスの discard・足元パスの歩幅");
const WG = TERRAIN_WGSL;
ok(/fn elevFine\(/.test(WG) && /vec2f\(0\.5 \+ uv\.x \* 0\.5, uv\.y\)/.test(WG) && /vec2f\(uv\.x \* 0\.5, uv\.y\)/.test(WG), "WGSL：右半分＝足元層・左半分＝近景層");
ok(/F\.fineP\.x > 0\.5[^\n]*win = F\.fineBounds/.test(WG) && /F\.farP\.z > 1\.5 && F\.farP\.z < 2\.5 && F\.fineP\.x > 0\.5/.test(WG) && /select\(F\.nearBounds\.w, F\.fineBounds\.w, F\.farP\.z > 2\.5\)/.test(WG), "WGSL：elevQ の窓・近景パスの discard・足元パスの歩幅");
if (fails) { console.error(`FAIL ${fails}`); process.exit(1); }
console.log("PASS terrain-foot");
