// LAS／COPC（Cloud Optimized Point Cloud・LAS 1.4＋LAZ＋八分木の階層）の形を読む（#178・自前＝本人裁定 2026-09-30）。地図に依らない純関数だけ：
//   置き場＝tile-formats（2026-10-15・点群計画 段 1-3＝形の読み取りは依存なしの部品の仕事。旧 globe/src/copc-format.js）。
//   ヘッダ（375B）・VLR（copc info／laszip／WKT）・階層の節ページ（32B の項＝key(d,x,y,z)・offset・byteSize・pointCount＝−1 は子ページ）・
//   節の範囲（立方体を d 段割った x,y,z 番目）・点の記録（形式 0〜10＝位置・強度・分類・RGB）・GeoTIFF キー（VLR 34735）の EPSG 番号。
//   LAS 1.0〜1.4 のヘッダを読む（2026-10-15・点群計画 段 3-1＝日本の配布物は LAS 1.2/1.3・形式 0〜3 が多い）。COPC が 1.4 であることの検査は呼び手。
// 取得（Range）と LAZ の展開は呼び手（globe の copc-worker.js → "#pointcloud-formats" のプラグイン）。依存なし（laz-perf も読まない）。

/** バイト列＝ArrayBuffer か型付き配列（new Uint8Array(buf) で写す） */
export type LasBytes = ArrayBuffer | ArrayLike<number>;
/** 位置を持つバイト列（ArrayBuffer か ArrayBufferView＝byteOffset を足して読む） */
export type LasView = ArrayBuffer | ArrayBufferView;
export type Vec3 = [number, number, number];
export interface LasHeader {
	version: [major: number, minor: number];
	headerSize: number; pointOffset: number; vlrCount: number;
	format: number; compressed: boolean; recordLength: number;
	scale: Vec3; offset: Vec3;
	max: Vec3; min: Vec3;
	evlrOffset: number; evlrCount: number; pointCount: number;
}
export interface LasVlr { userId: string; recordId: number; offset: number; length: number }
export interface CopcInfo { center: Vec3; halfsize: number; spacing: number; rootHierOffset: number; rootHierSize: number; gpsMin: number; gpsMax: number }
/** 節の鍵＝[d, x, y, z] */
export type NodeKey = [number, number, number, number];
export interface CopcNode { key: NodeKey; offset: number; byteSize: number; pointCount: number }
export interface CopcPage { key: NodeKey; offset: number; byteSize: number }
/** readRecords／readRecordsRaw が見るヘッダの部分 */
export type RecordHeader = Pick<LasHeader, "format" | "recordLength" | "scale" | "offset">;
export interface LasRecords { x: Float64Array; y: Float64Array; z: Float64Array; intensity: Uint16Array; classification: Uint8Array; rgb: Uint16Array | null }
export interface LasRecordsRaw { X: Int32Array; Y: Int32Array; Z: Int32Array; intensity: Uint16Array; classification: Uint8Array; rgb: Uint8Array | null }
export interface GeoKeysEpsg { horizontal: number | null; vertical: number | null }

const td = new TextDecoder();
const str = (u8: Uint8Array, o: number, n: number): string => td.decode(u8.subarray(o, o + n)).replace(/\0[\s\S]*$/, "");
const u64 = (dv: DataView, o: number): number => Number(dv.getBigUint64(o, true));

/** 先頭（1.4 は 375B・1.0〜1.2 は 227B 以上）→ ヘッダ。version＝[major, minor]。1.4 未満は点の数が 32bit・EVLR なし */
export function parseHeader(buf: LasBytes): LasHeader {
	const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (str(u8, 0, 4) !== "LASF") throw new Error("las: not a LAS file (no LASF signature)");
	const major = u8[24], minor = u8[25];
	if (major !== 1 || minor > 4) throw new Error(`las: LAS ${major}.${minor} is not supported`);
	const f = dv.getFloat64.bind(dv), v14 = minor >= 4;
	return {
		version: [major, minor],
		headerSize: dv.getUint16(94, true), pointOffset: dv.getUint32(96, true), vlrCount: dv.getUint32(100, true),
		format: u8[104] & 0x3f, compressed: (u8[104] & 0xc0) !== 0, recordLength: dv.getUint16(105, true),
		scale: [f(131, true), f(139, true), f(147, true)], offset: [f(155, true), f(163, true), f(171, true)],
		max: [f(179, true), f(195, true), f(211, true)], min: [f(187, true), f(203, true), f(219, true)],
		evlrOffset: v14 ? u64(dv, 235) : 0, evlrCount: v14 ? dv.getUint32(243, true) : 0, pointCount: v14 ? u64(dv, 247) : dv.getUint32(107, true),
	};
}
/** VLR の並び（ヘッダの直後から）→ [{ userId, recordId, offset, length }]（中身は呼び手が切り出す） */
export function listVlrs(buf: LasBytes, start: number, count: number, extended = false): LasVlr[] {
	const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out: LasVlr[] = [];
	let o = start;
	for (let i = 0; i < count && o + (extended ? 60 : 54) <= u8.byteLength; i++) {
		const userId = str(u8, o + 2, 16), recordId = dv.getUint16(o + 18, true);
		const length = extended ? u64(dv, o + 20) : dv.getUint16(o + 20, true), head = extended ? 60 : 54;
		out.push({ userId, recordId, offset: o + head, length });
		o += head + length;
	}
	return out;
}
/** copc info（userId "copc"・recordId 1・160B）→ 八分木の立方体と根の節ページ */
export function parseCopcInfo(buf: LasView, o = 0): CopcInfo {
	const dv = new DataView(ArrayBuffer.isView(buf) ? buf.buffer : buf, (ArrayBuffer.isView(buf) ? buf.byteOffset : 0) + o, 160), f = (k: number): number => dv.getFloat64(k, true);
	return { center: [f(0), f(8), f(16)], halfsize: f(24), spacing: f(32), rootHierOffset: u64(dv, 40), rootHierSize: u64(dv, 48), gpsMin: f(56), gpsMax: f(64) };
}
/** 節ページ（32B × n）→ { nodes: [{ key, offset, byteSize, pointCount }], pages: [{ key, offset, byteSize }] } */
export function parseHierarchyPage(buf: LasBytes): { nodes: CopcNode[]; pages: CopcPage[] } {
	const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), nodes: CopcNode[] = [], pages: CopcPage[] = [];
	for (let o = 0; o + 32 <= u8.byteLength; o += 32) {
		const key: NodeKey = [dv.getInt32(o, true), dv.getInt32(o + 4, true), dv.getInt32(o + 8, true), dv.getInt32(o + 12, true)];
		const offset = u64(dv, o + 16), byteSize = dv.getInt32(o + 24, true), pointCount = dv.getInt32(o + 28, true);
		if (pointCount === -1) pages.push({ key, offset, byteSize });
		else if (pointCount > 0) nodes.push({ key, offset, byteSize, pointCount });
	}
	return { nodes, pages };
}
export const keyStr = (k: ArrayLike<number> & { join(sep: string): string }): string => k.join("-");
/** 節の範囲（原座標系）＝[minx, miny, minz, maxx, maxy, maxz] */
export function nodeBounds(info: Pick<CopcInfo, "center" | "halfsize">, [d, x, y, z]: NodeKey): [number, number, number, number, number, number] {
	const size = info.halfsize * 2 / 2 ** d, c = info.center, h = info.halfsize;
	const x0 = c[0] - h + x * size, y0 = c[1] - h + y * size, z0 = c[2] - h + z * size;
	return [x0, y0, z0, x0 + size, y0 + size, z0 + size];
}
/** 親の key（根は null） */
export const parentKey = ([d, x, y, z]: NodeKey): NodeKey | null => d === 0 ? null : [d - 1, x >> 1, y >> 1, z >> 1];

// 点の記録の並び（LAS 1.4 R15 表 7〜）：形式 0〜5＝分類は 15 バイト目の下 5 bit・RGB は 2→20・3/5→28／形式 6〜10＝分類は 16 バイト目・RGB は 7/8/10→30
const RGB_AT: { [format: number]: number } = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
export const hasRgb = (format: number): boolean => format in RGB_AT;
/**
 * 解いた点の記録（recordLength × n の平たい配列）→ 列。形式 0〜10
 * @returns {{ x: Float64Array, y, z, intensity: Uint16Array, classification: Uint8Array, rgb: Uint16Array | null }}（x,y,z は原座標系＝scale・offset を掛けた値）
 */
export function readRecords(rec: ArrayBufferView, n: number, hdr: RecordHeader): LasRecords {
	const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength), L = hdr.recordLength, [sx, sy, sz] = hdr.scale, [ox, oy, oz] = hdr.offset;
	const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), intensity = new Uint16Array(n), classification = new Uint8Array(n);
	const ro = RGB_AT[hdr.format], rgb = ro !== undefined ? new Uint16Array(n * 3) : null, legacy = hdr.format < 6;
	for (let i = 0, o = 0; i < n; i++, o += L) {
		x[i] = dv.getInt32(o, true) * sx + ox; y[i] = dv.getInt32(o + 4, true) * sy + oy; z[i] = dv.getInt32(o + 8, true) * sz + oz;
		intensity[i] = dv.getUint16(o + 12, true); classification[i] = legacy ? dv.getUint8(o + 15) & 31 : dv.getUint8(o + 16);
		if (rgb) { rgb[i * 3] = dv.getUint16(o + ro, true); rgb[i * 3 + 1] = dv.getUint16(o + ro + 2, true); rgb[i * 3 + 2] = dv.getUint16(o + ro + 4, true); }
	}
	return { x, y, z, intensity, classification, rgb };
}

/**
 * 解いた点の記録 → 列（位置は記録のままの整数＝scale・offset を掛ける前）。丸ごと読み（段 3-3）で全点を持つ時に Float64 の 1/2 で済ませる用。
 *   rgb は 8bit（shift＝右へずらす数・16bit の作法なら 8）
 * @returns {{ X: Int32Array, Y, Z, intensity: Uint16Array, classification: Uint8Array, rgb: Uint8Array | null }}
 */
export function readRecordsRaw(rec: ArrayBufferView, n: number, hdr: Pick<RecordHeader, "format" | "recordLength">, { shift = 8 }: { shift?: number } = {}): LasRecordsRaw {
	const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength), L = hdr.recordLength;
	const X = new Int32Array(n), Y = new Int32Array(n), Z = new Int32Array(n), intensity = new Uint16Array(n), classification = new Uint8Array(n);
	const ro = RGB_AT[hdr.format], rgb = ro !== undefined ? new Uint8Array(n * 3) : null, legacy = hdr.format < 6;
	for (let i = 0, o = 0; i < n; i++, o += L) {
		X[i] = dv.getInt32(o, true); Y[i] = dv.getInt32(o + 4, true); Z[i] = dv.getInt32(o + 8, true);
		intensity[i] = dv.getUint16(o + 12, true); classification[i] = legacy ? dv.getUint8(o + 15) & 31 : dv.getUint8(o + 16);
		if (rgb) { rgb[i * 3] = dv.getUint16(o + ro, true) >> shift; rgb[i * 3 + 1] = dv.getUint16(o + ro + 2, true) >> shift; rgb[i * 3 + 2] = dv.getUint16(o + ro + 4, true) >> shift; }
	}
	return { X, Y, Z, intensity, classification, rgb };
}
/** 記録の RGB の最大（8bit で入れる書き手を見分ける＝最大が 255 以下なら shift 0） */
export function rgbMax(rec: ArrayBufferView, n: number, hdr: Pick<RecordHeader, "format" | "recordLength">): number {
	const ro = RGB_AT[hdr.format]; if (ro === undefined) return 0;
	const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength), L = hdr.recordLength; let mx = 0;
	for (let i = 0, o = ro; i < n; i++, o += L) for (let k = 0; k < 6; k += 2) { const v = dv.getUint16(o + k, true); if (v > mx) mx = v; }
	return mx;
}

/**
 * GeoTIFF キーの表（VLR "LASF_Projection" 34735・u16 の並び）→ { horizontal, vertical }（EPSG 番号・無ければ null）。
 *   ProjectedCSTypeGeoKey 3072 → 無ければ GeographicTypeGeoKey 2048・VerticalCSTypeGeoKey 4096。値 0（未定義）・32767（独自）は null
 */
export function geoKeysEpsg(buf: LasView, o = 0, length: number = buf.byteLength - o): GeoKeysEpsg {
	const u8 = new Uint8Array(ArrayBuffer.isView(buf) ? buf.buffer : buf, (ArrayBuffer.isView(buf) ? buf.byteOffset : 0) + o, length), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.byteLength < 8) return { horizontal: null, vertical: null };
	const nKeys = dv.getUint16(6, true), keys: { [id: number]: number } = {};
	for (let i = 0; i < nKeys && 8 + i * 8 + 8 <= u8.byteLength; i++) {
		const at = 8 + i * 8, id = dv.getUint16(at, true), loc = dv.getUint16(at + 2, true), val = dv.getUint16(at + 6, true);
		if (loc === 0) keys[id] = val;   // 値が直に入っている物だけ（EPSG 番号は必ずこの形）
	}
	const ok = (v: number | undefined): number | null => v && v !== 32767 ? v : null;
	return { horizontal: ok(keys[3072]) || ok(keys[2048]), vertical: ok(keys[4096]) };
}
