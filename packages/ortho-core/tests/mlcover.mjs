// MapLibre のタイルの z の選び方の検定（src/mlcover.js・selectLOD の zOf・2026-09-29）。node packages/ortho-core/tests/mlcover.mjs
// 守るもの：①傾き 60° 以下・地形なし＝画面の全部が floor(MapLibre の z)（raster は round・tileSize 256 は＋1）②selectLOD に zOf を渡すとその z で敷く（従来の閾は静止時に一段細かかった）
// ③地形あり・急な傾き＝距離の式（中心は z＋log2(1/cos(fov/2))・遠いほど粗い）④source の maxzoom（selectLOD の maxZ）で止まる ⑤zOf を渡さない既定の選び方は不変
import assert from "node:assert/strict";
import { mlTileZoomOf, mlCalculateTileZoom, ML_FOV_DEG } from "../src/mlcover.js";
import { selectLOD } from "../src/tilecover.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const D2R = Math.PI / 180;
const dzOf = lat => 1 + Math.log2(1 / Math.cos(lat * D2R));   // 目盛り "mercator"（globe zoomscale.js の mercatorDz と同式）
const W = 800, H = 600, LAT = 38.907, DZ = dzOf(LAT);
const camOf = (zML, pitchDeg = 0, bearingDeg = 0) => ({ center: [-77.04, LAT], zoom: zML + DZ, pitch: pitchDeg * D2R, bearing: bearingDeg * D2R, dpr: 1 });
const zs = sel => [...new Set(sel.map(t => t.z))].sort((a, b) => a - b);

t("傾き 0・地形なし＝floor（z11.15 → 11・z11.95 → 11）", () => {
	assert.equal(mlTileZoomOf(camOf(11.15), H, { dz: DZ })(11, 0, 0), 11);
	assert.equal(mlTileZoomOf(camOf(11.95), H, { dz: DZ })(11, 0, 0), 11);
});
t("整数の z の換算の誤差を切り捨てで落とさない（9 − 4e-10 → 9）", () => {
	assert.equal(mlTileZoomOf(camOf(9 - 4e-10), H, { dz: DZ })(0, 0, 0), 9);
	assert.equal(mlTileZoomOf(camOf(9 - 4e-10), H, { dz: DZ, terrain: true })(9, 146, 195), 9);   // 中心のタイル
});
t("raster＝round・tileSize 256 は＋1（z11.4 → 12・z11.6 → 13）", () => {
	assert.equal(mlTileZoomOf(camOf(11.4), H, { dz: DZ }, { tileSize: 256, round: true })(0, 0, 0), 12);
	assert.equal(mlTileZoomOf(camOf(11.6), H, { dz: DZ }, { tileSize: 256, round: true })(0, 0, 0), 13);
});
t("傾き 45°・60° も一定の z（MapLibre の maxConstantZoomPitch＝60）", () => {
	for (const p of [45, 60]) { const f = mlTileZoomOf(camOf(15.5, p), H, { dz: DZ }); assert.equal(f(15, 9000, 12000), 15); assert.equal(f(3, 2, 3), 15); }
});
t("selectLOD＋zOf：z11.15 の画面は全部 z11（従来の静止時の閾 384×bias は z12 を選んでいた）", () => {
	const cam = camOf(11.15), bias = 2 ** (DZ - 1);
	const ml = selectLOD(cam, W, H, { minZ: 0, maxZ: 14, zOf: mlTileZoomOf(cam, H, { dz: DZ }) });
	assert.deepEqual(zs(ml), [11]);
	assert.ok(ml.length >= 2 && ml.length <= 9, `tiles ${ml.length}`);
	assert.deepEqual(zs(selectLOD(cam, W, H, { minZ: 0, maxZ: 14, tilePx: 384 * bias })), [12]);   // 旧の選び（静止時の手前詳細化）＝記録
});
t("selectLOD＋zOf：傾き 45° でも一段（z15）", () => {
	const cam = camOf(15.5, 45);
	assert.deepEqual(zs(selectLOD(cam, W, H, { minZ: 0, maxZ: 16, zOf: mlTileZoomOf(cam, H, { dz: DZ }) })), [15]);
});
t("source の maxzoom（maxZ）で止まる＝z16.5 でも 14", () => {
	const cam = camOf(16.5);
	assert.deepEqual(zs(selectLOD(cam, W, H, { minZ: 0, maxZ: 14, zOf: mlTileZoomOf(cam, H, { dz: DZ }) })), [14]);
});
t("地形あり＝距離の式：傾き 0 の中心は z＋log2(1/cos(fov/2))（z11.95 → 12）", () => {
	const f = mlTileZoomOf(camOf(11.95), H, { dz: DZ, terrain: true });
	const x = Math.floor((-77.04 + 180) / 360 * 2 ** 12), y = 1566;
	assert.equal(f(12, x, y), 12);
	assert.ok(Math.abs(mlCalculateTileZoom(11.95, 0, 1, 1, ML_FOV_DEG) - (11.95 + Math.log2(1 / Math.cos(ML_FOV_DEG / 2 * D2R)))) < 1e-9);
});
t("急な傾き（70°）＝遠いほど粗い・画面に z が 2 段以上", () => {
	const cam = camOf(14, 70), f = mlTileZoomOf(cam, H, { dz: DZ });
	const sel = selectLOD(cam, W, H, { minZ: 0, maxZ: 16, zOf: f });
	assert.ok(zs(sel).length >= 2, `zs ${zs(sel)}`);
	const x = 4685, y = 6267;   // z14 の中心のタイル（ワシントン）・北＝画面の奥
	assert.equal(f(14, x, y), 14);
	assert.ok(f(14, x, y - 20) < f(14, x, y - 2) && f(14, x, y - 2) <= 14, `奥ほど粗い ${f(14, x, y - 20)} ${f(14, x, y - 2)}`);
});
t("zOf を渡さない既定の選び方は不変（z11.15・560×bias で z11／z11.6 で z12）", () => {
	const bias = 2 ** (DZ - 1);
	assert.deepEqual(zs(selectLOD(camOf(11.1), W, H, { minZ: 0, maxZ: 14, tilePx: 560 * bias })), [11]);
	assert.deepEqual(zs(selectLOD(camOf(11.6), W, H, { minZ: 0, maxZ: 14, tilePx: 560 * bias })), [12]);
});
console.log(`mlcover: ${n} passed`);
