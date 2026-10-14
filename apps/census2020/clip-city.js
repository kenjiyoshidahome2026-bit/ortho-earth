// 市区町村ポリゴンでの切り抜き（洪水浸水 A31 を区の境界で切る・本人裁定 2026-10-14「境界で切る」）。
// 2025 年版 A31b は区域が大きな面にまとまっていて、「少しでも市にかかれば丸ごと」だと区外（荒川の西など）まで塗られた。
// 手：市の面を earcut で三角形に割り、各三角形（凸）で対象の面を Sutherland–Hodgman で切る。切れ端は同じ feature の
// MultiPolygon の部品として並べる＝三角形は互いに重ならない＝gint の巻き数の塗りで継ぎ目なく 1 枚に見える
//（浸水の層は line-width 0＝三角形の継ぎ目の線は出ない）。穴は外環と同じ三角形で別々に切る（向きは保たれる＝巻き数で抜ける）。
// 座標は経緯度のまま（区の大きさでは平面とみなして差し支えない）。
import earcut from "earcut";

const open = r => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) ? r.slice(0, -1) : r;
const bboxOf = r => { let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity; for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; } return [w, s, e, n]; };
const hit = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// 凸の三角形 t（反時計回り [ax,ay,bx,by,cx,cy]）で環 r（閉じ点なし）を切る。3 点未満＝null
function clipRingTri(r, t) {
	let out = r;
	for (let k = 0; k < 3 && out.length; k++) {
		const ax = t[k * 2], ay = t[k * 2 + 1], bx = t[(k * 2 + 2) % 6], by = t[(k * 2 + 3) % 6];
		const side = (p) => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);   // ≥0＝辺の左（内側）
		const inp = out; out = [];
		let prev = inp[inp.length - 1], sp = side(prev);
		for (const cur of inp) {
			const sc = side(cur);
			if (sc >= 0) {
				if (sp < 0) { const u = sp / (sp - sc); out.push([prev[0] + u * (cur[0] - prev[0]), prev[1] + u * (cur[1] - prev[1])]); }
				out.push(cur);
			} else if (sp >= 0) { const u = sp / (sp - sc); out.push([prev[0] + u * (cur[0] - prev[0]), prev[1] + u * (cur[1] - prev[1])]); }
			prev = cur; sp = sc;
		}
	}
	return out.length >= 3 ? [...out, out[0]] : null;
}

// geom＝市の Polygon / MultiPolygon。戻り＝poly（[外環, 穴…]・GeoJSON の環）→ 切った面の配列（区にかからなければ []）
export function cityClipper(geom) {
	const polys = geom?.type === "Polygon" ? [geom.coordinates] : geom?.type === "MultiPolygon" ? geom.coordinates : [];
	const tris = [];
	for (const p of polys) {
		const flat = [], holes = [];
		p.forEach((ring, i) => { if (i) holes.push(flat.length / 2); for (const [x, y] of open(ring)) flat.push(x, y); });
		const idx = earcut(flat, holes.length ? holes : null, 2);
		for (let i = 0; i < idx.length; i += 3) {
			const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
			let t = [flat[a * 2], flat[a * 2 + 1], flat[b * 2], flat[b * 2 + 1], flat[c * 2], flat[c * 2 + 1]];
			if ((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]) < 0) t = [t[0], t[1], t[4], t[5], t[2], t[3]];   // 反時計回りへ
			tris.push({ t, bb: [Math.min(t[0], t[2], t[4]), Math.min(t[1], t[3], t[5]), Math.max(t[0], t[2], t[4]), Math.max(t[1], t[3], t[5])] });
		}
	}
	// 三角形の格子索引（区の bbox を G×G に割る）＝細かいセルが数十万あっても、近くの三角形だけを当てる
	const G = 64, all = tris.reduce((a, { bb }) => [Math.min(a[0], bb[0]), Math.min(a[1], bb[1]), Math.max(a[2], bb[2]), Math.max(a[3], bb[3])], [Infinity, Infinity, -Infinity, -Infinity]);
	const cw = (all[2] - all[0]) / G || 1, ch = (all[3] - all[1]) / G || 1, grid = Array.from({ length: G * G }, () => []);
	const cell = (x, y) => [Math.max(0, Math.min(G - 1, Math.floor((x - all[0]) / cw))), Math.max(0, Math.min(G - 1, Math.floor((y - all[1]) / ch)))];
	tris.forEach((tr, i) => { const [i0, j0] = cell(tr.bb[0], tr.bb[1]), [i1, j1] = cell(tr.bb[2], tr.bb[3]); for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) grid[j * G + k].push(i); });
	const near = bb => {
		if (!tris.length || !hit(bb, all)) return [];
		const [i0, j0] = cell(bb[0], bb[1]), [i1, j1] = cell(bb[2], bb[3]), seen = new Set();
		for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) for (const i of grid[j * G + k]) seen.add(i);
		return [...seen].sort((a, b) => a - b).map(i => tris[i]);
	};
	return poly => {
		const outer = open(poly[0] || []), holes = poly.slice(1).map(open), bb = bboxOf(outer), res = [];
		for (const { t, bb: tb } of near(bb)) {
			if (!hit(bb, tb)) continue;
			const o = clipRingTri(outer, t);
			if (!o) continue;
			res.push([o, ...holes.map(h => hit(bboxOf(h), tb) ? clipRingTri(h, t) : null).filter(Boolean)]);
		}
		return res;
	};
}
