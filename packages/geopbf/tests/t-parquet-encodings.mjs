#!/usr/bin/env node
// t-parquet-encodings: 他所の writer（pyarrow）が書く符号化を読む（改良点 14・2026-10-12）。
//   固定具は tests/fixtures/parquet/（make.py で生成・commit 済み）、正解は expected.json。
//   ・DataPage v2（無圧縮）と v1（snappy）の両方で DELTA_BINARY_PACKED（INT32/INT64）・DELTA_BYTE_ARRAY（BYTE_ARRAY/FIXED）・
//     DELTA_LENGTH_BYTE_ARRAY・BYTE_STREAM_SPLIT（FLOAT/DOUBLE）・RLE（BOOLEAN）が null 込みで一致、ページ跨ぎ・row group 跨ぎあり
//   ・INT96 timestamp（旧式）が Date で一致
//   ・入れ子の葉 a/b と実在の "a.b" 列が別の列として両方読める（旧＝同名で潰れる）
//   ・読めない符号化は列の unsupported に名前入りの理由
import { readFileSync } from "node:fs";
import { openParquet, readParquet, decodeDeltaBinaryPacked } from "../src/convert/parquet-read.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const dir = new URL("./fixtures/parquet/", import.meta.url);
const exp = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8"));
const load = (f) => new Uint8Array(readFileSync(new URL(f, dir)));

const same = (a, b, eps = 0) => a.length === b.length && a.every((v, i) => {
	const w = b[i];
	if (v === null || w === null) return v === w;
	if (v instanceof Uint8Array) return v.length === w.length && v.every((x, k) => x === w[k]);
	if (typeof v === "number" && eps) return Math.abs(v - w) <= eps * Math.max(1, Math.abs(w));
	return v === w;
});
for (const f of ["encodings-v2.parquet", "encodings-v1-snappy.parquet"]) {
	const r = await readParquet(load(f));
	ok(r.numRows === exp.n && r.columns.every(c => !c.unsupported), `${f}: ${r.numRows} 行・全 ${r.columns.length} 列が読める（${r.columns.filter(c => c.unsupported).map(c => c.name + ": " + c.unsupported).join("; ") || "unsupported なし"}）`);
	const col = (n) => r.columns.find(c => c.name === n)?.values ?? [];
	ok(same(col("i32"), exp.i32), `${f}: INT32 DELTA_BINARY_PACKED（null 込み・2^31 の端の値あり）`);
	ok(same(col("i64"), exp.i64), `${f}: INT64 DELTA_BINARY_PACKED（±2^52 の値あり）`);
	ok(same(col("s"), exp.s), `${f}: BYTE_ARRAY DELTA_BYTE_ARRAY（接頭辞共有・UTF-8・空文字）`);
	ok(same(col("s2"), exp.s2), `${f}: BYTE_ARRAY DELTA_LENGTH_BYTE_ARRAY`);
	ok(same(col("f32"), exp.f32), `${f}: FLOAT BYTE_STREAM_SPLIT`);
	ok(same(col("f64"), exp.f64), `${f}: DOUBLE BYTE_STREAM_SPLIT`);
	ok(same(col("b"), exp.b), `${f}: BOOLEAN RLE`);
	ok(same(col("fixed"), exp.fixed.map(v => v === null ? null : new Uint8Array(v))), `${f}: FIXED_LEN_BYTE_ARRAY DELTA_BYTE_ARRAY`);
}
{
	const r = await readParquet(load("int96.parquet"));
	const ts = r.columns.find(c => c.name === "ts");
	ok(ts && ts.type === 3 && !ts.unsupported && same(ts.values.map(d => d === null ? null : d.getTime()), exp.ts), "INT96 timestamp → Date（ミリ秒一致・null 込み・辞書ページ経由）");
	const pq = await openParquet(load("int96.parquet"));
	const st = pq.rowGroups[0].stats.ts;
	ok(!st || (st.min instanceof Date && st.max instanceof Date), `INT96 の列統計は書き手が付ければ Date（pyarrow は旧式型に統計を付けない: ${st ? "あり" : "なし"}）`);
}
{
	const pq = await openParquet(load("collide.parquet"));
	ok(pq.columns.map(c => c.name).join() === "a.b,a.b#2" && pq.columns[0].path.join("/") === "a/b" && pq.columns[1].path.join("/") === "a.b", `葉名の衝突: ${pq.columns.map(c => c.name).join(", ")}（path a/b と "a.b"）`);
	const m = await pq.readRowGroup(0);
	ok(same(m.get("a.b"), exp.collide["a.b"]) && same(m.get("a.b#2"), exp.collide["a.b#2"]), "衝突した 2 列が両方読める（入れ子 a/b＝数値・実在 a.b＝文字）");
	const r = await readParquet(load("collide.parquet"));
	ok(r.columns.length === 2 && same(r.columns[1].values, exp.collide["a.b#2"]), "readParquet でも 2 列");
}
{
	// 未対応の符号化（BIT_PACKED＝4 を INT32 に）は列ごとの unsupported に名前で立つ: v2 固定具の i32 列のページヘッダの encoding を書き換える
	const u8 = load("encodings-v2.parquet");
	const pq = await openParquet(u8);
	// 先頭 row group の i32 の列チャンク＝最初のページヘッダ。Thrift compact の DataPageHeaderV2 の encoding（field 4）を探して 5→4 に
	const buf = u8.slice();
	let patched = 0;
	for (let p = 4; p < 200 && !patched; p++) if (buf[p] === 0x15 && buf[p + 1] === 0x0a) { buf[p + 1] = 0x08; patched = 1; }   // i32 field 4 zigzag(5)=0x0a → zigzag(4)=0x08
	const r = patched ? await readParquet(buf) : null;
	const c = r?.columns.find(c => c.name === "i32");
	ok(c && c.unsupported && /BIT_PACKED/.test(c.unsupported) && /INT32/.test(c.unsupported) && r.columns.filter(x => x.unsupported).length === 1, `未対応の符号化は列の unsupported に名前入り: ${c?.unsupported}`);
	void pq;
}
{
	// decodeDeltaBinaryPacked の端: 値 1 個（block 無し）・INT32 の 2^32 回り
	const one = new Uint8Array([128, 1, 4, 1, 7]);   // block 128・miniblock 4・total 1・first zigzag(7)=14? → 下で組み直す
	one[4] = 14;
	const r1 = decodeDeltaBinaryPacked(one, 0, 1, 1);
	ok(r1.out[0] === 7 && r1.pos === 5, "DELTA_BINARY_PACKED: 値 1 個＝block 無し");
	let threw = null; try { decodeDeltaBinaryPacked(new Uint8Array([128, 1, 4, 2, 0]), 0, 2, 1); } catch (e) { threw = e.message; }
	ok(threw && /truncated/.test(threw), `切れた block は例外: ${threw}`);
}
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
