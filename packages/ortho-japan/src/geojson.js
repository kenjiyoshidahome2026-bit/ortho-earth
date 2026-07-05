// GeoJSON(features) → ortho-japan シーン（fill=earcut三角形 / line=capsule辺）。
// geopbf 等の外部ベクタを、タイル非依存で mat4 パイプラインへ流すためのアダプタ。
// 頂点は origin からの経緯度差分（精度確保）。renderer.setScene(s, slot) にそのまま渡せる形。
import earcut from "earcut";

// opts: { fillColor, lineColor, lineWidth, highlight:Set<featureIndex>, highlightColor }
export function buildGeoJSONScene(features, origin, opts = {}) {
	const [ox, oy] = origin;
	const fc = opts.fillColor || [0.20, 0.45, 0.85, 0.14];   // 面（半透明＝下地が透ける）
	const lc = opts.lineColor || [0.16, 0.40, 0.70, 0.95];   // 境界線
	const hiFc = opts.highlightColor || [0.95, 0.55, 0.15, 0.55];   // identify ヒット
	const hi = opts.highlight || null;
	const half = opts.lineWidth != null ? opts.lineWidth : 1.2;
	const fpos = [], fcol = [], P1 = [], P2 = [], lcol = [], lhalf = [];

	const pushRingLines = ring => {
		for (let i = 0; i + 1 < ring.length; i++) {
			const a = ring[i], b = ring[i + 1];
			P1.push(a[0] - ox, a[1] - oy); P2.push(b[0] - ox, b[1] - oy);
			lcol.push(lc[0], lc[1], lc[2], lc[3]); lhalf.push(half);
		}
	};
	// NOTE: この earcut fill は spike 用の足場。巨大ポリゴンは球面に沿わず扇が出る（本番は LOD+stencil）。
	// 市区町村のような小ポリゴンでは三角形が十分小さく球面を近似するので実用上問題ない。
	const fillPolygon = (rings, col) => {
		const uw = rings.map(unwrapRing);   // 経度連続化してから earcut（antimeridian跨ぎの扇を防ぐ）
		const flat = [], holes = []; let n = 0;
		uw.forEach((ring, ri) => {
			if (ri > 0) holes.push(n);
			for (const p of ring) { flat.push(p[0], p[1]); n++; }
		});
		for (const idx of earcut(flat, holes, 2)) { fpos.push(flat[idx * 2] - ox, flat[idx * 2 + 1] - oy); fcol.push(col[0], col[1], col[2], col[3]); }
		uw.forEach(pushRingLines);   // 境界も描く（unwrap済み。lonlatTo3Dは周期的なので>180でも正しい点）
	};

	features.forEach((f, i) => {
		const g = f && f.geometry; if (!g) return;
		const col = (hi && hi.has(i)) ? hiFc : fc;
		if (g.type === "Polygon") fillPolygon(g.coordinates, col);
		else if (g.type === "MultiPolygon") g.coordinates.forEach(rings => fillPolygon(rings, col));
		else if (g.type === "LineString") pushRingLines(unwrapRing(g.coordinates));
		else if (g.type === "MultiLineString") g.coordinates.forEach(r => pushRingLines(unwrapRing(r)));
	});

	const layers = [];
	if (fpos.length) layers.push({ kind: "fill", pos: new Float32Array(fpos), col: new Float32Array(fcol) });
	if (lhalf.length) layers.push({ kind: "line", P1: new Float32Array(P1), P2: new Float32Array(P2), col: new Float32Array(lcol), half: new Float32Array(lhalf) });
	return { origin: [ox, oy], layers };
}

// リングの経度を連続化：隣接頂点が±180°以内になるよう±360°足し引き。earcut(2D)がantimeridianを
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
