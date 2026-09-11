// src/modules/pbf.js（自前の protobuf ワイヤ実装）の検定。
// 外部 pbf パッケージを切った代わりに、ここが「バイト列が変わっていない」ことの唯一の砦になる。
// 期待値は protobuf のワイヤ仕様そのもの（golden バイト列を直書き）＝実装を書き換えても仕様側は動かない。
import Pbf from "../src/modules/pbf.js";

let ok = 0, ng = 0;
const hex = u => Array.from(u).map(b => b.toString(16).padStart(2, "0")).join(" ");
const enc = fn => { const p = new Pbf(); fn(p); return p.finish().slice(); };
function eq(label, got, want) {
	const g = typeof got === "string" ? got : JSON.stringify(got), w = typeof want === "string" ? want : JSON.stringify(want);
	if (g === w) { ok++; } else { ng++; console.error(`  NG ${label}\n    got  ${g}\n    want ${w}`); }
}
const bytes = (label, fn, want) => eq(label, hex(enc(fn)), want);

// ---- varint（境界: 1/2/4/5/10 バイト、負値は 2^64 の補数で10バイト）
bytes("varint 0",          p => p.writeVarint(0),          "00");
bytes("varint 1",          p => p.writeVarint(1),          "01");
bytes("varint 127",        p => p.writeVarint(127),        "7f");
bytes("varint 128",        p => p.writeVarint(128),        "80 01");
bytes("varint 300",        p => p.writeVarint(300),        "ac 02");
bytes("varint 2^28-1",     p => p.writeVarint(0xfffffff),  "ff ff ff 7f");
bytes("varint 2^28",       p => p.writeVarint(0x10000000), "80 80 80 80 01");
bytes("varint 2^32",       p => p.writeVarint(2 ** 32),    "80 80 80 80 10");
bytes("varint 2^53-1",     p => p.writeVarint(Number.MAX_SAFE_INTEGER), "ff ff ff ff ff ff ff 0f");
bytes("varint -1",         p => p.writeVarint(-1),         "ff ff ff ff ff ff ff ff ff 01");
bytes("varint -2",         p => p.writeVarint(-2),         "fe ff ff ff ff ff ff ff ff 01");
bytes("svarint 0",         p => p.writeSVarint(0),         "00");
bytes("svarint -1",        p => p.writeSVarint(-1),        "01");
bytes("svarint 1",         p => p.writeSVarint(1),         "02");
bytes("svarint -2",        p => p.writeSVarint(-2),        "03");
bytes("svarint 2^31",      p => p.writeSVarint(2 ** 31),   "80 80 80 80 10");

// varint 往復（符号なし・符号あり・zigzag）
for (const v of [0, 1, 127, 128, 16384, 0xfffffff, 0x10000000, 0xffffffff, 2 ** 32, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
	eq(`roundtrip varint ${v}`, new Pbf(enc(p => p.writeVarint(v))).readVarint(), v);
}
for (const v of [-1, -2, -128, -(2 ** 32), -Number.MAX_SAFE_INTEGER]) {
	eq(`roundtrip varint64 ${v}`, new Pbf(enc(p => p.writeVarint(v))).readVarint(true), v);
}
for (const v of [0, 1, -1, 127, -128, 2 ** 31, -(2 ** 31), 2 ** 40, -(2 ** 40), Number.MAX_SAFE_INTEGER]) {
	eq(`roundtrip svarint ${v}`, new Pbf(enc(p => p.writeSVarint(v))).readSVarint(), v);
}

// ---- 文字列（UTF-8 / 長さ varint の桁上がり / 孤立サロゲートは U+FFFD）
bytes("string ''",      p => p.writeString(""),      "00");
bytes("string 'abc'",   p => p.writeString("abc"),   "03 61 62 63");
bytes("string 'あ'",     p => p.writeString("あ"),    "03 e3 81 82");
bytes("string emoji",   p => p.writeString("🗾"),    "04 f0 9f 97 be");
bytes("string lone surrogate", p => p.writeString("\ud800"), "03 ef bf bd");
bytes("stringField",    p => p.writeStringField(1, "あ"), "0a 03 e3 81 82");
for (const n of [1, 42, 127, 128, 129, 16383, 16384, 40000]) {
	const s = "a".repeat(n), b = enc(p => p.writeString(s));
	eq(`string len ${n} roundtrip`, new Pbf(b).readString(), s);
	eq(`string len ${n} multibyte`, new Pbf(enc(p => p.writeString("あ".repeat(n)))).readString(), "あ".repeat(n));
}

// ---- 固定長 / 浮動小数（リトルエンディアン）
bytes("double 1",   p => p.writeDouble(1),        "00 00 00 00 00 00 f0 3f");
bytes("float 1",    p => p.writeFloat(1),         "00 00 80 3f");
bytes("fixed32 1",  p => p.writeFixed32(1),       "01 00 00 00");
bytes("fixed64 2^40", p => p.writeFixed64(2 ** 40), "00 00 00 00 00 01 00 00");
bytes("doubleField",  p => p.writeDoubleField(2, 1), "11 00 00 00 00 00 00 f0 3f");
bytes("floatField",   p => p.writeFloatField(2, 1),  "15 00 00 80 3f");
for (const v of [0, 1, -1, 0.5, Math.PI, 1e40, -1e-40, Number.MAX_SAFE_INTEGER]) {
	eq(`roundtrip double ${v}`, new Pbf(enc(p => p.writeDouble(v))).readDouble(), v);
}
eq("roundtrip float", new Pbf(enc(p => p.writeFloat(1.5))).readFloat(), 1.5);
eq("roundtrip fixed32", new Pbf(enc(p => p.writeFixed32(123456))).readFixed32(), 123456);
eq("roundtrip fixed64", new Pbf(enc(p => p.writeFixed64(2 ** 40 + 7))).readFixed64(), 2 ** 40 + 7);

// ---- bool / bytes
bytes("boolField true",  p => p.writeBooleanField(3, true),  "18 01");
bytes("boolField false", p => p.writeBooleanField(3, false), "18 00");
bytes("bytesField",      p => p.writeBytesField(4, new Uint8Array([1, 2, 3])), "22 03 01 02 03");
for (const n of [0, 1, 127, 128, 5000]) {
	const buf = new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
	const r = new Pbf(enc(p => p.writeBytes(buf)));
	eq(`roundtrip bytes ${n}`, hex(r.readBytes()), hex(buf));
}

// ---- packed（空配列は1バイトも書かない）
bytes("packed varint",  p => p.writePackedVarint(5, [1, 2, 300]), "2a 04 01 02 ac 02");
bytes("packed svarint", p => p.writePackedSVarint(5, [-1, 1]),    "2a 02 01 02");
bytes("packed empty",   p => p.writePackedVarint(5, []),          "");
for (const arr of [[1], [0, 1, 2, 3], Array.from({ length: 3000 }, (_, i) => i * 1237)]) {
	const r = new Pbf(enc(p => p.writePackedVarint(5, arr))); r.type = r.readVarint() & 7;
	eq(`roundtrip packed varint ${arr.length}`, r.readPackedVarint([]), arr);
	const d = new Pbf(enc(p => p.writePackedDouble(5, arr))); d.type = d.readVarint() & 7;
	eq(`roundtrip packed double ${arr.length}`, d.readPackedDouble([]), arr);
}

// ---- 入れ子メッセージ：長さ varint が1バイトを超えると本体を右へずらす経路
bytes("message short", p => p.writeMessage(6, () => p.writeVarintField(1, 7)), "32 02 08 07");
for (const n of [1, 100, 5000, 200000]) {
	const b = enc(p => p.writeMessage(6, () => { for (let i = 0; i < n; i++) p.writeVarintField(1, i % 128); }));
	const out = [];
	new Pbf(b).readFields(function (tag, _, p) { if (tag === 6) p.readMessage((t, __, q) => out.push(q.readVarint())); });
	eq(`roundtrip message n=${n}`, out.length, n);
	eq(`roundtrip message n=${n} tail`, out[n - 1], (n - 1) % 128);
}

// ---- 混在フィールド：読まなかったフィールドを skip で正しく飛ばせるか
const mixed = enc(p => {
	p.writeStringField(1, "header");
	p.writeVarintField(2, 2 ** 45);
	p.writeSVarintField(3, -123456789);
	p.writeBooleanField(4, true);
	p.writeDoubleField(5, Math.PI);
	p.writeFloatField(6, 1.5);
	p.writeBytesField(7, new Uint8Array([1, 2, 3]));
	p.writeMessage(8, () => { p.writePackedVarint(1, [1, 2, 3]); p.writeMessage(2, () => p.writeStringField(1, "深い")); });
	p.writeFixed32Field(9, 42);
	p.writeFixed64Field(10, 2 ** 40);
});
{
	let n = 0; const p = new Pbf(mixed);
	p.readFields(() => n++);
	eq("skip all fields", `${n}/${p.pos}`, `10/${mixed.length}`);
}
{
	const p = new Pbf(mixed), o = {};
	p.readFields(tag => {
		if (tag === 1) o.a = p.readString();
		else if (tag === 3) o.b = p.readSVarint();
		else if (tag === 5) o.c = p.readDouble();
		else if (tag === 10) o.d = p.readFixed64();
	});
	eq("read selected fields", o, { a: "header", b: -123456789, c: Math.PI, d: 2 ** 40 });
}

// ---- byteOffset つきビューから作っても double/float の位置がずれないこと
{
	const src = enc(p => { p.writeDoubleField(1, Math.PI); p.writeStringField(2, "やあ"); });
	const padded = new Uint8Array(src.length + 5); padded.set(src, 5);
	const p = new Pbf(padded.subarray(5)), o = {};
	p.readFields(tag => { if (tag === 1) o.d = p.readDouble(); else if (tag === 2) o.s = p.readString(); });
	eq("offset view", o, { d: Math.PI, s: "やあ" });
}

// ---- realloc：初期16バイトから伸ばしても内容が壊れないこと
{
	const b = enc(p => { for (let i = 0; i < 20000; i++) p.writeVarintField((i % 100) + 1, i * 97); });
	let n = 0, last = 0;
	new Pbf(b).readFields(function (tag, _, p) { n++; last = p.readVarint(); });
	eq("realloc growth", `${n}/${last}`, `20000/${19999 * 97}`);
}

console.log(ng ? `t-pbf: ${ok} ok, ${ng} NG` : `t-pbf: ok (${ok} checks)`);
process.exit(ng ? 1 : 0);
