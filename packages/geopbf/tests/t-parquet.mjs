#!/usr/bin/env node
// t-parquet: GeoPBF → GeoParquet（CPU 経路・決定的）。
//   ・PAR1 の骨格・footer・行数、WKB を自前で復号して GeoJSON の座標と一致、属性列の型
//   ・pyarrow があれば読み戻して schema/geo メタ/bbox 統計を確認（無ければその項目は skip 表示）
//   ・CLI（parquet サブコマンド）
globalThis.ImageData ??= class ImageData { };
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoPBF } from "../src/pbf-base.js";
import { toGeoParquet, fromGeoParquet } from "../src/convert/geoparquet.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const skip = (msg) => console.log("– skip:", msg);

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
const pbf = await new GeoPBF({ name: "fix", precision: 6, attribution: "t-parquet" }).set(structuredClone(fc));
const gj = pbf.geojson;
const r = await toGeoParquet(pbf, { gpu: false, order: "none" });   // 行順の検定は入力順で（空間整列は後段で別に検定）
const buf = r.buffer;
ok(r.stats.engine === "cpu" && r.stats.features === 8 && r.stats.vertices === 29, `toGeoParquet: ${buf.length} B・頂点 ${r.stats.vertices}`);
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
// 「PLAIN の [len][01 ..]」が 7 個並ぶ位置を線形探索（検定用の最小手＝pyarrow がある環境ではそちらでも確認）
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

// ---- pyarrow（あれば）--------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "geopbf-pq-"));
const pqPath = join(dir, "fix.parquet"); writeFileSync(pqPath, buf);
const py = spawnSync("python3", ["-c", `
import json, sys
try:
    import pyarrow.parquet as pq
except Exception as e:
    print("NOPYARROW"); sys.exit(0)
t = pq.read_table(sys.argv[1]); md = pq.read_metadata(sys.argv[1])
rows = t.to_pylist()
geo = json.loads(md.metadata[b"geo"])
st = md.row_group(0).column(md.num_columns - 4).statistics
print(json.dumps({"rows": t.num_rows, "cols": t.num_columns, "types": {f.name: str(f.type) for f in t.schema},
  "r0": {k: (v if not isinstance(v, (bytes, dict)) else ("bytes:%d" % len(v) if isinstance(v, bytes) else v)) for k, v in rows[0].items() if k != "d"},
  "d0": rows[0]["d"].isoformat(), "r7geom": rows[7]["geometry"], "geo_primary": geo["primary_column"], "xmin_stats": [st.has_min_max, st.min, st.max, st.null_count],
  "created": md.created_by, "kv": sorted(k.decode() for k in md.metadata.keys())}, default=str))
`, pqPath], { encoding: "utf8" });
if (py.status !== 0 || !py.stdout) skip(`pyarrow 検定（python3 が無い: ${(py.stderr || "").split("\n")[0]}）`);
else if (py.stdout.startsWith("NOPYARROW")) skip("pyarrow 検定（pyarrow 未導入）");
else {
	const o = JSON.parse(py.stdout);
	ok(o.rows === 8 && o.cols === 10, `pyarrow: 8 行 10 列（${o.rows}×${o.cols}）`);
	ok(o.types.b === "bool" && o.types.v === "int64" && o.types.f === "double" && o.types.n === "string" && o.types.d === "timestamp[ms, tz=UTC]" && /^struct<xmin: double not null/.test(o.types.bbox) && o.types.geometry === "binary", `pyarrow: 列型 ${JSON.stringify(o.types)}`);
	ok(o.r0.n === "A" && o.r0.v === 1 && o.r0.f === 1.5 && o.r0.b === true && o.r0["j.a"] === 1 && o.r0["nest.x"] === "é" && o.r0.geometry === "bytes:93" && o.r0.bbox.xmin === 139.5 && o.r0.bbox.ymax === 35.8, "pyarrow: 行 0 の値（入れ子は a.b 列・bbox struct）");
	ok(o.d0.startsWith("1970-01-02"), `pyarrow: TIMESTAMP(ms, UTC) ${o.d0}`);
	ok(o.r7geom === null, "pyarrow: geometry 無し feature は null");
	ok(o.geo_primary === "geometry" && o.xmin_stats[0] === true && o.xmin_stats[1] === 0.5 && o.xmin_stats[2] === 139.767125 && o.xmin_stats[3] === 1, `pyarrow: geo メタと bbox.xmin の統計 ${JSON.stringify(o.xmin_stats)}`);
	ok(o.created === "geopbf" && o.kv.includes("geopbf:attribution"), "pyarrow: created_by と geopbf:attribution");
}

// ---- bbox 列の既定は true・"auto" なら点だけのデータで省く ----
{
	const pp = await new GeoPBF({ name: "p" }).set({ type: "FeatureCollection", features: [{ type: "Feature", properties: { a: 1 }, geometry: { type: "Point", coordinates: [1, 2] } }] });
	const ra = await toGeoParquet(pp, { gpu: false, codec: "none", bboxColumn: "auto" }), rb = await toGeoParquet(pp, { gpu: false, codec: "none" });
	ok(!ra.geo.columns.geometry.covering && rb.geo.columns.geometry.covering && ra.buffer.length < rb.buffer.length, 'bbox 列: 既定は書く・"auto" は点だけのデータで省く');
}

// ---- 行の空間整列（order）: str は行グループ bbox が互いに重ならない・none は入力順・行の属性と幾何は一緒に動く ----
{
	let sd = 5; const rnd = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const N = 3000, feats = Array.from({ length: N }, (_, i) => ({ type: "Feature", properties: { i, lon: 0 }, geometry: { type: "Point", coordinates: [+(130 + rnd() * 10).toFixed(5), +(30 + rnd() * 10).toFixed(5)] } }));
	feats.forEach(f => { f.properties.lon = f.geometry.coordinates[0]; });
	const pp = await new GeoPBF({ name: "pts", precision: 5 }).set(structuredClone(feats.length ? { type: "FeatureCollection", features: feats } : null));
	const res = {};
	for (const order of ["none", "morton", "hilbert", "str"]) { res[order] = await toGeoParquet(pp, { gpu: false, codec: "none", rowGroupSize: 500, order }); writeFileSync(join(dir, `ord-${order}.parquet`), res[order].buffer); }
	ok(res.str.stats.order === "str", "order が stats に載る");
	const chk = spawnSync("python3", ["-c", `
import json, sys, itertools, struct
try:
    import pyarrow.parquet as pq
except Exception: print("NOPYARROW"); sys.exit(0)
out = {}
for order in ["none", "morton", "hilbert", "str"]:
    f = sys.argv[1] + "/ord-" + order + ".parquet"; md = pq.read_metadata(f); names = [md.schema.column(i).path for i in range(md.num_columns)]
    ci = {n: names.index(n) for n in ["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"]}
    boxes = [(rg.column(ci["bbox.xmin"]).statistics.min, rg.column(ci["bbox.ymin"]).statistics.min, rg.column(ci["bbox.xmax"]).statistics.max, rg.column(ci["bbox.ymax"]).statistics.max) for rg in (md.row_group(r) for r in range(md.num_row_groups))]
    ov = 0.0
    for a, b in itertools.combinations(boxes, 2):
        w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
        if w > 0 and h > 0: ov += w * h
    area = sum((b[2]-b[0])*(b[3]-b[1]) for b in boxes)
    t = pq.read_table(f).to_pylist()
    consistent = all(abs(struct.unpack("<d", r["geometry"][5:13])[0] - r["lon"]) < 1e-9 for r in t)
    out[order] = {"rg": md.num_row_groups, "ovRatio": ov / area, "row0": t[0]["i"], "consistent": consistent, "rows": len(t)}
print(json.dumps(out))
`, dir], { encoding: "utf8" });
	if (chk.status !== 0 || !chk.stdout || chk.stdout.startsWith("NOPYARROW")) skip("order 検定（pyarrow 無し）");
	else {
		const o = JSON.parse(chk.stdout);
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

// ---- 辞書符号化と全列の統計（pyarrow で読み戻し）-------------------------------------------------
{
	// cat: 3 値（run 多め＝RLE run）・alt: 2 値が交互（bit-packed）・cnt: 整数 5 値・uniq: 全て異なる（PLAIN のまま）・some: 後半だけ null
	const N = 1000, feats = Array.from({ length: N }, (_, i) => ({ type: "Feature", properties: { cat: ["bus", "駅", "café"][Math.floor(i / 100) % 3], alt: i % 2 ? "b" : "a", cnt: i % 5, uniq: "u" + i, some: i < 300 ? i * 0.5 : null, flag: i % 3 === 0 }, geometry: { type: "Point", coordinates: [i % 100, Math.floor(i / 100)] } }));
	const pp = await new GeoPBF({ name: "d", precision: 3 }).set({ type: "FeatureCollection", features: feats });
	const rd = await toGeoParquet(pp, { gpu: false, codec: "none", order: "none", rowGroupSize: 400, bboxColumn: false });
	writeFileSync(join(dir, "dict.parquet"), rd.buffer);
	const chk = spawnSync("python3", ["-c", `
import json, sys
try:
    import pyarrow.parquet as pq
except Exception:
    print("NOPYARROW"); sys.exit(0)
pf = pq.ParquetFile(sys.argv[1]); md = pf.metadata; t = pf.read(); rows = t.to_pylist()
ci = {md.row_group(0).column(i).path_in_schema: i for i in range(md.num_columns)}
enc = {k: list(md.row_group(0).column(i).encodings) for k, i in ci.items()}
st = {k: (lambda s: [s.min, s.max, s.null_count] if s and s.has_min_max else None)(md.row_group(2).column(i).statistics) for k, i in ci.items()}
ok = all(r["cat"] == ["bus", "駅", "café"][(i // 100) % 3] and r["alt"] == ("b" if i % 2 else "a") and r["cnt"] == i % 5 and r["uniq"] == "u%d" % i and r["some"] == (i * 0.5 if i < 300 else None) and r["flag"] == (i % 3 == 0) for i, r in enumerate(rows))
print(json.dumps({"rows": t.num_rows, "ok": ok, "enc": enc, "st": st, "rgs": md.num_row_groups}, default=str))
`, join(dir, "dict.parquet")], { encoding: "utf8" });
	if (chk.status !== 0 || !chk.stdout || chk.stdout.startsWith("NOPYARROW")) skip("辞書符号化の検定（pyarrow 無し）" + (chk.stderr || "").split("\n")[0]);
	else {
		const o = JSON.parse(chk.stdout);
		ok(o.rows === N && o.ok && o.rgs === 3, `辞書符号化: pyarrow で全 ${N} 行の値が一致（3 行グループ）`);
		ok(o.enc.cat.includes("RLE_DICTIONARY") && o.enc.alt.includes("RLE_DICTIONARY") && o.enc.cnt.includes("RLE_DICTIONARY") && !o.enc.uniq.includes("RLE_DICTIONARY") && !o.enc.flag.includes("RLE_DICTIONARY") && !o.enc.geometry.includes("RLE_DICTIONARY"), `辞書符号化: 低カーディナリティ列だけ RLE_DICTIONARY ${JSON.stringify(o.enc)}`);
		ok(o.st.cat[0] === "bus" && o.st.cat[1] === "café" && o.st.cnt[0] === 0 && o.st.cnt[1] === 4 && o.st.uniq[0] === "u800" && o.st.uniq[1] === "u999" && o.st.some === null && o.st.geometry === null, `統計: 3 番目の行グループの min/max（文字列はバイト順・全 null 列と幾何は無し）${JSON.stringify(o.st)}`);
	}
}

// ---- zstd コーデックとデータページ分割（pyarrow で読み戻し・値が無圧縮版と一致） ----------------------
{
	const { hasZstd } = await import("../src/convert/gzip.js");
	const rz = await hasZstd() ? await toGeoParquet(pbf, { gpu: false, codec: "zstd", order: "none" }) : null;
	if (!rz) skip("zstd（この Node に zstdCompressSync が無い）");
	else { writeFileSync(join(dir, "z.parquet"), rz.buffer); ok(rz.stats.codec === "zstd" && rz.buffer.length < r0.buffer.length, `zstd: ${rz.buffer.length} B < 無圧縮 ${r0.buffer.length} B`); }
	const rp = await toGeoParquet(pbf, { gpu: false, codec: "none", order: "none", pageSize: 64 });   // 値 64 B 毎にページ＝geometry は 1 行 1 ページ
	writeFileSync(join(dir, "pages.parquet"), rp.buffer);
	ok(rp.buffer.length > r0.buffer.length, `pageSize 64: ページヘッダぶん大きい（${rp.buffer.length} > ${r0.buffer.length}）`);
	const chk = spawnSync("python3", ["-c", `
import sys, json
try:
    import pyarrow.parquet as pq
except Exception: print("NOPYARROW"); sys.exit(0)
base = pq.read_table(sys.argv[1]); out = {}
for name in sys.argv[2:]:
    try: t = pq.read_table(name); out[name.split("/")[-1]] = t.equals(base)
    except Exception as e: out[name.split("/")[-1]] = str(e)[:120]
md = pq.ParquetFile(sys.argv[3]).metadata.row_group(0)
out["codec"] = md.column(md.num_columns - 5).compression if len(sys.argv) > 3 else None
print(json.dumps(out))
`, pqPath, ...(rz ? [join(dir, "z.parquet")] : []), join(dir, "pages.parquet")], { encoding: "utf8" });
	if (chk.status !== 0 || !chk.stdout || chk.stdout.startsWith("NOPYARROW")) skip("zstd/ページ分割の pyarrow 検定（pyarrow 無し）");
	else { const o = JSON.parse(chk.stdout); if (rz) ok(o["z.parquet"] === true, `pyarrow: zstd ファイルの内容が一致（${JSON.stringify(o)}）`); ok(o["pages.parquet"] === true, "pyarrow: 複数データページのファイルの内容が一致"); }
}

// ---- 逆変換 GeoParquet → GeoPBF（往復で GeoJSON が一致・全コーデック・複数ページ・geopandas/DuckDB の出力） -------------
{
	const norm = (p) => JSON.stringify(p.geojson.features.map(f => [f.geometry, f.properties]));
	const want = norm(pbf);
	for (const codec of ["none", "gzip", ...(await (await import("../src/convert/gzip.js")).hasZstd() ? ["zstd"] : [])]) {
		const w = await toGeoParquet(pbf, { gpu: false, codec, order: "none" });
		const r = await fromGeoParquet(w.buffer);
		ok(norm(r.pbf) === want && r.pbf.precision() === 6 && r.pbf.name() === "fix" && r.pbf.attribution() === "t-parquet", `往復 ${codec}: 幾何（GC・穴・多部・null）・属性（Date・JSON・入れ子 a.b・真偽・負数）・ヘッダが一致`);
	}
	const w2 = await toGeoParquet(pbf, { gpu: false, codec: "none", order: "str", pageSize: 64, rowGroupSize: 3 });
	const r2 = await fromGeoParquet(w2.buffer);
	ok(r2.stats.features === 8 && JSON.stringify(r2.pbf.geojson.features.map(f => f.properties.n).sort()) === JSON.stringify(pbf.geojson.features.map(f => f.properties.n).sort()) && r2.stats.skipped.length === 0, `往復（複数ページ・3 行グループ・STR 順）: 8 feature・bbox 覆域列は黙って省く`);
	const r3 = await fromGeoParquet(w2.buffer, { include: ["n"], precision: 3 });
	ok(Object.keys(r3.pbf.getProperties(0)).join() === "n" && r3.pbf.precision() === 3, "逆変換の include と precision");
	let threw = false; try { await fromGeoParquet(w2.buffer, { geometryColumn: "nope" }); } catch { threw = true; } ok(threw, "幾何列が無ければ例外");
	// geopandas（pyarrow: snappy・辞書）と DuckDB（PLAIN_DICTIONARY）の出力
	const gj = join(dir, "fix.geojson"); writeFileSync(gj, JSON.stringify(pbf.geojson));
	const py2 = spawnSync("python3", ["-c", `
import sys, json
try:
    import geopandas as gpd
except Exception: print("NOGPD"); sys.exit(0)
g = gpd.read_file(sys.argv[1]); g.to_parquet(sys.argv[2]); g.to_parquet(sys.argv[3], compression="zstd", data_page_version="2.0")
try:
    import duckdb; duckdb.sql("COPY (SELECT * FROM '%s') TO '%s' (FORMAT PARQUET)" % (sys.argv[2], sys.argv[4])); print("OK duck")
except Exception as e: print("OK noduck")
`, gj, join(dir, "gpd.parquet"), join(dir, "gpd2.parquet"), join(dir, "duck.parquet")], { encoding: "utf8" });
	if (py2.status !== 0 || !py2.stdout || py2.stdout.startsWith("NOGPD")) skip("geopandas/DuckDB 出力の逆変換（geopandas 無し）");
	else {
		const names = (p) => p.geojson.features.map(f => f.properties.n).sort().join();
		for (const f of ["gpd.parquet", "gpd2.parquet", ...(py2.stdout.includes("OK duck") ? ["duck.parquet"] : [])]) {
			const r = await fromGeoParquet(new Uint8Array(readFileSync(join(dir, f))));
			const b = r.pbf.geojson.features.find(f => f.properties.n === "B"), a = r.pbf.geojson.features.find(f => f.properties.n === "A");
			// GDAL は幾何なし feature を落とし、真偽を 0/1 に、入れ子を struct 列にする＝そこは書き手の流儀（struct の葉は "nest.x" に平坦化して拾う）
			ok(r.stats.features >= 7 && b && b.geometry.type === "MultiPolygon" && b.geometry.coordinates[0].length === 2 && a.properties.v === 1 && a.properties.f === 1.5 && (a.properties.b === true || a.properties.b === 1) && a.properties.nest?.x === "é" && a.properties.j?.a === 1 && r.stats.skipped.length === 0 && r.stats.crs.includes("4326"), `${f}: ${r.stats.features} feature・穴付き多面・属性型・struct の葉を "nest.x" に・CRS ${r.stats.crs}（writer ${r.stats.created.slice(0, 18)}）`);
		}
	}
}

// ---- 行グループ分割 -------------------------------------------------------------------------
const r3 = await toGeoParquet(pbf, { gpu: false, rowGroupSize: 3, order: "none" });
ok(r3.buffer.length > buf.length, "rowGroupSize=3 で 3 行グループ（footer が大きい）");

// ---- CLI --------------------------------------------------------------------------------------
const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const inPath = join(dir, "fix.geopbf"); writeFileSync(inPath, Buffer.from(pbf.arrayBuffer));
const out = run("parquet", inPath, join(dir, "cli.parquet"), "--no-gpu", "--compression", "none", "--order", "none");
ok(/features 8/.test(out) && /CPU/.test(out) && /Polygon/.test(out), "CLI parquet: 実行報告");
const cliBuf = readFileSync(join(dir, "cli.parquet"));
ok(cliBuf.subarray(0, 4).toString() === "PAR1" && cliBuf.length === r0.buffer.length, "CLI parquet: 出力（無圧縮）がライブラリ経路と同じ長さ");
const out2 = run("parquet2pbf", join(dir, "cli.parquet"), join(dir, "back.geopbf"), "--no-gzip");
const back = await new GeoPBF().set(new Uint8Array(readFileSync(join(dir, "back.geopbf"))));
ok(/features 8/.test(out2) && back.length === 8 && back.precision() === 6 && JSON.stringify(back.geojson.features.map(f => [f.geometry, f.properties])) === JSON.stringify(pbf.geojson.features.map(f => [f.geometry, f.properties])), "CLI parquet2pbf: GeoParquet → GeoPBF が元と一致");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
