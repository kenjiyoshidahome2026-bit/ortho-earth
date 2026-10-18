#!/usr/bin/env node
// t-parquet: GeoPBF → GeoParquet（CPU 経路・決定的）。
//   ・PAR1 の骨格・footer・行数、WKB を自前で復号して GeoJSON の座標と一致、属性列の型
//   ・hyparquet（外部の読み手）で読み戻して schema/geo メタ/bbox 統計・辞書符号化・zstd・ページ分割を確認
//   ・CLI（parquet サブコマンド）
globalThis.ImageData ??= class ImageData { };
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { parquetMetadata, parquetReadObjects, parquetSchema } from "hyparquet";
import { GeoPBFBase } from "../src/pbf-base.ts";
import { toGeoParquet, fromGeoParquet } from "../src/convert/geoparquet.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const skip = (msg) => console.log("– skip:", msg);
// 読み戻しの答え合わせは外部の読み手 hyparquet（純 JS・2026-10-18 に pyarrow から置き換え）。zstd・gzip は Node の zlib で解く（hyparquet が自前で解くのは snappy だけ）
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const compressors = { ZSTD: (input) => new Uint8Array(zlib.zstdDecompressSync(input)), GZIP: (input) => new Uint8Array(zlib.gunzipSync(input)) };
const hyRead = (u8, opts = {}) => parquetReadObjects({ file: ab(u8), compressors, ...opts });

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", properties: { n: "A", v: 1, f: 1.5, b: true, d: new Date(86400000), j: { a: 1 }, nest: { x: "é", y: 2 } }, geometry: { type: "Polygon", coordinates: [sq(139.5, 35.5, 139.8, 35.8)] } },
	{ type: "Feature", properties: { n: "B", v: -2, f: 2, b: false }, geometry: { type: "MultiPolygon", coordinates: [[sq(15, 15, 16, 16), sq(15.2, 15.2, 15.8, 15.8)], [sq(20, 20, 21, 21)]] } },
	{ type: "Feature", properties: { n: "L", v: 3 }, geometry: { type: "LineString", coordinates: [[139.5, 35.5], [139.65, 35.3], [139.8, 35.5]] } },
	{ type: "Feature", properties: { n: "P", v: 4 }, geometry: { type: "Point", coordinates: [139.767125, 35.681236] } },
	{ type: "Feature", properties: { n: "MPt" }, geometry: { type: "MultiPoint", coordinates: [[1, 1], [2, 2]] } },
	{ type: "Feature", properties: { n: "MLS" }, geometry: { type: "MultiLineString", coordinates: [[[0.5, 0.5], [1, 1]], [[2, 2], [3, 4]]] } },
	{ type: "Feature", properties: { n: "GC" }, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [5, 5] }, { type: "LineString", coordinates: [[5, 5], [6, 6]] }] } },
	{ type: "Feature", properties: { n: "empty" }, geometry: null },
] };
const pbf = await new GeoPBFBase({ name: "fix", precision: 6, attribution: "t-parquet" }).set(structuredClone(fc));
const gj = pbf.geojson;
const r = await toGeoParquet(pbf, { gpu: false, order: "none" });   // 行順の検定は入力順で（空間整列は後段で別に検定）
const buf = r.buffer;
ok(pbf.dropped === 1 && pbf.length === 7 && r.stats.engine === "cpu" && r.stats.features === 7 && r.stats.vertices === 29, `toGeoParquet: ${buf.length} B・頂点 ${r.stats.vertices}（幾何 null の 1 件は set() が落として数える）`);
const magic = (o) => String.fromCharCode(...buf.subarray(o, o + 4));
ok(magic(0) === "PAR1" && magic(buf.length - 4) === "PAR1", "PAR1 の骨格");
const footLen = new DataView(buf.buffer, buf.byteOffset).getUint32(buf.length - 8, true);
ok(footLen > 0 && footLen < buf.length - 12, `footer 長 ${footLen}`);
ok(r.geo.columns.geometry.encoding === "WKB" && r.geo.columns.geometry.geometry_types.join() === "GeometryCollection,LineString,MultiLineString,MultiPoint,MultiPolygon,Point,Polygon" && r.geo.columns.geometry.crs?.id?.code === "CRS84", "geo メタ: WKB・geometry_types・CRS84");
ok(r.geo.columns.geometry.bbox.join() === "0.5,0.5,139.8,35.8" && r.geo.columns.geometry.covering.bbox.xmin.join() === "bbox,xmin", "geo メタ: bbox と covering");

// ---- WKB を自前で復号して GeoJSON と一致（無圧縮・1 行グループで geometry 列の PLAIN を直読み）----------
const r0 = await toGeoParquet(pbf, { gpu: false, codec: "none", order: "none" });
const u8 = r0.buffer, dv = new DataView(u8.buffer, u8.byteOffset);
// WKB（LE）→ GeoJSON 幾何
function readWkb(p) {
	const t = dv.getUint32(p.i + 1, true); p.i += 5;
	const pt = () => { const x = dv.getFloat64(p.i, true), y = dv.getFloat64(p.i + 8, true); p.i += 16; return [x, y]; };
	const n = () => { const v = dv.getUint32(p.i, true); p.i += 4; return v; };
	const pts = () => { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(pt()); return a; };
	const ring = () => pts();
	switch (t) {
		case 1: return { type: "Point", coordinates: pt() };
		case 2: return { type: "LineString", coordinates: pts() };
		case 3: { const c = n(), rs = []; for (let i = 0; i < c; i++) rs.push(ring()); return { type: "Polygon", coordinates: rs }; }
		case 4: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p).coordinates); return { type: "MultiPoint", coordinates: a }; }
		case 5: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p).coordinates); return { type: "MultiLineString", coordinates: a }; }
		case 6: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p).coordinates); return { type: "MultiPolygon", coordinates: a }; }
		case 7: { const c = n(), a = []; for (let i = 0; i < c; i++) a.push(readWkb(p)); return { type: "GeometryCollection", geometries: a }; }
	}
	throw new Error("wkb type " + t);
}
// geometry 列のページ: 直前の feature の WKB 先頭バイト列（01 03 00 00 00 …）で探す代わりに、footer から辿らず
// 「PLAIN の [len][01 ..]」が 7 個並ぶ位置を線形探索（検定用の最小手＝hyparquet でも確認）
const expectWkb = gj.features.filter(f => f.geometry).map(f => f.geometry);
let found = 0, pos = -1;
for (let i = 4; i + 5 < u8.length; i++) {
	if (u8[i + 4] === 1 && dv.getUint32(i, true) === 21 + 0 * 0 && u8[i + 5] === 3 && u8[i + 6] === 0) { /* Point 21B? no: 最初は Polygon */ }
}
// 先頭 feature（Polygon: 1+4+4+4+5*16 = 93 B）の長さ前置 93 を探す
for (let i = 4; i + 4 < u8.length; i++) if (dv.getUint32(i, true) === 93 && u8[i + 4] === 1 && u8[i + 5] === 3 && u8[i + 6] === 0 && u8[i + 7] === 0 && u8[i + 8] === 0) { pos = i; break; }
ok(pos > 0, "geometry 列の PLAIN 値列を見つけた");
if (pos > 0) {
	const p = { i: pos }, got = [];
	for (let k = 0; k < expectWkb.length; k++) { const len = dv.getUint32(p.i, true); p.i += 4; const start = p.i; got.push(readWkb(p)); if (p.i - start !== len) { ok(false, `WKB 長が合わない（feature ${k}）`); break; } }
	found = got.length;
	ok(found === expectWkb.length && JSON.stringify(got) === JSON.stringify(expectWkb), `WKB 復号 ${found} 件が GeoJSON（precision 6）と一致（閉じ点・穴・多部・GC・double 厳密）`);
}

// ---- hyparquet（外部の読み手）で読み戻す ------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "geopbf-pq-"));
{
	// 列型はファイルに書いた素の型で見る（既定の geoparquet: true は geo メタを読んで geometry に GEOMETRY 型を被せ、行では WKB を GeoJSON に解く）
	const md = parquetMetadata(ab(buf), { geoparquet: false }), sch = parquetSchema(md), rows = await hyRead(buf);
	const leaf = (name) => sch.children.find(c => c.element.name === name)?.element;
	const lt = (name) => leaf(name)?.logical_type;
	const bbox = sch.children.find(c => c.element.name === "bbox");
	ok(Number(md.num_rows) === 7 && rows.length === 7 && sch.children.length === 10, `hyparquet: 7 行 10 列（幾何 null の 1 件は set() が落とす）（${md.num_rows}×${sch.children.length}）`);
	ok(leaf("b").type === "BOOLEAN" && leaf("v").type === "INT64" && leaf("f").type === "DOUBLE" && lt("n")?.type === "STRING"
		&& lt("d")?.type === "TIMESTAMP" && lt("d").unit === "MILLIS" && lt("d").isAdjustedToUTC === true
		&& bbox?.children.map(c => c.element.name).join() === "xmin,ymin,xmax,ymax" && bbox.children[0].element.type === "DOUBLE" && bbox.children[0].element.repetition_type === "REQUIRED"
		&& leaf("geometry").type === "BYTE_ARRAY" && !lt("geometry"), "hyparquet: 列型（bool・int64・double・string・timestamp[ms, UTC]・bbox struct・binary）");
	const r0 = rows[0];
	ok(r0.n === "A" && r0.v === 1n && r0.f === 1.5 && r0.b === true && r0["j.a"] === 1n && r0["nest.x"] === "é" && r0.geometry?.type === "Polygon" && r0.bbox.xmin === 139.5 && r0.bbox.ymax === 35.8, "hyparquet: 行 0 の値（入れ子は a.b 列・bbox struct）");
	ok(JSON.stringify(rows.map(r => r.geometry)) === JSON.stringify(gj.features.map(f => f.geometry)), "hyparquet: WKB を GeoJSON に復号して 7 件とも一致（hyparquet 自身の WKB 読み）");
	ok(r0.d instanceof Date && r0.d.toISOString().startsWith("1970-01-02"), `hyparquet: TIMESTAMP(ms, UTC) ${r0.d?.toISOString?.()}`);
	const kv = Object.fromEntries(md.key_value_metadata.map(({ key, value }) => [key, value]));
	const st = md.row_groups[0].columns.find(c => c.meta_data.path_in_schema.join(".") === "bbox.xmin").meta_data.statistics;
	ok(JSON.parse(kv.geo).primary_column === "geometry" && st.min_value === 0.5 && st.max_value === 139.767125 && Number(st.null_count) === 0, `hyparquet: geo メタと bbox.xmin の統計 ${[st.min_value, st.max_value, st.null_count]}`);
	ok(md.created_by === "geopbf" && "geopbf:attribution" in kv, "hyparquet: created_by と geopbf:attribution");
}

// ---- bbox 列の既定は true・"auto" なら点だけのデータで省く ----
{
	const pp = await new GeoPBFBase({ name: "p" }).set({ type: "FeatureCollection", features: [{ type: "Feature", properties: { a: 1 }, geometry: { type: "Point", coordinates: [1, 2] } }] });
	const ra = await toGeoParquet(pp, { gpu: false, codec: "none", bboxColumn: "auto" }), rb = await toGeoParquet(pp, { gpu: false, codec: "none" });
	ok(!ra.geo.columns.geometry.covering && rb.geo.columns.geometry.covering && ra.buffer.length < rb.buffer.length, 'bbox 列: 既定は書く・"auto" は点だけのデータで省く');
}

// ---- 行の空間整列（order）: str は行グループ bbox が互いに重ならない・none は入力順・行の属性と幾何は一緒に動く ----
{
	let sd = 5; const rnd = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const N = 3000, feats = Array.from({ length: N }, (_, i) => ({ type: "Feature", properties: { i, lon: 0 }, geometry: { type: "Point", coordinates: [+(130 + rnd() * 10).toFixed(5), +(30 + rnd() * 10).toFixed(5)] } }));
	feats.forEach(f => { f.properties.lon = f.geometry.coordinates[0]; });
	const pp = await new GeoPBFBase({ name: "pts", precision: 5 }).set(structuredClone(feats.length ? { type: "FeatureCollection", features: feats } : null));
	const res = {};
	for (const order of ["none", "morton", "hilbert", "str"]) { res[order] = await toGeoParquet(pp, { gpu: false, codec: "none", rowGroupSize: 500, order }); }
	ok(res.str.stats.order === "str", "order が stats に載る");
	const o = {};
	for (const order of ["none", "morton", "hilbert", "str"]) {
		const md = parquetMetadata(ab(res[order].buffer));
		const boxes = md.row_groups.map(rg => { const c = Object.fromEntries(rg.columns.map(x => [x.meta_data.path_in_schema.join("."), x.meta_data.statistics])); return [c["bbox.xmin"].min_value, c["bbox.ymin"].min_value, c["bbox.xmax"].max_value, c["bbox.ymax"].max_value]; });
		let ov = 0;
		for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
			const A = boxes[a], B = boxes[b], w = Math.min(A[2], B[2]) - Math.max(A[0], B[0]), h = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
			if (w > 0 && h > 0) ov += w * h;
		}
		const area = boxes.reduce((s, b) => s + (b[2] - b[0]) * (b[3] - b[1]), 0);
		const t = await hyRead(res[order].buffer);
		o[order] = { rg: md.row_groups.length, ovRatio: ov / area, row0: Number(t[0].i), consistent: t.every(r => Math.abs(r.geometry.coordinates[0] - r.lon) < 1e-9), rows: t.length };
	}
	{
		ok(o.none.rg === 6 && o.none.row0 === 0 && o.none.rows === N, `order none: 入力順（row0=${o.none.row0}・6 行グループ）`);
		ok(o.str.ovRatio === 0 && o.hilbert.ovRatio < o.morton.ovRatio && o.morton.ovRatio < o.none.ovRatio, `order: 行グループ bbox の重なり率 none ${o.none.ovRatio.toFixed(2)} > morton ${o.morton.ovRatio.toFixed(2)} > hilbert ${o.hilbert.ovRatio.toFixed(2)} > str ${o.str.ovRatio}`);
		ok(Object.values(o).every(v => v.consistent), "並べ替え後も各行の属性と幾何が一致");
	}
}

// ---- 列の選別 ------------------------------------------------------------------------------
{
	const names = (r) => r.geo && Object.keys(r.geo.columns) && null;   // geo メタは列選別と無関係
	const ri = await toGeoParquet(pbf, { gpu: false, codec: "none", include: ["n"] }), rx = await toGeoParquet(pbf, { gpu: false, codec: "none", excludeAll: true });
	ok(ri.buffer.length < r0.buffer.length && rx.buffer.length < ri.buffer.length, `include/excludeAll: 列が減って小さい（${r0.buffer.length} > ${ri.buffer.length} > ${rx.buffer.length}）`);
	const txt = Buffer.from(rx.buffer).toString("latin1");
	ok(!txt.includes("\x04nest") && txt.includes("geometry"), "excludeAll: footer に属性列名が無く geometry は残る");
	names(ri);
}

// ---- 辞書符号化と全列の統計（hyparquet で読み戻し）-------------------------------------------------
{
	// cat: 3 値（run 多め＝RLE run）・alt: 2 値が交互（bit-packed）・cnt: 整数 5 値・uniq: 全て異なる（PLAIN のまま）・some: 後半だけ null
	const N = 1000, feats = Array.from({ length: N }, (_, i) => ({ type: "Feature", properties: { cat: ["bus", "駅", "café"][Math.floor(i / 100) % 3], alt: i % 2 ? "b" : "a", cnt: i % 5, uniq: "u" + i, some: i < 300 ? i * 0.5 : null, flag: i % 3 === 0 }, geometry: { type: "Point", coordinates: [i % 100, Math.floor(i / 100)] } }));
	const pp = await new GeoPBFBase({ name: "d", precision: 3 }).set({ type: "FeatureCollection", features: feats });
	const rd = await toGeoParquet(pp, { gpu: false, codec: "none", order: "none", rowGroupSize: 400, bboxColumn: false });
	{
		const md = parquetMetadata(ab(rd.buffer)), rows = await hyRead(rd.buffer);
		const cols = (rg) => Object.fromEntries(md.row_groups[rg].columns.map(c => [c.meta_data.path_in_schema.join("."), c.meta_data]));
		const enc = Object.fromEntries(Object.entries(cols(0)).map(([k, m]) => [k, m.encodings]));
		const st = Object.fromEntries(Object.entries(cols(2)).map(([k, m]) => { const s = m.statistics; return [k, s && s.min_value !== undefined ? [s.min_value, s.max_value, Number(s.null_count)] : null]; }));
		const allOk = rows.every((r, i) => r.cat === ["bus", "駅", "café"][Math.floor(i / 100) % 3] && r.alt === (i % 2 ? "b" : "a") && r.cnt === BigInt(i % 5) && r.uniq === "u" + i && r.some === (i < 300 ? i * 0.5 : null) && r.flag === (i % 3 === 0));
		const o = { enc, st: Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v && v.map(x => typeof x === "bigint" ? Number(x) : x)])) };
		ok(rows.length === N && allOk && md.row_groups.length === 3, `辞書符号化: hyparquet で全 ${N} 行の値が一致（3 行グループ）`);
		ok(o.enc.cat.includes("RLE_DICTIONARY") && o.enc.alt.includes("RLE_DICTIONARY") && o.enc.cnt.includes("RLE_DICTIONARY") && !o.enc.uniq.includes("RLE_DICTIONARY") && !o.enc.flag.includes("RLE_DICTIONARY") && !o.enc.geometry.includes("RLE_DICTIONARY"), `辞書符号化: 低カーディナリティ列だけ RLE_DICTIONARY ${JSON.stringify(o.enc)}`);
		ok(o.st.cat[0] === "bus" && o.st.cat[1] === "café" && o.st.cnt[0] === 0 && o.st.cnt[1] === 4 && o.st.uniq[0] === "u800" && o.st.uniq[1] === "u999" && o.st.some === null && o.st.geometry === null, `統計: 3 番目の行グループの min/max（文字列はバイト順・全 null 列と幾何は無し）${JSON.stringify(o.st)}`);
	}
}

// ---- zstd コーデックとデータページ分割（hyparquet で読み戻し・値が無圧縮版と一致） ----------------------
{
	const { hasZstd } = await import("../src/convert/gzip.ts");
	const rz = await hasZstd() ? await toGeoParquet(pbf, { gpu: false, codec: "zstd", order: "none" }) : null;
	if (!rz) skip("zstd（この Node に zstdCompressSync が無い）");
	else ok(rz.stats.codec === "zstd" && rz.buffer.length < r0.buffer.length, `zstd: ${rz.buffer.length} B < 無圧縮 ${r0.buffer.length} B`);
	const rp = await toGeoParquet(pbf, { gpu: false, codec: "none", order: "none", pageSize: 64 });   // 値 64 B 毎にページ＝geometry は 1 行 1 ページ
	ok(rp.buffer.length > r0.buffer.length, `pageSize 64: ページヘッダぶん大きい（${rp.buffer.length} > ${r0.buffer.length}）`);
	const J = (rows) => JSON.stringify(rows, (k, v) => typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? [...v] : v);
	const base = J(await hyRead(buf));
	if (rz) ok(J(await hyRead(rz.buffer)) === base, "hyparquet: zstd ファイルの内容が一致");
	ok(J(await hyRead(rp.buffer)) === base, "hyparquet: 複数データページのファイルの内容が一致");
}

// ---- 逆変換 GeoParquet → GeoPBF（往復で GeoJSON が一致・全コーデック・複数ページ） -------------
{
	const norm = (p) => JSON.stringify(p.geojson.features.map(f => [f.geometry, f.properties]));
	const want = norm(pbf);
	for (const codec of ["none", "gzip", ...(await (await import("../src/convert/gzip.ts")).hasZstd() ? ["zstd"] : [])]) {
		const w = await toGeoParquet(pbf, { gpu: false, codec, order: "none" });
		const r = await fromGeoParquet(w.buffer);
		ok(norm(r.pbf) === want && r.pbf.precision() === 6 && r.pbf.name() === "fix" && r.pbf.attribution() === "t-parquet", `往復 ${codec}: 幾何（GC・穴・多部）・属性（Date・JSON・入れ子 a.b・真偽・負数）・ヘッダが一致`);
	}
	const w2 = await toGeoParquet(pbf, { gpu: false, codec: "none", order: "str", pageSize: 64, rowGroupSize: 3 });
	const r2 = await fromGeoParquet(w2.buffer);
	ok(r2.stats.features === 7 && r2.stats.rows === 7 && r2.stats.droppedGeometries === 0 && JSON.stringify(r2.pbf.geojson.features.map(f => f.properties.n).sort()) === JSON.stringify(pbf.geojson.features.map(f => f.properties.n).sort()) && r2.stats.skipped.length === 0, `往復（複数ページ・3 行グループ・STR 順）: 7 feature・bbox 覆域列は黙って省く`);
	const r3 = await fromGeoParquet(w2.buffer, { include: ["n"], precision: 3 });
	ok(Object.keys(r3.pbf.getProperties(0)).join() === "n" && r3.pbf.precision() === 3, "逆変換の include と precision");
	let threw = false; try { await fromGeoParquet(w2.buffer, { geometryColumn: "nope" }); } catch { threw = true; } ok(threw, "幾何列が無ければ例外");
}

// ---- 行グループ分割 -------------------------------------------------------------------------
const r3 = await toGeoParquet(pbf, { gpu: false, rowGroupSize: 3, order: "none" });
ok(r3.buffer.length > buf.length, "rowGroupSize=3 で 3 行グループ（footer が大きい）");

// ---- CLI --------------------------------------------------------------------------------------
const CLI = new URL("../src/cli/geopbf.ts", import.meta.url).pathname;
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, GEOPBF_LANG: "en" } });
const inPath = join(dir, "fix.geopbf"); writeFileSync(inPath, Buffer.from(pbf.arrayBuffer));
const out = run("parquet", inPath, join(dir, "cli.parquet"), "--no-gpu", "--compression", "none", "--order", "none");
ok(/features 7/.test(out) && /CPU/.test(out) && /Polygon/.test(out), "CLI parquet: 実行報告");
const cliBuf = readFileSync(join(dir, "cli.parquet"));
ok(cliBuf.subarray(0, 4).toString() === "PAR1" && cliBuf.length === r0.buffer.length, "CLI parquet: 出力（無圧縮）がライブラリ経路と同じ長さ");
const out2 = run("parquet2pbf", join(dir, "cli.parquet"), join(dir, "back.geopbf"), "--no-gzip");
const back = await new GeoPBFBase().set(new Uint8Array(readFileSync(join(dir, "back.geopbf"))));
ok(/features 7/.test(out2) && back.length === 7 && back.precision() === 6 && JSON.stringify(back.geojson.features.map(f => [f.geometry, f.properties])) === JSON.stringify(pbf.geojson.features.map(f => [f.geometry, f.properties])), "CLI parquet2pbf: GeoParquet → GeoPBF が元と一致");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
