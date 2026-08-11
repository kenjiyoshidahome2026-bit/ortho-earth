// 建物の押し出し（LOD1相当）：bvmap の BldA フットプリントを高さ方向に立ち上げる。
// bvmap に高さ属性は無いので vt_code(建物種別)から概略高さを推定。屋根(earcut)＋壁(各辺のquad)を生成。
// PLATEAU実メッシュ（正確な高さ/屋根）への"扉"の叩き台。
import earcut from "earcut";
import { tileLocalToLonLat } from "./tile.js";
import { polygons } from "./decode.js";   // フラットgeom({coords,ends})→[flat, holes]（build と共用）

// vt_code(建物種別) → 概略高さ(m)。3101普通/3102堅ろう/3103高層/3111無壁舎 など。
const HEIGHT_M = { 3101: 9, 3102: 16, 3103: 34, 3104: 22, 3111: 5, 3112: 5 };
import { worldRadiusM } from "./camera.js";
const EARTH_M = () => worldRadiusM(), EXAG = 1.6;   // 単位球スケール換算（球6371000／楕円体a＝camera.js のノブに追随）＋見栄えの誇張
const ROOF = 1.0, WALL = 0.76;             // 陰影（屋根明／壁暗）

export function buildBuildings({ layers, z, x, y }, origin) {
	const src = layers.BldA;
	if (!src || z < 14) return null;         // 建物は近景(高z)タイルのみ
	const [ox, oy] = origin;
	const pos = [], shade = [], anchor = [];
	const toLL = (px, py) => tileLocalToLonLat(x, y, z, px, py, src.extent);

	for (const f of src.features) {
		if (f.props.vt_lvorder !== 0) continue;                       // 地上レベルのみ
		const h = (HEIGHT_M[f.props.vt_code] || 10) * EXAG / EARTH_M();
		for (const [flat, holes] of polygons(f.geom)) {
			const nv = flat.length / 2;
			const ll = new Array(nv);
			for (let i = 0; i < nv; i++) { const [lon, lat] = toLL(flat[i * 2], flat[i * 2 + 1]); ll[i] = [lon - ox, lat - oy]; }
			const ax = ll[0][0], ay = ll[0][1];   // 建物の基準点：一棟の全頂点で単一標高＝垂直プリズム（屋根水平）
			// 屋根（上面, height=h）
			for (const idx of earcut(flat, holes, 2)) { const p = ll[idx]; pos.push(p[0], p[1], h); shade.push(ROOF); anchor.push(ax, ay); }
			// 壁（各リングの辺ごとに地上0→上h の quad）
			const ringStarts = [0, ...(holes || []), nv];
			for (let r = 0; r < ringStarts.length - 1; r++) {
				const a = ringStarts[r], b = ringStarts[r + 1];
				for (let i = a; i < b; i++) {
					const j = (i + 1 < b) ? i + 1 : a, p0 = ll[i], p1 = ll[j];
					pos.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h); shade.push(WALL, WALL, WALL); anchor.push(ax, ay, ax, ay, ax, ay);
					pos.push(p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h); shade.push(WALL, WALL, WALL); anchor.push(ax, ay, ax, ay, ax, ay);
				}
			}
		}
	}
	return pos.length ? { pos: new Float32Array(pos), shade: new Float32Array(shade), anchor: new Float32Array(anchor) } : null;
}

// moj筆/ドロップGISポリゴンの3D押し出し（一律の薄い高さ）＝buildBuildings の機構を GeoJSON 直で再利用。
// ★earcut を使わない：moj は自己交差/穴/巨大ポリゴンが混じり earcut が詰まる。屋根は stencil-then-cover の
//   fan（anchor, v_i, v_{i+1}）＝巻き数で穴/凹/自己交差を処理（geojson.js の overlay 塗りと同流儀）。
//   全頂点 z=h・shade=1 にするので屋根も壁と同じ BUILDING_VS/bldProg で描ける（専用シェーダ不要）。renderer が
//   屋根だけ描画の仕方を stencil に変える。壁は各辺の quad（0→h）＝三角形分割不要。base は anchor の標高＝平屋根/垂直壁。
const ringsOf = g => !g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
export function buildExtrudedParcels(features, origin, { heightM = 4, exag = EXAG } = {}) {
	if (!features || !features.length) return null;
	const [ox, oy] = origin;
	const h = heightM * exag / EARTH_M();                          // 一律の高さ（単位球スケール）＝壁の頂点z・屋根のz
	const wPos = [], wSh = [], wAnc = [], rPos = [], rSh = [], rAnc = [];
	for (const f of features) {
		for (const poly of ringsOf(f && f.geometry)) {
			if (!poly.length || !poly[0] || poly[0].length < 3) continue;
			const ax = poly[0][0][0] - ox, ay = poly[0][0][1] - oy;   // 筆の基準点（外周先頭）＝一筆で単一標高（平屋根・垂直壁）。穴も同じ anchor で巻き数減算
			for (const ring of poly) {
				const n = ring.length; if (n < 3) continue;
				const closed = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
				const end = closed ? n - 1 : n; if (end < 3) continue;
				for (let i = 0; i < end; i++) {
					const p0 = ring[i], p1 = ring[(i + 1) % end];
					const x0 = p0[0] - ox, y0 = p0[1] - oy, x1 = p1[0] - ox, y1 = p1[1] - oy;
					wPos.push(x0, y0, 0, x1, y1, 0, x1, y1, h); wSh.push(WALL, WALL, WALL); wAnc.push(ax, ay, ax, ay, ax, ay);
					wPos.push(x0, y0, 0, x1, y1, h, x0, y0, h); wSh.push(WALL, WALL, WALL); wAnc.push(ax, ay, ax, ay, ax, ay);
					rPos.push(ax, ay, h, x0, y0, h, x1, y1, h); rSh.push(ROOF, ROOF, ROOF); rAnc.push(ax, ay, ax, ay, ax, ay);
				}
			}
		}
	}
	if (!wPos.length) return null;
	return {
		walls: { pos: new Float32Array(wPos), shade: new Float32Array(wSh), anchor: new Float32Array(wAnc) },
		roof:  { pos: new Float32Array(rPos), shade: new Float32Array(rSh), anchor: new Float32Array(rAnc) },
	};
}

// ドロップGIS/moj筆のジオメトリを地形に沿わせて描く（fillなし）＝各頂点を「自分の標高」に落とす。ポリゴン/線/点の全型。
// ★anchor をその頂点自身の位置にする＝BUILDING_VS の base=elev(anchor) が各点の実標高になり、辺/点が地形に沿う（平屋根の単一標高と対照）。
//   線（ポリゴン境界＋LineString）＝GL_LINES で辺ごと端点2つ。点（Point）＝GL_POINTS。liftM=地形へ微上げして潜り/z-fight を避ける。
//   全て BUILDING_VS/bldProg で描ける（点は gl_PointSize）。返り値 { lines:{pos,shade,anchor}|null, points:{…}|null }。
const _pack = a => a.pos.length ? { pos: new Float32Array(a.pos), shade: new Float32Array(a.shade), anchor: new Float32Array(a.anchor) } : null;
export function buildDrapedGeometry(features, origin, { liftM = 1, exag = EXAG } = {}) {
	if (!features || !features.length) return { lines: null, points: null };
	const [ox, oy] = origin;
	const lift = liftM * exag / EARTH_M();                         // 微リフト（単位球スケール）＝a_pos.z。base(=自標高)へ上乗せ
	const L = { pos: [], shade: [], anchor: [] };               // GL_LINES
	const P = { pos: [], shade: [], anchor: [] };               // GL_POINTS
	const vtx = (t, x, y) => { const dx = x - ox, dy = y - oy; t.pos.push(dx, dy, lift); t.shade.push(1.0); t.anchor.push(dx, dy); };   // anchor=自分＝自標高に乗る
	const polyline = (pts, closeLoop) => {   // closeLoop=true＝ポリゴン環（末尾→先頭も結ぶ）、false＝LineString（開いた線）
		const n = pts?.length | 0; if (n < 2) return;
		let m = n;
		if (closeLoop && pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1]) m = n - 1;   // 閉環の末尾重複を落とす
		if (m < 2) return;
		const edges = closeLoop ? m : m - 1;
		for (let i = 0; i < edges; i++) { const a = pts[i], b = pts[(i + 1) % m]; vtx(L, a[0], a[1]); vtx(L, b[0], b[1]); }
	};
	const geom = g => {
		if (!g) return;
		switch (g.type) {
			case "Point":           if (g.coordinates) vtx(P, g.coordinates[0], g.coordinates[1]); break;
			case "MultiPoint":      for (const p of g.coordinates || []) vtx(P, p[0], p[1]); break;
			case "LineString":      polyline(g.coordinates, false); break;
			case "MultiLineString": for (const l of g.coordinates || []) polyline(l, false); break;
			case "Polygon":         for (const r of g.coordinates || []) polyline(r, true); break;
			case "MultiPolygon":    for (const poly of g.coordinates || []) for (const r of poly) polyline(r, true); break;
			case "GeometryCollection": for (const gg of g.geometries || []) geom(gg); break;
		}
	};
	for (const f of features) geom(f && f.geometry);
	return { lines: _pack(L), points: _pack(P) };
}
