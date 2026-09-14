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

// 完全球体：隣接頂点は大円で結ぶ（塗り扇/境界線が弦にならない・gint の度アンカーと同じ線・2026-09-14）。
// 長辺（中心角 > GC_STEP）だけ大円上の中間点を挿す＝密な小ポリゴン（census 町丁目等）は素通り（n=1）でゼロ費用。
// 入力は unwrapRing 済み（lon 連続）。中間点も直前の出力に対して連続化＝縫い目跨ぎでも一本のまま。
const D2R = Math.PI / 180, R2D = 180 / Math.PI, GC_STEP = 2 * D2R;   // 2°刻み（塗り境界の滑らかさ）
const toVec = (lon, lat) => { const c = Math.cos(lat * D2R); return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)]; };
function densifyGC(ring) {
	if (ring.length < 2) return ring;
	const out = [ring[0]]; let prev = ring[0][0];
	for (let i = 1; i < ring.length; i++) {
		const a = ring[i - 1], b = ring[i], va = toVec(a[0], a[1]), vb = toVec(b[0], b[1]);
		const cx = va[1] * vb[2] - va[2] * vb[1], cy = va[2] * vb[0] - va[0] * vb[2], cz = va[0] * vb[1] - va[1] * vb[0];
		const w = Math.atan2(Math.hypot(cx, cy, cz), va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]);
		const n = Math.max(1, Math.ceil(w / GC_STEP)), sw = Math.sin(w);
		for (let s = 1; s < n; s++) {   // 中間点（端点 b は下でそのまま積む＝弦浮きを避けつつ端点は制御点のまま）
			const t = s / n, ka = Math.sin((1 - t) * w) / sw, kb = Math.sin(t * w) / sw;
			const vx = va[0] * ka + vb[0] * kb, vy = va[1] * ka + vb[1] * kb, vz = va[2] * ka + vb[2] * kb;
			let lon = Math.atan2(vy, vx) * R2D; const lat = Math.atan2(vz, Math.hypot(vx, vy)) * R2D;
			while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360;
			out.push([lon, lat]); prev = lon;
		}
		out.push(b); prev = b[0];   // b は unwrapRing 済みの連続 lon
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
		if (opts.lines === false) return;   // 塗り専用シーン（海面下の陸地等）＝境界線バッファを作らない（辺数分の無駄なインスタンス描画を出さない）
		for (let i = 0; i + 1 < ring.length; i++) {
			P1.push(ring[i][0] - ox, ring[i][1] - oy); P2.push(ring[i + 1][0] - ox, ring[i + 1][1] - oy);
			lcol.push(lc[0], lc[1], lc[2], lc[3]); lhalf.push(half);
		}
	};
	const fanPolygon = rings => {
		const uw = rings.map(r => densifyGC(unwrapRing(r)));   // 大円で密化＝塗り扇/境界線が弦にならない
		const ax = uw[0][0][0] - ox, ay = uw[0][0][1] - oy;   // ポリゴンの anchor（外周先頭）。全リング共通で穴を巻き数減算
		for (const ring of uw) {
			for (let i = 0; i + 1 < ring.length; i++) fan.push(ax, ay, ring[i][0] - ox, ring[i][1] - oy, ring[i + 1][0] - ox, ring[i + 1][1] - oy);
		}
		uw.forEach(pushRingLines);
	};
	// opts.ranges＝feature 毎の fan 頂点レンジ＋外接円（単位球3D中心と角半径の cos/sin）を同梱＝
	// 全球スケールの層（wdepr）の球体カリング用：完全裏側の feature は CPU 側でレンジごと描かない
	//（対蹠点付近はVSの地平円クランプがリング一周巻きになり全面+1化する＝クランプだけでは守れない）。
	const feats = opts.ranges ? [] : null;
	features.forEach(f => {
		const g = f && f.geometry; if (!g) return;
		const vStart = fan.length / 2;
		if (g.type === "Polygon") fanPolygon(g.coordinates);
		else if (g.type === "MultiPolygon") g.coordinates.forEach(fanPolygon);
		else if (g.type === "LineString") pushRingLines(densifyGC(unwrapRing(g.coordinates)));
		else if (g.type === "MultiLineString") g.coordinates.forEach(r => pushRingLines(densifyGC(unwrapRing(r))));
		if (!feats) return;
		const count = fan.length / 2 - vStart;
		if (!count) return;
		let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;   // fan デルタの bbox（origin相対・unwrap済）
		for (let i = vStart * 2; i < fan.length; i += 2) { const x = fan[i], y = fan[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
		const cl = (x0 + x1) / 2 + ox, ct = (y0 + y1) / 2 + oy;   // 中心（絶対 lon/lat）
		const cLat = Math.cos(ct * D2R);
		const C = [cLat * Math.cos(cl * D2R), Math.sin(ct * D2R), cLat * Math.sin(cl * D2R)];   // lonlatTo3D と同じ Y-up 規約
		// 角半径＝bbox 対角の半分（度）を球面角へ（高緯度の経度縮みは cos 補正＝過大側に安全倒し）
		const rad = Math.hypot((x1 - x0) / 2, (y1 - y0) / 2) * D2R;
		feats.push({ start: vStart, count, C, cosR: Math.cos(Math.min(rad, Math.PI)), sinR: Math.sin(Math.min(rad, Math.PI)) });
	});
	return { origin: [ox, oy], fanPos: new Float32Array(fan), P1: new Float32Array(P1), P2: new Float32Array(P2), lineCol: new Float32Array(lcol), lineHalf: new Float32Array(lhalf), feats };
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
