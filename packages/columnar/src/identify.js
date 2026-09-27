// identify.js ── 列チャンクの識別（worker 側・#90）。フラットな幾何（経緯度）と feature bbox で当てる。
// 優先＝gint と同じ：tolPt 以内の点（最寄り）→ tolLine 以内の線（最寄り）→ 含む面のうち最小（面積）。
// 経度は ±180° 跨ぎの連続化（chunk.js）に合わせ、lon と lon+360 の両方で当てる。
import { K } from "./flat.js";

const D2R = Math.PI / 180;
// 点と線分の距離²（経度は cos(lat) で縮める＝度の等方化）
function segDist2(px, py, ax, ay, bx, by, kx) {
	const dx = (bx - ax) * kx, dy = by - ay, l2 = dx * dx + dy * dy;
	let t = l2 > 0 ? (((px - ax) * kx) * dx + (py - ay) * dy) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const ex = (px - ax) * kx - dx * t, ey = (py - ay) - dy * t;
	return ex * ex + ey * ey;
}
function inRing(xy, s, e, px, py) {
	let inside = false;
	for (let i = s, j = e - 1; i < e; j = i++) {
		const xi = xy[i * 2], yi = xy[i * 2 + 1], xj = xy[j * 2], yj = xy[j * 2 + 1];
		if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
function ringArea(xy, s, e) { let a = 0; for (let i = s, j = e - 1; i < e; j = i++) a += xy[j * 2] * xy[i * 2 + 1] - xy[i * 2] * xy[j * 2 + 1]; return Math.abs(a) / 2; }

// flat＝読み手のフラットな幾何・fbbox＝buildChunk の feature bbox。tolM＝{ point, line }（m）。戻り＝チャンク内 feature 番号 | -1
export function identifyIn(flat, fbbox, lon, lat, { tolPointM = 50, tolLineM = 30 } = {}) {
	const { xy, featPart, partKind, partStart } = flat;
	const kx = Math.max(0.05, Math.cos(lat * D2R)), mDeg = 1 / 111320;
	const tp = tolPointM * mDeg, tl = tolLineM * mDeg, tp2 = tp * tp, tl2 = tl * tl;
	let bestPt = -1, bestPtD = tp2, bestLn = -1, bestLnD = tl2, bestPoly = -1, bestArea = Infinity;
	for (const px of [lon, lon + 360]) {
		for (let f = 0; f < flat.n; f++) {
			const b = f * 4;
			if (px < fbbox[b] - tp || px > fbbox[b + 2] + tp || lat < fbbox[b + 1] - tp || lat > fbbox[b + 3] + tp) continue;
			let polyHit = false, polyArea = 0, groupIn = false, groupArea = 0;   // 外周 1 つ＋その穴＝1 群。群が「中」で終われば当たり（多重面は群ごと）
			const closeGroup = () => { if (groupIn) { polyHit = true; polyArea += groupArea; } groupIn = false; groupArea = 0; };
			for (let p = featPart[f]; p < featPart[f + 1]; p++) {
				const kind = partKind[p], s = partStart[p], e = partStart[p + 1];
				if (kind === K.POINT) { const dx = (xy[s * 2] - px) * kx, dy = xy[s * 2 + 1] - lat, d = dx * dx + dy * dy; if (d < bestPtD) { bestPtD = d; bestPt = f; } }
				else if (kind === K.LINE) { for (let v = s + 1; v < e; v++) { const d = segDist2(px, lat, xy[v * 2 - 2], xy[v * 2 - 1], xy[v * 2], xy[v * 2 + 1], kx); if (d < bestLnD) { bestLnD = d; bestLn = f; } } }
				else if (kind === K.OUTER) { closeGroup(); groupIn = inRing(xy, s, e, px, lat); if (groupIn) groupArea = ringArea(xy, s, e); }
				else if (kind === K.HOLE && groupIn) { if (inRing(xy, s, e, px, lat)) groupIn = false; }
			}
			closeGroup();
			if (polyHit && polyArea < bestArea) { bestArea = polyArea; bestPoly = f; }
		}
	}
	return bestPt >= 0 ? bestPt : bestLn >= 0 ? bestLn : bestPoly;
}
