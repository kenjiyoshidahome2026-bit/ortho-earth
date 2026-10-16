// 建物の押し出し（LOD1相当）：bvmap の BldA フットプリントを高さ方向に立ち上げる。
// bvmap に高さ属性は無いので vt_code(建物種別)から概略高さを推定。屋根(earcut)＋壁(各辺のquad)を生成。
// 建物の実メッシュ（正確な高さ/屋根）への"扉"の叩き台。
import earcut from "earcut";
import { tileLocalToLonLat } from "./tile.ts";
import { polygons } from "./decode.ts";   // フラットgeom({coords,ends})→[flat, holes]（build と共用）
import type { TileXYZ } from "./tile.ts";
import type { DecodedTile, TileData } from "./tileformat.ts";
import type { BuildingsGeom } from "./scene.ts";

import { worldRadiusM } from "./camera.ts";
const EARTH_M = (): number => worldRadiusM();   // 単位球スケール換算（球6371000／楕円体a＝camera.js のノブに追随）
// 建物の高さの係数＝1.0（誇張しない・本人裁定 2026-09-27）。旧 1.6 は 2026-07-04 の叩き台の「見栄えの誇張」で、
// 2 日後の標高ポリシー（TERR_EXAG 1.7→1.0・地形を歪めない）に取り残されていた＝表の 9/16/34m が実際は 14.4/25.6/54.4m で立ち、
// 影は 1.6 倍長く、PLATEAU（実高さ）との被覆の切れ目に段差が出ていた。係数として残す＝見栄えの再導入でなく A/B と実験の口。
const EXAG = 1.0;
const ROOF = 1.0, WALL = 0.76;             // 陰影（屋根明／壁暗）

/** style.schema.buildings＝どの層のどの属性が建物の種別と階層を表すか */
export interface BuildingsSchema { layer: string; levelKey?: string | null; codeKey?: string | null; heightByCode?: Record<string, number> | null; defaultHeight?: number | null }
export interface BuildingsSchemaHolder { buildings?: BuildingsSchema | null; [k: string]: unknown }
export interface BuildingsTile extends TileXYZ { layers: TileData }

// 建物の押し出し。**どの層のどの属性が建物の種別と階層を表すかは style が申告する**（style.schema.buildings）。
// エンジンはソースの名乗り方を知らない＝申告の無いソース（?pm= の任意アーカイブ等）では建物を出さない。
//   schema.buildings = { layer, levelKey, codeKey, heightByCode:{コード:高さm}, defaultHeight }
// 地理院 optimal_bvmap の申告は apps/ortho-japan/style-mono.js（3101 普通/3102 堅ろう/3103 高層/3111 無壁舎 など・2026-09-17）。
export function buildBuildings({ layers, z, x, y }: BuildingsTile, origin: readonly number[], schema: BuildingsSchemaHolder | null = null): BuildingsGeom | null {
	const B = schema && schema.buildings;
	if (!B) return null;                     // 語彙の申告が無いソース＝建物は立てない
	const src = (layers as DecodedTile)[B.layer];
	if (!src || z < 14) return null;         // 建物は近景(高z)タイルのみ
	const [ox, oy] = origin;
	const pos: number[] = [], shade: number[] = [], anchor: number[] = [];
	const toLL = (px: number, py: number): [number, number] => tileLocalToLonLat(x, y, z, px, py, src.extent);

	for (const f of src.features) {
		if (B.levelKey && f.props[B.levelKey] !== 0) continue;        // 地上レベルのみ（階層の属性は申告側が指名）
		const h = ((B.heightByCode && B.heightByCode[f.props[B.codeKey as string] as string]) || B.defaultHeight || 10) * EXAG / EARTH_M();
		for (const [flat, holes] of polygons(f.geom!)) {
			const nv = flat.length / 2;
			const ll: [number, number][] = new Array(nv);
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

// ドロップGIS/moj筆のジオメトリを地形に沿わせて描く（fillなし）＝各頂点を「自分の標高」に落とす。ポリゴン/線/点の全型。
// ★anchor をその頂点自身の位置にする＝BUILDING_VS の base=elev(anchor) が各点の実標高になり、辺/点が地形に沿う（平屋根の単一標高と対照）。
//   線（ポリゴン境界＋LineString）＝GL_LINES で辺ごと端点2つ。点（Point）＝GL_POINTS。liftM=地形へ微上げして潜り/z-fight を避ける。
//   全て BUILDING_VS/bldProg で描ける（点は gl_PointSize）。返り値 { lines:{pos,shade,anchor}|null, points:{…}|null }。
/** [lon, lat]（度） */
type Pt = number[];
/** 読む GeoJSON の形（Point…MultiPolygon・GeometryCollection） */
export interface DrapeGeometry { type: string; coordinates?: unknown; geometries?: DrapeGeometry[] | null }
export interface DrapeFeature { geometry?: DrapeGeometry | null }
export interface DrapeOptions { liftM?: number; exag?: number }
export interface DrapedGeometry { lines: BuildingsGeom | null; points: BuildingsGeom | null }
interface Acc { pos: number[]; shade: number[]; anchor: number[] }
const _pack = (a: Acc): BuildingsGeom | null => a.pos.length ? { pos: new Float32Array(a.pos), shade: new Float32Array(a.shade), anchor: new Float32Array(a.anchor) } : null;
export function buildDrapedGeometry(features: readonly (DrapeFeature | null | undefined)[] | null | undefined, origin: readonly number[], { liftM = 1, exag = 1 }: DrapeOptions = {}): DrapedGeometry {   // 持ち上げは z-fight の余白＝建物の高さ係数（EXAG）に相乗りさせない（2026-09-27・呼び出し側の liftM が実メートル）
	if (!features || !features.length) return { lines: null, points: null };
	const [ox, oy] = origin;
	const lift = liftM * exag / EARTH_M();                         // 微リフト（単位球スケール）＝a_pos.z。base(=自標高)へ上乗せ
	const L: Acc = { pos: [], shade: [], anchor: [] };               // GL_LINES
	const P: Acc = { pos: [], shade: [], anchor: [] };               // GL_POINTS
	const vtx = (t: Acc, x: number, y: number): void => { const dx = x - ox, dy = y - oy; t.pos.push(dx, dy, lift); t.shade.push(1.0); t.anchor.push(dx, dy); };   // anchor=自分＝自標高に乗る
	// 案B（長辺の適応細分・2026-09-06 本人指名）: ドレープは頂点でしか標高を取らない＝長い直線は途中の地形を無視して
	// 山を貫く/浮く（米加国境状態）。目標区間 ≈0.001°（≈100m）＝地形メッシュのセル級で中間点を挿し、各点が
	// elevQ（案A＝描画メッシュの折れ線面）に乗る＝線が面の折れ目どおりに折れる。1辺上限 256 分割（500km 級でも
	// 2km 刻み＝主要な起伏は拾う）・全体予算 60万頂点（≈14MB・超過後は端点のみ＝従来動作へ静かに縮退）。
	const SUB_STEP = 0.001, SUB_EDGE_MAX = 256, D2R = Math.PI / 180;
	let subBudget = 600000;
	// 中間点は大円上（完全球体＝頂点は大円で結ぶ・2026-09-14）。細分数は地形追従（≈100m）と大円追従（≈0.5°）の多い方。
	const gcvec = (lon: number, lat: number): number[] => { const c = Math.cos(lat * D2R); return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)]; };
	const edge = (a: Pt, b: Pt): void => {
		const cs = Math.cos((a[1] + b[1]) * 0.5 * D2R);
		const len = Math.hypot((b[0] - a[0]) * cs, b[1] - a[1]);
		const va = gcvec(a[0], a[1]), vb = gcvec(b[0], b[1]);
		const cx = va[1] * vb[2] - va[2] * vb[1], cy = va[2] * vb[0] - va[0] * vb[2], cz = va[0] * vb[1] - va[1] * vb[0];
		const w = Math.atan2(Math.hypot(cx, cy, cz), va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]), sw = Math.sin(w);
		let n = (subBudget > 0) ? Math.min(Math.max(Math.ceil(len / SUB_STEP), Math.ceil(w / (0.5 * D2R))), SUB_EDGE_MAX) : 1;
		if (n < 1) n = 1;
		if (n > 1) subBudget -= (n - 1) * 2;
		const at = (k: number): Pt => { if (sw < 1e-9) return [a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]; const t = k / n, ka = Math.sin((1 - t) * w) / sw, kb = Math.sin(t * w) / sw; const vx = va[0] * ka + vb[0] * kb, vy = va[1] * ka + vb[1] * kb, vz = va[2] * ka + vb[2] * kb; let lon = Math.atan2(vy, vx) / D2R; const lat = Math.atan2(vz, Math.hypot(vx, vy)) / D2R; while (lon - a[0] > 180) lon -= 360; while (lon - a[0] < -180) lon += 360; return [lon, lat]; };
		for (let k = 0; k < n; k++) { const p0 = at(k), p1 = at(k + 1); vtx(L, p0[0], p0[1]); vtx(L, p1[0], p1[1]); }
	};
	const polyline = (pts: Pt[] | null | undefined, closeLoop: boolean): void => {   // closeLoop=true＝ポリゴン環（末尾→先頭も結ぶ）、false＝LineString（開いた線）
		const n = (pts?.length as number) | 0; if (n < 2) return;
		let m = n;
		if (closeLoop && pts![0][0] === pts![n - 1][0] && pts![0][1] === pts![n - 1][1]) m = n - 1;   // 閉環の末尾重複を落とす
		if (m < 2) return;
		const edges = closeLoop ? m : m - 1;
		for (let i = 0; i < edges; i++) edge(pts![i], pts![(i + 1) % m]);
	};
	const geom = (g: DrapeGeometry | null | undefined): void => {
		if (!g) return;
		switch (g.type) {
			case "Point":           if (g.coordinates) vtx(P, (g.coordinates as Pt)[0], (g.coordinates as Pt)[1]); break;
			case "MultiPoint":      for (const p of (g.coordinates as Pt[] | undefined) || []) vtx(P, p[0], p[1]); break;
			case "LineString":      polyline(g.coordinates as Pt[], false); break;
			case "MultiLineString": for (const l of (g.coordinates as Pt[][] | undefined) || []) polyline(l, false); break;
			case "Polygon":         for (const r of (g.coordinates as Pt[][] | undefined) || []) polyline(r, true); break;
			case "MultiPolygon":    for (const poly of (g.coordinates as Pt[][][] | undefined) || []) for (const r of poly) polyline(r, true); break;
			case "GeometryCollection": for (const gg of g.geometries || []) geom(gg); break;
		}
	};
	for (const f of features) geom(f && f.geometry);
	return { lines: _pack(L), points: _pack(P) };
}
