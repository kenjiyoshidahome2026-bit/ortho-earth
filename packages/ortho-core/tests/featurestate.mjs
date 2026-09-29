// feature-state を組み立てへ届ける口（#109・A1）：buildTileDrawList と buildLabels の省略できる stateOf(f)。
// paint の ["feature-state", k] だけが読む（filter は読まない＝MapLibre と同じ）・渡さなければ今と同じ出力（基図＝黄金の写しは不変）。
import assert from "node:assert/strict";
import { buildTileDrawList } from "../src/build.js";
import { buildLabels } from "../src/labels.js";

const sq = (x0, y0, x1, y1) => ({ coords: new Int32Array([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]), ends: [10] });
const hl = (on, off) => ["case", ["boolean", ["feature-state", "hl"], false], on, off];
const polys = { extent: 4096, features: [{ type: "Polygon", id: 1, props: { n: "a" }, geom: sq(100, 100, 300, 300) }, { type: "Polygon", id: 2, props: { n: "b" }, geom: sq(500, 100, 700, 300) }] };
const lines = { extent: 4096, features: [{ type: "LineString", id: 1, props: {}, geom: { coords: new Int32Array([0, 1000, 800, 1000]), ends: [4] } }, { type: "LineString", id: 2, props: {}, geom: { coords: new Int32Array([0, 2000, 800, 2000]), ends: [4] } }] };
const state = new Map([[1, { hl: true, hide: true }]]), stateOf = f => state.get(f.id);
const style = { layers: [
	{ id: "f", type: "fill", "source-layer": "p", paint: { "fill-color": hl("#00ff00", "#0000ff"), "fill-opacity": hl(0.5, 1) } },
	{ id: "l", type: "line", "source-layer": "l", paint: { "line-color": hl("#ff0000", "#000000"), "line-width": hl(6, 2) } },
	{ id: "hide", type: "fill", "source-layer": "p", filter: ["!", ["boolean", ["feature-state", "hide"], false]], paint: { "fill-color": "#ffffff" } },   // filter は状態を読まない＝両方描く
] };
const tile = extra => buildTileDrawList({ layers: { p: polys, l: lines }, z: 14, x: 14562, y: 6759, ...extra }, style, [0, 0]);

// 塗り：頂点色は地物ごと（1 つ目＝緑・半透明／2 つ目＝青）
const A = tile({ stateOf }), fill = A.ops.find(o => o.id === "f");
assert.deepEqual([...fill.col.subarray(0, 4)], [0, 255, 0, 128], "状態のある地物＝case の真の枝（色と不透明度）");
assert.deepEqual([...fill.col.subarray(fill.col.length - 4)], [0, 0, 255, 255], "状態の無い地物（最後の頂点＝2 つ目の地物）＝既定");
// 線：色と幅
const line = A.ops.find(o => o.id === "l"), segs = line.half.length / 2;
assert.deepEqual([...line.col.subarray(0, 4)], [255, 0, 0, 255]); assert.equal(line.half[0], 3);
assert.deepEqual([...line.col.subarray(segs * 4, segs * 4 + 4)], [0, 0, 0, 255]); assert.equal(line.half[segs], 1);
// filter は状態を読まない
assert.equal(A.ops.find(o => o.id === "hide").idx.length, 12, "filter の feature-state は undefined＝2 つとも描く");

// 渡さない＝今と同じ（バイトまで）・状態の無い stateOf も同じ
const same = (a, b) => assert.deepEqual(a.ops.map(o => [o.id, [...(o.col || [])], [...(o.half || [])]]), b.ops.map(o => [o.id, [...(o.col || [])], [...(o.half || [])]]));
same(tile({}), tile({ stateOf: () => undefined }));
assert.deepEqual([...tile({}).ops.find(o => o.id === "f").col.subarray(0, 4)], [0, 0, 255, 255], "stateOf 無し＝既定の枝");

// 注記：text-color・halo・text-opacity が状態で変わる・filter は読まない・渡さなければ既定
const pts = { extent: 4096, features: [{ type: "Point", id: 1, props: { name: "A" }, geom: { coords: [100, 200] } }, { type: "Point", id: 2, props: { name: "B" }, geom: { coords: [900, 200] } }] };
const lstyle = { layers: [{ id: "s", type: "symbol", "source-layer": "poi", filter: ["!", ["boolean", ["feature-state", "hide"], false]], layout: { "text-field": ["get", "name"] },
	paint: { "text-color": hl("#ff0000", "#000000"), "text-halo-color": hl("#00ff00", "#ffffff"), "text-halo-width": hl(2, 0), "text-opacity": hl(0.5, 1) } }] };
const L1 = Object.fromEntries(buildLabels({ layers: { poi: pts }, z: 14, x: 0, y: 0, stateOf }, lstyle).labels.map(L => [L.text, L]));
assert.deepEqual(Object.keys(L1).sort(), ["A", "B"], "filter は状態を読まない");
assert.deepEqual(L1.A.color, [1, 0, 0, 1]); assert.deepEqual(L1.A.halo, [0, 1, 0, 1]); assert.equal(L1.A.haloW, 2); assert.equal(L1.A.op, 0.5);
assert.deepEqual(L1.B.color, [0, 0, 0, 1]); assert.equal(L1.B.haloW, 0); assert.equal(L1.B.op, 1);
const L0 = Object.fromEntries(buildLabels({ layers: { poi: pts }, z: 14, x: 0, y: 0 }, lstyle).labels.map(L => [L.text, L]));
assert.deepEqual(L0.A.color, [0, 0, 0, 1], "stateOf 無し＝既定");

console.log("featurestate: ok");
