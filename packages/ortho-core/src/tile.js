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

// タイル {x,y,z} が配信圏 coverage=[west,south,east,north] と全く重ならない（＝提供圏外）か。
// coverage 未指定なら常に false（全タイル取得＝従来動作を壊さない）。圏外なら呼び出し側で fetch を省き
// __empty（=404と同じ全面水域）として扱う＝外洋・国外への無駄な 404 リクエストを断つ。
// 判定は「重なりゼロ」＝圏に少しでも掛かるタイルは取得する（実タイルを絶対に巻き込まない安全側）。
export function tileOutsideCoverage(x, y, z, coverage) {
	if (!coverage) return false;
	const [cw, cs, ce, cn] = coverage;
	const [tw, ts, te, tn] = tileBounds(x, y, z);
	return te <= cw || tw >= ce || tn <= cs || ts >= cn;
}
