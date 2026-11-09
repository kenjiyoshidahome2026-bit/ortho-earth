// 面の貼り付け（分類・P0 #1・2026-10-25）の柱を組む＝GeoJSON の面・線 → 上下に伸ばした閉じた柱（β 単位球の原点相対の三角形）。
// 描くのは core の set("classify")（gl/classify.ts・gpu/classify.ts）＝柱を描き終えた深度に当て、柱の内側にある面（地形・3D Tiles・模型）の画素だけ塗る。
// 柱は一つずつ閉じていればよい（重なりは巻き数が数える）。面の向きは全部の柱で揃える（上の蓋＝2D で反時計回り・下の蓋＝逆・壁＝輪の右が外）。
// 線は幅（m）の帯＝区間ごとの長方形の柱＋折れ目の八角形の柱。辺は maxSegM ごとに刻む（壁が地球の丸みに沿う）。
// 蓋は輪の頂点だけで三角形に割る（earcut）＝大きい面（数百 km）は蓋が弦で沈む＝上の蓋の高さに余裕を持たせる（既定 10000m）。
import earcut from "earcut";
import { ellNormal3D, lonlatTo3D } from "@ortho-earth/core";

type Ring = number[][];
export interface ClassifyGeomOptions {
	/** 線の帯の幅（m・既定 4） */ width?: number;
	/** 柱の下と上（m・楕円体高・既定 −1000 と 10000） */ minHeight?: number; maxHeight?: number;
	/** 辺を刻む長さ（m・既定 2000） */ maxSegM?: number;
	earthM: number; ell: boolean;
}
export interface ClassifyGeom { pos: Float32Array; idx: Uint32Array; origin: number[]; bbox: number[]; volumes: number }

const D2R = Math.PI / 180;
/** a closed volume given as triangles (addClassification's { type: "Mesh" }): positions = ECEF metres (x, y, z per vertex), indices =
 *  triangles counter-clockwise seen from outside (Cesium's BoxGeometry / EllipsoidGeometry / CylinderGeometry: ClassificationPrimitive) */
export interface ClassifyMesh { type: "Mesh"; positions: ArrayLike<number>; indices: ArrayLike<number> }

const WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
function llhOf(x: number, y: number, z: number): [number, number, number] {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - WGS_E2)), h = 0;
	for (let i = 0; i < 5; i++) { const sn = Math.sin(lat), N = WGS_A / Math.sqrt(1 - WGS_E2 * sn * sn); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - WGS_E2 * N / (N + h))); }
	return [lon / D2R, lat / D2R, h];
}
/** a { type: "Mesh" } volume → the classify column format (the same world as the polygon columns: lon/lat on the unit sphere + height) */
function meshVolume(m: ClassifyMesh, o: ClassifyGeomOptions): ClassifyGeom | null {
	const P = m.positions, I = m.indices, n = Math.floor(P.length / 3);
	if (n < 4 || I.length < 12) return null;
	const llh: Array<[number, number, number]> = [];
	for (let k = 0; k < n; k++) llh.push(llhOf(+P[k * 3], +P[k * 3 + 1], +P[k * 3 + 2]));
	const l0 = llh[0][0];
	for (const q of llh) { while (q[0] - l0 > 180) q[0] -= 360; while (q[0] - l0 < -180) q[0] += 360; }
	let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
	for (const q of llh) { w = Math.min(w, q[0]); e = Math.max(e, q[0]); s = Math.min(s, q[1]); nn = Math.max(nn, q[1]); }
	const origin = lonlatTo3D((w + e) / 2, (s + nn) / 2), pos = new Float32Array(n * 3);
	llh.forEach(([lng, lat, h], k) => {
		const u = lonlatTo3D(lng, lat), nr = o.ell ? ellNormal3D(lng, lat) : u, kk = h / o.earthM;
		pos[k * 3] = u[0] + nr[0] * kk - origin[0]; pos[k * 3 + 1] = u[1] + nr[1] * kk - origin[1]; pos[k * 3 + 2] = u[2] + nr[2] * kk - origin[2];
	});
	const idx = new Uint32Array(I.length - (I.length % 3));
	for (let i = 0; i < idx.length; i++) idx[i] = I[i];
	return { pos, idx, origin, bbox: [w, s, e, nn], volumes: 1 };
}
type GeoIn = { type?: string; geometry?: GeoIn; features?: GeoIn[]; geometries?: GeoIn[]; coordinates?: unknown };

/** GeoJSON（Feature・FeatureCollection・Geometry・GeometryCollection）→ 面（輪の列）と線（点の列）。点は持たない */
export function classifyShapes(data: unknown): { polys: Ring[][]; lines: Ring[] } {
	const polys: Ring[][] = [], lines: Ring[] = [];
	const ok = (c: unknown): c is number[] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
	const ring = (r: unknown): Ring => (Array.isArray(r) ? r.filter(ok).map(c => [+c[0], +c[1]]) : []);
	const walk = (g: GeoIn | null | undefined): void => {
		if (!g || typeof g !== "object") return;
		if (g.type === "FeatureCollection") return void (g.features || []).forEach(walk);
		if (g.type === "Feature") return walk(g.geometry);
		if (g.type === "GeometryCollection") return void (g.geometries || []).forEach(walk);
		const c = g.coordinates as unknown[];
		if (!Array.isArray(c)) return;
		if (g.type === "Polygon") polys.push(c.map(ring));
		else if (g.type === "MultiPolygon") for (const p of c) polys.push((p as unknown[]).map(ring));
		else if (g.type === "LineString") lines.push(ring(c));
		else if (g.type === "MultiLineString") for (const l of c) lines.push(ring(l));
	};
	walk(data as GeoIn);
	return { polys, lines };
}

// 2D の符号付き面積（x＝経度×cos・y＝緯度）
const area2 = (r: Ring, k: number) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * k * q[1] - q[0] * k * p[1]; } return a / 2; };
// 閉じの重複と連続する同じ点を落とし、経度を最初の点の近くへ（日付変更線を跨ぐ輪を 2D で割れるように）
function cleanRing(r: Ring): Ring {
	const out: Ring = [];
	for (const c of r) {
		let lng = c[0];
		if (out.length) { const l0 = out[0][0]; while (lng - l0 > 180) lng -= 360; while (lng - l0 < -180) lng += 360; }
		const last = out[out.length - 1];
		if (!last || last[0] !== lng || last[1] !== c[1]) out.push([lng, c[1]]);
	}
	if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (a[0] === b[0] && a[1] === b[1]) out.pop(); }
	return out;
}
// 辺を maxSegM ごとに刻む（経緯度で直線に割る）
function densify(r: Ring, maxSegM: number): Ring {
	const out: Ring = [];
	for (let i = 0, n = r.length; i < n; i++) {
		const p = r[i], q = r[(i + 1) % n];
		const dx = (q[0] - p[0]) * 111320 * Math.cos(((p[1] + q[1]) / 2) * D2R), dy = (q[1] - p[1]) * 110540;
		const k = Math.max(1, Math.ceil(Math.hypot(dx, dy) / maxSegM));
		for (let j = 0; j < k; j++) out.push([p[0] + (q[0] - p[0]) * j / k, p[1] + (q[1] - p[1]) * j / k]);
	}
	return out;
}
// 線の帯 → 長方形（区間）と八角形（折れ目）の輪（どれも反時計回り）
function lineRings(line: Ring, width: number): Ring[] {
	const l = cleanRing(line).filter((c, i, a) => i === 0 || c[0] !== a[i - 1][0] || c[1] !== a[i - 1][1]);
	const h = Math.max(0.01, width / 2), out: Ring[] = [];
	const mx = (lat: number) => 111320 * Math.cos(lat * D2R), my = 110540;
	for (let i = 0; i + 1 < l.length; i++) {
		const a = l[i], b = l[i + 1], kx = mx((a[1] + b[1]) / 2);
		const ex = (b[0] - a[0]) * kx, ny = (b[1] - a[1]) * my, len = Math.hypot(ex, ny);
		if (!(len > 0)) continue;
		const ox = -ny / len * h / kx, oy = ex / len * h / my;   // 左（進む向きの左）へ半幅
		out.push([[a[0] - ox, a[1] - oy], [b[0] - ox, b[1] - oy], [b[0] + ox, b[1] + oy], [a[0] + ox, a[1] + oy]]);
	}
	for (let i = 1; i + 1 < l.length; i++) {   // 折れ目を塞ぐ（端は塞がない＝MapLibre の line-cap butt と同じ）
		const c = l[i], kx = mx(c[1]), r: Ring = [];
		for (let j = 0; j < 8; j++) { const t = (j + 0.5) * Math.PI / 4; r.push([c[0] + Math.cos(t) * h / kx, c[1] + Math.sin(t) * h / my]); }
		out.push(r);
	}
	return out;
}

/** 面・線 → 柱の三角形（原点相対の β 座標）。何も無ければ null */
export function classifyGeometry(data: unknown, o: ClassifyGeomOptions): ClassifyGeom | null {
	const mesh = data as ClassifyMesh | null;
	if (mesh && typeof mesh === "object" && mesh.type === "Mesh") return meshVolume(mesh, o);
	const { polys, lines } = classifyShapes(data);
	const width = o.width ?? 4, h0 = o.minHeight ?? -1000, h1 = o.maxHeight ?? 10000, seg = o.maxSegM ?? 2000;
	const vols: Ring[][] = [];
	for (const p of polys) {
		const rings = p.map(cleanRing).filter(r => r.length >= 3);
		if (!rings.length) continue;
		// 穴も外の輪の経度に揃える
		const l0 = rings[0][0][0];
		for (const r of rings.slice(1)) { let d = 0; while (r[0][0] + d - l0 > 180) d -= 360; while (r[0][0] + d - l0 < -180) d += 360; if (d) for (const c of r) c[0] += d; }
		vols.push(rings);
	}
	for (const l of lines) for (const r of lineRings(l, width)) vols.push([r]);
	if (!vols.length) return null;
	// 原点＝全体の経緯度の箱の真ん中（海抜 0）
	let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
	for (const v of vols) for (const c of v[0]) { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
	const oLng = (w + e) / 2, oLat = (s + n) / 2, origin = lonlatTo3D(oLng, oLat);
	const pos: number[] = [], idx: number[] = [];
	const put = (lng: number, lat: number, hM: number): number => {
		const u = lonlatTo3D(lng, lat), m = o.ell ? ellNormal3D(lng, lat) : u, k = hM / o.earthM;
		pos.push(u[0] + m[0] * k - origin[0], u[1] + m[1] * k - origin[1], u[2] + m[2] * k - origin[2]);
		return pos.length / 3 - 1;
	};
	for (const v of vols) {
		const kx = Math.cos(((v[0].reduce((a, c) => a + c[1], 0)) / v[0].length) * D2R);
		// 外の輪＝反時計回り・穴＝時計回り（壁の外向きを「輪の右」で揃える）
		const rings = v.map((r, i) => { const d = densify(r, seg), a = area2(d, kx); return (i === 0) === (a < 0) ? d.reverse() : d; });
		const flat: number[] = [], holes: number[] = [];
		for (const r of rings) { if (flat.length) holes.push(flat.length / 2); for (const c of r) flat.push(c[0] * kx, c[1]); }
		const tri = earcut(flat, holes.length ? holes : undefined, 2);
		if (!tri.length) continue;
		const all = rings.flat();
		const top = all.map(c => put(c[0], c[1], h1)), bot = all.map(c => put(c[0], c[1], h0));
		for (let i = 0; i < tri.length; i += 3) {
			const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
			const ccw = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]) > 0;
			const [p, q, r] = ccw ? [a, b, c] : [a, c, b];
			idx.push(top[p], top[q], top[r], bot[p], bot[r], bot[q]);   // 上＝反時計回り・下＝逆
		}
		let base = 0;
		for (const r of rings) {
			for (let i = 0, m = r.length; i < m; i++) {
				const a = base + i, b = base + (i + 1) % m;
				idx.push(bot[a], bot[b], top[b], bot[a], top[b], top[a]);   // 壁＝a→b の右が外
			}
			base += r.length;
		}
	}
	if (!idx.length) return null;
	return { pos: new Float32Array(pos), idx: new Uint32Array(idx), origin, bbox: [w, s, e, n], volumes: vols.length };
}
