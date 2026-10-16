#!/usr/bin/env node
// t-encode-edge: 符号化の境界値（改良点 17・2026-10-12）。pbf-base の set() → arrayBuffer → set(ArrayBuffer) の往復で、
//   精度 1〜9・値の全型（STRING/FLOAT/INTEGER/BOOL/JSON/DATE/COLOR/BBOX/FUNC/BLOB/IMAGE/NULL）の端・noprop・updateHeader・
//   鍵の多さと文字・幾何の端（穴・GeometryCollection・幾何なし）を数字で固定する。外部データ不要・決定的。
import { GeoPBF } from "../src/pbf-base.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (props, xy = [139.767125, 35.681236]) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: xy } });
const roundtrip = async (gj, opts = {}, readOpts = opts) => {
	const w = await new GeoPBF({ name: "edge", ...opts }).set(gj);
	const r = await new GeoPBF(readOpts).set(w.arrayBuffer.slice(0));
	return { w, r, gj: r.geojson, p: (i) => r.geojson.features[i].properties };
};

// ---- 精度 1〜9 -----------------------------------------------------------------------------------
for (const prec of [1, 3, 6, 7, 9]) {
	const { r, gj } = await roundtrip(fc([pt({}, [139.123456789, -35.987654321]), pt({}, [-179.999999999, 89.999999999])]), { precision: prec });
	const c = gj.features[0].geometry.coordinates, c2 = gj.features[1].geometry.coordinates, e = Math.pow(10, -prec) / 2 + 1e-12;
	ok(r.precision() === prec && Math.abs(c[0] - 139.123456789) <= e && Math.abs(c[1] + 35.987654321) <= e && Math.abs(c2[0] + 179.999999999) <= e && Math.abs(c2[1] - 89.999999999) <= e,
		`precision ${prec}: 座標の誤差 ≤ 0.5×10^-${prec}（${c.join(", ")}）`);
}
{
	const { gj } = await roundtrip(fc([pt({}, [139.1234567891234, 35.1234567891234])]), { precision: 9 });
	ok(gj.features[0].geometry.coordinates[0] === 139.123456789 && gj.features[0].geometry.coordinates[1] === 35.123456789, "precision 9: 10 桁目以降は落ちる（round）");
	const { r } = await roundtrip(fc([pt({})]), {});
	ok(r.precision() === 6, "既定の precision は 6");
}

// ---- 値の型の端 ---------------------------------------------------------------------------------
{
	const long = "あ".repeat(100000);
	const props = {
		s0: "", s1: "東京🗼", s2: long, s3: "rgb(1,2,3) ", s4: "0x1F",
		f1: 1.5, f2: -0.25, f3: 1e300, f4: Number.MIN_VALUE, f5: 123456789.123456789,
		i0: 0, i1: -1, i2: 2 ** 31, i3: 2 ** 53 - 1, i4: -(2 ** 53 - 1), i5: -(2 ** 31),
		b1: true, b0: false,
		j1: { a: [1, "x", null, { b: true }] }, j2: {}, j3: [], j4: [1, 2, 3], j5: [1, 2, 3, 4, 5], j6: ["a", "b", "c", "d"],
		d1: new Date(0), d2: new Date(-86400000 * 365), d3: new Date("2100-12-31T23:59:59.000Z"), d4: new Date(1500),
		c1: "rgb(255,0,128)", c2: "rgba(1,2,3,0.50)", c3: "rgb(256,0,0)",
		bb: [120.5, 20.25, 150.75, 46.5],
		n0: null,
		fn: (x) => x * 2,
	};
	const { p } = await roundtrip(fc([pt(props)]));
	const q = p(0);
	ok(q.s0 === "" && q.s1 === "東京🗼" && q.s2 === long && q.s3 === "rgb(1,2,3) " && q.s4 === "0x1F", "STRING: 空・絵文字・100,000 字・色に似た文字列はそのまま");
	ok(q.f1 === 1.5 && q.f2 === -0.25 && q.f3 === 1e300 && q.f4 === Number.MIN_VALUE && q.f5 === 123456789.123456789, "FLOAT: 1e300・MIN_VALUE・17 桁が bit 同一");
	ok(q.i0 === 0 && q.i1 === -1 && q.i2 === 2 ** 31 && q.i3 === 2 ** 53 - 1 && q.i4 === -(2 ** 53 - 1) && q.i5 === -(2 ** 31), "INTEGER: 0・負・2^31・±(2^53−1)");
	ok(q.b1 === true && q.b0 === false, "BOOL");
	ok(JSON.stringify(q.j1) === JSON.stringify(props.j1) && JSON.stringify(q.j2) === "{}" && JSON.stringify(q.j3) === "[]" && JSON.stringify(q.j4) === "[1,2,3]" && JSON.stringify(q.j5) === "[1,2,3,4,5]" && JSON.stringify(q.j6) === '["a","b","c","d"]', "JSON: 入れ子・空・3/5 要素の配列・文字の 4 要素");
	ok(q.bb instanceof Float64Array && Array.from(q.bb).join() === "120.5,20.25,150.75,46.5", "BBOX: 数の 4 要素配列は Float64Array で戻る（仕様どおり＝JSON ではない）");
	ok(q.d1 instanceof Date && q.d1.getTime() === 0 && q.d2.getTime() === -86400000 * 365 && q.d3.getTime() === Date.parse("2100-12-31T23:59:59.000Z") && q.d4.getTime() === 2000, "DATE: epoch・負（1969）・2100 年・ミリ秒は秒へ丸め（1500→2000）");
	ok(q.c1 === "rgb(255,0,128)" && q.c2 === "rgba(1,2,3,0.50)" && q.c3 === "rgb(256,0,0)", "COLOR: 正規形は COLOR 型で往復・範囲外は STRING のまま");
	ok(!("n0" in q), "null の値は書かれない（NULL 型は writer が出さない＝読むと鍵ごと無い。鍵辞書には残る）");
	ok(typeof q.fn === "string" && /x \* 2/.test(q.fn), "FUNC: 既定（noeval）は関数のソース文字列");
	const { p: p2 } = await roundtrip(fc([pt({ u: undefined, v: 1 })]));
	ok(!("u" in p2(0)) && p2(0).v === 1, "undefined の値は鍵ごと落ちる");
}
// ---- BLOB / IMAGE（BUFS プール）----------------------------------------------------------------------
{
	const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
	const ImageDataStub = class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
	const hadImageData = typeof globalThis.ImageData !== "undefined";
	if (!hadImageData) globalThis.ImageData = ImageDataStub;
	const img = new globalThis.ImageData(new Uint8ClampedArray([9, 8, 7, 255, 1, 2, 3, 4]), 2, 1);
	const { p, w } = await roundtrip(fc([pt({ b: new Blob([bytes], { type: "application/octet-stream" }), f: new File([bytes], "a.bin", { type: "x/y" }), im: img, nest: { b2: new Blob([bytes]) } }), pt({ b: new Blob([bytes]) })]));
	const q = p(0);
	ok(q.b instanceof Blob && q.b.size === 6 && q.b.type === "application/octet-stream" && new Uint8Array(await q.b.arrayBuffer()).join() === bytes.join(), "BLOB: 中身と type が往復");
	ok(q.f instanceof File && q.f.name === "a.bin" && q.f.type === "x/y" && q.f.size === 6, "BLOB（File）: 名前と type");
	ok(q.im && q.im.width === 2 && q.im.height === 1 && Array.from(q.im.data).join() === "9,8,7,255,1,2,3,4", "IMAGE: 幅・高さ・画素");
	ok(q["nest.b2"] instanceof Blob || q.nest?.b2 instanceof Blob, "入れ子の BLOB も残る");
	ok(p(1).b instanceof Blob && p(1).b.size === 6, "2 地物目の BLOB");
	ok(w.bufs.length === 2, `同じ中身の BLOB 4 本は BUFS プールで 1 本に・画像で 1 本＝計 ${w.bufs.length}`);
	const { w: w2 } = await roundtrip(fc([pt({ a: new Blob([bytes]), b: new Blob([new Uint8Array([7])]) })]));
	ok(w2.bufs.length === 2, "中身が違えば 2 本");
	if (!hadImageData) delete globalThis.ImageData;
}
// ---- noprop ----------------------------------------------------------------------------------------
{
	const { w, r, gj } = await roundtrip(fc([pt({ a: 1, b: "x" }), pt({ a: 2 })]), { noprop: true }, {});
	ok(w.length === 2 && gj.features.length === 2 && Object.keys(gj.features[0].properties).length === 0 && gj.features[0].geometry.coordinates[0] === 139.767125, "noprop: 属性なし・幾何は残る");
	ok(w.keys.length === 0 && r.keys.length === 0, "noprop: 鍵辞書が空");
}
// ---- updateHeader -----------------------------------------------------------------------------------
{
	const w = await new GeoPBF({ name: "n" }).set(fc([pt({ a: 1 }), pt({ a: 2 }, [1, 2])]));
	const before = w.arrayBuffer.byteLength;
	w.name("renamed").description("D".repeat(10000)).license("CC BY 4.0").attribution("© test").minZoom(3).maxZoom(12);
	const r = await new GeoPBF().set(w.arrayBuffer.slice(0));
	ok(r.name() === "renamed" && r.description().length === 10000 && r.license() === "CC BY 4.0" && r.attribution() === "© test" && r.minZoom() === 3 && r.maxZoom() === 12, "updateHeader: 6 項目が書き換わる（10,000 字の description も）");
	ok(r.length === 2 && r.geojson.features[1].geometry.coordinates.join() === "1,2" && r.getProperties(1).a === 2 && r.arrayBuffer.byteLength > before + 10000, "updateHeader: 本体は無傷・大きさが増える");
	w.description("");
	const r2 = await new GeoPBF().set(w.arrayBuffer.slice(0));
	ok(!r2.description() && r2.name() === "renamed" && r2.length === 2, "updateHeader: 空に戻すと縮む・他は保つ");
}
// ---- 鍵の多さと文字・型の混在 -----------------------------------------------------------------------------
{
	const many = {}; for (let i = 0; i < 300; i++) many[`k${i}`] = i;
	const odd = { "a.b": 1, "c:d": "x", "e f": true, "日本語": "値", "": "empty-key", "x": { "y.z": 2 } };
	const { p, r } = await roundtrip(fc([pt(many), pt(odd), pt({ k0: "string now" }), pt({ k0: null })]));
	ok(Object.keys(p(0)).length === 300 && p(0).k299 === 299 && r.keys.length >= 300, "300 の鍵");
	const q = p(1);
	ok(q.a?.b === 1 && q["c:d"] === "x" && q["e f"] === true && q["日本語"] === "値" && q[""] === "empty-key", "鍵の文字: ':' 空白・日本語・空の鍵はそのまま。'.' を含む鍵は入れ子に戻る（a.b → {a:{b}}＝平坦化の規約）");
	ok(q.x?.["y.z"] === 2 && r.keys.includes("x.y.z"), `入れ子の中の '.' 付き鍵は x.y.z と平坦化され x:{"y.z"} に戻る（${JSON.stringify(q.x)}）`);
	ok(p(2).k0 === "string now" && !("k0" in p(3)), "同じ鍵に数・文字が混在してよい・null は無いのと同じ");
}
// ---- 幾何の端 -------------------------------------------------------------------------------------------
{
	const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
	const feats = [
		{ type: "Feature", properties: { n: "hole" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 10, 10), sq(2, 2, 4, 4), sq(6, 6, 8, 8)] } },
		{ type: "Feature", properties: { n: "gc" }, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 1] }, { type: "LineString", coordinates: [[0, 0], [1, 1]] }, { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] }] } },
		{ type: "Feature", properties: { n: "none" }, geometry: null },
		{ type: "Feature", properties: { n: "mp" }, geometry: { type: "MultiPoint", coordinates: [[0, 0], [180, 90], [-180, -90]] } },
		{ type: "Feature", properties: { n: "ml" }, geometry: { type: "MultiLineString", coordinates: [[[0, 0], [0.000001, 0.000001]], [[1, 1], [2, 2], [3, 3]]] } },
	];
	const { w, gj } = await roundtrip(fc(feats));
	ok(w.dropped === 1 && gj.features.length === 4, "幾何なしは 1 件落として数える");
	const g0 = gj.features[0].geometry;
	ok(g0.type === "Polygon" && g0.coordinates.length === 3 && g0.coordinates[1].length === 5 && g0.coordinates[1][0].join() === "2,2", "穴 2 つの面");
	const g1 = gj.features[1].geometry;
	ok(g1.type === "GeometryCollection" && g1.geometries.map(g => g.type).join() === "Point,LineString,Polygon", "GeometryCollection の 3 種");
	ok(gj.features[2].geometry.coordinates[1].join() === "180,90" && gj.features[2].geometry.coordinates[2].join() === "-180,-90", "±180/±90 の端の点");
	ok(gj.features[3].geometry.coordinates[0][1].join() === "0.000001,0.000001", "precision 6 の最小の差（1e-6）が残る");
}
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
