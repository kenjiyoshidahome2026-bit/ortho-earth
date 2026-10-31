// 3D Tiles の Vector タイル（.vctr・Cesium の Vector3DTileContent・実験的な vctr 形式・2026-10-31）＝地面を塗る多角形。
// Cesium は多角形を「最低〜最高の高さの柱」にして地形と 3D Tiles を分類（塗る）＝この地図の分類の柱（core の set("classify")）と同じ使い方。
// 出力は .geom（geom-tile.ts）と同じ GeomOut＝tiles3d の volsOn がスタイルの色で柱を上げる。shape＝-1（点群の内外の判定はしない）。
// 中身＝44 バイトの頭（magic "vctr"・version 1・byteLength・特徴表 JSON／binary・batch table JSON／binary・indices・多角形の位置・線の位置・点の位置の各 byteLength）、
//   特徴表 JSON／binary、batch table、（4 バイト境界）indices（u32）、多角形の位置（u16：u の列・v の列・ジグザグの差分）、線・点の位置。
//   特徴表：POLYGONS_LENGTH・POLYGON_COUNTS（頂点数）・POLYGON_INDEX_COUNTS（三角形の index 数）・POLYGON_MINIMUM_HEIGHTS／MAXIMUM_HEIGHTS（無ければ REGION の 4・5）・
//   POLYGON_BATCH_IDS（u16・無ければ 0 から）・REGION（[西, 南, 東, 北（rad）, 最低, 最高（m）]）。u／v は 0〜32767 を REGION の経緯度へ線形に。
// 柱の形は Cesium（Workers/createVectorTilePolygons.js）と同じ：楕円体の面の点から法線方向に最低・最高の高さ＝底と天井、側面は輪の各辺。
// 線（POLYLINES）と点（POINTS）はまだ描かない（数だけ数える）。
import { batchTableOf } from "./mesh-features.ts";
import type { GeomOut, GeomPart } from "./geom-tile.ts";

type BinRef = { byteOffset: number };
interface VctrFeatureTable {
	POLYGONS_LENGTH?: number; POLYLINES_LENGTH?: number; POINTS_LENGTH?: number; REGION?: number[]; RTC_CENTER?: number[];
	POLYGON_COUNTS?: BinRef | number[]; POLYGON_COUNT?: BinRef | number[]; POLYGON_INDEX_COUNTS?: BinRef | number[]; POLYGON_INDEX_COUNT?: BinRef | number[];
	POLYGON_MINIMUM_HEIGHTS?: BinRef | number[]; POLYGON_MAXIMUM_HEIGHTS?: BinRef | number[]; POLYGON_BATCH_IDS?: BinRef | number[];
}
const td = new TextDecoder();
const jsonAt = (ab: ArrayBuffer, off: number, len: number): Record<string, unknown> | null => len ? JSON.parse(td.decode(new Uint8Array(ab, off, len)).replace(/[\0\s]+$/, "")) : null;
const A = 6378137, E2 = 6.69437999014e-3;   // WGS84
const MAX_SHORT = 32767;

/** .vctr の中身（off＝cmpt の中の位置）→ 多角形ごとの閉じた柱（null＝多角形なし） */
export function decodeVctr(ab: ArrayBuffer, off = 0): (GeomOut & { polylines: number; points: number }) | null {
	const dv = new DataView(ab, off);
	if (dv.getUint32(4, true) !== 1) throw new Error(`vctr: version ${dv.getUint32(4, true)} (only 1)`);
	if (dv.getUint32(8, true) === 0) return null;
	const ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true), idxB = dv.getUint32(28, true);
	let p = off + 44;
	const J = (jsonAt(ab, p, ftJ) || {}) as VctrFeatureTable; p += ftJ;
	const binOff = p; p += ftB;
	const BT = jsonAt(ab, p, btJ); p += btJ;
	const btBin = BT && btB ? new Uint8Array(ab, p, btB) : null; p += btJ ? btB : 0;
	const nPoly = (J.POLYGONS_LENGTH ?? 0) | 0, nLine = (J.POLYLINES_LENGTH ?? 0) | 0, nPt = (J.POINTS_LENGTH ?? 0) | 0, total = nPoly + nLine + nPt;
	const region = J.REGION;
	if (!nPoly || !region || region.length < 6) return null;
	// 特徴表の配列＝binary の byteOffset か、JSON の配列そのもの
	const arr = <T extends Uint32Array | Float32Array | Uint16Array>(v: BinRef | number[] | undefined, n: number, C: { new(b: ArrayBuffer): T; BYTES_PER_ELEMENT: number; from(a: ArrayLike<number>): T }): T | null => {
		if (v == null) return null;
		if (Array.isArray(v)) return C.from(v);
		const o = binOff + (v.byteOffset ?? 0);
		return new C(ab.slice(o, o + n * C.BYTES_PER_ELEMENT));
	};
	const counts = arr(J.POLYGON_COUNTS ?? J.POLYGON_COUNT, nPoly, Uint32Array), idxCounts = arr(J.POLYGON_INDEX_COUNTS ?? J.POLYGON_INDEX_COUNT, nPoly, Uint32Array);
	if (!counts || !idxCounts) throw new Error("vctr: POLYGON_COUNTS / POLYGON_INDEX_COUNTS missing");
	const minHs = J.POLYGON_MINIMUM_HEIGHTS && J.POLYGON_MAXIMUM_HEIGHTS ? arr(J.POLYGON_MINIMUM_HEIGHTS, nPoly, Float32Array) : null;
	const maxHs = minHs ? arr(J.POLYGON_MAXIMUM_HEIGHTS, nPoly, Float32Array) : null;
	// batch id：多角形→線→点の順に 0 から（どれかに *_BATCH_IDS があれば全部ある＝Cesium の約束）
	const ids = arr(J.POLYGON_BATCH_IDS, nPoly, Uint16Array) ?? Uint16Array.from({ length: nPoly }, (_, i) => i);
	p += (4 - (p % 4)) % 4;   // indices は 4 バイト境界（Cesium と同じく ArrayBuffer の頭からの位置で揃える＝cmpt の中でも）
	let nPos = 0, nIdx = 0;
	for (let i = 0; i < nPoly; i++) { nPos += counts[i]; nIdx += idxCounts[i]; }
	const indices = new Uint32Array(ab.slice(p, p + nIdx * 4)); p += idxB;
	const uv = new Uint16Array(ab.slice(p, p + nPos * 4));
	// ジグザグの差分（u の列・v の列それぞれ通しで）
	let u = 0, v = 0;
	for (let i = 0; i < nPos; i++) {
		const zu = uv[i], zv = uv[nPos + i];
		u += (zu >> 1) ^ -(zu & 1); v += (zv >> 1) ^ -(zv & 1);
		uv[i] = u; uv[nPos + i] = v;
	}
	const [w, s, e, n, rMin, rMax] = region;
	// 柱の中心＝RTC_CENTER（あれば）か REGION の中央・中間の高さ（Cesium と同じ）
	const ecef = (lon: number, lat: number, h: number, out: number[], o = 0) => {
		const sl = Math.sin(lat), cl = Math.cos(lat), N = A / Math.sqrt(1 - E2 * sl * sl);
		out[o] = (N + h) * cl * Math.cos(lon); out[o + 1] = (N + h) * cl * Math.sin(lon); out[o + 2] = (N * (1 - E2) + h) * sl;
	};
	const center = [0, 0, 0];
	if (J.RTC_CENTER?.length === 3) center.splice(0, 3, ...J.RTC_CENTER);
	else ecef((w + e) / 2, (s + n) / 2, (rMin + rMax) / 2, center);
	const parts: GeomPart[] = [], q = [0, 0, 0];
	const noInv = new Float64Array(16);
	let vOff = 0, iOff = 0;
	for (let k = 0; k < nPoly; k++) {
		const cnt = counts[k], ic = idxCounts[k], lo = minHs ? minHs[k] : rMin, hi = maxHs ? maxHs[k] : rMax;
		const pos = new Float32Array(cnt * 6), lon = new Float64Array(cnt), lat = new Float64Array(cnt);
		for (let j = 0; j < cnt; j++) {
			lon[j] = w + (e - w) * uv[vOff + j] / MAX_SHORT; lat[j] = s + (n - s) * uv[nPos + vOff + j] / MAX_SHORT;
			// 天井（2j）と底（2j+1）＝楕円体の面の点から法線方向へ（測地高＝そのまま h）
			ecef(lon[j], lat[j], hi, q); pos[j * 6] = q[0] - center[0]; pos[j * 6 + 1] = q[1] - center[1]; pos[j * 6 + 2] = q[2] - center[2];
			ecef(lon[j], lat[j], lo, q); pos[j * 6 + 3] = q[0] - center[0]; pos[j * 6 + 4] = q[1] - center[1]; pos[j * 6 + 5] = q[2] - center[2];
		}
		// 向き＝外向きに反時計回り（分類の柱の約束・.geom と同じ）。天井の三角形は経緯度（東・北）で反時計回りに揃え、側面は輪の向き（面積の符号）で決める
		const idx = new Uint32Array(ic * 2 + cnt * 6);
		let t = 0;
		for (let j = 0; j < ic; j += 3) {
			let a = indices[iOff + j] - vOff, b = indices[iOff + j + 1] - vOff, c = indices[iOff + j + 2] - vOff;
			if (a >= cnt || b >= cnt || c >= cnt) continue;
			if ((lon[b] - lon[a]) * (lat[c] - lat[a]) - (lat[b] - lat[a]) * (lon[c] - lon[a]) < 0) { const x = b; b = c; c = x; }
			idx[t++] = 2 * a; idx[t++] = 2 * b; idx[t++] = 2 * c;
			idx[t++] = 2 * c + 1; idx[t++] = 2 * b + 1; idx[t++] = 2 * a + 1;
		}
		let area = 0;
		for (let j = 0; j < cnt; j++) { const j1 = (j + 1) % cnt; area += lon[j] * lat[j1] - lon[j1] * lat[j]; }
		for (let j = 0; j < cnt; j++) {
			let j0 = j, j1 = (j + 1) % cnt;
			if (area < 0) { const x = j0; j0 = j1; j1 = x; }   // 時計回りの輪＝辺を逆にたどる
			// 反時計回りの輪の辺 j0→j1 の外＝進む向きの右：底 j0・底 j1・天井 j1／底 j0・天井 j1・天井 j0
			idx[t++] = 2 * j0 + 1; idx[t++] = 2 * j1 + 1; idx[t++] = 2 * j1;
			idx[t++] = 2 * j0 + 1; idx[t++] = 2 * j1; idx[t++] = 2 * j0;
		}
		parts.push({ id: ids[k], pos, idx: t === idx.length ? idx : idx.slice(0, t), shape: -1, inv: noInv });
		vOff += cnt; iOff += ic;
	}
	const table = BT ? batchTableOf(BT, btBin, total) : null;
	return { center, parts, table, polylines: nLine, points: nPt };
}
