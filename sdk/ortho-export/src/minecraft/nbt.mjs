// NBT（Minecraft の名前つきバイナリ木）の読み書き。依存ゼロ。
//   Java 版＝ビッグエンディアン（level.dat は gzip・region の塊は zlib）／統合版＝リトルエンディアン（level.dat・LevelDB の値）。
//   値の書き方：素の object＝compound・string＝string・number＝int・それ以外は下の型つきの箱（byte(1) / long(5n) / list("string", [...]) …）。
export const T = { end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 };
const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

const box = (t) => (v) => ({ $t: T[t], v });
export const byte = box("byte"), short = box("short"), int = box("int"), float = box("float"), double = box("double");
export const long = (v) => ({ $t: T.long, v: BigInt(v) });
export const byteArray = box("byteArray"), intArray = box("intArray"), longArray = box("longArray");
/** list(要素の型名, 要素) 例：list("compound", [{...}])・list("string", ["a"])・空の list は list("end", []) */
export const list = (type, items) => ({ $t: T.list, of: T[type], v: items });

const typeOf = (v) => v && typeof v === "object" && "$t" in v ? v.$t : typeof v === "string" ? T.string : typeof v === "number" ? T.int : typeof v === "boolean" ? T.byte : typeof v === "bigint" ? T.long : T.compound;
const raw = (v) => v && typeof v === "object" && "$t" in v ? v.v : typeof v === "boolean" ? (v ? 1 : 0) : v;

class Out {
	constructor(le) { this.le = le; this.buf = new Uint8Array(1 << 16); this.dv = new DataView(this.buf.buffer); this.n = 0; }
	need(k) { if (this.n + k <= this.buf.length) return; let L = this.buf.length; while (L < this.n + k) L *= 2; const b = new Uint8Array(L); b.set(this.buf.subarray(0, this.n)); this.buf = b; this.dv = new DataView(b.buffer); }
	u8(v) { this.need(1); this.buf[this.n++] = v & 255; }
	i16(v) { this.need(2); this.dv.setInt16(this.n, v, this.le); this.n += 2; }
	i32(v) { this.need(4); this.dv.setInt32(this.n, v, this.le); this.n += 4; }
	i64(v) { this.need(8); this.dv.setBigInt64(this.n, BigInt.asIntN(64, BigInt(v)), this.le); this.n += 8; }
	f32(v) { this.need(4); this.dv.setFloat32(this.n, v, this.le); this.n += 4; }
	f64(v) { this.need(8); this.dv.setFloat64(this.n, v, this.le); this.n += 8; }
	bytes(b) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; }
	str(s) { const b = new TextEncoder().encode(s); this.i16(b.length); this.bytes(b); }
	done() { return this.buf.slice(0, this.n); }
}

function payload(o, t, v, of) {
	switch (t) {
		case T.byte: return o.u8(v);
		case T.short: return o.i16(v);
		case T.int: return o.i32(v);
		case T.long: return o.i64(v);
		case T.float: return o.f32(v);
		case T.double: return o.f64(v);
		case T.byteArray: o.i32(v.length); return o.bytes(v instanceof Uint8Array ? v : Uint8Array.from(v, x => x & 255));
		case T.string: return o.str(v);
		case T.list: {
			const items = v; o.u8(items.length ? of : T.end); o.i32(items.length);
			for (const it of items) payload(o, of, raw(it), it && it.of);
			return;
		}
		case T.compound:
			for (const [k, x] of Object.entries(v)) { if (x === undefined) continue; const tt = typeOf(x); o.u8(tt); o.str(k); payload(o, tt, raw(x), x && x.of); }
			return o.u8(T.end);
		case T.intArray: o.i32(v.length); for (const x of v) o.i32(x); return;
		case T.longArray:
			o.i32(v.length);
			if (v instanceof BigInt64Array && !o.le) {   // 速い道：素の 8 バイトを裏返して並べる（機械はリトルエンディアン）
				const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); o.need(b.length);
				for (let i = 0; i < b.length; i += 8) for (let k = 0; k < 8; k++) o.buf[o.n + i + k] = b[i + 7 - k];
				o.n += b.length; return;
			}
			for (const x of v) o.i64(x); return;
		default: throw new Error(`nbt: bad tag ${t}`);
	}
}

/** 名前つきの根の compound を書く（Java＝le false・統合版＝le true） */
export function writeNbt(root, { name = "", le = false } = {}) {
	const o = new Out(le); o.u8(T.compound); o.str(name); payload(o, T.compound, root); return o.done();
}

/** 読む（検定用）：戻り＝{ name, value }。値は素の JS（long＝bigint・配列は typed array・list は配列）。 */
export function readNbt(bytes, { le = false } = {}) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let p = 0;
	const str = () => { const n = dv.getUint16(p, le); p += 2; const s = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return s; };
	const read = (t) => {
		switch (t) {
			case T.byte: return dv.getInt8(p++);
			case T.short: { const v = dv.getInt16(p, le); p += 2; return v; }
			case T.int: { const v = dv.getInt32(p, le); p += 4; return v; }
			case T.long: { const v = dv.getBigInt64(p, le); p += 8; return v; }
			case T.float: { const v = dv.getFloat32(p, le); p += 4; return v; }
			case T.double: { const v = dv.getFloat64(p, le); p += 8; return v; }
			case T.byteArray: { const n = dv.getInt32(p, le); p += 4; const v = bytes.slice(p, p + n); p += n; return v; }
			case T.string: return str();
			case T.list: { const of = bytes[p++], n = dv.getInt32(p, le); p += 4; const a = []; for (let i = 0; i < n; i++) a.push(read(of)); return a; }
			case T.compound: { const o = {}; for (;;) { const tt = bytes[p++]; if (tt === T.end) return o; o[str()] = read(tt); } }
			case T.intArray: { const n = dv.getInt32(p, le); p += 4; const a = new Int32Array(n); for (let i = 0; i < n; i++, p += 4) a[i] = dv.getInt32(p, le); return a; }
			case T.longArray: { const n = dv.getInt32(p, le); p += 4; const a = new BigInt64Array(n); for (let i = 0; i < n; i++, p += 8) a[i] = dv.getBigInt64(p, le); return a; }
			default: throw new Error(`nbt: bad tag ${t} (${NAME[t]}) at ${p}`);
		}
	};
	const t = bytes[p++]; if (t !== T.compound) throw new Error("nbt: root is not a compound");
	const name = str(); const value = read(T.compound);
	return { name, value, length: p };
}
