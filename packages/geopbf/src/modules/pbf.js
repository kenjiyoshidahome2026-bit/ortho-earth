// Protocol Buffers のワイヤ形式（varint / 64bit / 長さ付き / 32bit）だけを実装した自前リーダ・ライタ。
// 外部パッケージ pbf への依存を切るために置いた＝geopbf は実行時依存ゼロ（GeoPBF 本体・MVT・登記所備付地図の全てがここを通る）。
// .proto コンパイラは持たない（geopbf はスキーマを手書きで読み書きするので要らない）。API は pbf 4.x と同名・同挙動＝
// 既存の *.geopbf / *.mvt とバイト列が一致することが唯一の正しさの基準（tests/t-pbf.mjs が全型で往復検証）。
// 仕様: https://protobuf.dev/programming-guides/encoding/

const POW32 = 4294967296;                   // 2^32＝下位/上位ワードの桁上げ
const VARINT = 0, FIXED64 = 1, BYTES = 2, FIXED32 = 5;   // ワイヤ型
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8");
const hasEncodeInto = typeof encoder.encodeInto === "function";

export default class Pbf {
	constructor(buf = new Uint8Array(16)) {
		this.buf = ArrayBuffer.isView(buf) ? buf : new Uint8Array(buf);
		// byteOffset を渡す＝ビュー（subarray）で来ても double/float が正しい位置を指す
		this.dataView = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
		this.pos = 0;
		this.type = 0;
		this.length = this.buf.length;
	}

	// === 読み ===

	readFields(readField, result, end = this.length) {
		while (this.pos < end) {
			const val = this.readVarint(), tag = val >> 3, startPos = this.pos;
			this.type = val & 0x7;
			readField(tag, result, this);
			if (this.pos === startPos) this.skip(val);   // ハンドラが読まなかったフィールドは読み飛ばす
		}
		return result;
	}
	readMessage(readField, result) { return this.readFields(readField, result, this.readVarint() + this.pos); }

	readVarint(isSigned) {
		const buf = this.buf; let b, lo, hi;
		b = buf[this.pos++]; lo  =  b & 0x7f;        if (b < 0x80) return lo;
		b = buf[this.pos++]; lo |= (b & 0x7f) << 7;  if (b < 0x80) return lo;
		b = buf[this.pos++]; lo |= (b & 0x7f) << 14; if (b < 0x80) return lo;
		b = buf[this.pos++]; lo |= (b & 0x7f) << 21; if (b < 0x80) return lo;
		// 5バイト目が下位ワードの残り4bitと上位ワードの先頭3bitに跨る
		b = buf[this.pos++]; lo = (lo | ((b & 0x0f) << 28)) >>> 0; hi = (b & 0x70) >> 4; if (b < 0x80) return toNum(lo, hi, isSigned);
		b = buf[this.pos++]; hi |= (b & 0x7f) << 3;  if (b < 0x80) return toNum(lo, hi, isSigned);
		b = buf[this.pos++]; hi |= (b & 0x7f) << 10; if (b < 0x80) return toNum(lo, hi, isSigned);
		b = buf[this.pos++]; hi |= (b & 0x7f) << 17; if (b < 0x80) return toNum(lo, hi, isSigned);
		b = buf[this.pos++]; hi |= (b & 0x7f) << 24; if (b < 0x80) return toNum(lo, hi, isSigned);
		b = buf[this.pos++]; hi |= (b & 0x01) << 31; if (b < 0x80) return toNum(lo, hi, isSigned);
		throw new Error("Expected varint not more than 10 bytes");
	}
	readVarint64() { return this.readVarint(true); }
	readSVarint() { const n = this.readVarint(); return n % 2 === 1 ? (n + 1) / -2 : n / 2; }   // zigzag
	readBoolean() { return Boolean(this.readVarint()); }

	readFixed32()  { const v = this.dataView.getUint32(this.pos, true);  this.pos += 4; return v; }
	readSFixed32() { const v = this.dataView.getInt32(this.pos, true);   this.pos += 4; return v; }
	readFixed64()  { const v = this.dataView.getUint32(this.pos, true) + this.dataView.getUint32(this.pos + 4, true) * POW32; this.pos += 8; return v; }
	readSFixed64() { const v = this.dataView.getUint32(this.pos, true) + this.dataView.getInt32(this.pos + 4, true) * POW32;  this.pos += 8; return v; }
	readFloat()    { const v = this.dataView.getFloat32(this.pos, true); this.pos += 4; return v; }
	readDouble()   { const v = this.dataView.getFloat64(this.pos, true); this.pos += 8; return v; }

	readString() {
		const end = this.readVarint() + this.pos, pos = this.pos;
		this.pos = end;
		return decoder.decode(this.buf.subarray(pos, end));
	}
	readBytes() {
		const end = this.readVarint() + this.pos, buffer = this.buf.subarray(this.pos, end);
		this.pos = end;
		return buffer;
	}

	// packed 配列。非 packed（単体値が並ぶ旧式）で来た場合は1個だけ読む＝readPackedEnd の pos+1
	readPackedEnd() { return this.type === BYTES ? this.readVarint() + this.pos : this.pos + 1; }
	readPackedVarint(arr = [], isSigned) { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readVarint(isSigned)); return arr; }
	readPackedSVarint(arr = [])  { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readSVarint());  return arr; }
	readPackedBoolean(arr = [])  { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readBoolean());  return arr; }
	readPackedFloat(arr = [])    { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readFloat());    return arr; }
	readPackedDouble(arr = [])   { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readDouble());   return arr; }
	readPackedFixed32(arr = [])  { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readFixed32());  return arr; }
	readPackedSFixed32(arr = []) { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readSFixed32()); return arr; }
	readPackedFixed64(arr = [])  { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readFixed64());  return arr; }
	readPackedSFixed64(arr = []) { const end = this.readPackedEnd(); while (this.pos < end) arr.push(this.readSFixed64()); return arr; }

	skip(val) {
		const type = val & 0x7;
		if (type === VARINT) while (this.buf[this.pos++] > 0x7f) { }
		else if (type === BYTES) this.pos = this.readVarint() + this.pos;
		else if (type === FIXED32) this.pos += 4;
		else if (type === FIXED64) this.pos += 8;
		else throw new Error(`Unimplemented type: ${type}`);
	}

	// === 書き ===

	realloc(min) {
		let length = this.length || 16;
		while (length < this.pos + min) length *= 2;
		if (length !== this.length) {
			const buf = new Uint8Array(length);
			buf.set(this.buf);
			this.buf = buf;
			this.dataView = new DataView(buf.buffer);
			this.length = length;
		}
	}
	finish() { this.length = this.pos; this.pos = 0; return this.buf.subarray(0, this.length); }
	writeTag(tag, type) { this.writeVarint((tag << 3) | type); }

	writeVarint(val) {
		val = +val || 0;
		if (val < 0 || val > 0xfffffff) return writeVarint64(this, val);   // 5バイト以上＝64bit 経路へ
		this.realloc(4);
		this.buf[this.pos++] =           val & 0x7f  | (val > 0x7f ? 0x80 : 0); if (val <= 0x7f) return;
		this.buf[this.pos++] = ((val >>>= 7) & 0x7f) | (val > 0x7f ? 0x80 : 0); if (val <= 0x7f) return;
		this.buf[this.pos++] = ((val >>>= 7) & 0x7f) | (val > 0x7f ? 0x80 : 0); if (val <= 0x7f) return;
		this.buf[this.pos++] =   (val >>> 7) & 0x7f;
	}
	writeSVarint(val) { this.writeVarint(val < 0 ? -val * 2 - 1 : val * 2); }   // zigzag
	writeBoolean(val) { this.writeVarint(+val); }

	writeFixed32(val)  { this.realloc(4); this.dataView.setInt32(this.pos, val, true); this.pos += 4; }
	writeSFixed32(val) { this.writeFixed32(val); }
	writeFixed64(val)  { this.realloc(8); this.dataView.setInt32(this.pos, val & -1, true); this.dataView.setInt32(this.pos + 4, Math.floor(val / POW32), true); this.pos += 8; }
	writeSFixed64(val) { this.writeFixed64(val); }
	writeFloat(val)    { this.realloc(4); this.dataView.setFloat32(this.pos, val, true); this.pos += 4; }
	writeDouble(val)   { this.realloc(8); this.dataView.setFloat64(this.pos, val, true); this.pos += 8; }

	// 長さが先に要る（varint 前置）が UTF-8 バイト数は書いてみないと判らない＝1バイト予約して直接書き、
	// はみ出したぶんだけ後ろへずらす。長さを測るための先読みエンコードを1回省く定石。
	writeString(str) {
		str = String(str);
		this.realloc(str.length * 3 + 8);   // UTF-16 1単位 → UTF-8 最大3バイト（サロゲート対は2単位4バイト）
		this.pos++;
		const startPos = this.pos;
		if (hasEncodeInto) this.pos += encoder.encodeInto(str, this.buf.subarray(startPos)).written;
		else { const b = encoder.encode(str); this.buf.set(b, startPos); this.pos += b.length; }
		const len = this.pos - startPos;
		if (len >= 0x80) makeRoomForExtraLength(this, startPos, len);
		this.pos = startPos - 1;
		this.writeVarint(len);
		this.pos += len;
	}
	writeBytes(buffer) {
		const len = buffer.length;
		this.writeVarint(len);
		this.realloc(len);
		this.buf.set(buffer, this.pos); this.pos += len;
	}
	writeRawMessage(fn, obj) {
		this.pos++;                       // 短いメッセージ用に長さ1バイトを予約（writeString と同じ手）
		const startPos = this.pos;
		fn(obj, this);
		const len = this.pos - startPos;
		if (len >= 0x80) makeRoomForExtraLength(this, startPos, len);
		this.pos = startPos - 1;
		this.writeVarint(len);
		this.pos += len;
	}
	writeMessage(tag, fn, obj) { this.writeTag(tag, BYTES); this.writeRawMessage(fn, obj); }

	writePackedVarint(tag, arr)  { if (arr.length) this.writeMessage(tag, packVarint, arr); }
	writePackedSVarint(tag, arr) { if (arr.length) this.writeMessage(tag, packSVarint, arr); }
	writePackedBoolean(tag, arr) { if (arr.length) this.writeMessage(tag, packBoolean, arr); }
	writePackedFloat(tag, arr)   { if (arr.length) this.writeMessage(tag, packFloat, arr); }
	writePackedDouble(tag, arr)  { if (arr.length) this.writeMessage(tag, packDouble, arr); }
	writePackedFixed32(tag, arr) { if (arr.length) this.writeMessage(tag, packFixed32, arr); }
	writePackedSFixed32(tag, arr){ if (arr.length) this.writeMessage(tag, packSFixed32, arr); }
	writePackedFixed64(tag, arr) { if (arr.length) this.writeMessage(tag, packFixed64, arr); }
	writePackedSFixed64(tag, arr){ if (arr.length) this.writeMessage(tag, packSFixed64, arr); }

	writeVarintField(tag, val)   { this.writeTag(tag, VARINT);  this.writeVarint(val); }
	writeSVarintField(tag, val)  { this.writeTag(tag, VARINT);  this.writeSVarint(val); }
	writeBooleanField(tag, val)  { this.writeVarintField(tag, +val); }
	writeStringField(tag, str)   { this.writeTag(tag, BYTES);   this.writeString(str); }
	writeBytesField(tag, buffer) { this.writeTag(tag, BYTES);   this.writeBytes(buffer); }
	writeFloatField(tag, val)    { this.writeTag(tag, FIXED32); this.writeFloat(val); }
	writeDoubleField(tag, val)   { this.writeTag(tag, FIXED64); this.writeDouble(val); }
	writeFixed32Field(tag, val)  { this.writeTag(tag, FIXED32); this.writeFixed32(val); }
	writeSFixed32Field(tag, val) { this.writeTag(tag, FIXED32); this.writeSFixed32(val); }
	writeFixed64Field(tag, val)  { this.writeTag(tag, FIXED64); this.writeFixed64(val); }
	writeSFixed64Field(tag, val) { this.writeTag(tag, FIXED64); this.writeSFixed64(val); }
}

// 下位/上位の32bitワードに割ってから7bitずつ吐く（JS の数値は32bitシフトを跨げない）。負値は 2^64 の補数＝10バイト。
function writeVarint64(pbf, val) {
	let lo, hi;
	if (val >= 0) { lo = (val % POW32) | 0; hi = (val / POW32) | 0; }
	else {
		const t = -val;
		lo = ~((t % POW32) | 0); hi = ~((t / POW32) | 0);
		if (lo ^ 0xffffffff) lo = (lo + 1) | 0; else { lo = 0; hi = (hi + 1) | 0; }
	}
	if (val >= 0x10000000000000000 || val < -0x10000000000000000) throw new Error("Given varint doesn't fit into 10 bytes");
	pbf.realloc(10);
	for (let i = 0; i < 10; i++) {
		const b = lo & 0x7f;
		lo = ((lo >>> 7) | (hi << 25)) >>> 0; hi = hi >>> 7;
		if (!lo && !hi) { pbf.buf[pbf.pos++] = b; return; }
		pbf.buf[pbf.pos++] = b | 0x80;
	}
}

function toNum(lo, hi, isSigned) { return isSigned ? (hi | 0) * POW32 + (lo >>> 0) : (hi >>> 0) * POW32 + (lo >>> 0); }

// 予約した1バイトでは長さ varint が入り切らなかった分だけ本体を右へずらす
function makeRoomForExtraLength(pbf, startPos, len) {
	let extraLen = 0;
	for (let n = len; n > 0x7f; n = Math.floor(n / 128)) extraLen++;
	pbf.realloc(extraLen);
	for (let i = pbf.pos - 1; i >= startPos; i--) pbf.buf[i + extraLen] = pbf.buf[i];
}

function packVarint(arr, pbf)   { for (let i = 0; i < arr.length; i++) pbf.writeVarint(arr[i]); }
function packSVarint(arr, pbf)  { for (let i = 0; i < arr.length; i++) pbf.writeSVarint(arr[i]); }
function packBoolean(arr, pbf)  { for (let i = 0; i < arr.length; i++) pbf.writeBoolean(arr[i]); }
function packFloat(arr, pbf)    { for (let i = 0; i < arr.length; i++) pbf.writeFloat(arr[i]); }
function packDouble(arr, pbf)   { for (let i = 0; i < arr.length; i++) pbf.writeDouble(arr[i]); }
function packFixed32(arr, pbf)  { for (let i = 0; i < arr.length; i++) pbf.writeFixed32(arr[i]); }
function packSFixed32(arr, pbf) { for (let i = 0; i < arr.length; i++) pbf.writeSFixed32(arr[i]); }
function packFixed64(arr, pbf)  { for (let i = 0; i < arr.length; i++) pbf.writeFixed64(arr[i]); }
function packSFixed64(arr, pbf) { for (let i = 0; i < arr.length; i++) pbf.writeSFixed64(arr[i]); }
