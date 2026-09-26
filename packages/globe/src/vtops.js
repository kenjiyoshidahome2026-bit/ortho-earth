// vector source の描く層（fill／line／circle／symbol・MapLibre 互換 段 8⑤・2026-09-27）の純関数＝node で検定（tests/vtdraw.mjs）。
// 組み立ての本体は core の buildTileDrawList（fill／line）と buildLabels（点の注記）＝基図と同じ部品。ここはその前処理：
//   ズームの置き換え・タイルの枠で切る（バッファの二重を作らない）・circle を長さ 0 の線（カプセルの丸点）へ・面の注記点（極）・li の帯。
import { classifyRings, clipRing, ringArea2 } from "./vtmesh.js";

// li の帯：基図の層の添字（数百まで）・図郭外の水域の擬似帯（−1000 付近）と重ならない＝renderer の門（海・建物の塗り）に掛からない。
// key＝層の順の鍵（小数可＝間に差し込んでも他の層の鍵は動かない＝他の source を組み直さない）。副番号（0＝本体・1＝下敷き（円の縁・輪郭）・2＝上（円の塗り））は 1e-7 刻み
export const USER_LI0 = 1 << 20;
export const liOf = (key, sub = 0) => USER_LI0 + key + sub * 1e-7;

// 式の ["zoom"] を数へ（深い写し）。["literal", …] の中は触らない。層は正規化で ["-",["zoom"],dz] になっている＝z はエンジンの目盛り
export function substituteZoom(e, z) {
	if (Array.isArray(e)) {
		if (e[0] === "literal") return e;
		if (e.length === 1 && e[0] === "zoom") return z;
		return e.map(x => substituteZoom(x, z));
	}
	if (e && typeof e === "object") { const o = {}; for (const k of Object.keys(e)) o[k] = substituteZoom(e[k], z); return o; }
	return e;
}

// 面をタイルの枠 [0,E]² で切る（MapLibre の classifyRings で外周と穴を分けてから輪ごとに Sutherland–Hodgman）。
// 戻り＝{ coords: Float64Array, ends } （外周は面積が正・穴は負＝core の polygons と同じ向き）か null（全部枠の外）
export function clipFillGeom(geom, E) {
	const out = [], ends = [];
	for (const poly of classifyRings(geom)) {
		const outer = clipRing(poly[0], E); if (!outer) continue;
		push(out, ends, outer, true);
		for (let k = 1; k < poly.length; k++) { const h = clipRing(poly[k], E); if (h) push(out, ends, h, false); }
	}
	return ends.length ? { coords: Float64Array.from(out), ends } : null;
}
function push(out, ends, r, positive) {
	const flip = (ringArea2(r) > 0) !== positive, n = r.length / 2;
	for (let i = 0; i < n; i++) { const j = flip ? n - 1 - i : i; out.push(r[j * 2], r[j * 2 + 1]); }
	out.push(out[out.length - 2 * n], out[out.length - 2 * n + 1]);   // 閉じる（core の線の経路は閉じた輪で一周を描く）
	ends.push(out.length);
}

// 線をタイルの枠で切る（線分ごとに Liang–Barsky・枠の中の連なりを 1 本に）。closedRuns＝面の輪を線として描く時（line 層・fill の輪郭）＝
// 枠の上を走る辺（切った後の継ぎ目）は落とす＝隣のタイルとの境に偽の線を出さない
export function clipLineGeom(geom, E, { skipBoundary = false } = {}) {
	const { coords: c, ends } = geom, out = [], oEnds = [];
	let cur = [];
	const flush = () => { if (cur.length >= 4) { for (const v of cur) out.push(v); oEnds.push(out.length); } cur = []; };
	let s = 0;
	for (const e of ends) {
		for (let i = s; i + 3 < e; i += 2) {
			const seg = clipSeg(c[i], c[i + 1], c[i + 2], c[i + 3], E);
			if (!seg || (skipBoundary && onEdge(seg, E))) { flush(); continue; }
			const [ax, ay, bx, by] = seg, k = cur.length;
			if (!k || cur[k - 2] !== ax || cur[k - 1] !== ay) { flush(); cur.push(ax, ay); }
			cur.push(bx, by);
		}
		flush(); s = e;
	}
	return oEnds.length ? { coords: Float64Array.from(out), ends: oEnds } : null;
}
const onEdge = ([ax, ay, bx, by], E) => (ax === bx && (ax <= 0 || ax >= E)) || (ay === by && (ay <= 0 || ay >= E));
export function clipSeg(ax, ay, bx, by, E) {
	const dx = bx - ax, dy = by - ay;
	let t0 = 0, t1 = 1;
	for (const [p, q] of [[-dx, ax], [dx, E - ax], [-dy, ay], [dy, E - ay]]) {
		if (p === 0) { if (q < 0) return null; continue; }
		const r = q / p;
		if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
	}
	const snap = v => v < 0 ? 0 : v > E ? E : v;   // 交点は枠の値ちょうど（丸めの誤差で枠の外へ出さない）
	return [snap(ax + t0 * dx), snap(ay + t0 * dy), snap(ax + t1 * dx), snap(ay + t1 * dy)];
}

// 点がタイルの中（バッファを除く・右と下は含まない＝隣のタイルと二重にならない）
export const inTile = (x, y, E) => x >= 0 && x < E && y >= 0 && y < E;

// 地物の頂点（circle＝MapLibre は線と面も頂点ごとに円を描く）。閉じた輪の最後の点（先頭の複製）は数えない。タイルの中の物だけ
export function verticesOf(f, E) {
	const { coords: c, ends } = f.geom, out = [];
	if (f.type === "Point") { for (let i = 0; i < c.length; i += 2) if (inTile(c[i], c[i + 1], E)) out.push(c[i], c[i + 1]); return out; }
	let s = 0;
	for (const e of ends) {
		const closed = f.type === "Polygon" && e - s >= 4 && c[s] === c[e - 2] && c[s + 1] === c[e - 1];
		for (let i = s; i < (closed ? e - 2 : e); i += 2) if (inTile(c[i], c[i + 1], E)) out.push(c[i], c[i + 1]);
		s = e;
	}
	return out;
}
// 頂点の列 → 長さ 0 の線の地物（カプセルの丸点＝半径は線幅の半分）
export const dotsGeom = v => { const coords = new Float64Array(v.length * 2), ends = []; for (let i = 0; i < v.length; i += 2) { coords.set([v[i], v[i + 1], v[i], v[i + 1]], i * 2); ends.push(i * 2 + 4); } return { coords, ends }; };
// 輪（中空の円の縁）＝点のまわりの 24 角形（半径はタイル単位＝止まった所のズームで px から換算・動いている間は地図と一緒に伸び縮みする）
export function ringGeom(x, y, rU, n = 24) {
	const coords = new Float64Array((n + 1) * 2);
	for (let i = 0; i <= n; i++) { const a = i / n * 2 * Math.PI; coords[i * 2] = x + rU * Math.cos(a); coords[i * 2 + 1] = y + rU * Math.sin(a); }
	coords[n * 2] = coords[0]; coords[n * 2 + 1] = coords[1];
	return { coords, ends: [coords.length] };
}
// 画面の 1px がタイル単位でいくつか（タイル z を表示の z＝pz で見る時・256px 世界＝エンジンの目盛り）
export const unitsPerPx = (E, tileZ, pz) => E / (256 * 2 ** (pz - tileZ));

// 注記の点（symbol・symbol-placement "point"）：点＝そのまま（MultiPoint はばらす）・面＝面ごとの極（MapLibre の findPoleOfInaccessibility・精度 16 単位）。
// 線は MapLibre でも点の注記を線の頂点に置くが、この段では出さない（線の上の注記は段 8③）。タイルの中の点だけ
export function labelPointsOf(f, E) {
	const out = [];
	if (f.type === "Point") { const c = f.geom.coords; for (let i = 0; i < c.length; i += 2) if (inTile(c[i], c[i + 1], E)) out.push([c[i], c[i + 1]]); }
	else if (f.type === "Polygon") for (const poly of classifyRings(f.geom)) { const p = poleOf(poly, 16); if (p && inTile(p[0], p[1], E)) out.push(p); }
	return out;
}

// 極（pole of inaccessibility・mapbox/polylabel と同じ格子の二分探索）。rings＝[外周, 穴…]（開いた Float64Array）
export function poleOf(rings, precision = 1) {
	const o = rings[0]; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < o.length; i += 2) { if (o[i] < minX) minX = o[i]; if (o[i] > maxX) maxX = o[i]; if (o[i + 1] < minY) minY = o[i + 1]; if (o[i + 1] > maxY) maxY = o[i + 1]; }
	const w = maxX - minX, h = maxY - minY, cs = Math.min(w, h);
	if (!(cs > 0)) return [minX, minY];
	const cell = (x, y, hh) => { const d = signedDist(x, y, rings); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
	const q = [];
	for (let x = minX; x < maxX; x += cs) for (let y = minY; y < maxY; y += cs) q.push(cell(x + cs / 2, y + cs / 2, cs / 2));
	let best = centroidCell(rings, cell);
	const bb = cell(minX + w / 2, minY + h / 2, 0); if (bb.d > best.d) best = bb;
	let guard = 0;
	while (q.length && guard++ < 4000) {
		let bi = 0; for (let i = 1; i < q.length; i++) if (q[i].max > q[bi].max) bi = i;
		const c = q.splice(bi, 1)[0];
		if (c.d > best.d) best = c;
		if (c.max - best.d <= precision) continue;
		const hh = c.h / 2;
		q.push(cell(c.x - hh, c.y - hh, hh), cell(c.x + hh, c.y - hh, hh), cell(c.x - hh, c.y + hh, hh), cell(c.x + hh, c.y + hh, hh));
	}
	return [best.x, best.y];
}
function centroidCell(rings, cell) {
	const r = rings[0]; let a = 0, x = 0, y = 0;
	for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) { const f = r[i] * r[j + 1] - r[j] * r[i + 1]; x += (r[i] + r[j]) * f; y += (r[i + 1] + r[j + 1]) * f; a += f * 3; }
	return a === 0 ? cell(r[0], r[1], 0) : cell(x / a, y / a, 0);
}
function signedDist(x, y, rings) {   // 面の中＝正・外＝負（最も近い辺までの距離）
	let inside = false, d2 = Infinity;
	for (const r of rings) for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
		const ax = r[i], ay = r[i + 1], bx = r[j], by = r[j + 1];
		if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
		let px = ax, py = ay, dx = bx - ax, dy = by - ay;
		if (dx || dy) { const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy); if (t > 1) { px = bx; py = by; } else if (t > 0) { px += dx * t; py += dy * t; } }
		const e = (x - px) ** 2 + (y - py) ** 2; if (e < d2) d2 = e;
	}
	return (inside ? 1 : -1) * Math.sqrt(d2);
}

// paint／layout のズームの鍵（vtmesh.paintZoomKey に layout も載せる＝text-size などのズームの式でも組み直す）
export const styleZoomProps = L => ({ ...(L.paint || {}), ...Object.fromEntries(Object.entries(L.layout || {}).map(([k, v]) => ["layout:" + k, v])) });
// 表示の z を 0.25 刻みへ（同じ鍵の間はどのタイルも同じ z で組む＝隣り合うタイルの線幅が揃う）
export const quantZoom = z => Math.round(z * 4) / 4;
