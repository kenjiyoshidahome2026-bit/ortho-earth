// @ortho-earth/columnar の検定（Node・#90 段 1）。node packages/columnar/tests/t-columnar.mjs
//  ① 同じデータを GeoPBF から作ったチャンクと toGeoParquet → row group から作ったチャンクで、feature 数・型・座標・面の外周と穴・行番号が一致
//  ② addWkb（直詰め）＝parseWkb → addGeoJSON（参照経路）
//  ③ buildChunk：1° 超の辺の細分・三角形の面積＝面の面積・LOD の単調減・小さな面は四角に潰れて消えない・原点相対・±180° 跨ぎ
//  ④ identify：点 → 線 → 面（最小）の優先・穴の中は当たらない・多重面
//  ⑤ style：paint/filter → fid 表（core の buildFidStyle と同じ形）・参照する列だけ
//  ⑥ 読み手の登録簿（拡張子・先頭バイト）
import assert from "node:assert/strict";
globalThis.ImageData ??= class ImageData { };   // pbf-base の makeKeys が触る（ブラウザの型）＝Node では空の型で
import { GeoPBF } from "geopbf/pbf-base";
import { toGeoParquet } from "geopbf/geoparquet";
import { parseWkb } from "geopbf/parquet";
import { flatBuilder, addGeoJSON, addWkb, K, T } from "../src/flat.js";
import { buildChunk, buildLevels, unwrapAntimeridian, cellOfZoom, LOD_ZOOMS, toXYZ, chunkBuffers, levelBuffers, copyChunk } from "../src/chunk.js";
import { cacheKey, cacheRecord, buildTag } from "../src/cache.js";
import { identifyIn } from "../src/identify.js";
import { tableFor, paintColumns, DEFAULT_PAINT } from "../src/style.js";
import { GEOPBF_SOURCE } from "../src/sources/geopbf.js";
import { GEOPARQUET_SOURCE } from "../src/sources/geoparquet.js";
import { registerColumnarSource, findColumnarSource } from "../src/sources/registry.js";
import { FGB_SOURCE } from "../src/sources/fgb.js";
import { shareStats, gintPreferred } from "../src/share.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFidStyle } from "@ortho-earth/core/fidstyle";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 試料：面（穴あり）・多重面・大きな面（辺 10°）・線・多重線・点・多重点・属性
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
const feats = [];
let id = 0;
const add = (geometry, props = {}) => feats.push({ type: "Feature", properties: { id: id++, v: props.v ?? id, name: props.name ?? "f" + id, ...props }, geometry });
add({ type: "Polygon", coordinates: [sq(139.0, 35.0, 0.02), sq(139.005, 35.005, 0.005)] }, { name: "holed", v: 10 });                       // 0 穴あき
add({ type: "MultiPolygon", coordinates: [[sq(139.1, 35.0, 0.01)], [sq(139.15, 35.0, 0.01), sq(139.152, 35.002, 0.002)]] }, { v: 20 });   // 1 多重面（2 つ目に穴）
add({ type: "Polygon", coordinates: [[[130, 30], [140, 30], [140, 40], [130, 40], [130, 30]]] }, { name: "big", v: 30 });                    // 2 大きな面＝辺 10°
add({ type: "LineString", coordinates: [[139.2, 35.0], [139.21, 35.01], [139.22, 35.0]] }, { v: 40 });                                        // 3 線
add({ type: "MultiLineString", coordinates: [[[139.3, 35.0], [139.31, 35.0]], [[139.3, 35.01], [139.31, 35.01]]] }, { v: 50 });              // 4 多重線
add({ type: "Point", coordinates: [139.4, 35.0] }, { v: 60 });                                                                                 // 5 点
add({ type: "MultiPoint", coordinates: [[139.5, 35.0], [139.51, 35.0]] }, { v: 70 });                                                          // 6 多重点
add({ type: "Polygon", coordinates: [sq(139.6, 35.0, 0.00002)] }, { name: "tiny", v: 80 });                                                   // 7 極小の面（2m 角）
for (let i = 0; i < 40; i++) add({ type: "Polygon", coordinates: [sq(140 + (i % 8) * 0.05, 36 + Math.floor(i / 8) * 0.05, 0.03)] }, { v: 100 + i });   // 8.. 筆風の格子
const fc = { type: "FeatureCollection", features: feats };
const pbf = new GeoPBF({ name: "t" }); await pbf.set(fc);
const N = feats.length;

// フラットな幾何 → 比較しやすい形（行番号 → { type, parts:[{kind, xy:[…]}] }）
const digest = (flat) => {
	const out = new Map();
	for (let f = 0; f < flat.n; f++) {
		const parts = [];
		for (let p = flat.featPart[f]; p < flat.featPart[f + 1]; p++) parts.push({ kind: flat.partKind[p], xy: Array.from(flat.xy.subarray(flat.partStart[p] * 2, flat.partStart[p + 1] * 2)) });
		out.set(flat.rows[f], { type: flat.types[f], parts });
	}
	return out;
};
const sameDigest = (A, B, eps) => {
	assert.equal(A.size, B.size, "feature count");
	for (const [k, a] of A) {
		const b = B.get(k); assert.ok(b, `row ${k} missing`);
		assert.equal(a.type, b.type, `row ${k} type`); assert.equal(a.parts.length, b.parts.length, `row ${k} parts`);
		for (let i = 0; i < a.parts.length; i++) { assert.equal(a.parts[i].kind, b.parts[i].kind, `row ${k} part ${i} kind`); assert.equal(a.parts[i].xy.length, b.parts[i].xy.length, `row ${k} part ${i} len`); for (let j = 0; j < a.parts[i].xy.length; j++) assert.ok(near(a.parts[i].xy[j], b.parts[i].xy[j], eps), `row ${k} part ${i} coord ${j}: ${a.parts[i].xy[j]} vs ${b.parts[i].xy[j]}`); }
	}
};

// ── ① GeoPBF の読み手 と GeoParquet の読み手
const rp = await GEOPBF_SOURCE.open(pbf.arrayBuffer, { name: "t.geopbf", chunkFeatures: 16 });
const { buffer: pq } = await toGeoParquet(pbf, { codec: "gzip", gpu: false, rowGroupSize: 16, order: "str" });
const rq = await GEOPARQUET_SOURCE.open(new Uint8Array(pq), { name: "t.parquet" });
await t("geopbf reader: meta", () => {
	assert.equal(rp.meta.rows, N); assert.ok(rp.meta.chunks.length >= 3, "chunks " + rp.meta.chunks.length);
	assert.equal(rp.meta.chunks.reduce((s, c) => s + c.rows, 0), N);
	assert.deepEqual(rp.meta.columns.map(c => c.name).sort(), ["id", "name", "v"]);
	assert.ok(rp.meta.columns.find(c => c.name === "v").numeric && !rp.meta.columns.find(c => c.name === "name").numeric);
	assert.deepEqual(rp.range("v"), [10, 139]);
	for (const c of rp.meta.chunks) assert.ok(c.bbox[0] <= c.bbox[2] && c.bytes > 0);
});
await t("geoparquet reader: meta", () => {
	assert.equal(rq.meta.rows, N); assert.equal(rq.meta.chunks.length, Math.ceil(N / 16));
	assert.ok(rq.meta.chunks.every(c => c.bbox), "covering bbox from stats");
	assert.deepEqual(rq.meta.range.v, [10, 139]);
});
// 両方の読み手の全チャンクを「元の feature（id 列）」で突き合わせる
const gather = async (r) => {
	const flats = new Map();   // id → digest 項
	for (let g = 0; g < r.meta.chunks.length; g++) {
		const flat = await r.readGeometry(g), cols = await r.readColumns(g, ["id"], flat.rows), d = digest(flat);
		for (let f = 0; f < flat.n; f++) flats.set(cols.id[f], d.get(flat.rows[f]));
	}
	return flats;
};
await t("same chunks from GeoPBF and from GeoParquet (features, types, rings, holes, coords)", async () => {
	const A = await gather(rp), B = await gather(rq);
	sameDigest(A, B, 1e-6);
	assert.equal(A.get(0).parts.map(p => p.kind).join(","), [K.OUTER, K.HOLE].join(","));
	assert.equal(A.get(1).parts.map(p => p.kind).join(","), [K.OUTER, K.OUTER, K.HOLE].join(","));
	assert.equal(A.get(6).parts.length, 2); assert.equal(A.get(6).type, T.MultiPoint);
	assert.equal(A.get(0).parts[0].xy.length, 8, "ring without closing point");
});
await t("readColumns / readProps (both readers)", async () => {
	const fa = await rp.readGeometry(0), ca = await rp.readColumns(0, ["v", "name", "nope"], fa.rows);
	assert.equal(ca.v.length, fa.n); assert.ok(!("nope" in ca));
	const pa = await rp.readProps(0, fa.rows[0]); assert.equal(pa.v, ca.v[0]); assert.equal(pa.name, ca.name[0]);
	const fb = await rq.readGeometry(0), cb = await rq.readColumns(0, ["v", "name"], fb.rows);
	assert.equal(cb.v.length, fb.n);
	const pb = await rq.readProps(0, fb.rows[0]); assert.equal(pb.v, cb.v[0]); assert.equal(pb.name, cb.name[0]);
});

// ── ② addWkb ＝ parseWkb → addGeoJSON
await t("addWkb equals parseWkb+addGeoJSON", async () => {
	const { openParquet } = await import("geopbf/parquet");
	const p = await openParquet(new Uint8Array(pq));
	const m = await p.readRowGroup(0, { columns: [p.geometry.name] }), wk = m.get(p.geometry.name);
	const A = flatBuilder(), B = flatBuilder();
	for (let i = 0; i < wk.length; i++) { if (!wk[i]) continue; addWkb(A, i, wk[i]); addGeoJSON(B, i, parseWkb(wk[i], { vertices: 0 })); }
	sameDigest(digest(A.finish()), digest(B.finish()), 0);
});

// ── ③ buildChunk
const flatAll = await rp.readGeometry([...Array(rp.meta.chunks.length).keys()].find(g => rp.readGeometry(g).rows.includes(2)) ?? 0);
const chunkOf = (rows) => { const fb = flatBuilder(); for (const r of rows) addGeoJSON(fb, r, feats[r].geometry); return buildChunk(fb.finish(), { g: 0 }); };
await t("buildChunk: subdivision of >1° edges, fills area, levels", () => {
	const c = chunkOf([2]);
	const full = c.levels[0]; assert.equal(full.zoom, Infinity);
	// 線の辺＝全部 ≤ 1°（原点相対 xyz を経緯度に戻して測る）
	const O = c.origin, toLL = (p, i) => { const x = p[i * 3] + O[0], y = p[i * 3 + 1] + O[1], z = p[i * 3 + 2] + O[2]; return [Math.atan2(z, x) / Math.PI * 180, Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI * 180]; };
	const nv = full.lines.feat.length;
	assert.equal(nv, 4 * 10 + 1, "10° edges → 10 segments each + closing vertex");
	for (let i = 0; i + 1 < nv; i++) { if (full.lines.feat[i] & 0x80000000) continue; const a = toLL(full.lines.pos, i), b = toLL(full.lines.pos, i + 1); assert.ok(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) <= 1 + 1e-6, `edge ${i} > 1°`); }
	assert.ok(full.lines.feat[nv - 1] & 0x80000000, "ring end flagged");
	// 三角形の面積（経緯度平面）＝10°×10°
	const { pos, index } = full.fills; let area = 0;
	for (let k = 0; k < index.length; k += 3) { const a = toLL(pos, index[k]), b = toLL(pos, index[k + 1]), d = toLL(pos, index[k + 2]); area += Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])) / 2; }
	assert.ok(near(area, 100, 1e-3), "area " + area);
	// 原点相対＝小さい
	for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(pos[i]) < 0.2);
	assert.ok(c.levels.length >= 1 && c.levels.every((L, i) => i === 0 || L.zoom < c.levels[i - 1].zoom), "levels descending " + c.levels.map(L => L.zoom));
});
await t("buildChunk: LOD reduces vertices monotonically; tiny polygon survives as a quad", () => {
	// 頂点の多い面（64 角形・半径 0.01°）× 40 と極小の面（2m 角）
	const circle = (cx, cy, r, m = 64) => { const o = []; for (let i = 0; i < m; i++) o.push([cx + r * Math.cos(i / m * 2 * Math.PI), cy + r * Math.sin(i / m * 2 * Math.PI)]); o.push(o[0]); return o; };
	const fb = flatBuilder();
	addGeoJSON(fb, 7, feats[7].geometry);
	for (let i = 0; i < 40; i++) addGeoJSON(fb, 100 + i, { type: "Polygon", coordinates: [circle(140 + (i % 8) * 0.05, 36 + Math.floor(i / 8) * 0.05, 0.01)] });
	const c = buildChunk(fb.finish(), { g: 0 });
	const counts = c.levels.map(L => (L.lines?.feat.length ?? 0) + (L.fills?.pos.length / 3 ?? 0));
	assert.ok(c.levels.length >= 3, "levels " + c.levels.map(L => L.zoom));
	for (let i = 1; i < counts.length; i++) assert.ok(counts[i] < counts[i - 1] * 0.75, `level ${i} not smaller: ${counts}`);
	const low = c.levels[c.levels.length - 1], tinyF = Array.from(c.rows).indexOf(7);
	let tri = 0; for (let k = 0; k < low.fills.index.length; k += 3) if (low.fills.feat[low.fills.index[k]] === tinyF) tri++;
	assert.equal(tri, 2, "tiny polygon → 2 triangles (quad) at the lowest level");
	assert.ok(low.zoom <= 9, "lowest level zoom " + low.zoom);
	// 最下段でも 40 の円が全部残る（面ごとに三角形がある）
	const seen = new Set(); for (let k = 0; k < low.fills.index.length; k += 3) seen.add(low.fills.feat[low.fills.index[k]]);
	assert.equal(seen.size, 41);
});
await t("cellOfZoom / toXYZ", () => {
	assert.ok(near(cellOfZoom(0), 360 / 256)); assert.ok(near(cellOfZoom(8), 360 / 256 / 256));
	const p = toXYZ(0, 0, 1); assert.deepEqual(p.map(v => +v.toFixed(9)), [1, 0, 0]);
	const q = toXYZ(90, 0, 1); assert.ok(near(q[2], 1, 1e-9));
});
await t("antimeridian: a feature spanning ±180° is made continuous; bbox and identify follow", () => {
	const fb = flatBuilder();
	addGeoJSON(fb, 0, { type: "Polygon", coordinates: [[[179, 10], [-179, 10], [-179, 12], [179, 12], [179, 10]]] });
	const flat = fb.finish();
	assert.equal(unwrapAntimeridian(flat), 1);
	assert.ok(flat.xy.every((v, i) => i % 2 === 1 || v >= 179), "negative lons shifted by 360");
	const c = buildChunk(flat, { unwrap: false });
	assert.ok(c.bbox[0] >= 179 && c.bbox[2] <= 181);
	assert.equal(identifyIn(flat, c.fbbox, -179.5, 11), 0, "identify with a negative lon");
	assert.equal(identifyIn(flat, c.fbbox, 179.5, 11), 0);
	assert.equal(identifyIn(flat, c.fbbox, 170, 11), -1);
});

// ── ④ identify
await t("identify: priority point > line > smallest polygon; holes; multipolygon", () => {
	const rows = [0, 1, 2, 3, 5];   // holed, multi, big, line, point（big は全部を含む）
	const fb = flatBuilder(); for (const r of rows) addGeoJSON(fb, r, feats[r].geometry);
	const flat = fb.finish(), c = buildChunk(flat, {});
	const at = (lon, lat) => { const f = identifyIn(flat, c.fbbox, lon, lat); return f < 0 ? null : flat.rows[f]; };
	assert.equal(at(139.001, 35.001), 0, "inside holed (smaller than big)");
	assert.equal(at(139.0075, 35.0075), 2, "inside the hole → big polygon (the container)");
	assert.equal(at(139.105, 35.005), 1, "multipolygon part 1");
	assert.equal(at(139.155, 35.005), 1, "multipolygon part 2 (outside its hole)");
	assert.equal(at(139.1530, 35.0030), 2, "inside the hole of part 2 → big");
	assert.equal(at(139.21, 35.0101), 3, "near the line (≈11 m)");
	assert.equal(at(139.4001, 35.0001), 5, "near the point (≈14 m) beats the polygon");
	assert.equal(at(135, 35), 2, "big only");
	assert.equal(at(100, 0), null);
});

// ── ⑤ style
await t("style: paintColumns / tableFor = buildFidStyle", () => {
	const paint = { "fill-color": ["match", ["get", "name"], "holed", "#ff0000", "#0000ff"], "fill-opacity": 0.5, "line-width": ["case", [">", ["get", "v"], 25], 3, 1] };
	const filter = ["!=", ["get", "name"], "big"];
	assert.deepEqual([...paintColumns(paint, filter)].sort(), ["name", "v"]);
	const fb = flatBuilder(); for (const r of [0, 2, 5]) addGeoJSON(fb, r, feats[r].geometry);
	const flat = fb.finish();
	const cols = { name: ["holed", "big", "f6"], v: [10, 30, 60] };
	const u32 = tableFor({ paint, filter, zoom: 5, cols, types: flat.types, n: 3 });
	const ref = buildFidStyle(paint, [0, 2, 5].map((r, i) => ({ properties: { name: cols.name[i], v: cols.v[i] }, geometry: { type: feats[r].geometry.type } })), { filter, zoom: 5 }).u32;
	assert.deepEqual(Array.from(u32), Array.from(ref));
	assert.equal(u32[0] >>> 0, 0xff000080 >>> 0, "holed = red α0.5");
	assert.equal(u32[1 * 4 + 2] & 1, 0, "big filtered out");
	assert.equal((u32[1 * 4 + 2] >>> 24), 24, "line-width 3px → 24/8");
	const d = tableFor({ paint: null, cols: {}, types: flat.types, n: 3 });
	assert.ok(d[0] !== 0 && (d[2] & 1) === 1, "default paint fills and is visible");
	assert.ok(DEFAULT_PAINT["fill-color"]);
});

// ── ⑥ registry
await t("registry: extension and magic bytes", () => {
	registerColumnarSource(GEOPBF_SOURCE); registerColumnarSource(GEOPARQUET_SOURCE);
	assert.equal(findColumnarSource({ name: "a.parquet" }).name, "geoparquet");
	assert.equal(findColumnarSource({ name: "a.GeoParquet" }).name, "geoparquet");
	assert.equal(findColumnarSource({ name: "a.geopbf" }).name, "geopbf");
	assert.equal(findColumnarSource({ name: "x.bin", head: new Uint8Array([0x50, 0x41, 0x52, 0x31]) }).name, "geoparquet");
	assert.equal(findColumnarSource({ name: "", head: new Uint8Array([0x1f, 0x8b, 8]) }).name, "geopbf");
	assert.equal(findColumnarSource({ name: "x.shp" }), null);
	assert.equal(findColumnarSource({ name: "x.shp", hint: "geopbf" }).name, "geopbf");
});
// ── ⑦ 弧の共有の物差し（振り分けの規則）
await t("shareStats: admin-like (long shared arcs) → gint; parcels/lines/points → columnar", async () => {
	// 行政界風＝隣り合う 2 つの大きな面が長い共有弧を持つ（1 面 200 頂点・共有 100）
	const arc = []; for (let i = 0; i <= 100; i++) arc.push([139 + i * 0.001, 35 + Math.sin(i / 7) * 0.002]);
	const left = [...arc, [139.1, 34.9], [139.0, 34.9], arc[0]], right = [...arc.slice().reverse(), [139.0, 35.1], [139.1, 35.1], arc[100]];
	const fbA = flatBuilder(); addGeoJSON(fbA, 0, { type: "Polygon", coordinates: [left] }); addGeoJSON(fbA, 1, { type: "Polygon", coordinates: [right] });
	const A = shareStats(fbA.finish());
	assert.ok(A.ratio > 0.45 && A.meanVertices > 100, JSON.stringify(A));
	assert.equal(gintPreferred(A, 10e6), true); assert.equal(gintPreferred(A, 100e6), false, "too big for gint");
	// 筆風＝小さな四角の格子（共有は多いが弧が短い）
	const fbP = flatBuilder(); for (let i = 0; i < 100; i++) addGeoJSON(fbP, i, { type: "Polygon", coordinates: [sq(140 + (i % 10) * 0.01, 36 + Math.floor(i / 10) * 0.01, 0.01)] });
	const P = shareStats(fbP.finish());
	assert.ok(P.ratio > 0.3 && P.meanVertices === 4, JSON.stringify(P));
	assert.equal(gintPreferred(P, 10e6), false);
	// 線と点＝共有なし
	const fbL = flatBuilder(); for (let i = 0; i < 5; i++) addGeoJSON(fbL, i, feats[3].geometry); addGeoJSON(fbL, 9, feats[5].geometry);
	const L = shareStats(fbL.finish()); assert.ok(L.ratio > 0.7 && L.meanVertices === 3, JSON.stringify(L));   // 同じ線を 5 回＝共有だが短い
	assert.equal(gintPreferred(L, 1e6), false);
	assert.equal(gintPreferred(null, 1e6), false);
	// 読み手の meta.share（GeoPBF・GeoParquet とも先頭チャンクの標本）
	assert.ok(rp.meta.share && rp.meta.share.vertices > 0, JSON.stringify(rp.meta.share));
	assert.ok(rq.meta.share && rq.meta.share.vertices > 0, JSON.stringify(rq.meta.share));
	const f0 = await rp.readGeometry(0); assert.ok(f0.n > 0, "flat0 is served then rebuilt");
	const f0b = await rp.readGeometry(0); assert.equal(f0b.n, f0.n);
});
// ── ⑧ FlatGeobuf の読み手（geopbf/fgb 経由・公式 countries.fgb）
await t("fgb reader: countries.fgb → chunks (delegates to the geopbf reader)", async () => {
	const u8 = new Uint8Array(readFileSync(fileURLToPath(new URL("../../geopbf/tests/fixtures/fgb/countries.fgb", import.meta.url))));
	assert.equal(findColumnarSource({ name: "x.fgb" })?.name, undefined, "not registered yet");
	registerColumnarSource(FGB_SOURCE);
	assert.equal(findColumnarSource({ name: "x.fgb" }).name, "fgb");
	assert.equal(findColumnarSource({ name: "", head: u8.subarray(0, 8) }).name, "fgb");
	const r = await FGB_SOURCE.open(u8, { name: "countries.fgb" });
	assert.equal(r.meta.kind, "fgb"); assert.ok(r.meta.rows >= 100, "rows " + r.meta.rows);
	assert.ok(r.meta.share && r.meta.share.meanVertices > 40, JSON.stringify(r.meta.share));
	const f = await r.readGeometry(0); assert.ok(f.n > 0 && f.xy.length > 0);
	const cols = await r.readColumns(0, r.meta.columns.slice(0, 1).map(c => c.name), f.rows); assert.equal(Object.keys(cols).length, 1);
});
// ── ⑨ IDB の 1 件（worker の chunk() と同じ順）：main へ transfer した後でも構造化複製が通る・鍵に作り方
await t("cache: the record survives the transfer to main (was DataCloneError); key carries rAx/lods", () => {
	const fb = flatBuilder(); for (const r of [0, 1, 3, 5, 6]) addGeoJSON(fb, r, feats[r].geometry);
	const flat = fb.finish(), c = buildChunk(flat, { g: 3, zoom: 5 });   // zoom 5 → 段 6 だけ先に（pending）
	assert.ok(c.pending && c.points && c.levels.length === 1 && c.levels[0].zoom === 6, "first level " + c.levels.map(L => L.zoom));
	const snap = copyChunk(c);
	structuredClone(c, { transfer: chunkBuffers(c) });   // main へ渡した＝worker 側は detach
	assert.equal(c.rows.byteLength, 0, "rows detached");
	assert.throws(() => structuredClone({ ...c }), /DataCloneError|detached/i, "the old record ({ ...c } after transfer) cannot be put");
	const added = buildLevels(flat, c, {});
	const rec = cacheRecord(snap, added, flat), back = structuredClone(rec);   // put の複製＝呼んだ時
	structuredClone(added, { transfer: levelBuffers(added) });   // その後で段を main へ渡しても写しは無傷
	assert.equal(back.chunk.pending, false);
	assert.deepEqual(Array.from(back.chunk.rows), Array.from(flat.rows));
	assert.equal(back.chunk.points.pos.length, 3 * 3, "3 points (point + multipoint)");
	assert.deepEqual(back.chunk.levels.map(L => L.zoom), [Infinity, 6]);
	for (const L of back.chunk.levels) assert.ok(L.lines.pos.length > 0 && L.fills.index.length > 0, "level " + L.zoom + " has data");
	assert.ok(rec.bytesTotal > flat.xy.byteLength);
	// 鍵：球（rAx=1）で焼いた物を楕円体で出さない・LOD 段の違いも別物・URL の無い源は置かない
	const ell = 6356752.314245 / 6378137, base = "https://x/a.parquet|etag";
	const kS = cacheKey(base, 3, buildTag({ rAx: 1, lods: LOD_ZOOMS })), kE = cacheKey(base, 3, buildTag({ rAx: ell, lods: LOD_ZOOMS }));
	assert.notEqual(kS, kE);
	assert.equal(kS, cacheKey(base, 3, buildTag({ rAx: 1, lods: [...LOD_ZOOMS] })), "same build → same key");
	assert.notEqual(kS, cacheKey(base, 3, buildTag({ rAx: 1, lods: [12, 9] })));
	assert.notEqual(kS, cacheKey(base, 3, buildTag({ rAx: 1, lods: LOD_ZOOMS, chunkFeatures: 16 })));
	assert.equal(cacheKey(null, 3, buildTag({})), null);
});
console.log(`columnar: ${n} passed`);
