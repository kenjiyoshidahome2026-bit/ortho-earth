#!/usr/bin/env node
// t-fgb: FlatGeobuf v3 → GeoPBF（convert/fgb.js）。固定資料は FlatGeobuf 公式リポジトリ test/data の見本（BSD-2・LICENSE-flatgeobuf）。
//   旧 decoder は geopbf 自身の書き出し（型=Unknown・全列 String・索引なし）しか読めず、公式 countries.fgb が 0 件だった（2026-09-22）。
//   ・ヘッダの geometry_type 継承（地物側に型が無い）・index_node_size 既定 16（欄なし＝索引あり）・索引の読み飛ばし
//   ・全列型（alldatatypes）・地物ごとの型混在（heterogeneous）・MultiPolygon の parts・features_count 不明（0）
//   ・CRS：無し／EPSG:4326 はそのまま・経緯度でない投影系は投げる（ignoreCrs で素通し）・v2 は明示エラー・幾何なしは落として数える
globalThis.ImageData ??= class ImageData { };
import { readFileSync } from "node:fs";
import { GeoPBF } from "../src/pbf-base.js";
import { fromFlatGeobuf, readFlatGeobufHeader, calcTreeSize } from "../src/convert/fgb.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fx = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/fgb/${n}`, import.meta.url)));
const load = async (n, opts) => { const { pbf, stats } = await fromFlatGeobuf(fx(n), opts); return { q: await new GeoPBF().set(pbf.arrayBuffer), stats }; };

// ── ヘッダ ───────────────────────────────────────────────────────────────────
{
	const h = readFlatGeobufHeader(fx("countries.fgb"));
	ok(h.geometryType === 6 && h.featuresCount === 179 && h.indexNodeSize === 16 && h.crs?.code === 4326, `countries: MultiPolygon・179 件・索引 16（欄なし＝既定）・EPSG:4326（${h.geometryType}/${h.featuresCount}/${h.indexNodeSize}/${h.crs?.code}）`);
	ok(h.columns.map(c => `${c.name}:${c.type}`).join() === "id:11,name:11", `countries: 列 id/name（String）`);
	ok(calcTreeSize(179, 16) === (179 + 12 + 1) * 40, "calcTreeSize: 179 件・節 16 ＝ 179+12+1 節");
}

// ── countries（単一型・索引あり・地物側に型なし）────────────────────────────
{
	const { q, stats } = await load("countries.fgb");
	ok(q.length === 179 && stats.types.MultiPolygon === 179 && stats.droppedGeometries === 0, `countries: 179 地物すべて MultiPolygon（${q.length}）`);
	const f = q.getFeature(0);
	ok(f.properties.id === "ATA" && f.properties.name === "Antarctica", `countries[0] 属性（${JSON.stringify(f.properties)}）`);
	ok(f.geometry.type === "MultiPolygon" && near(f.geometry.coordinates[0][0][0][0], -59.572095) && near(f.geometry.coordinates[0][0][0][1], -80.040179), "countries[0] 最初の頂点");
	const names = q.properties.map(p => p.name);
	ok(names.includes("Japan") && names.includes("United States of America"), "countries: Japan・USA を含む");
	const nocrs = await load("countries_nocrs.fgb");
	ok(nocrs.q.length === 179 && nocrs.stats.crs.startsWith("none"), `countries_nocrs: CRS 無し＝経緯度とみなして 179（${nocrs.stats.crs}）`);
}

// ── 全列型 ─────────────────────────────────────────────────────────────────
{
	const { q } = await load("alldatatypes.fgb");
	const p = q.getFeature(0).properties;
	ok(p.byte === -1 && p.ubyte === 255 && p.bool === true && p.short === -1 && p.ushort === 65535, `整数（8/16 bit）と真偽（${JSON.stringify(p)}）`);
	ok(p.int === -1 && p.uint === 4294967295 && p.long === -1 && p.ulong === "18446744073709551615", "整数（32/64 bit・ULong 最大値は文字列で精度保持）");
	ok(p.float === 0 && p.double === 0 && p.string === "X" && p.json === "X" && p.datetime === "2020-02-29T12:34:56Z", "実数・文字列・JSON（解釈できない＝文字列のまま）・日時");
}

// ── 型の混在・parts・件数不明・空・幾何なし ─────────────────────────────────
{
	const { q, stats } = await load("heterogeneous.fgb");
	ok(q.length === 3 && stats.types.Point === 1 && stats.types.LineString === 1 && stats.types.MultiPolygon === 1, `heterogeneous: 地物ごとの型（${JSON.stringify(stats.types)}）`);
	ok(near(q.getFeature(0).geometry.coordinates[0], 1.2) && near(q.getFeature(0).geometry.coordinates[1], -2.1), "heterogeneous[0] Point 座標");
	const mp = await load("mp_overlapping.fgb");
	ok(mp.q.length === 2 && mp.q.getFeature(0).geometry.type === "MultiPolygon" && mp.q.getFeature(0).geometry.coordinates.length >= 2, "mp_overlapping: MultiPolygon の parts（型を省いた Polygon）");
	const uk = await load("unknown_feature_count.fgb");
	ok(uk.q.length === 1 && uk.stats.types.Polygon === 1, "unknown_feature_count: features_count 0（不明・索引なし）でも最後まで読む");
	const np = await load("no_properties.fgb");
	ok(np.q.length === 1 && Object.keys(np.q.getFeature(0).properties).length === 0, "no_properties: 列なし");
	const em = await fromFlatGeobuf(fx("empty.fgb"));
	ok(em.stats.features === 0 && em.stats.rows === 0, "empty: 0 件で投げない");
	const ng = await fromFlatGeobuf(fx("countries_nogeo.fgb"));
	ok(ng.stats.features === 0 && ng.stats.droppedGeometries === 179, `countries_nogeo: 幾何なし 179 件は落として数える（${ng.stats.droppedGeometries}）`);
}

// ── CRS・版 ──────────────────────────────────────────────────────────────────
{
	let err = "";
	try { await fromFlatGeobuf(fx("poly00.fgb")); } catch (e) { err = e.message; }
	ok(/EPSG:27700/.test(err) && /ignoreCrs/.test(err), `poly00（EPSG:27700）＝経緯度でないので投げる（${err.slice(0, 60)}…）`);
	const raw = await fromFlatGeobuf(fx("poly00.fgb"), { ignoreCrs: true });
	ok(raw.stats.features === 10 && !raw.stats.reprojected, `poly00 ignoreCrs: 変換せず 10 件（${raw.stats.features}）`);
	let v2 = "";
	try { await fromFlatGeobuf(fx("topp_states.fgb")); } catch (e) { v2 = e.message; }
	ok(/major version 2/.test(v2), `topp_states（v2）＝明示エラー（${v2}）`);
	let bad = "";
	try { await fromFlatGeobuf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); } catch (e) { bad = e.message; }
	ok(/not a FlatGeobuf/.test(bad), "magic 違い＝明示エラー");
}

console.log(fails ? `\n✗ ${fails} failed` : "\n✓ t-fgb all passed");
process.exit(fails ? 1 : 0);
