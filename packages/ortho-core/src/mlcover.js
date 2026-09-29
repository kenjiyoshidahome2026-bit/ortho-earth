// MapLibre のタイルの z の選び方（coveringTiles・6.11.2 の dist を読んで写した）。
// 目盛り "mercator"／"maplibre"（MapLibre の口）で、描く・問い合わせるタイルの z を本物と同じにする。
// エンジンの既定の選び方（tilecover.selectLOD＝画面上の大きさの閾＋静止時の手前詳細化）は、内製アプリの目盛り（ortho）ではそのまま。
//   ・一定の z＝floor(MapLibre の z＋log2(512／tileSize))（raster は round＝roundZoom）。傾き ≤ clamp(78.5−fov/2, 0, 60)° で地形なしの時
//   ・それ以外（地形あり・急な傾き）＝タイルごとに defaultCalculateTileZoom（距離と見込み角で遠いほど粗く）
// 距離はすべて MapLibre のメルカトル単位（世界＝1）で、MapLibre のカメラ（fov 36.87°・画面の高さ CSS px）から組む＝エンジンのカメラの fovy に依らない。
// 近似（記録）：globe 投影の例（MapLibre の globe は z>4 で距離式）もメルカトルの規則で選ぶ・可視判定は selectLOD のまま。依存なし。
const D2R = Math.PI / 180;
export const ML_FOV_DEG = 36.86989764584402;   // MapLibre の既定の縦の視野角（2·atan(3/4)）
const MAX_HORIZON_DEG = 89.25;                 // maxMercatorHorizonAngle
const ZEPS = 1e-6;                             // 整数の z の境の遊び（エンジンの z − dz の往復で 1e-9 程度ずれる）
const mercY = lat => { const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

function integralOfCosXByP(p, x1, x2) {
	const n = 10, dx = (x2 - x1) / n;
	let sum = 0;
	for (let i = 0; i < n; i++) sum += dx * Math.pow(Math.cos(x1 + (i + 0.5) / n * (x2 - x1)), p);
	return sum;
}
// createCalculateTileZoomFunction(9.314, 3)＝MapLibre の defaultCalculateTileZoom
export function mlCalculateTileZoom(centerZ, dist2D, distZ, dist3DCenter, fovDeg, maxLevels = 9.314, maxMinRatio = 3) {
	const behavior = 2 * ((maxLevels - 1) / Math.log2(Math.cos((MAX_HORIZON_DEG - fovDeg) * D2R) / Math.cos(MAX_HORIZON_DEG * D2R)) - 1);
	const centerPitch = Math.acos(distZ / dist3DCenter);
	const count0 = 2 * integralOfCosXByP(behavior - 1, 0, fovDeg / 2 * D2R);
	const hi = Math.min(MAX_HORIZON_DEG * D2R, centerPitch + fovDeg / 2 * D2R), lo = Math.min(hi, centerPitch - fovDeg / 2 * D2R);
	const count = integralOfCosXByP(behavior - 1, lo, hi);
	const tilePitch = Math.atan(dist2D / distZ), dist3D = Math.hypot(dist2D, distZ);
	let z = centerZ + Math.log2(dist3DCenter / dist3D / Math.max(0.5, Math.cos(fovDeg / 2 * D2R)));
	z += behavior * Math.log2(Math.cos(tilePitch)) / 2;
	z -= Math.log2(Math.max(1, count / count0 / maxMinRatio)) / 2;
	return z;
}

// cam＝エンジンのカメラ（center [lon,lat]・zoom＝エンジン z・pitch/bearing＝ラジアン）。cover＝{ dz（エンジン z − MapLibre z）, fovDeg?, terrain? }。
// Hcss＝画面の高さ（CSS px）。tileSize＝source のタイルの大きさ（vector 512・raster 既定 512）。round＝raster（MapLibre の roundZoom）。
// 返す＝(z, x, y) → そのタイルで MapLibre が望む z（整数・0 以上・source の maxzoom では切らない＝selectLOD の maxZ が切る）
export function mlTileZoomOf(cam, Hcss, cover, { tileSize = 512, round = false } = {}) {
	const rnd = round ? v => Math.round(v + ZEPS) : v => Math.floor(v + ZEPS);   // ZEPS＝目盛りの換算の誤差（z9 が 8.9999999996 になって一段粗くなった＝o45）
	const zML = cam.zoom - (cover.dz || 0), fov = cover.fovDeg || ML_FOV_DEG;
	const centerZ = zML + Math.log2(512 / (tileSize || 512));
	const pitchDeg = (cam.pitch || 0) / D2R;
	const maxConstPitch = Math.max(0, Math.min(60, 78.5 - fov / 2));
	if (!cover.terrain && pitchDeg <= maxConstPitch) { const z = Math.max(0, rnd(centerZ)); return () => z; }
	// カメラの位置（メルカトル単位）＝cameraMercatorCoordinateFromCenterAndRotation と同じ組み方
	const d = (Hcss / 2) / Math.tan(fov / 2 * D2R) / (512 * 2 ** zML);
	const b = (cam.bearing || 0) / D2R, p = pitchDeg * D2R;
	const dzM = d * Math.cos(p), dhM = d * Math.sin(p);
	const cx = (cam.center[0] + 180) / 360 + dhM * Math.sin(-b * D2R), cy = mercY(cam.center[1]) + dhM * Math.cos(-b * D2R);
	return (z, x, y) => {
		const N = 2 ** z, x0 = x / N, y0 = y / N, s = 1 / N;
		let dx = Infinity;
		for (const w of [-1, 0, 1]) { const a = x0 + w; dx = Math.min(dx, cx < a ? a - cx : cx > a + s ? cx - a - s : 0); }   // 東西は巻いて近い方
		const dy = cy < y0 ? y0 - cy : cy > y0 + s ? cy - y0 - s : 0;
		return Math.max(0, rnd(mlCalculateTileZoom(centerZ, Math.hypot(dx, dy), dzM, d, fov)));
	};
}
