#!/usr/bin/env node
// @ortho-earth/react の検定（Node）：① 純関数（diffProps・syncLayer・layerSpecOf・splitDataProps）を偽の map で ② renderToString＝<Globe> は div を 1 つ描き、map ができる前は子を描かない（SSR で createGlobe を呼ばない）
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Globe, Source, Layer, Data, Marker, diffProps, syncLayer, layerSpecOf, splitDataProps, shallowEqual } from "../src/index.ts";
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };
const fakeMap = () => { const calls = []; const rec = k => (...a) => { calls.push([k, ...a]); }; return { calls, setPaintProperty: rec("paint"), setLayoutProperty: rec("layout"), setFilter: rec("filter"), setLayerZoomRange: rec("zoom") }; };

t("shallowEqual", () => { assert.equal(shallowEqual({ a: 1 }, { a: 1 }), true); assert.equal(shallowEqual({ a: 1 }, { a: 2 }), false); assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 1 }), false); const f = () => 0; assert.equal(shallowEqual({ f }, { f }), true); });
t("diffProps", () => {
	assert.deepEqual(diffProps({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), { b: 3, c: 4 });
	assert.deepEqual(diffProps({ a: 1 }, {}), { a: undefined });
	assert.deepEqual(diffProps({ e: ["get", "x"] }, { e: ["get", "x"] }), {});   // 同じ式（別の配列）は差分でない
	assert.deepEqual(diffProps(undefined, { a: 1 }), { a: 1 });
});
t("syncLayer.paintLayout", () => {
	const m = fakeMap();
	const r = syncLayer(m, "L", { type: "circle", paint: { "circle-color": "#f00", "circle-radius": 4 }, layout: { visibility: "visible" } }, { type: "circle", paint: { "circle-color": "#0f0", "circle-radius": 4 }, layout: { visibility: "none" } });
	assert.deepEqual(r, ["paint.circle-color", "layout.visibility"]);
	assert.deepEqual(m.calls, [["paint", "L", "circle-color", "#0f0"], ["layout", "L", "visibility", "none"]]);
});
t("syncLayer.filterZoom", () => {
	const m = fakeMap();
	const r = syncLayer(m, "L", { type: "fill", filter: ["==", "a", 1] }, { type: "fill", filter: ["==", "a", 2], minzoom: 5 });
	assert.deepEqual(r, ["filter", "zoom"]); assert.deepEqual(m.calls, [["filter", "L", ["==", "a", 2]], ["zoom", "L", 5, 24]]);
	const m2 = fakeMap(); assert.deepEqual(syncLayer(m2, "L", { type: "fill", filter: ["==", "a", 1] }, { type: "fill" }), ["filter"]); assert.deepEqual(m2.calls, [["filter", "L", null]]);
});
t("syncLayer.recreate", () => { const m = fakeMap(); assert.equal(syncLayer(m, "L", { type: "fill", source: "a" }, { type: "line", source: "a" }), "recreate"); assert.equal(syncLayer(m, "L", { type: "fill", source: "a" }, { type: "fill", source: "b" }), "recreate"); assert.equal(m.calls.length, 0); });
t("syncLayer.noop", () => { const m = fakeMap(); assert.deepEqual(syncLayer(m, "L", { type: "fill", paint: { "fill-color": "#000" } }, { type: "fill", paint: { "fill-color": "#000" } }), []); });
t("layerSpecOf", () => {
	assert.deepEqual(layerSpecOf({ id: "L", type: "fill", beforeId: "x", children: null, paint: { a: 1 } }, "ctx"), { id: "L", source: "ctx", type: "fill", paint: { a: 1 } });
	assert.equal(layerSpecOf({ id: "L", type: "fill", source: "own" }, "ctx").source, "own");
});
t("splitDataProps", () => { const gp = d => d.p; assert.deepEqual(splitDataProps({ id: "d", kind: "points", data: [1], getPosition: gp, getRadius: 3, children: null }), { id: "d", kind: "points", data: [1], acc: { getPosition: gp, getRadius: 3 } }); });
t("ssr.Globe", () => {
	let called = 0;
	const html = renderToString(h(Globe, { className: "g", style: { height: 300 }, create: () => { called++; return {}; } }, h(Source, { id: "s", type: "geojson", data: null }, h(Layer, { id: "l", type: "circle" })), h(Data, { kind: "points", data: [] }), h(Marker, { lngLat: [0, 0] }, "x")));
	assert.equal(called, 0, "SSR では createGlobe を呼ばない");
	assert.match(html, /^<div class="g" style="width:100%;height:300px;position:relative"><\/div>$/);
});
console.log(`react: ${n} 件 PASS`);
