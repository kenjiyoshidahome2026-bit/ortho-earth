// convert/parquet-read.js ── Apache Parquet の最小リーダ（依存ゼロ）。geoparquet.js の逆変換（GeoParquet → GeoPBF）用。
// 読めるもの: Thrift compact の FileMetaData / PageHeader、DataPage v1・v2、PLAIN / PLAIN_DICTIONARY / RLE_DICTIONARY、
// definition level の RLE/bit-packed、圧縮 none / gzip / zstd（Node）/ snappy（自前・pyarrow と geopandas の既定）。
// 型: BOOLEAN / INT32 / INT64 / FLOAT / DOUBLE / BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY。平坦な列（optional/required）だけ＝
// 入れ子の group は葉ごとの列として path で返し、repeated（list/map）は読まずに飛ばす。
// 戻り: { numRows, keyValue, created, columns: [{ path: string[], name, type, logical, values: Array(numRows) | null }] }
import { inflate } from "../modules/inflate.js";

// ── Thrift compact ──
class TReader {
	constructor(u8, pos = 0) { this.u8 = u8; this.pos = pos; this.last = 0; this.stack = []; }
	byte() { return this.u8[this.pos++]; }
	varint() { let v = 0, m = 1; for (;;) { const b = this.u8[this.pos++]; v += (b & 127) * m; if (b < 128) return v; m *= 128; } }
	zig() { const n = this.varint(); return n % 2 ? -(n + 1) / 2 : n / 2; }
	i64() { return this.zig(); }
	double() { const v = new DataView(this.u8.buffer, this.u8.byteOffset + this.pos).getFloat64(0, true); this.pos += 8; return v; }
	binary() { const n = this.varint(), b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
	string() { return new TextDecoder().decode(this.binary()); }
	// struct を { fieldId: value } に。type 別の読み手 spec[fieldId] = fn(reader, type) が無ければ汎用
	struct(spec = {}) {
		this.stack.push(this.last); this.last = 0;
		const out = {};
		for (;;) {
			const h = this.byte();
			if (h === 0) break;
			const type = h & 15, delta = h >> 4;
			const id = delta ? this.last + delta : this.zig(); this.last = id;
			out[id] = spec[id] ? spec[id](this, type) : this.value(type);
		}
		this.last = this.stack.pop();
		return out;
	}
	listHeader() { const h = this.byte(); let n = h >> 4; const type = h & 15; if (n === 15) n = this.varint(); return { n, type }; }
	list(fn) { const { n, type } = this.listHeader(); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = fn ? fn(this, type) : this.value(type); return out; }
	value(type) {
		switch (type) {
			case 1: return true; case 2: return false;
			case 3: return (this.byte() << 24) >> 24;
			case 4: case 5: case 6: return this.zig();
			case 7: return this.double();
			case 8: return this.binary();
			case 9: case 10: return this.list();
			case 11: { const n = this.varint(); if (!n) return new Map(); const kt = this.byte(); const m = new Map(); for (let i = 0; i < n; i++) m.set(this.value(kt >> 4), this.value(kt & 15)); return m; }
			case 12: return this.struct();
			default: throw new Error("parquet: unknown thrift type " + type);
		}
	}
}
const str = (r, t) => r.string();
const strList = (r) => r.list(str);

// ── ページ本文の復号 ──
function snappy(src) {   // raw snappy（Parquet の SNAPPY はフレーム無し）
	let p = 0, n = 0, m = 1;
	for (;;) { const b = src[p++]; n += (b & 127) * m; if (b < 128) break; m *= 128; }
	const out = new Uint8Array(n); let o = 0;
	while (p < src.length) {
		const tag = src[p++];
		if ((tag & 3) === 0) {
			let len = tag >> 2;
			if (len >= 60) { const k = len - 59; len = 0; for (let i = 0; i < k; i++) len |= src[p + i] << (8 * i); p += k; len >>>= 0; }
			len += 1;
			out.set(src.subarray(p, p + len), o); p += len; o += len;
		} else {
			let len, off;
			if ((tag & 3) === 1) { len = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p]; p += 1; }
			else if ((tag & 3) === 2) { len = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
			else { len = (tag >> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4; }
			let s = o - off;
			for (let i = 0; i < len; i++) out[o++] = out[s++];   // 重なりあり＝1 バイトずつ
		}
	}
	return out;
}
const CODEC_NAME = { 0: "none", 1: "snappy", 2: "gzip", 6: "zstd" };
async function decompress(u8, codec, uncompressedSize) {
	if (codec === 0) return u8;
	if (codec === 1) return snappy(u8);
	if (codec === 2) return inflate(u8, "gzip");
	if (codec === 6) return inflate(u8, "zstd");
	throw new Error("parquet: unsupported codec " + (CODEC_NAME[codec] ?? codec) + "（none/snappy/gzip/zstd）");
}

// RLE/bit-packed hybrid → Int32Array(n)（bit 幅 w）
function decodeHybrid(u8, pos, end, w, n) {
	const out = new Int32Array(n); let o = 0;
	const bytes = (w + 7) >> 3;
	while (o < n && pos < end) {
		let h = 0, m = 1; for (;;) { const b = u8[pos++]; h += (b & 127) * m; if (b < 128) break; m *= 128; }
		if (h & 1) {   // bit-packed: (h>>1) groups of 8
			const groups = h >>> 1; let acc = 0, nb = 0;
			for (let g = 0; g < groups; g++) for (let i = 0; i < 8; i++) {
				while (nb < w) { acc += (u8[pos++] || 0) * Math.pow(2, nb); nb += 8; }
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

// PLAIN の値列を n 個読む（type 別）。BYTE_ARRAY は Uint8Array の配列
function decodePlain(u8, pos, type, n, typeLength) {
	const dv = new DataView(u8.buffer, u8.byteOffset), out = new Array(n);
	if (type === 0) { for (let i = 0; i < n; i++) out[i] = !!(u8[pos + (i >> 3)] & (1 << (i & 7))); return { out, pos: pos + ((n + 7) >> 3) }; }
	if (type === 1) { for (let i = 0; i < n; i++) out[i] = dv.getInt32(pos + i * 4, true); return { out, pos: pos + n * 4 }; }
	if (type === 2) { for (let i = 0; i < n; i++) { const lo = dv.getUint32(pos + i * 8, true), hi = dv.getInt32(pos + i * 8 + 4, true); out[i] = hi * 4294967296 + lo; } return { out, pos: pos + n * 8 }; }
	if (type === 4) { for (let i = 0; i < n; i++) out[i] = dv.getFloat32(pos + i * 4, true); return { out, pos: pos + n * 4 }; }
	if (type === 5) { for (let i = 0; i < n; i++) out[i] = dv.getFloat64(pos + i * 8, true); return { out, pos: pos + n * 8 }; }
	if (type === 6) { for (let i = 0; i < n; i++) { const l = dv.getUint32(pos, true); out[i] = u8.subarray(pos + 4, pos + 4 + l); pos += 4 + l; } return { out, pos }; }
	if (type === 7) { for (let i = 0; i < n; i++) { out[i] = u8.subarray(pos, pos + typeLength); pos += typeLength; } return { out, pos }; }
	throw new Error("parquet: unsupported physical type " + type);
}

// 論理型に沿って JS 値へ
function converter(el) {
	const lt = el.logical, ct = el.converted, type = el.type;
	const utf8 = () => { const d = new TextDecoder(); return (b) => d.decode(b); };
	if (type === 6 || type === 7) {
		if (lt === "JSON" || ct === 19) { const d = new TextDecoder(); return (b) => { try { return JSON.parse(d.decode(b)); } catch { return d.decode(b); } }; }
		if (lt === "STRING" || lt === "ENUM" || ct === 0 || ct === 21) return utf8();
		return (b) => b.slice();   // 生バイト
	}
	if (lt && lt.kind === "TIMESTAMP") { const div = lt.unit === "MILLIS" ? 1 : lt.unit === "MICROS" ? 1e3 : 1e6; return (v) => new Date(v / div); }
	if (ct === 9) return (v) => new Date(v);          // TIMESTAMP_MILLIS
	if (ct === 10) return (v) => new Date(v / 1e3);   // TIMESTAMP_MICROS
	if (lt === "DATE" || ct === 6) return (v) => new Date(v * 86400000);
	if (lt && lt.kind === "DECIMAL") { const s = Math.pow(10, lt.scale || 0); return (v) => (typeof v === "number" ? v : Number(v)) / s; }
	return null;
}

function parseLogical(v) {   // LogicalType union → 名前（＋詳細）
	if (!v || typeof v !== "object") return null;
	const id = +Object.keys(v)[0];
	const names = { 1: "STRING", 2: "MAP", 3: "LIST", 4: "ENUM", 6: "DATE", 9: "INTEGER", 10: "UNKNOWN", 11: "JSON", 12: "BSON", 13: "UUID" };
	if (id === 5) return { kind: "DECIMAL", scale: v[5]?.[1] ?? 0 };
	if (id === 8) { const unit = v[8]?.[2] || {}; return { kind: "TIMESTAMP", unit: unit[1] !== undefined ? "MILLIS" : unit[2] !== undefined ? "MICROS" : "NANOS" }; }
	if (id === 7) return { kind: "TIME" };
	return names[id] ?? null;
}

export async function readParquet(u8) {
	const n = u8.length;
	if (n < 12 || String.fromCharCode(u8[n - 4], u8[n - 3], u8[n - 2], u8[n - 1]) !== "PAR1") throw new Error("parquet: PAR1 の末尾署名が無い");
	const metaLen = new DataView(u8.buffer, u8.byteOffset).getUint32(n - 8, true);
	const meta = new TReader(u8, n - 8 - metaLen).struct({
		2: (r) => r.list((r) => r.struct({ 4: str })),
		4: (r) => r.list((r) => r.struct({ 1: (r) => r.list((r) => r.struct({ 1: str, 3: (r) => r.struct({ 3: strList }) })) })),
		5: (r) => r.list((r) => r.struct({ 1: str, 2: str })),
		6: str,
	});
	const schema = meta[2], numRows = meta[3] ?? 0, rowGroups = meta[4] ?? [], created = meta[6] ?? "";
	const keyValue = {}; for (const kv of meta[5] ?? []) keyValue[kv[1]] = kv[2] ?? null;
	// スキーマ木を辿って葉の path・最大 definition level・repeated の有無を得る
	const leaves = [];
	let i = 1;
	const walk = (path, maxDef, repeated) => {
		const el = schema[i++]; const name = el[4], children = el[5] ?? 0, rep = el[3] ?? 0;
		const md = maxDef + (rep === 1 ? 1 : 0) + (rep === 2 ? 1 : 0), rp = repeated || rep === 2;
		const p = path.concat(name);
		if (children) { for (let c = 0; c < children; c++) walk(p, md, rp); }
		else leaves.push({ path: p, name: p.join("."), type: el[1], typeLength: el[2] ?? 0, converted: el[6], logical: parseLogical(el[10]), maxDef: md, repeated: rp });
	};
	while (i < schema.length) walk([], 0, false);
	// 列ごとに全行グループを読む
	const columns = leaves.map(l => ({ path: l.path, name: l.name, type: l.type, logical: l.logical ?? (l.converted === 0 ? "STRING" : l.converted === 19 ? "JSON" : null), values: l.repeated ? null : new Array(numRows), unsupported: l.repeated ? "repeated" : null }));
	const dv = new DataView(u8.buffer, u8.byteOffset);
	let row0 = 0;
	for (const rg of rowGroups) {
		const chunks = rg[1] ?? [], rgRows = rg[3] ?? 0;
		for (const ch of chunks) {
			const cm = ch[3]; if (!cm) continue;
			const pathKey = (cm[3] ?? []).join("."), ci = columns.findIndex(c => c.name === pathKey);
			if (ci < 0) continue;
			const col = columns[ci], leaf = leaves[ci];
			if (col.unsupported) continue;
			const codec = cm[4] ?? 0, numValues = cm[5] ?? 0;
			let pos = cm[11] !== undefined ? Math.min(cm[11], cm[9]) : cm[9];
			const conv = converter(leaf), defW = leaf.maxDef ? Math.ceil(Math.log2(leaf.maxDef + 1)) : 0;
			let dict = null, got = 0, r = row0;
			try {
				while (got < numValues && pos < n) {
					const tr = new TReader(u8, pos);
					const ph = tr.struct({ 5: (r) => r.struct(), 7: (r) => r.struct(), 8: (r) => r.struct() });
					const kind = ph[1], uncSize = ph[2], compSize = ph[3];
					const bodyStart = tr.pos; pos = bodyStart + compSize;
					if (kind === 2) {   // DICTIONARY_PAGE
						const body = await decompress(u8.subarray(bodyStart, pos), codec, uncSize);
						dict = decodePlain(body, 0, leaf.type, ph[7][1], leaf.typeLength).out;
						continue;
					}
					if (kind !== 0 && kind !== 3) continue;
					let numV, enc, levels, body;
					if (kind === 0) {
						const h = ph[5]; numV = h[1]; enc = h[2];
						body = await decompress(u8.subarray(bodyStart, pos), codec, uncSize);
						let p = 0;
						if (leaf.maxDef) { const len = dv.getUint32 ? new DataView(body.buffer, body.byteOffset).getUint32(0, true) : 0; levels = decodeHybrid(body, 4, 4 + len, defW, numV); p = 4 + len; }
						body = body.subarray(p);
					} else {
						const h = ph[8]; numV = h[1]; enc = h[4]; const defLen = h[5] ?? 0, repLen = h[6] ?? 0, compressed = h[7] !== false;
						const raw = u8.subarray(bodyStart, pos);
						if (leaf.maxDef) levels = decodeHybrid(raw, repLen, repLen + defLen, defW, numV);
						const rest = raw.subarray(repLen + defLen);
						body = compressed ? await decompress(rest, codec, uncSize - repLen - defLen) : rest;
					}
					const nonNull = levels ? levels.reduce((s, v) => s + (v === leaf.maxDef ? 1 : 0), 0) : numV;
					let vals;
					if (enc === 0) vals = decodePlain(body, 0, leaf.type, nonNull, leaf.typeLength).out;
					else if (enc === 2 || enc === 8) { if (!dict) throw new Error("辞書ページが無い"); const w = body[0]; const idx = decodeHybrid(body, 1, body.length, w, nonNull); vals = new Array(nonNull); for (let k = 0; k < nonNull; k++) vals[k] = dict[idx[k]]; }
					else throw new Error("unsupported encoding " + enc);
					let vi = 0;
					for (let k = 0; k < numV; k++) {
						if (levels && levels[k] !== leaf.maxDef) { col.values[r++] = null; continue; }
						const v = vals[vi++]; col.values[r++] = conv ? conv(v) : v;
					}
					got += numV;
				}
			} catch (e) { col.unsupported = String(e.message || e); col.values = null; }
		}
		row0 += rgRows;
	}
	return { numRows, keyValue, created, columns };
}
