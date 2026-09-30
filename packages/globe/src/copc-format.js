// COPC（Cloud Optimized Point Cloud・LAS 1.4＋LAZ＋八分木の階層）の形を読む（#178・自前＝本人裁定 2026-09-30）。地図に依らない純関数だけ：
//   ヘッダ（375B）・VLR（copc info／laszip／WKT）・階層の節ページ（32B の項＝key(d,x,y,z)・offset・byteSize・pointCount＝−1 は子ページ）・
//   節の範囲（立方体を d 段割った x,y,z 番目）・点の記録（形式 6/7/8＝位置・強度・分類・RGB）。
// 取得（Range）と LAZ の展開は呼び手（copc-worker.js → "#pointcloud-formats" のプラグイン）。依存なし。

const td = new TextDecoder();
const str = (u8, o, n) => td.decode(u8.subarray(o, o + n)).replace(/\0[\s\S]*$/, "");
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));

/** 先頭（375B 以上）→ ヘッダ */
export function parseHeader(buf) {
	const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (str(u8, 0, 4) !== "LASF") throw new Error("copc: not a LAS file (no LASF signature)");
	const major = u8[24], minor = u8[25];
	if (major !== 1 || minor < 4) throw new Error(`copc: LAS ${major}.${minor} — COPC needs LAS 1.4`);
	const f = dv.getFloat64.bind(dv);
	return {
		headerSize: dv.getUint16(94, true), pointOffset: dv.getUint32(96, true), vlrCount: dv.getUint32(100, true),
		format: u8[104] & 0x3f, compressed: (u8[104] & 0xc0) !== 0, recordLength: dv.getUint16(105, true),
		scale: [f(131, true), f(139, true), f(147, true)], offset: [f(155, true), f(163, true), f(171, true)],
		max: [f(179, true), f(195, true), f(211, true)], min: [f(187, true), f(203, true), f(219, true)],
		evlrOffset: u64(dv, 235), evlrCount: dv.getUint32(243, true), pointCount: u64(dv, 247),
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

/**
 * 解いた点の記録（recordLength × n の平たい配列）→ 列。形式 6/7/8（LAS 1.4＝COPC が許す形）
 * @returns {{ x: Float64Array, y, z, intensity: Uint16Array, classification: Uint8Array, rgb: Uint16Array | null }}（x,y,z は原座標系＝scale・offset を掛けた値）
 */
export function readRecords(rec, n, hdr) {
	const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength), L = hdr.recordLength, [sx, sy, sz] = hdr.scale, [ox, oy, oz] = hdr.offset;
	const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), intensity = new Uint16Array(n), classification = new Uint8Array(n);
	const hasRgb = hdr.format === 7 || hdr.format === 8, rgb = hasRgb ? new Uint16Array(n * 3) : null;
	for (let i = 0, o = 0; i < n; i++, o += L) {
		x[i] = dv.getInt32(o, true) * sx + ox; y[i] = dv.getInt32(o + 4, true) * sy + oy; z[i] = dv.getInt32(o + 8, true) * sz + oz;
		intensity[i] = dv.getUint16(o + 12, true); classification[i] = dv.getUint8(o + 16);
		if (rgb) { rgb[i * 3] = dv.getUint16(o + 30, true); rgb[i * 3 + 1] = dv.getUint16(o + 32, true); rgb[i * 3 + 2] = dv.getUint16(o + 34, true); }
	}
	return { x, y, z, intensity, classification, rgb };
}
