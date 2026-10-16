// convert/parquet-read.js ── Apache Parquet の最小リーダ（依存ゼロ）。geoparquet.js の逆変換（GeoParquet → GeoPBF）用。
// 2026-09-20：**部分読み**＝openParquet(src) の src は Uint8Array のほか url / Blob / {read,size}。footer（末尾）だけを最初に読み、
// 列チャンクは row group × 列の byte range を readMany（隣接合体・並列）で取る＝全量を持たない。row group の列統計（min/max）と
// GeoParquet の bbox 覆域列から、視野（bbox）に触れる row group だけを選べる（select）。書き手が空間整列していれば読む量が視野比例になる。
// 読めるもの: Thrift compact の FileMetaData / PageHeader、DataPage v1・v2、PLAIN / PLAIN_DICTIONARY / RLE_DICTIONARY、
// RLE（BOOLEAN）/ DELTA_BINARY_PACKED / DELTA_LENGTH_BYTE_ARRAY / DELTA_BYTE_ARRAY / BYTE_STREAM_SPLIT（2026-10-12・改良点 14＝
// parquet-java／DuckDB／pyarrow の v2 ページで属性が黙って消えていた）、definition level の RLE/bit-packed、
// 圧縮 none / gzip / zstd（Node）/ snappy（自前・pyarrow と geopandas の既定）。
// 型: BOOLEAN / INT32 / INT64 / INT96（旧式の timestamp＝Date）/ FLOAT / DOUBLE / BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY。
// 平坦な列（optional/required）だけ＝入れ子の group は葉ごとの列として path で返し（name＝path を "." で結んだもの・実在の
// "a.b" 列と衝突したら後の方に "#2" "#3"…）、repeated（list/map）は読まずに飛ばす。読めない符号化・型は列ごとに
// columns[i].unsupported に理由（"unsupported encoding BIT_PACKED" など）。
// 戻り: { numRows, keyValue, created, columns: [{ path: string[], name, type, logical, values: Array(numRows) | null }] }
const DEC = new TextDecoder();   // 呼び出しごとの new TextDecoder を撤去（2026-09-15）
import { inflate } from "../modules/inflate.ts";
import { openSource } from "../cog/source.ts";
import type { SourceInput, SourceOptions, SourceMetrics, ByteRange } from "../cog/source.ts";
import { readUvarint, readSvarint } from "../modules/varint.ts";   // 部分読み（Range）＝COG と同じソース抽象（url | Blob/File | {read,size}）

/** Thrift の struct（fieldId → 値） */
export type TStruct = Record<number, unknown>;
type FieldReader = (r: TReader, type: number) => unknown;

// ── Thrift compact ──
class TReader {
	u8: Uint8Array;
	pos: number;
	last: number;
	stack: number[];
	constructor(u8: Uint8Array, pos = 0) { this.u8 = u8; this.pos = pos; this.last = 0; this.stack = []; }
	byte(): number { return this.u8[this.pos++]; }
	varint(): number { return readUvarint(this.u8, this); }
	zig(): number { return readSvarint(this.u8, this); }
	i64(): number { return this.zig(); }
	double(): number { const v = new DataView(this.u8.buffer, this.u8.byteOffset + this.pos).getFloat64(0, true); this.pos += 8; return v; }
	binary(): Uint8Array { const n = this.varint(), b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
	string(): string { return DEC.decode(this.binary()); }
	// struct を { fieldId: value } に。type 別の読み手 spec[fieldId] = fn(reader, type) が無ければ汎用
	struct(spec: Record<number, FieldReader> = {}): TStruct {
		this.stack.push(this.last); this.last = 0;
		const out: TStruct = {};
		for (;;) {
			const h = this.byte();
			if (h === 0) break;
			const type = h & 15, delta = h >> 4;
			const id = delta ? this.last + delta : this.zig(); this.last = id;
			out[id] = spec[id] ? spec[id](this, type) : this.value(type);
		}
		this.last = this.stack.pop() as number;
		return out;
	}
	listHeader(): { n: number; type: number } { const h = this.byte(); let n = h >> 4; const type = h & 15; if (n === 15) n = this.varint(); return { n, type }; }
	list(fn?: FieldReader): unknown[] { const { n, type } = this.listHeader(); const out: unknown[] = new Array(n); for (let i = 0; i < n; i++) out[i] = fn ? fn(this, type) : this.value(type); return out; }
	value(type: number): unknown {
		switch (type) {
			case 1: return true; case 2: return false;
			case 3: return (this.byte() << 24) >> 24;
			case 4: case 5: case 6: return this.zig();
			case 7: return this.double();
			case 8: return this.binary();
			case 9: case 10: return this.list();
			case 11: { const n = this.varint(); if (!n) return new Map(); const kt = this.byte(); const m = new Map<unknown, unknown>(); for (let i = 0; i < n; i++) m.set(this.value(kt >> 4), this.value(kt & 15)); return m; }
			case 12: return this.struct();
			default: throw new Error("parquet: unknown thrift type " + type);
		}
	}
}
const str: FieldReader = (r) => r.string();
const strList: FieldReader = (r) => r.list(str);

// ── ページ本文の復号 ──
// 細工されたページへの備え（2026-10-11・安全既定）: 宣言長は呼び手の上限（ページヘッダの uncompressed_page_size か MAX_PAGE）で
// 確保前に検査し、リテラル・複写とも「入力の外・出力の外・まだ書いていない所」を読まない（旧＝宣言サイズをそのまま確保・境界検査なし）。
export const MAX_PAGE = 1 << 30;   // 1 ページ／1 列チャンクの伸長後の上限（1 GiB）。Parquet の実用サイズ（既定 1 MB ページ・128 MB row group）の遥か上
export function snappy(src: Uint8Array, limit = MAX_PAGE): Uint8Array {   // raw snappy（Parquet の SNAPPY はフレーム無し）
	let p = 0, n = 0, m = 1;
	for (;;) { if (p >= src.length) throw new Error("snappy: truncated length header"); const b = src[p++]; n += (b & 127) * m; if (b < 128) break; m *= 128; if (m > 2 ** 35) throw new Error("snappy: bad length header"); }
	if (n > limit) throw new Error(`snappy: declared size ${n} exceeds limit ${limit}`);
	const out = new Uint8Array(n); let o = 0;
	while (p < src.length) {
		const tag = src[p++];
		if ((tag & 3) === 0) {
			let len = tag >> 2;
			if (len >= 60) { const k = len - 59; if (p + k > src.length) throw new Error("snappy: truncated literal length"); len = 0; for (let i = 0; i < k; i++) len |= src[p + i] << (8 * i); p += k; len >>>= 0; }
			len += 1;
			if (p + len > src.length || o + len > n) throw new Error("snappy: literal runs past the input or the declared size");
			out.set(src.subarray(p, p + len), o); p += len; o += len;
		} else {
			let len: number, off: number;
			if ((tag & 3) === 1) { if (p + 1 > src.length) throw new Error("snappy: truncated copy"); len = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p]; p += 1; }
			else if ((tag & 3) === 2) { if (p + 2 > src.length) throw new Error("snappy: truncated copy"); len = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
			else { if (p + 4 > src.length) throw new Error("snappy: truncated copy"); len = (tag >> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4; }
			let s = o - off;
			if (off === 0 || s < 0 || o + len > n) throw new Error("snappy: copy offset outside the output written so far");
			for (let i = 0; i < len; i++) out[o++] = out[s++];   // 重なりあり＝1 バイトずつ
		}
	}
	if (o !== n) throw new Error(`snappy: output ${o} B does not match declared ${n} B`);
	return out;
}
const CODEC_NAME: Record<number, string> = { 0: "none", 1: "snappy", 2: "gzip", 6: "zstd" };
const ENC_NAME: Record<number, string> = { 0: "PLAIN", 2: "PLAIN_DICTIONARY", 3: "RLE", 4: "BIT_PACKED", 5: "DELTA_BINARY_PACKED", 6: "DELTA_LENGTH_BYTE_ARRAY", 7: "DELTA_BYTE_ARRAY", 8: "RLE_DICTIONARY", 9: "BYTE_STREAM_SPLIT" };
const PT_NAME: Record<number, string> = { 0: "BOOLEAN", 1: "INT32", 2: "INT64", 3: "INT96", 4: "FLOAT", 5: "DOUBLE", 6: "BYTE_ARRAY", 7: "FIXED_LEN_BYTE_ARRAY" };
async function decompress(u8: Uint8Array, codec: number, uncompressedSize: number): Promise<Uint8Array> {
	// uncompressedSize＝ページヘッダの宣言（型は Thrift の i32 ＝ 2 GiB 未満）。上限（MAX_PAGE）を越える宣言は確保前に拒む
	if (!(uncompressedSize >= 0) || uncompressedSize > MAX_PAGE) throw new Error(`parquet: page declares ${uncompressedSize} B uncompressed (limit ${MAX_PAGE})`);
	if (codec === 0) return u8;
	let out: Uint8Array;
	if (codec === 1) out = snappy(u8, uncompressedSize);
	else if (codec === 2) out = await inflate(u8, "gzip");
	else if (codec === 6) out = await inflate(u8, "zstd");
	else throw new Error("parquet: unsupported codec " + (CODEC_NAME[codec] ?? codec) + " (none/snappy/gzip/zstd)");
	if (out.length > uncompressedSize) throw new Error(`parquet: page inflated to ${out.length} B, more than the declared ${uncompressedSize} B`);
	return out;
}

// RLE/bit-packed hybrid → Int32Array(n)（bit 幅 w）
function decodeHybrid(u8: Uint8Array, pos: number, end: number, w: number, n: number): Int32Array {
	const out = new Int32Array(n); let o = 0;
	const bytes = (w + 7) >> 3;
	end = Math.min(end, u8.length);   // end は呼び手の宣言＝入力の外を指し得る（細工されたページ）。読むのは end まで・足りない分は 0
	while (o < n && pos < end) {
		let h = 0, m = 1; for (;;) { const b = pos < end ? u8[pos] : 0; pos++; h += (b & 127) * m; if (b < 128) break; m *= 128; }
		if (h & 1) {   // bit-packed: (h>>1) groups of 8
			const groups = h >>> 1; let acc = 0, nb = 0;
			for (let g = 0; g < groups && o < n; g++) for (let i = 0; i < 8; i++) {
				while (nb < w) { acc += (pos < end ? u8[pos] : 0) * Math.pow(2, nb); pos++; nb += 8; }
				const v = acc % Math.pow(2, w); acc = Math.floor(acc / Math.pow(2, w)); nb -= w;
				if (o < n) out[o++] = v;
			}
		} else {   // RLE run
			const cnt = h >>> 1; let v = 0; for (let i = 0; i < bytes; i++) v += u8[pos + i] * Math.pow(2, 8 * i); pos += bytes;
			for (let i = 0; i < cnt && o < n; i++) out[o++] = v;
		}
	}
	return out;
}

/** 復号した値列と、消費した次の位置 */
export interface Decoded { out: ArrayLike<unknown>; pos: number }
interface DecodedNums { out: Int32Array | number[]; pos: number }
interface DecodedBytes { out: Uint8Array[]; pos: number }

// ── DELTA_BINARY_PACKED（INT32/INT64）──
// 頭: block size・block 当たりの miniblock 数・値の総数・先頭の値（zigzag）。block ごとに min delta（zigzag）と miniblock の bit 幅、
// 続けて miniblock の bit-packed 列（値が尽きた miniblock は書かれない）。INT32 は 2^32 で回り（spec の overflow）、INT64 は
// 2^53 を越えると Number の精度で丸まる（PLAIN の INT64 と同じ）。戻り { out, pos }（pos＝消費した次の位置＝DELTA_*BYTE_ARRAY が続きを読む）
function uleb(u8: Uint8Array, pos: number): [number, number] { const c = { pos }; const v = readUvarint(u8, c); return [v, c.pos]; }
function zigzag64(u8: Uint8Array, pos: number): [bigint, number] {   // zigzag varint（64 bit）→ BigInt
	let v = 0n, sh = 0n, b: number;
	do { if (pos >= u8.length) throw new Error("parquet: truncated delta header"); b = u8[pos++]; v |= BigInt(b & 127) << sh; sh += 7n; } while (b >= 128);
	return [(v >> 1n) ^ -(v & 1n), pos];
}
export function decodeDeltaBinaryPacked(u8: Uint8Array, pos: number, n: number, type: number): DecodedNums {
	const big = type === 2;   // INT64＝BigInt で積む（delta の幅が 32 を越え得る）
	let bs: number, mbs: number, total: number, first: bigint;
	[bs, pos] = uleb(u8, pos); [mbs, pos] = uleb(u8, pos); [total, pos] = uleb(u8, pos); [first, pos] = zigzag64(u8, pos);
	if (!(bs > 0) || !(mbs > 0) || bs % mbs || (bs / mbs) % 32) throw new Error(`parquet: bad DELTA_BINARY_PACKED header (block ${bs}, miniblocks ${mbs})`);
	if (total < n) throw new Error(`parquet: DELTA_BINARY_PACKED holds ${total} values, page needs ${n}`);
	const per = bs / mbs, out: Int32Array | number[] = big ? new Array<number>(n) : new Int32Array(n);
	const wrap32 = (v: bigint): number => Number(BigInt.asIntN(32, v));
	let cur = first, o = 0;
	if (n) out[o++] = big ? Number(cur) : wrap32(cur);
	let left = total - 1;   // 残る delta の数（ページの n を越える分も読み飛ばす＝pos を正しく進める）
	while (left > 0) {
		let minD: bigint; [minD, pos] = zigzag64(u8, pos);
		if (pos + mbs > u8.length) throw new Error("parquet: truncated DELTA_BINARY_PACKED block");
		const widths = u8.subarray(pos, pos + mbs); pos += mbs;
		for (let m = 0; m < mbs && left > 0; m++) {
			const w = widths[m];
			if (w > 64) throw new Error("parquet: DELTA_BINARY_PACKED bit width " + w);
			const bytes = (per * w) >> 3;
			if (pos + bytes > u8.length) throw new Error("parquet: truncated DELTA_BINARY_PACKED miniblock");
			const take = Math.min(per, left);
			if (w === 0) { for (let i = 0; i < take; i++) { cur += minD; if (o < n) out[o++] = big ? Number(cur) : wrap32(cur); } }
			else {
				let acc = 0n, nb = 0n, p = pos; const W = BigInt(w), mask = (1n << W) - 1n;
				for (let i = 0; i < take; i++) {
					while (nb < W) { acc |= BigInt(u8[p++]) << nb; nb += 8n; }
					cur += minD + (acc & mask); acc >>= W; nb -= W;
					if (o < n) out[o++] = big ? Number(BigInt.asIntN(64, cur)) : wrap32(cur);
				}
			}
			pos += bytes; left -= take;
		}
	}
	return { out, pos };
}
// DELTA_LENGTH_BYTE_ARRAY: 長さ列（DELTA_BINARY_PACKED INT32）＋連結したバイト列
function decodeDeltaLengthByteArray(u8: Uint8Array, pos: number, n: number): DecodedBytes {
	const { out: lens, pos: p0 } = decodeDeltaBinaryPacked(u8, pos, n, 1);
	const out: Uint8Array[] = new Array(n); let p = p0;
	for (let i = 0; i < n; i++) { const l = lens[i]; if (l < 0 || p + l > u8.length) throw new Error("parquet: DELTA_LENGTH_BYTE_ARRAY runs past the page"); out[i] = u8.subarray(p, p + l); p += l; }
	return { out, pos: p };
}
// DELTA_BYTE_ARRAY: 前の値との共通接頭辞の長さ列＋接尾辞（DELTA_LENGTH_BYTE_ARRAY）。FIXED_LEN_BYTE_ARRAY にも使われる
function decodeDeltaByteArray(u8: Uint8Array, pos: number, n: number): DecodedBytes {
	const { out: pre, pos: p0 } = decodeDeltaBinaryPacked(u8, pos, n, 1);
	const { out: suf, pos: p1 } = decodeDeltaLengthByteArray(u8, p0, n);
	const out: Uint8Array[] = new Array(n); let prev = new Uint8Array(0);
	for (let i = 0; i < n; i++) {
		const k = pre[i]; if (k < 0 || k > prev.length) throw new Error("parquet: DELTA_BYTE_ARRAY prefix longer than the previous value");
		const v = new Uint8Array(k + suf[i].length); v.set(prev.subarray(0, k), 0); v.set(suf[i], k); out[i] = prev = v;
	}
	return { out, pos: p1 };
}
// BYTE_STREAM_SPLIT: 値の k 番目のバイトを集めた stream が size 本（FLOAT 4・DOUBLE 8・INT32 4・INT64 8・FIXED_LEN は typeLength）
function decodeByteStreamSplit(u8: Uint8Array, pos: number, type: number, n: number, typeLength: number): Decoded {
	const size = type === 1 || type === 4 ? 4 : type === 2 || type === 5 ? 8 : type === 7 ? typeLength : 0;
	if (!size) throw new Error("parquet: BYTE_STREAM_SPLIT on physical type " + type);
	if (pos + n * size > u8.length) throw new Error("parquet: truncated BYTE_STREAM_SPLIT page");
	const raw = new Uint8Array(n * size);
	for (let k = 0; k < size; k++) { const s0 = pos + k * n; for (let i = 0; i < n; i++) raw[i * size + k] = u8[s0 + i]; }
	return decodePlain(raw, 0, type, n, typeLength);
}
// INT96（旧式の timestamp）: 8 バイトの nanos-of-day ＋ 4 バイトの Julian day（どちらも LE）→ Date（ミリ秒へ丸め）
function int96ToDate(dv: DataView, p: number): Date {
	const lo = dv.getUint32(p, true), hi = dv.getUint32(p + 4, true), jd = dv.getUint32(p + 8, true);
	const nanos = hi * 4294967296 + lo;
	return new Date((jd - 2440588) * 86400000 + Math.floor(nanos / 1e6));
}

// PLAIN の値列を n 個読む（type 別）。BYTE_ARRAY は Uint8Array の配列
function decodePlain(u8: Uint8Array, pos: number, type: number, n: number, typeLength: number): { out: unknown[]; pos: number } {
	const dv = new DataView(u8.buffer, u8.byteOffset), out: unknown[] = new Array(n);
	if (type === 3) { for (let i = 0; i < n; i++) out[i] = int96ToDate(dv, pos + i * 12); return { out, pos: pos + n * 12 }; }
	if (type === 0) { for (let i = 0; i < n; i++) out[i] = !!(u8[pos + (i >> 3)] & (1 << (i & 7))); return { out, pos: pos + ((n + 7) >> 3) }; }
	if (type === 1) { for (let i = 0; i < n; i++) out[i] = dv.getInt32(pos + i * 4, true); return { out, pos: pos + n * 4 }; }
	if (type === 2) { for (let i = 0; i < n; i++) { const lo = dv.getUint32(pos + i * 8, true), hi = dv.getInt32(pos + i * 8 + 4, true); out[i] = hi * 4294967296 + lo; } return { out, pos: pos + n * 8 }; }
	if (type === 4) { for (let i = 0; i < n; i++) out[i] = dv.getFloat32(pos + i * 4, true); return { out, pos: pos + n * 4 }; }
	if (type === 5) { for (let i = 0; i < n; i++) out[i] = dv.getFloat64(pos + i * 8, true); return { out, pos: pos + n * 8 }; }
	if (type === 6) { for (let i = 0; i < n; i++) { const l = dv.getUint32(pos, true); out[i] = u8.subarray(pos + 4, pos + 4 + l); pos += 4 + l; } return { out, pos }; }
	if (type === 7) { for (let i = 0; i < n; i++) { out[i] = u8.subarray(pos, pos + typeLength); pos += typeLength; } return { out, pos }; }
	throw new Error("parquet: unsupported physical type " + type);
}

/** 論理型（LogicalType union の名前・DECIMAL/TIMESTAMP/TIME は詳細つき） */
export type Logical = string | { kind: "DECIMAL"; scale: number } | { kind: "TIMESTAMP"; unit: string } | { kind: "TIME" } | null;
/** スキーマの葉 */
export interface Leaf { path: string[]; name: string; type: number; typeLength: number; converted: number | undefined; logical: Logical; maxDef: number; repeated: boolean; pathKey?: string }
/** 列定義（openParquet / readParquet の columns） */
export interface ParquetColumnInfo { path: string[]; name: string; type: number; logical: Logical; unsupported: string | null }

// 論理型に沿って JS 値へ
function converter(el: Leaf): ((v: unknown) => unknown) | null {
	const lt = el.logical, ct = el.converted, type = el.type;
	const utf8 = (): ((b: unknown) => string) => { const d = new TextDecoder(); return (b) => d.decode(b as Uint8Array); };
	if (type === 6 || type === 7) {
		if (lt === "JSON" || ct === 19) { const d = new TextDecoder(); return (b) => { try { return JSON.parse(d.decode(b as Uint8Array)); } catch { return d.decode(b as Uint8Array); } }; }
		if (lt === "STRING" || lt === "ENUM" || ct === 0 || ct === 21) return utf8();
		return (b) => (b as Uint8Array).slice();   // 生バイト
	}
	if (lt && typeof lt === "object" && lt.kind === "TIMESTAMP") { const div = lt.unit === "MILLIS" ? 1 : lt.unit === "MICROS" ? 1e3 : 1e6; return (v) => new Date((v as number) / div); }
	if (ct === 9) return (v) => new Date(v as number);          // TIMESTAMP_MILLIS
	if (ct === 10) return (v) => new Date((v as number) / 1e3);   // TIMESTAMP_MICROS
	if (lt === "DATE" || ct === 6) return (v) => new Date((v as number) * 86400000);
	if (lt && typeof lt === "object" && lt.kind === "DECIMAL") { const s = Math.pow(10, lt.scale || 0); return (v) => (typeof v === "number" ? v : Number(v)) / s; }
	return null;
}

function parseLogical(v: unknown): Logical {   // LogicalType union → 名前（＋詳細）
	if (!v || typeof v !== "object") return null;
	const st = v as TStruct;
	const id = +Object.keys(st)[0];
	const names: Record<number, string> = { 1: "STRING", 2: "MAP", 3: "LIST", 4: "ENUM", 6: "DATE", 9: "INTEGER", 10: "UNKNOWN", 11: "JSON", 12: "BSON", 13: "UUID" };
	if (id === 5) return { kind: "DECIMAL", scale: ((st[5] as TStruct | undefined)?.[1] as number | undefined) ?? 0 };
	if (id === 8) { const unit = ((st[8] as TStruct | undefined)?.[2] as TStruct | undefined) || {}; return { kind: "TIMESTAMP", unit: unit[1] !== undefined ? "MILLIS" : unit[2] !== undefined ? "MICROS" : "NANOS" }; }
	if (id === 7) return { kind: "TIME" };
	return names[id] ?? null;
}

// ── footer ──
const spec: Record<number, FieldReader> = {
	2: (r) => r.list((r) => r.struct({ 4: str })),
	4: (r) => r.list((r) => r.struct({ 1: (r) => r.list((r) => r.struct({ 1: str, 3: (r) => r.struct({ 3: strList }) })) })),
	5: (r) => r.list((r) => r.struct({ 1: str, 2: str })),
	6: str,
};
interface FooterRowGroup { numRows: number; chunks: TStruct[] }
interface Footer { numRows: number; keyValue: Record<string, string | null>; created: string; leaves: Leaf[]; columns: ParquetColumnInfo[]; rowGroups: FooterRowGroup[]; leafIndex: Map<string, number> }
// FileMetaData のバイト列 → スキーマの葉・列定義・row group（チャンクの生メタ付き）
function parseFooter(foot: Uint8Array): Footer {
	const meta = new TReader(foot, 0).struct(spec);
	const schema = meta[2] as TStruct[], numRows = (meta[3] as number | undefined) ?? 0, rgs = (meta[4] as TStruct[] | undefined) ?? [], created = (meta[6] as string | undefined) ?? "";
	const keyValue: Record<string, string | null> = {}; for (const kv of (meta[5] as TStruct[] | undefined) ?? []) keyValue[kv[1] as string] = (kv[2] as string | undefined) ?? null;
	// スキーマ木を辿って葉の path・最大 definition level・repeated の有無を得る
	const leaves: Leaf[] = [];
	let i = 1;
	const walk = (path: string[], maxDef: number, repeated: boolean): void => {
		const el = schema[i++]; const name = el[4] as string, children = (el[5] as number | undefined) ?? 0, rep = (el[3] as number | undefined) ?? 0;
		const md = maxDef + (rep === 1 ? 1 : 0) + (rep === 2 ? 1 : 0), rp = repeated || rep === 2;
		const p = path.concat(name);
		if (children) { for (let c = 0; c < children; c++) walk(p, md, rp); }
		else leaves.push({ path: p, name: p.join("."), type: el[1] as number, typeLength: (el[2] as number | undefined) ?? 0, converted: el[6] as number | undefined, logical: parseLogical(el[10]), maxDef: md, repeated: rp });
	};
	while (i < schema.length) walk([], 0, false);
	// 葉の name は path を "." で結んだもの。実在の "a.b" 列と入れ子 a/b が同名になったら後の方へ "#2" "#3"… を付けて一意に
	//（chunk との突き合わせは path そのもので行う＝pathKey）。旧は同名 2 本が Map で潰れ、どちらの値かが写し順で決まっていた
	const seen = new Map<string, number>();
	for (const l of leaves) { l.pathKey = JSON.stringify(l.path); const c = seen.get(l.name) ?? 0; seen.set(l.name, c + 1); if (c) l.name = `${l.name}#${c + 1}`; }
	const columns: ParquetColumnInfo[] = leaves.map(l => ({ path: l.path, name: l.name, type: l.type, logical: l.logical ?? (l.converted === 0 ? "STRING" : l.converted === 19 ? "JSON" : null), unsupported: l.repeated ? "repeated" : null }));
	const rowGroups: FooterRowGroup[] = rgs.map(rg => ({ numRows: (rg[3] as number | undefined) ?? 0, chunks: (rg[1] as TStruct[] | undefined) ?? [] }));
	const leafIndex = new Map(leaves.map((l, k) => [l.pathKey as string, k]));
	return { numRows, keyValue, created, leaves, columns, rowGroups, leafIndex };
}
// 列チャンクの統計値（min_value/max_value・旧 min/max）を物理型で復号。文字列は STRING のときだけ文字へ
function statValue(leaf: Leaf, b: unknown): unknown {
	if (!(b instanceof Uint8Array)) return undefined;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	switch (leaf.type) {
		case 0: return !!b[0];
		case 3: return b.byteLength >= 12 ? int96ToDate(dv, 0) : undefined;
		case 1: return b.byteLength >= 4 ? dv.getInt32(0, true) : undefined;
		case 2: return b.byteLength >= 8 ? dv.getInt32(4, true) * 4294967296 + dv.getUint32(0, true) : undefined;
		case 4: return b.byteLength >= 4 ? dv.getFloat32(0, true) : undefined;
		case 5: return b.byteLength >= 8 ? dv.getFloat64(0, true) : undefined;
		case 6: case 7: return (leaf.logical === "STRING" || leaf.converted === 0) ? DEC.decode(b) : b.slice();
		default: return undefined;
	}
}
// 列チャンクの byte 範囲＝[min(辞書ページ, データページ), +total_compressed_size)
const chunkSpan = (cm: TStruct): ByteRange => { const from = cm[11] !== undefined ? Math.min(cm[11] as number, cm[9] as number) : cm[9] as number; return { from, len: (cm[7] as number | undefined) ?? 0 }; };

// 列チャンク 1 本（buf＝chunkSpan の範囲のバイト列）→ 値の配列（rows 行・null 込み）
async function decodeChunk(buf: Uint8Array, cm: TStruct, leaf: Leaf, rows: number): Promise<unknown[]> {
	const values: unknown[] = new Array(rows);
	const codec = (cm[4] as number | undefined) ?? 0, numValues = (cm[5] as number | undefined) ?? 0;
	const { from } = chunkSpan(cm);
	let pos = 0;   // buf 内の位置（buf の先頭＝辞書ページかデータページの先頭）
	const conv = converter(leaf), defW = leaf.maxDef ? Math.ceil(Math.log2(leaf.maxDef + 1)) : 0;
	let dict: unknown[] | null = null, got = 0, r = 0;
	while (got < numValues && pos < buf.length) {
		const tr = new TReader(buf, pos);
		const ph = tr.struct({ 5: (r) => r.struct(), 7: (r) => r.struct(), 8: (r) => r.struct() });
		const kind = ph[1] as number, uncSize = ph[2] as number, compSize = ph[3] as number;
		if (!(compSize >= 0) || !(uncSize >= 0)) throw new Error("parquet: page header with negative size (corrupt file)");
		const bodyStart = tr.pos; pos = bodyStart + compSize;
		if (pos > buf.length) throw new Error(`parquet: page body (${compSize} B) runs past its column chunk (${buf.length - bodyStart} B left; corrupt or truncated)`);
		if (kind === 2) {   // DICTIONARY_PAGE
			const body = await decompress(buf.subarray(bodyStart, pos), codec, uncSize);
			dict = decodePlain(body, 0, leaf.type, (ph[7] as TStruct)[1] as number, leaf.typeLength).out;
			continue;
		}
		if (kind !== 0 && kind !== 3) continue;
		let numV: number, enc: number, levels: Int32Array | undefined, body: Uint8Array;
		if (kind === 0) {
			const h = ph[5] as TStruct; numV = h[1] as number; enc = h[2] as number;
			body = await decompress(buf.subarray(bodyStart, pos), codec, uncSize);
			let p = 0;
			if (leaf.maxDef) { const len = new DataView(body.buffer, body.byteOffset).getUint32(0, true); levels = decodeHybrid(body, 4, 4 + len, defW, numV); p = 4 + len; }
			body = body.subarray(p);
		} else {
			const h = ph[8] as TStruct; numV = h[1] as number; enc = h[4] as number; const defLen = (h[5] as number | undefined) ?? 0, repLen = (h[6] as number | undefined) ?? 0, compressed = h[7] !== false;
			const raw = buf.subarray(bodyStart, pos);
			if (leaf.maxDef) levels = decodeHybrid(raw, repLen, repLen + defLen, defW, numV);
			const rest = raw.subarray(repLen + defLen);
			body = compressed ? await decompress(rest, codec, uncSize - repLen - defLen) : rest;
		}
		const nonNull = levels ? levels.reduce((s, v) => s + (v === leaf.maxDef ? 1 : 0), 0) : numV;
		let vals: ArrayLike<unknown>;
		if (enc === 0) vals = decodePlain(body, 0, leaf.type, nonNull, leaf.typeLength).out;
		else if (enc === 3 && leaf.type === 0) { const len = new DataView(body.buffer, body.byteOffset).getUint32(0, true); const bits = decodeHybrid(body, 4, 4 + len, 1, nonNull); const bv: boolean[] = new Array(nonNull); for (let k = 0; k < nonNull; k++) bv[k] = !!bits[k]; vals = bv; }   // RLE（BOOLEAN・v2 ページの既定）
		else if (enc === 5 && (leaf.type === 1 || leaf.type === 2)) vals = decodeDeltaBinaryPacked(body, 0, nonNull, leaf.type).out;
		else if (enc === 6 && leaf.type === 6) vals = decodeDeltaLengthByteArray(body, 0, nonNull).out;
		else if (enc === 7 && (leaf.type === 6 || leaf.type === 7)) vals = decodeDeltaByteArray(body, 0, nonNull).out;
		else if (enc === 9) vals = decodeByteStreamSplit(body, 0, leaf.type, nonNull, leaf.typeLength).out;
		else if (enc === 2 || enc === 8) { if (!dict) throw new Error("parquet: dictionary page missing"); const w = body[0]; const idx = decodeHybrid(body, 1, body.length, w, nonNull); const dv: unknown[] = new Array(nonNull); for (let k = 0; k < nonNull; k++) dv[k] = dict[idx[k]]; vals = dv; }
		else throw new Error("unsupported encoding " + (ENC_NAME[enc] ?? enc) + " for physical type " + (PT_NAME[leaf.type] ?? leaf.type));
		let vi = 0;
		for (let k = 0; k < numV; k++) {
			if (levels && levels[k] !== leaf.maxDef) { values[r++] = null; continue; }
			const v = vals[vi++]; values[r++] = conv ? conv(v) : v;
		}
		got += numV;
	}
	void from;
	return values;
}

/** parquetSource の戻り（手元の Uint8Array か openSource） */
interface ParquetSource {
	read(from: number, len: number): Promise<Uint8Array>;
	readMany(ranges: ByteRange[]): Promise<Uint8Array[]>;
	size: number | null;
	tail?: Uint8Array;
	metrics: SourceMetrics;
	wholeFile?: boolean;
	inMemory?: boolean;
	etag?: string | null;
}
export type ParquetInput = Uint8Array | ArrayBuffer | SourceInput;
export type OpenParquetOptions = SourceOptions;

// ソース＝Uint8Array/ArrayBuffer（手元）か url/Blob/{read,size}（部分読み・COG と同じ openSource）。戻り { read, readMany, size, tail, metrics, wholeFile }
const TAIL = 65536;
async function parquetSource(src: ParquetInput, opts: OpenParquetOptions): Promise<ParquetSource> {
	if (src instanceof ArrayBuffer) src = new Uint8Array(src);
	if (src instanceof Uint8Array) {
		const u8 = src, size = u8.length;
		return { read: async (f, l) => u8.subarray(f, f + l), readMany: async rs => rs.map(r => u8.subarray(r.from, r.from + r.len)),
			size, tail: u8.subarray(Math.max(0, size - TAIL)), metrics: { rangeRequests: 0, coalescedFrom: 0, bytesFetched: 0 }, wholeFile: true, inMemory: true };
	}
	return openSource(src, { tailBytes: opts.tailBytes ?? TAIL, gapBytes: opts.gapBytes ?? 65536, maxReq: opts.maxReq ?? (4 << 20), concurrency: opts.concurrency ?? 6, fetch: opts.fetch, signal: opts.signal });
}

/** GeoParquet の geo メタ（key_value の "geo"） */
export interface GeoColumnMeta { encoding?: string; geometry_types?: string[]; bbox?: number[]; crs?: unknown; covering?: { bbox?: Record<string, string[]> } }
export interface GeoMeta { version?: string; primary_column?: string; columns?: Record<string, GeoColumnMeta> }
export interface GeometryInfo { name: string; encoding: string; types: string[]; bbox: number[] | null; crs: unknown; covering: Record<string, string> | null }
export interface ColumnStats { min: unknown; max: unknown; nulls: number | null }
export interface RowGroupInfo { numRows: number; bytes: number; stats: Record<string, ColumnStats> }
export interface ParquetFile {
	numRows: number;
	keyValue: Record<string, string | null>;
	created: string;
	columns: ParquetColumnInfo[];
	geo: GeoMeta | null;
	geometry: GeometryInfo | null;
	rowGroups: RowGroupInfo[];
	source: { size: number; etag: string | null; wholeFile: boolean; inMemory: boolean; metrics: SourceMetrics; read(from: number, len: number): Promise<Uint8Array> };
	readRowGroup(g: number, opts?: { columns?: string[] }): Promise<Map<string, unknown[] | null>>;
	select(opts?: { bbox?: readonly number[] | null }): { groups: number[]; pruned: boolean };
}

// ファイルを開いてメタデータと列定義を返す（値は読まない）。src＝Uint8Array | ArrayBuffer | url | Blob/File | {read,size}。
// 戻り: { numRows, keyValue, created, columns, geo, geometry, rowGroups: [{ numRows, bytes, stats }], source: { size, wholeFile, metrics },
//         readRowGroup(g, { columns? }) → Map(列名 → Array(rgRows) | null), select({ bbox }) → { groups: number[], pruned: boolean } }
//   readRowGroup：columns を渡すとその列チャンクの byte range だけ取る（全 row group を一度に持たない・1GB 級の轍 2026-09-16）。
//   読めない列は columns[i].unsupported に理由を立てて null。stats＝列統計 { min, max, nulls }（bbox 覆域列の刈り込みの鍵）。
//   select：GeoParquet の covering.bbox 列の統計で視野と交わる row group を返す。統計の無い書き手のファイルは全 row group（pruned:false）。
export async function openParquet(src: ParquetInput, opts: OpenParquetOptions = {}): Promise<ParquetFile> {
	const s = await parquetSource(src, opts);
	const size = s.size;
	let tail = s.tail;
	if (size === null || !(size >= 12) || !tail || tail.length < 8) throw new Error("parquet: file too short");
	if (String.fromCharCode(tail[tail.length - 4], tail[tail.length - 3], tail[tail.length - 2], tail[tail.length - 1]) !== "PAR1") throw new Error("parquet: missing PAR1 trailer magic");
	const metaLen = new DataView(tail.buffer, tail.byteOffset).getUint32(tail.length - 8, true);
	if (metaLen + 12 > size) throw new Error(`parquet: footer length ${metaLen} exceeds file (${size} B)`);
	const foot = metaLen + 8 <= tail.length ? tail.subarray(tail.length - 8 - metaLen, tail.length - 8) : await s.read(size - 8 - metaLen, metaLen);   // 末尾 64KB に収まらない footer は 1 本足す
	const F = parseFooter(foot);
	let geo: GeoMeta | null = null; try { geo = F.keyValue.geo ? JSON.parse(F.keyValue.geo) as GeoMeta : null; } catch { /* geo メタが壊れている＝普通の parquet として扱う */ }
	const gname = geo?.primary_column, gmeta = gname ? geo?.columns?.[gname] : null;
	const geometry: GeometryInfo | null = gmeta ? { name: gname as string, encoding: gmeta.encoding ?? "WKB", types: gmeta.geometry_types ?? [], bbox: gmeta.bbox ?? null, crs: gmeta.crs, covering: gmeta.covering?.bbox ? Object.fromEntries(Object.entries(gmeta.covering.bbox).map(([k, p]) => [k, p.join(".")])) : null } : null;
	const rowGroups = F.rowGroups.map(rg => {
		const stats: Record<string, ColumnStats> = {}; let bytes = 0;
		for (const ch of rg.chunks) {
			const cm = ch[3] as TStruct | undefined; if (!cm) continue;
			const ci = F.leafIndex.get(JSON.stringify(cm[3] ?? [])) ?? -1, name = ci >= 0 ? F.columns[ci].name : ((cm[3] as string[] | undefined) ?? []).join(".");
			bytes += (cm[7] as number | undefined) ?? 0;
			const st = cm[12] as TStruct | undefined;
			if (st && ci >= 0) {
				const min = statValue(F.leaves[ci], st[6] ?? st[2]), max = statValue(F.leaves[ci], st[5] ?? st[1]);
				if (min !== undefined || max !== undefined) stats[name] = { min, max, nulls: (st[3] as number | undefined) ?? null };
			}
		}
		return { numRows: rg.numRows, bytes, stats, chunks: rg.chunks };
	});

	async function readRowGroup(g: number, { columns }: { columns?: string[] } = {}): Promise<Map<string, unknown[] | null>> {
		const rg = rowGroups[g]; if (!rg) throw new Error(`parquet: row group ${g} not found (${rowGroups.length} groups)`);
		const want = columns ? new Set(columns) : null;
		const out = new Map<string, unknown[] | null>(), jobs: { name: string; ci: number; cm: TStruct; from: number; len: number }[] = [];
		for (const ch of rg.chunks) {
			const cm = ch[3] as TStruct | undefined; if (!cm) continue;
			const ci = F.leafIndex.get(JSON.stringify(cm[3] ?? [])) ?? -1; if (ci < 0) continue;
			const name = F.columns[ci].name;
			if (want && !want.has(name)) continue;
			const col = F.columns[ci];
			if (col.unsupported) { out.set(name, null); continue; }
			const { from, len } = chunkSpan(cm);
			if (!(len > 0)) { col.unsupported = "chunk without total_compressed_size"; out.set(name, null); continue; }
			jobs.push({ name, ci, cm, from, len });
		}
		const bufs = await s.readMany(jobs.map(j => ({ from: j.from, len: j.len })));
		for (let k = 0; k < jobs.length; k++) {
			const j = jobs[k];
			try { out.set(j.name, await decodeChunk(bufs[k], j.cm, F.leaves[j.ci], rg.numRows)); }
			catch (e) { F.columns[j.ci].unsupported = String((e as Error).message || e); out.set(j.name, null); }
		}
		return out;
	}
	// 視野 bbox [w, s, e, n] と交わる row group（GeoParquet の bbox 覆域列の統計から）
	function select({ bbox }: { bbox?: readonly number[] | null } = {}): { groups: number[]; pruned: boolean } {
		const all = rowGroups.map((_, i) => i);
		if (!bbox || !geometry?.covering) return { groups: all, pruned: false };
		const c = geometry.covering, [w, so, e, n] = bbox;
		const groups: number[] = [];
		let complete = true;
		for (let i = 0; i < rowGroups.length; i++) {
			const st = rowGroups[i].stats, xmin = st[c.xmin], ymin = st[c.ymin], xmax = st[c.xmax], ymax = st[c.ymax];
			if (!xmin || !ymin || !xmax || !ymax || [xmin.min, ymin.min, xmax.max, ymax.max].some(v => typeof v !== "number")) { complete = false; groups.push(i); continue; }   // 統計なし＝安全側に読む
			if ((xmin.min as number) <= e && (xmax.max as number) >= w && (ymin.min as number) <= n && (ymax.max as number) >= so) groups.push(i);
		}
		return { groups, pruned: complete };
	}
	return { numRows: F.numRows, keyValue: F.keyValue, created: F.created, columns: F.columns, geo, geometry,
		rowGroups: rowGroups.map(r => ({ numRows: r.numRows, bytes: r.bytes, stats: r.stats })),
		source: { size, etag: s.etag ?? null, wholeFile: !!s.wholeFile, inMemory: !!s.inMemory, metrics: s.metrics, read: (from, len) => s.read(from, len) }, readRowGroup, select };   // read＝全量へ落とす呼び手用（wholeFile なら手元の写しから）
}

export interface ReadColumn extends ParquetColumnInfo { values: unknown[] | null }
export interface ReadParquetResult { numRows: number; keyValue: Record<string, string | null>; created: string; columns: ReadColumn[] }
// 互換：全 row group を列ごとに連結して返す（values: Array(numRows)）。逐次で良い呼び手は openParquet + readRowGroup を使う
export async function readParquet(u8: ParquetInput): Promise<ReadParquetResult> {
	const pq = await openParquet(u8);
	const columns: ReadColumn[] = pq.columns.map(c => ({ path: c.path, name: c.name, type: c.type, logical: c.logical, values: c.unsupported ? null : new Array<unknown>(pq.numRows), unsupported: c.unsupported }));
	let row0 = 0;
	for (let g = 0; g < pq.rowGroups.length; g++) {
		const m = await pq.readRowGroup(g), rows = pq.rowGroups[g].numRows;
		for (const c of columns) { const v = m.get(c.name); if (!v || !c.values) continue; for (let i = 0; i < rows; i++) c.values[row0 + i] = v[i]; }
		row0 += rows;
	}
	columns.forEach((c, i) => { if (pq.columns[i].unsupported) { c.unsupported = pq.columns[i].unsupported; c.values = null; } });
	return { numRows: pq.numRows, keyValue: pq.keyValue, created: pq.created, columns };
}
