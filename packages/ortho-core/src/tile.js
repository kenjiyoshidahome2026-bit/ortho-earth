// Web Mercator タイル座標 ⇄ 経緯度。MVT のタイルローカル座標(0..extent) を経緯度へ戻すのに使う。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function lonLatToTile(lon, lat, z) {
	const n = 1 << z;
	const x = Math.floor((lon / 360 + 0.5) * n);
	const y = Math.floor((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2 * n);
	return [x, y];
}

// タイルローカル座標 (px,py ∈ [0,extent]) → 経緯度。extent は各 source-layer が持つ（通常4096）。
export function tileLocalToLonLat(x, y, z, px, py, extent) {
	const n = 1 << z;
	const wx = (x + px / extent) / n;         // 世界メルカトル [0,1]
	const wy = (y + py / extent) / n;
	const lon = wx * 360 - 180;
	const lat = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * wy))) - Math.PI / 2);
	return [lon, lat];
}

// タイル {x,y,z} の経緯度境界（west,south,east,north）
export function tileBounds(x, y, z) {
	const n = 1 << z;
	const lon0 = x / n * 360 - 180, lon1 = (x + 1) / n * 360 - 180;
	const lat0 = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y / n))) - Math.PI / 2);
	const lat1 = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * (y + 1) / n))) - Math.PI / 2);
	return [lon0, lat1, lon1, lat0];
}
