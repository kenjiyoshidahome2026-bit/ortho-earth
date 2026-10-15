// LAS／COPC（Cloud Optimized Point Cloud・LAS 1.4＋LAZ＋八分木の階層）の形を読む（#178・自前＝本人裁定 2026-09-30）。地図に依らない純関数だけ：
//   置き場＝tile-formats（2026-10-15・点群計画 段 1-3＝形の読み取りは依存なしの部品の仕事。旧 globe/src/copc-format.js）。
//   ヘッダ（375B）・VLR（copc info／laszip／WKT）・階層の節ページ（32B の項＝key(d,x,y,z)・offset・byteSize・pointCount＝−1 は子ページ）・
//   節の範囲（立方体を d 段割った x,y,z 番目）・点の記録（形式 0〜10＝位置・強度・分類・RGB）・GeoTIFF キー（VLR 34735）の EPSG 番号。
//   LAS 1.0〜1.4 のヘッダを読む（2026-10-15・点群計画 段 3-1＝日本の配布物は LAS 1.2/1.3・形式 0〜3 が多い）。COPC が 1.4 であることの検査は呼び手。
// 取得（Range）と LAZ の展開は呼び手（globe の copc-worker.js → "#pointcloud-formats" のプラグイン）。依存なし（laz-perf も読まない）。

const td = new TextDecoder();
const str = (u8, o, n) => td.decode(u8.subarray(o, o + n)).replace(/\0[\s\S]*$/, "");
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));

/** 先頭（1.4 は 375B・1.0〜1.2 は 227B 以上）→ ヘッダ。version＝[major, minor]。1.4 未満は点の数が 32bit・EVLR なし */
export function parseHeader(buf) {
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
export function listVlrs(buf, start, count, extended = false) {
	const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
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
export function parseCopcInfo(buf, o = 0) {
	const dv = new DataView(buf.buffer ? buf.buffer : buf, (buf.byteOffset || 0) + o, 160), f = k => dv.getFloat64(k, true);
	return { center: [f(0), f(8), f(16)], halfsize: f(24), spacing: f(32), rootHierOffset: u64(dv, 40), rootHierSize: u64(dv, 48), gpsMin: f(56), gpsMax: f(64) };
}
/** 節ページ（32B × n）→ { nodes: [{ key, offset, byteSize, pointCount }], pages: [{ key, offset, byteSize }] } */
export function parseHierarchyPage(buf) {
	const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), nodes = [], pages = [];
	for (let o = 0; o + 32 <= u8.byteLength; o += 32) {
		const key = [dv.getInt32(o, true), dv.getInt32(o + 4, true), dv.getInt32(o + 8, true), dv.getInt32(o + 12, true)];
		const offset = u64(dv, o + 16), byteSize = dv.getInt32(o + 24, true), pointCount = dv.getInt32(o + 28, true);
		if (pointCount === -1) pages.push({ key, offset, byteSize });
		else if (pointCount > 0) nodes.push({ key, offset, byteSize, pointCount });
	}
	return { nodes, pages };
}
export const keyStr = k => k.join("-");
/** 節の範囲（原座標系）＝[minx, miny, minz, maxx, maxy, maxz] */
export function nodeBounds(info, [d, x, y, z]) {
	const size = info.halfsize * 2 / 2 ** d, c = info.center, h = info.halfsize;
	const x0 = c[0] - h + x * size, y0 = c[1] - h + y * size, z0 = c[2] - h + z * size;
	return [x0, y0, z0, x0 + size, y0 + size, z0 + size];
}
/** 親の key（根は null） */
export const parentKey = ([d, x, y, z]) => d === 0 ? null : [d - 1, x >> 1, y >> 1, z >> 1];

// 点の記録の並び（LAS 1.4 R15 表 7〜）：形式 0〜5＝分類は 15 バイト目の下 5 bit・RGB は 2→20・3/5→28／形式 6〜10＝分類は 16 バイト目・RGB は 7/8/10→30
const RGB_AT = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
export const hasRgb = format => format in RGB_AT;
/**
 * 解いた点の記録（recordLength × n の平たい配列）→ 列。形式 0〜10
 * @returns {{ x: Float64Array, y, z, intensity: Uint16Array, classification: Uint8Array, rgb: Uint16Array | null }}（x,y,z は原座標系＝scale・offset を掛けた値）
 */
export function readRecords(rec, n, hdr) {
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
 * GeoTIFF キーの表（VLR "LASF_Projection" 34735・u16 の並び）→ { horizontal, vertical }（EPSG 番号・無ければ null）。
 *   ProjectedCSTypeGeoKey 3072 → 無ければ GeographicTypeGeoKey 2048・VerticalCSTypeGeoKey 4096。値 0（未定義）・32767（独自）は null
 */
export function geoKeysEpsg(buf, o = 0, length = buf.byteLength - o) {
	const u8 = new Uint8Array(buf.buffer ? buf.buffer : buf, (buf.byteOffset || 0) + o, length), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.byteLength < 8) return { horizontal: null, vertical: null };
	const nKeys = dv.getUint16(6, true), keys = {};
	for (let i = 0; i < nKeys && 8 + i * 8 + 8 <= u8.byteLength; i++) {
		const at = 8 + i * 8, id = dv.getUint16(at, true), loc = dv.getUint16(at + 2, true), val = dv.getUint16(at + 6, true);
		if (loc === 0) keys[id] = val;   // 値が直に入っている物だけ（EPSG 番号は必ずこの形）
	}
	const ok = v => v && v !== 32767 ? v : null;
	return { horizontal: ok(keys[3072]) || ok(keys[2048]), vertical: ok(keys[4096]) };
}
