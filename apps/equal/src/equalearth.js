// Equal Earth（Šavrič, Patterson, Jenny 2018）＝正積の擬円筒図法。単位＝半径1の球（ラジアン長）。
// 中央経線は常に「画面中心の経度」＝経度は dλ（中心からの差）でしか投影に入らない。
// シェーダ（renderer.js の EE_GLSL）と同じ式＝CPU はカメラ（中心・錨・縮小の下限）だけに使う。
export const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// 緯度(度) → パラメトリック緯度 l
const paramLat = lat => Math.asin(M * Math.sin(lat * D2R));

// y(φ)：経度に依存しない＝緯線は水平な直線
export function yOfLat(lat) {
	const l = paramLat(lat), l2 = l * l, l6 = l2 * l2 * l2;
	return l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2));
}
// x = dλ(rad) · k(φ)：経線方向の横倍率（極でも 0 にならない＝平極）
export function kOfLat(lat) {
	const l = paramLat(lat), l2 = l * l, l6 = l2 * l2 * l2;
	return Math.cos(l) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2)));
}
// y → φ(度)（Newton・d3-geo-projection と同じ反復）
export function latOfY(y) {
	let l = y, l2 = l * l, l6 = l2 * l2 * l2;
	for (let i = 0; i < 12; i++) {
		const fy = l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)) - y;
		const fpy = A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2);
		const d = fy / fpy; l -= d; l2 = l * l; l6 = l2 * l2 * l2;
		if (Math.abs(d) < 1e-12) break;
	}
	return Math.asin(Math.max(-1, Math.min(1, Math.sin(l) / M))) * R2D;
}

export const Y_MAX = yOfLat(90);                       // ≈1.3174
export const X_MAX = Math.PI * kOfLat(0);              // ≈2.7207（赤道の半幅）
// 外形の半幅（高さ y の位置で経線 ±180° が来る x）。|y| に対して単調減少＝外形は凸
export const halfWidthAtY = y => Math.PI * kOfLat(latOfY(Math.max(-Y_MAX, Math.min(Y_MAX, y))));

export const wrapLon = lon => ((lon + 180) % 360 + 360) % 360 - 180;

// ── カメラ：{ lon=中央経線=画面中心の経度, lat=画面中心の緯度, zoom } ──
// 倍率は ortho と同一定義（z＝正射スケール・WORLD_PX=256）：1 単位（=球面1ラジアン）= 256·2^z/(2π) CSS px。
// 正積なので局所面積倍率は全域で 1＝同じ z なら ortho の中心と同じ縮尺で、LOD の閾値も全域一定。
export const pxPerUnit = zoom => 256 * Math.pow(2, zoom) / (2 * Math.PI);

// 画面 CSS px（中心原点・y 下向き）→ 経緯度。外形の外なら null
export function unproject(view, sx, sy) {
	const s = pxPerUnit(view.zoom);
	const y = yOfLat(view.lat) - sy / s;
	if (Math.abs(y) > Y_MAX) return null;
	const lat = latOfY(y);
	const dlon = sx / (s * kOfLat(lat)) * R2D;
	if (Math.abs(dlon) > 180) return null;
	return [wrapLon(view.lon + dlon), lat];
}

// 「余白を出さない」縮小下限：画面矩形（中心 x=0）が外形の内側に収まる最小 z。
// 条件 h/2 ≤ Y_MAX かつ w/2 ≤ halfWidthAtY(h/2)（外形は凸・中心 yc=0 が最も余裕がある）＝z について単調＝二分法
export function minZoomFor(W, H) {
	const fits = z => { const s = pxPerUnit(z), hu = H / (2 * s), wu = W / (2 * s); return hu <= Y_MAX && wu <= halfWidthAtY(hu); };
	let lo = -4, hi = 12;
	for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
	return hi;
}

// 中心緯度の可動域：|yc| + h/2 ≤ yLim（yLim＝外形の半幅が w/2 になる高さ）
function clampCenterY(yc, W, H, zoom) {
	const s = pxPerUnit(zoom), hu = H / (2 * s), wu = W / (2 * s);
	let lo = 0, hi = Y_MAX;   // halfWidthAtY(yLim) = wu を解く（単調減少）
	if (halfWidthAtY(Y_MAX) >= wu) lo = Y_MAX;
	else for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (halfWidthAtY(mid) >= wu) lo = mid; else hi = mid; }
	const lim = Math.max(0, lo - hu);
	return Math.max(-lim, Math.min(lim, yc));
}

export function clampView(view, W, H, maxZoom) {
	const zoom = Math.max(minZoomFor(W, H), Math.min(maxZoom, view.zoom));
	const yc = clampCenterY(yOfLat(Math.max(-90, Math.min(90, view.lat))), W, H, zoom);
	return { lon: wrapLon(view.lon), lat: latOfY(yc), zoom };
}

// 錨つき再配置：経緯度 (lon,lat) が画面 (sx,sy) に来るカメラ。中央経線＝中心経度なので
// y は φ だけ、x は dλ·k(φ) だけで決まる＝解析的に厳密に解ける（ズーム・ドラッグ・ピンチ共通）
export function anchorView(lon, lat, sx, sy, zoom) {
	const s = pxPerUnit(zoom);
	const yc = yOfLat(lat) + sy / s;
	const dlon = Math.max(-180, Math.min(180, sx / (s * kOfLat(lat)) * R2D));
	return { lon: wrapLon(lon - dlon), lat: latOfY(Math.max(-Y_MAX, Math.min(Y_MAX, yc))), zoom };
}
