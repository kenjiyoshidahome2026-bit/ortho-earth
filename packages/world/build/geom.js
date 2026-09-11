// 山脈ポリゴン（Natural Earth geography_regions_polys）→ 2〜4 点の軸線（Kenji 2026-09-11「range は点では表しにくい＝2〜4 点のラインで持ち、表示時に spline＋ポリゴン化」）
//   手順: ポリゴン内部を格子で標本化（面積重み）→ 局所平面（km）で主成分軸を取る → 軸に沿って k 点（長さで 2/3/4）を置き、各点は窓内標本の垂直方向の重心
//   → 弧を描く山脈（アルプス・カルパティア・ヒマラヤ）も折れ線で追う。幅＝窓内の垂直方向の広がり（p10〜p90）の中央値（km）
export function rangeAxis(features, { maxPoints = 4 } = {}) {
	const polys = [];   // [outer, holes...] の配列
	for (const f of features) { const g = f.geometry; if (!g) continue; (g.type == "MultiPolygon" ? g.coordinates : g.type == "Polygon" ? [g.coordinates] : []).forEach(p => polys.push(p)); }
	if (!polys.length) return null;
	let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
	for (const p of polys) for (const [x, y] of p[0]) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
	const lat0 = (miny + maxy) / 2, kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
	const step = Math.sqrt((maxx - minx) * (maxy - miny) / 6000) || 0.01;   // 格子＝bbox に約 6000 点（内部は 2000〜4000 点）
	const pts = [];
	for (let x = minx + step / 2; x < maxx; x += step) for (let y = miny + step / 2; y < maxy; y += step) if (polys.some(p => insidePoly(p, x, y))) pts.push([(x - minx) * kx, (y - miny) * ky]);
	if (pts.length < 20) return null;
	const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
	let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
	const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), u = [Math.cos(th), Math.sin(th)], v = [-u[1], u[0]];
	const ts = pts.map(([x, y]) => (x - mx) * u[0] + (y - my) * u[1]), ss = pts.map(([x, y]) => (x - mx) * v[0] + (y - my) * v[1]);
	const tmin = Math.min(...ts), tmax = Math.max(...ts), L = tmax - tmin;
	const k = Math.min(maxPoints, L < 600 ? 2 : L < 1500 ? 3 : 4), half = L / (2 * k), line = [], widths = [];
	for (let i = 0; i < k; i++) {
		const ti = tmin + L * (0.06 + 0.88 * i / (k - 1));
		const win = [], narrow = []; ts.forEach((t, j) => { const d = Math.abs(t - ti); d < half && win.push(ss[j]); d < half / 2 && narrow.push(ss[j]); });
		const si = win.reduce((a, b) => a + b, 0) / win.length;
		const w = narrow.length >= 10 ? narrow : win; w.sort((a, b) => a - b);   // 幅は狭い窓で（広い窓だと弧の曲がりが幅に混ざる＝アンデスで 2 倍近く太った）
		widths.push(w[Math.floor(w.length * 0.9)] - w[Math.floor(w.length * 0.1)]);
		const x = mx + u[0] * ti + v[0] * si, y = my + u[1] * ti + v[1] * si;
		line.push([+(minx + x / kx).toFixed(3), +(miny + y / ky).toFixed(3)]);
	}
	widths.sort((a, b) => a - b);
	return { line, width: Math.round(widths[Math.floor(widths.length / 2)]), length: Math.round(lineLengthKm(line)) };
}
// 手書きの軸線（seed の axis 列 "lon lat;lon lat;…"）
export function parseAxis(s) {
	const line = String(s || "").split(";").map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length == 2 && p.every(Number.isFinite));
	return line.length >= 2 ? { line, length: Math.round(lineLengthKm(line)) } : null;
}
export function lineLengthKm(line) {
	let d = 0; for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]); return d;
}
function haversine([x1, y1], [x2, y2]) {
	const r = Math.PI / 180, dLat = (y2 - y1) * r, dLon = (x2 - x1) * r, a = Math.sin(dLat / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin(dLon / 2) ** 2;
	return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function insidePoly(rings, x, y) {   // 外環＋穴の偶奇判定
	let inside = false;
	for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i], [xj, yj] = ring[j];
		if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
