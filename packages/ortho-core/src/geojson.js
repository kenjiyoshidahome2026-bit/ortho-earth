// GeoJSON(features) → ortho-japan overlay（stencil-then-cover の fan 三角形 / line=capsule辺）。
// geopbf 等の外部ベクタを、タイル非依存で mat4 パイプラインへ流すためのアダプタ。
// 頂点は origin からの経緯度差分（精度確保）。

// リングの経度を連続化：隣接頂点が±180°以内になるよう±360°足し引き。2D三角形分割がantimeridianを
// 誤って横断するのを防ぐ。>180/<-180 の値になるが lonlatTo3D は周期的なので3D位置は正しい。
function unwrapRing(ring) {
	if (!ring.length) return ring;
	const out = [ring[0]]; let prev = ring[0][0];
	for (let i = 1; i < ring.length; i++) {
		let lon = ring[i][0];
		while (lon - prev > 180) lon -= 360;
		while (lon - prev < -180) lon += 360;
		out.push([lon, ring[i][1]]); prev = lon;
	}
	return out;
}

// stencil-then-cover 用：ポリゴンを fan 三角形(anchor, v_i, v_{i+1})に。earcut不要（凹/穴は巻き数が処理）。
// 塗りの被覆は境界の巻き数で決まるので fan の形は問わない＝球面で扇にならない。境界線も併せて出す。
export function buildGeoJSONOverlay(features, origin, opts = {}) {
	const [ox, oy] = origin;
	const lc = opts.lineColor || [0.16, 0.40, 0.70, 0.95];
	const half = opts.lineWidth != null ? opts.lineWidth : 1.2;
	const fan = [], P1 = [], P2 = [], lcol = [], lhalf = [];
	const pushRingLines = ring => {
		for (let i = 0; i + 1 < ring.length; i++) {
			P1.push(ring[i][0] - ox, ring[i][1] - oy); P2.push(ring[i + 1][0] - ox, ring[i + 1][1] - oy);
			lcol.push(lc[0], lc[1], lc[2], lc[3]); lhalf.push(half);
		}
	};
	const fanPolygon = rings => {
		const uw = rings.map(unwrapRing);
		const ax = uw[0][0][0] - ox, ay = uw[0][0][1] - oy;   // ポリゴンの anchor（外周先頭）。全リング共通で穴を巻き数減算
		for (const ring of uw) {
			for (let i = 0; i + 1 < ring.length; i++) fan.push(ax, ay, ring[i][0] - ox, ring[i][1] - oy, ring[i + 1][0] - ox, ring[i + 1][1] - oy);
		}
		uw.forEach(pushRingLines);
	};
	features.forEach(f => {
		const g = f && f.geometry; if (!g) return;
		if (g.type === "Polygon") fanPolygon(g.coordinates);
		else if (g.type === "MultiPolygon") g.coordinates.forEach(fanPolygon);
		else if (g.type === "LineString") pushRingLines(unwrapRing(g.coordinates));
		else if (g.type === "MultiLineString") g.coordinates.forEach(r => pushRingLines(unwrapRing(r)));
	});
	return { origin: [ox, oy], fanPos: new Float32Array(fan), P1: new Float32Array(P1), P2: new Float32Array(P2), lineCol: new Float32Array(lcol), lineHalf: new Float32Array(lhalf) };
}

// 点-in-ポリゴン（GeoJSON Polygon/MultiPolygon, 経緯度）。identify の JS 経路。穴も考慮。
export function pointInFeature(lon, lat, geom) {
	if (!geom) return false;
	if (geom.type === "Polygon") return inRings(lon, lat, geom.coordinates);
	if (geom.type === "MultiPolygon") return geom.coordinates.some(rings => inRings(lon, lat, rings));
	return false;
}
function inRings(lon, lat, rings) {
	if (!rings.length || !inRing(lon, lat, rings[0])) return false;   // 外周内
	for (let i = 1; i < rings.length; i++) if (inRing(lon, lat, rings[i])) return false;   // 穴なら除外
	return true;
}
function inRing(lon, lat, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
		if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
	}
	return inside;
}
