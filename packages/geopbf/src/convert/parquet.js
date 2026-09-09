// convert/parquet.js ── Apache Parquet の最小ライタ（依存ゼロ）。Thrift compact protocol の FileMetaData / PageHeader を
// 手書きし、DataPage v1・PLAIN か RLE_DICTIONARY（行グループ内の異なり値が半分以下なら辞書ページ＋添字の RLE/bit-packed）・
// definition level は RLE（bit 幅 1）・全列の min/max/null_count 統計・圧縮は GZIP か無圧縮。
// 読み手は pyarrow / DuckDB / GDAL / GeoPandas を想定（tests/t-parquet.mjs が pyarrow で読み戻す）。
//
// 対応する列型: BOOLEAN / INT64 / DOUBLE / BYTE_ARRAY（UTF8・JSON・生バイト）。
// スキーマは depth-first の SchemaElement 列で受ける（GeoParquet の bbox = optional group { required double ×4 }）。
import { gzip, zstd } from "./gzip.js";

// ── Thrift compact protocol ──
const CT = { BOOL_TRUE: 1, BOOL_FALSE: 2, BYTE: 3, I16: 4, I32: 5, I64: 6, DOUBLE: 7, BINARY: 8, LIST: 9, SET: 10, MAP: 11, STRUCT: 12 };
export class TWriter {
	constructor(cap = 4096) { this.buf = new Uint8Array(cap); this.pos = 0; this.last = 0; this.stack = []; }
	need(n) { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf); this.buf = b; } }
	byte(v) { this.need(1); this.buf[this.pos++] = v & 255; }
	varint(v) { this.need(10); while (v >= 128) { this.buf[this.pos++] = (v % 128) | 128; v = Math.floor(v / 128); } this.buf[this.pos++] = v; }
	zig(v) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
	structBegin() { this.stack.push(this.last); this.last = 0; }
	structEnd() { this.byte(0); this.last = this.stack.pop(); }
	header(id, type) { const d = id - this.last; if (d > 0 && d <= 15) this.byte((d << 4) | type); else { this.byte(type); this.zig(id); } this.last = id; }
	bool(id, v) { this.header(id, v ? CT.BOOL_TRUE : CT.BOOL_FALSE); }
	i32(id, v) { this.header(id, CT.I32); this.zig(v); }
	i64(id, v) { this.header(id, CT.I64); this.zig(v); }
	double(id, v) { this.header(id, CT.DOUBLE); this.need(8); new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, v, true); this.pos += 8; }
	binary(id, u8) { this.header(id, CT.BINARY); this.varint(u8.length); this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
	string(id, s) { this.binary(id, new TextEncoder().encode(s)); }
	struct(id) { this.header(id, CT.STRUCT); this.structBegin(); }
	list(id, elemType, size) { this.header(id, CT.LIST); this.listHeader(elemType, size); }
	listHeader(elemType, size) { if (size < 15) this.byte((size << 4) | elemType); else { this.byte(0xF0 | elemType); this.varint(size); } }
	rawBinary(u8) { this.varint(u8.length); this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }   // list 要素の binary/string
	finish() { return this.buf.subarray(0, this.pos); }
}

export const PT = { BOOLEAN: 0, INT32: 1, INT64: 2, INT96: 3, FLOAT: 4, DOUBLE: 5, BYTE_ARRAY: 6, FIXED_LEN_BYTE_ARRAY: 7 };
export const REP = { REQUIRED: 0, OPTIONAL: 1, REPEATED: 2 };
const CONV = { UTF8: 0, TIMESTAMP_MILLIS: 9, JSON: 19 };
const CODEC = { none: 0, snappy: 1, gzip: 2, zstd: 6 };

// SchemaElement: { name, type?, repetition?, numChildren?, logical?: "UTF8"|"JSON"|"TIMESTAMP_MILLIS" }
function writeSchemaElement(w, e) {
	w.structBegin();
	if (e.type !== undefined) w.i32(1, e.type);
	if (e.repetition !== undefined) w.i32(3, e.repetition);
	w.string(4, e.name);
	if (e.numChildren !== undefined) w.i32(5, e.numChildren);
	if (e.logical && CONV[e.logical] !== undefined) w.i32(6, CONV[e.logical]);
	if (e.logical === "UTF8") { w.struct(10); w.struct(1); w.structEnd(); w.structEnd(); }                       // LogicalType.STRING
	else if (e.logical === "JSON") { w.struct(10); w.struct(12); w.structEnd(); w.structEnd(); }                 // LogicalType.JSON
	else if (e.logical === "TIMESTAMP_MILLIS") { w.struct(10); w.struct(8); w.bool(1, true); w.struct(2); w.struct(1); w.structEnd(); w.structEnd(); w.structEnd(); w.structEnd(); }   // TIMESTAMP{utc, MILLIS}
	w.structEnd();
}

// definition level（0/1）の RLE/bit-packed hybrid（RLE run のみ・bit 幅 1）＋4 バイト長前置
function encodeDefLevels(levels) {
	const w = new TWriter(64);
	let i = 0;
	while (i < levels.length) { let j = i + 1; while (j < levels.length && levels[j] === levels[i]) j++; w.varint((j - i) * 2); w.byte(levels[i]); i = j; }
	const body = w.finish(), out = new Uint8Array(4 + body.length);
	new DataView(out.buffer).setUint32(0, body.length, true); out.set(body, 4);
	return out;
}

// BYTE_ARRAY の値 → バイト列（文字列は UTF-8・Uint8Array はそのまま）
const enc = new TextEncoder();
const toBytes = (v) => v instanceof Uint8Array ? v : enc.encode(String(v));
// 符号なしバイト列の辞書順比較
function cmpBytes(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }

// 値の PLAIN 符号化。vals: 非 null の値だけ（順序保持）
function encodeValues(type, vals) {
	if (type === PT.BOOLEAN) { const out = new Uint8Array((vals.length + 7) >> 3); for (let i = 0; i < vals.length; i++) if (vals[i]) out[i >> 3] |= 1 << (i & 7); return out; }
	if (type === PT.DOUBLE) { const out = new Uint8Array(vals.length * 8), dv = new DataView(out.buffer); for (let i = 0; i < vals.length; i++) dv.setFloat64(i * 8, vals[i], true); return out; }
	if (type === PT.INT64) { const out = new Uint8Array(vals.length * 8), dv = new DataView(out.buffer); for (let i = 0; i < vals.length; i++) { const v = vals[i], hi = Math.floor(v / 4294967296); dv.setUint32(i * 8, v - hi * 4294967296, true); dv.setInt32(i * 8 + 4, hi, true); } return out; }
	if (type === PT.BYTE_ARRAY) {
		const bs = vals.map(toBytes);
		let n = 0; for (const b of bs) n += 4 + b.length;
		const out = new Uint8Array(n), dv = new DataView(out.buffer); let p = 0;
		for (const b of bs) { dv.setUint32(p, b.length, true); out.set(b, p + 4); p += 4 + b.length; }
		return out;
	}
	throw new Error("parquet: unsupported type " + type);
}
const le8 = (v) => { const u = new Uint8Array(8); new DataView(u.buffer).setFloat64(0, v, true); return u; };
const le8i = (v) => { const u = new Uint8Array(8), hi = Math.floor(v / 4294967296); const dv = new DataView(u.buffer); dv.setUint32(0, v - hi * 4294967296, true); dv.setInt32(4, hi, true); return u; };

// Parquet の RLE/bit-packed hybrid（辞書添字用）。同値が 8 個以上続く区間は RLE run、それ以外は 8 個単位の bit-packed。
// idx: 添字列（n 個）、w: ビット幅（1..32）。戻り: [w の 1 バイト] ＋ run 列
function encodeHybrid(idx, n, w) {
	const out = new TWriter(64 + ((n * w) >> 3));
	out.byte(w);
	const bytesPerVal = (w + 7) >> 3;
	let i = 0;
	while (i < n) {
		let j = i + 1; while (j < n && idx[j] === idx[i]) j++;
		if (j - i >= 8) { out.varint((j - i) * 2); let v = idx[i]; for (let b = 0; b < bytesPerVal; b++) { out.byte(v % 256); v = Math.floor(v / 256); } i = j; continue; }
		let k = j;   // run にならない区間 [i, k) を集める（次の 8 個以上の run の手前まで）
		while (k < n) { let m = k + 1; while (m < n && idx[m] === idx[k]) m++; if (m - k >= 8) break; k = m; }
		// 8 の倍数に切り上げ（途中なら次の run から借りる・末尾なら 0 詰め）
		const cnt = k < n ? Math.min(n - i, (k - i + 7) & ~7) : k - i, groups = Math.ceil(cnt / 8);
		out.varint(groups * 2 + 1);
		let acc = 0, nb = 0;
		for (let p = 0; p < groups * 8; p++) {
			const v = i + p < n ? idx[i + p] : 0;
			acc += v * Math.pow(2, nb); nb += w;
			while (nb >= 8) { out.byte(acc % 256); acc = Math.floor(acc / 256); nb -= 8; }
		}
		i += cnt;
	}
	return out.finish().slice();
}

// 行グループ内の辞書化：異なり値が半分以下（先頭 4096 個で 2048 を超えたら諦める）で辞書が 1 MB 以下なら { dict, idx }
function tryDictionary(type, vals) {
	const n = vals.length;
	if (n < 2) return null;
	const map = new Map(), dict = [], idx = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		const v = vals[i];
		let d = map.get(v);
		if (d === undefined) { d = dict.length; map.set(v, d); dict.push(v); if ((i === 4095 && d > 2047) || d > (n >> 1)) return null; }
		idx[i] = d;
	}
	if (dict.length > (n >> 1)) return null;
	if (type === PT.BYTE_ARRAY) { let bytes = 0; for (const v of dict) bytes += 4 + toBytes(v).length; if (bytes > (1 << 20)) return null; }
	return { dict, idx };
}

// 列の統計（min/max のバイト表現）。BYTE_ARRAY は符号なしバイト列の辞書順・128 B を超える値があれば統計なし
function statsOf(type, vals) {
	if (!vals.length) return null;
	if (type === PT.BYTE_ARRAY) {
		let mn = null, mx = null;
		for (const v of vals) { const b = toBytes(v); if (b.length > 128) return null; if (mn === null || cmpBytes(b, mn) < 0) mn = b; if (mx === null || cmpBytes(b, mx) > 0) mx = b; }
		return { min: mn, max: mx };
	}
	let mn = Infinity, mx = -Infinity;
	for (const v of vals) { const x = +v; if (x !== x) continue; if (x < mn) mn = x; if (x > mx) mx = x; }
	if (mn === Infinity) return null;
	if (type === PT.BOOLEAN) return { min: new Uint8Array([mn ? 1 : 0]), max: new Uint8Array([mx ? 1 : 0]) };
	if (type === PT.INT64) return { min: le8i(mn), max: le8i(mx) };
	return { min: le8(mn), max: le8(mx) };
}

// columns: [{ path: ["a"] | ["bbox","xmin"], type: PT.*, values?: 配列（行順）| get(row) → 値 | null,
//            stats?: false で統計を省く（既定＝全列）, dict?: false で辞書化しない（幾何の WKB など）}]
// opts: { rowGroupSize=65536, codec:"gzip"|"zstd"|"none", level（zstd）, pageSize=1MB（データページの値バイト上限）,
//         keyValue: {k: v}, createdBy, compress?: async (u8)=>u8 }
export async function writeParquet({ schema, columns, numRows }, opts = {}) {
	const rowGroupSize = opts.rowGroupSize ?? 65536, codecName = opts.codec ?? "gzip", codec = CODEC[codecName], pageSize = opts.pageSize ?? (1 << 20);
	if (codec === undefined || codec === 1) throw new Error("parquet: codec は gzip か zstd か none");
	const gz = opts.compress ?? (codec === 6 ? (u8) => zstd(u8, opts.level) : gzip);
	const compress = async (u8) => codec ? gz(u8) : u8;
	const parts = [new Uint8Array([0x50, 0x41, 0x52, 0x31])];   // "PAR1"
	let fileOff = 4;
	const rowGroups = [];
	for (let r0 = 0; r0 < numRows; r0 += rowGroupSize) {
		const n = Math.min(rowGroupSize, numRows - r0), chunks = [];
		let totalBytes = 0, totalComp = 0;
		for (const col of columns) {
			const levels = new Uint8Array(n), vals = [], src = col.values;
			let nulls = 0;
			for (let i = 0; i < n; i++) {
				const v = src ? src[r0 + i] : col.get(r0 + i);
				if (v === null || v === undefined) { nulls++; continue; }
				levels[i] = 1; vals.push(v);
			}
			const st = col.stats === false ? null : statsOf(col.type, vals);
			const dic = col.dict === false || col.type === PT.BOOLEAN ? null : tryDictionary(col.type, vals);
			let unc = 0, cmp = 0, dictOff = null;
			const page = async (kind, body, numValues, encoding) => {   // ページを書き、(unc, cmp) を積む
				const comp = await compress(body);
				const ph = new TWriter(64);
				ph.structBegin();
				ph.i32(1, kind);                   // 0 DATA_PAGE / 2 DICTIONARY_PAGE
				ph.i32(2, body.length); ph.i32(3, comp.length);
				if (kind === 0) { ph.struct(5); ph.i32(1, numValues); ph.i32(2, encoding); ph.i32(3, 3); ph.i32(4, 3); ph.structEnd(); }   // DataPageHeader: num_values, encoding, RLE, RLE
				else { ph.struct(7); ph.i32(1, numValues); ph.i32(2, 0); ph.bool(3, false); ph.structEnd(); }                         // DictionaryPageHeader: num_values, PLAIN, is_sorted
				ph.structEnd();
				const phb = ph.finish().slice(), off = fileOff;
				parts.push(phb, comp); fileOff += phb.length + comp.length;
				unc += phb.length + body.length; cmp += phb.length + comp.length;
				return off;
			};
			// データページ分割：値のバイト量が pageSize を超えない行範囲ごとに 1 ページ（読み手のストリーミング・巨大 1 ページ回避）
			const bytesOf = col.type === PT.BYTE_ARRAY ? (v) => 4 + toBytes(v).length : col.type === PT.BOOLEAN ? () => 0.125 : () => 8;
			const ranges = [];   // [row0, row1, val0, val1]
			{
				let r0i = 0, v0 = 0, acc = 0, vi = 0;
				for (let i = 0; i < n; i++) {
					if (!levels[i]) continue;
					const b = dic ? 1 : bytesOf(vals[vi]);
					if (acc + b > pageSize && vi > v0) { ranges.push([r0i, i, v0, vi]); r0i = i; v0 = vi; acc = 0; }
					acc += b; vi++;
				}
				ranges.push([r0i, n, v0, vi]);
			}
			let pageOff = null;
			if (dic) {
				dictOff = await page(2, encodeValues(col.type, dic.dict), dic.dict.length, 0);
				const w = Math.max(1, Math.ceil(Math.log2(dic.dict.length)));
				for (const [a, b, va, vb] of ranges) {
					const lv = encodeDefLevels(levels.subarray(a, b)), hb = encodeHybrid(dic.idx.subarray(va, vb), vb - va, w);
					const raw = new Uint8Array(lv.length + hb.length); raw.set(lv, 0); raw.set(hb, lv.length);
					const off = await page(0, raw, b - a, 8); pageOff ??= off;   // RLE_DICTIONARY
				}
			} else {
				for (const [a, b, va, vb] of ranges) {
					const lv = encodeDefLevels(levels.subarray(a, b)), vbytes = encodeValues(col.type, vals.slice(va, vb));
					const raw = new Uint8Array(lv.length + vbytes.length); raw.set(lv, 0); raw.set(vbytes, lv.length);
					const off = await page(0, raw, b - a, 0); pageOff ??= off;   // PLAIN
				}
			}
			totalBytes += unc; totalComp += cmp;
			chunks.push({ col, pageOff, dictOff, unc, cmp, n, nulls, st });
		}
		rowGroups.push({ chunks, n, totalBytes, totalComp });
	}
	// FileMetaData
	const w = new TWriter(1 << 16);
	w.structBegin();
	w.i32(1, 2);                                              // version
	w.list(2, CT.STRUCT, schema.length); for (const e of schema) writeSchemaElement(w, e);
	w.i64(3, numRows);
	w.list(4, CT.STRUCT, rowGroups.length);
	for (const rg of rowGroups) {
		w.structBegin();
		w.list(1, CT.STRUCT, rg.chunks.length);
		for (const c of rg.chunks) {
			w.structBegin();
			w.i64(2, c.dictOff ?? c.pageOff);                     // file_offset
			w.struct(3);                                          // ColumnMetaData
			w.i32(1, c.col.type);
			if (c.dictOff !== null) { w.list(2, CT.I32, 3); w.zig(0); w.zig(3); w.zig(8); }   // encodings: PLAIN, RLE, RLE_DICTIONARY
			else { w.list(2, CT.I32, 2); w.zig(0); w.zig(3); }                               // PLAIN, RLE
			w.list(3, CT.BINARY, c.col.path.length); for (const s of c.col.path) w.rawBinary(new TextEncoder().encode(s));
			w.i32(4, codec);
			w.i64(5, c.n);
			w.i64(6, c.unc); w.i64(7, c.cmp);
			w.i64(9, c.pageOff);                                  // data_page_offset
			if (c.dictOff !== null) w.i64(11, c.dictOff);         // dictionary_page_offset
			if (c.st || c.nulls) {                                // Statistics
				w.struct(12);
				w.i64(3, c.nulls);
				if (c.st) { w.binary(5, c.st.max); w.binary(6, c.st.min); }
				w.structEnd();
			}
			w.structEnd();
			w.structEnd();
		}
		w.i64(2, rg.totalBytes); w.i64(3, rg.n);
		w.i64(6, rg.totalComp);
		w.structEnd();
	}
	const kv = Object.entries(opts.keyValue || {});
	if (kv.length) { w.list(5, CT.STRUCT, kv.length); for (const [k, v] of kv) { w.structBegin(); w.string(1, k); if (v != null) w.string(2, v); w.structEnd(); } }
	w.string(6, opts.createdBy ?? "geopbf");
	// column_orders: 葉列ごとに TypeDefinedOrder{}。これが無いと parquet-cpp（pyarrow）は min_value/max_value を読まない
	w.list(7, CT.STRUCT, columns.length); for (let i = 0; i < columns.length; i++) { w.structBegin(); w.struct(1); w.structEnd(); w.structEnd(); }
	w.structEnd();
	const meta = w.finish();
	const tail = new Uint8Array(8); new DataView(tail.buffer).setUint32(0, meta.length, true); tail.set([0x50, 0x41, 0x52, 0x31], 4);
	parts.push(meta, tail);
	let total = 0; for (const p of parts) total += p.length;
	const out = new Uint8Array(total); let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
	return out;
}
