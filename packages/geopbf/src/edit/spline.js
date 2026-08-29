// @spline（滑らか曲線）＝制御点列→Catmull-Rom 細分。純幾何（DOM/描画なし）＝フォーマット水準の正典。
// 8/29 に ortho-japan/gadgets/anno.js から昇格（sanitize と同じ型＝描画側 anno は再輸出で追従）。
// エディタ（geopbf/edit/model）と再生（anno の @spline 描画）が同じ一本を使う＝WYSIWYG の担保。
export function smoothRing(coords, closed, steps = 12) {
	let pts = coords;
	if (closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
	const n = pts.length;
	if (n < 3) return coords.slice();   // 少なすぎ＝そのまま
	const P = i => closed ? pts[(i % n + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
	const out = [];
	const segEnd = closed ? n : n - 1;
	for (let i = 0; i < segEnd; i++) {
		const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
		for (let j = 0; j < steps; j++) {
			const t = j / steps, t2 = t * t, t3 = t2 * t;   // Catmull-Rom（一様・tension 0.5）
			out.push([
				0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
				0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
			]);
		}
	}
	out.push(closed ? [out[0][0], out[0][1]] : [P(n - 1)[0], P(n - 1)[1]]);   // 閉じ or 終端
	return out;
}
export function smoothGeom(g) {   // 線/面のジオメトリを曲線化（点系はそのまま）
	if (g.type === "LineString") return { type: g.type, coordinates: smoothRing(g.coordinates, false) };
	if (g.type === "MultiLineString") return { type: g.type, coordinates: g.coordinates.map(l => smoothRing(l, false)) };
	if (g.type === "Polygon") return { type: g.type, coordinates: g.coordinates.map(r => smoothRing(r, true)) };
	if (g.type === "MultiPolygon") return { type: g.type, coordinates: g.coordinates.map(p => p.map(r => smoothRing(r, true))) };
	return g;
}
