// 建物の押し出し（LOD1相当）：bvmap の BldA フットプリントを高さ方向に立ち上げる。
// bvmap に高さ属性は無いので vt_code(建物種別)から概略高さを推定。屋根(earcut)＋壁(各辺のquad)を生成。
// PLATEAU実メッシュ（正確な高さ/屋根）への"扉"の叩き台。
import earcut from "earcut";
import { tileLocalToLonLat } from "./tile.js";
import { polygons } from "./decode.js";   // フラットgeom({coords,ends})→[flat, holes]（build と共用）

// vt_code(建物種別) → 概略高さ(m)。3101普通/3102堅ろう/3103高層/3111無壁舎 など。
const HEIGHT_M = { 3101: 9, 3102: 16, 3103: 34, 3104: 22, 3111: 5, 3112: 5 };
const EARTH_M = 6371000, EXAG = 1.6;       // 単位球スケール換算＋見栄えの誇張
const ROOF = 1.0, WALL = 0.76;             // 陰影（屋根明／壁暗）

export function buildBuildings({ layers, z, x, y }, origin) {
	const src = layers.BldA;
	if (!src || z < 14) return null;         // 建物は近景(高z)タイルのみ
	const [ox, oy] = origin;
	const pos = [], shade = [], anchor = [];
	const toLL = (px, py) => tileLocalToLonLat(x, y, z, px, py, src.extent);

	for (const f of src.features) {
		if (f.props.vt_lvorder !== 0) continue;                       // 地上レベルのみ
		const h = (HEIGHT_M[f.props.vt_code] || 10) * EXAG / EARTH_M;
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
