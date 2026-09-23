// 外来の MapLibre style の読み替え（src/mlstyle.js・#33）と評価器の追加分（色の補間・常用の演算子・色名/HSL）の検定。
// node packages/ortho-core/tests/mlstyle.mjs
import assert from "node:assert/strict";
import { convertFilter, convertValue, splitMapLibreStyle, shiftLayerZoom, tileUrlOf, isExpressionFilter } from "../src/mlstyle.js";
import { evalExpr, truthy } from "../src/expr.js";
import { parseRGBA } from "../src/color.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };
const ctx = (props = {}, geom = "Polygon", zoom = 10) => ({ zoom, props, geom, vars: {} });

t("旧式フィルタ（$type・in・!has・大小）", () => {
	const f = convertFilter(["all", ["==", "$type", "Polygon"], ["in", "class", "park", "forest"], ["!has", "name"], [">=", "rank", 2]]);
	assert.equal(truthy(evalExpr(f, ctx({ class: "park", rank: 3 }))), true);
	assert.equal(truthy(evalExpr(f, ctx({ class: "x", rank: 3 }))), false);
	assert.equal(truthy(evalExpr(f, ctx({ class: "park", name: "a", rank: 3 }))), false);
	assert.equal(truthy(evalExpr(f, ctx({ class: "park" }))), false);   // 大小比較は属性なしを落とす
	assert.equal(truthy(evalExpr(f, ctx({ class: "park", rank: 3 }, "LineString"))), false);
});
t("現代の式はそのまま", () => {
	const e = ["==", ["get", "class"], "x"];
	assert.equal(isExpressionFilter(e), true);
	assert.equal(convertFilter(e), e);
	assert.equal(isExpressionFilter(["==", "class", "x"]), false);
	assert.equal(isExpressionFilter(["in", "class", "a", "b"]), false);
});
t("旧式の関数（exponential・interval・categorical・identity）", () => {
	assert.ok(Math.abs(evalExpr(convertValue({ base: 1.4, stops: [[10, 1], [20, 10]] }, "line-width"), ctx({}, "", 15)) - 2.411) < 0.01);
	assert.equal(evalExpr(convertValue({ stops: [[4, "left"], [8, "center"]] }, "text-anchor"), ctx({}, "", 6)), "left");
	const cat = convertValue({ property: "class", type: "categorical", stops: [["a", "red"], ["b", "blue"]], default: "gray" }, "fill-color");
	assert.equal(evalExpr(cat, ctx({ class: "b" })), "blue");
	assert.equal(evalExpr(cat, ctx({ class: "z" })), "gray");
	assert.equal(evalExpr(convertValue({ type: "identity", property: "h" }, "fill-extrusion-height"), ctx({ h: 7 })), 7);
});
t("差し込み記法（段の値の中も）", () => {
	assert.equal(evalExpr(convertValue("{name:latin} ({ref})", "text-field"), ctx({ "name:latin": "Tokyo", ref: 1 }, "Point")), "Tokyo (1)");
	const v = convertValue({ stops: [[2, "{ABBREV}"], [4, "{NAME}"]] }, "text-field");
	assert.equal(evalExpr(v, ctx({ ABBREV: "Jpn", NAME: "Japan" }, "Point", 3)), "Jpn");
	assert.equal(evalExpr(v, ctx({ ABBREV: "Jpn", NAME: "Japan" }, "Point", 5)), "Japan");
});
t("色の補間・色名・HSL", () => {
	assert.deepEqual(parseRGBA(evalExpr(["interpolate", ["linear"], ["zoom"], 5, "#000000", 15, "#ffffff"], ctx({}, "", 10))).map(v => +v.toFixed(2)), [0.5, 0.5, 0.5, 1]);
	assert.deepEqual(parseRGBA("steelblue").map(v => +v.toFixed(3)), [0.275, 0.51, 0.706, 1]);
	assert.deepEqual(parseRGBA("hsl(120, 100%, 50%)").map(v => +v.toFixed(6)), [0, 1, 0, 1]);
	assert.equal(evalExpr(["downcase", ["get", "n"]], ctx({ n: "ABC" })), "abc");
	assert.equal(evalExpr(["format", ["get", "n"], { "font-scale": 1.2 }], ctx({ n: "x" })), "x");
});
t("ズームの読み替え（MapLibre の z → この地図の z）", () => {
	const L = shiftLayerZoom({ id: "a", type: "line", minzoom: 5, maxzoom: 12, paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 20, 11] } }, 1);
	assert.equal(L.minzoom, 6); assert.equal(L.maxzoom, 13);
	assert.equal(evalExpr(L.paint["line-width"], ctx({}, "", 11)), 1);   // この地図の z11＝MapLibre の z10
});
t("振り分け（基図・画像・利用者・描かない）", () => {
	const r = splitMapLibreStyle({ version: 8, sources: { v: { type: "vector", tiles: ["x/{z}/{x}/{y}"] }, r: { type: "raster", tiles: ["r/{z}/{x}/{y}.png"] }, g: { type: "geojson", data: {} } },
		layers: [{ id: "bg", type: "background" }, { id: "rel", type: "raster", source: "r" }, { id: "w", type: "fill", source: "v", "source-layer": "water" },
			{ id: "rd", type: "symbol", source: "v", "source-layer": "road", layout: { "symbol-placement": "line", "text-field": "{name}" } },
			{ id: "b3", type: "fill-extrusion", source: "v", "source-layer": "building" }, { id: "gj", type: "circle", source: "g" }] });
	assert.equal(r.vectorSource, "v");
	assert.deepEqual(r.base.map(L => L.id), ["bg", "w"]);
	assert.deepEqual(r.raster.map(L => L.id), ["rel"]);
	assert.deepEqual(r.geojson.map(L => L.id), ["gj"]);
	assert.deepEqual(r.skipped.map(k => k.id), ["rd", "b3"]);
});
t("タイルの URL 型紙（tms・{s}）", () => {
	assert.equal(tileUrlOf({ tiles: ["https://a/{z}/{x}/{y}.pbf"] })(3, 1, 2), "https://a/3/1/2.pbf");
	assert.equal(tileUrlOf({ tiles: ["https://a/{z}/{x}/{y}.pbf"], scheme: "tms" })(3, 1, 2), "https://a/3/1/5.pbf");
	assert.match(tileUrlOf({ tiles: ["https://{s}.a/{z}/{x}/{y}"] })(1, 0, 0), /^https:\/\/[abc]\.a\/1\/0\/0$/);
});
console.log(`\n${n} passed`);
