// MapLibre 形の fill/line/circle → gint の表（src/mltables.js・MapLibre 互換の台帳 段 4）の検定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { packMLLayers, buildMLTable, zoomSensitivity } from "../src/mltables.js";

const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });
const PG = (p = {}) => F("Polygon", [[[0, 0], [1, 0], [1, 1], [0, 0]]], p), LN = (p = {}) => F("LineString", [[0, 0], [1, 1]], p), PT = (p = {}) => F("Point", [0, 0], p);
const L = (id, type, extra = {}) => ({ id, type, source: "s", paint: {}, ...extra });
const rec = (t, fid) => { const j = fid * 4, b = t.u32[j + 2]; return { fill: t.u32[j], line: t.u32[j + 1], w8: b >>> 24, r8: (b >>> 8) & 255, vis: b & 1 }; };
const types = ps => ps.map(p => p.layers.map(l => l.type + (p.outline && l.type === "fill" ? "+o" : "")).join(",")).join(" | ");

test("詰め方（連続する層・型の順を崩さない）", () => {
	assert.equal(types(packMLLayers([L("a", "fill"), L("b", "line")])), "fill,line");
	assert.equal(types(packMLLayers([L("a", "fill"), L("b", "fill")])), "fill | fill");            // ハイライト層
	assert.equal(types(packMLLayers([L("a", "line"), L("b", "line")])), "line | line");            // 縁取り
	assert.equal(types(packMLLayers([L("a", "line"), L("b", "fill")])), "line | fill");            // 線の上に塗り
	assert.equal(types(packMLLayers([L("a", "fill", { paint: { "fill-outline-color": "#f00" } }), L("b", "line")])), "fill+o | line");
	assert.equal(types(packMLLayers([L("a", "fill"), L("b", "line"), L("c", "circle")])), "fill,line,circle");
	assert.equal(types(packMLLayers([L("a", "circle"), L("b", "fill")])), "circle | fill");
	assert.equal(packMLLayers([L("x", "symbol"), L("a", "fill")]).length, 1);                      // gint でない層は数えない
});
test("fill の層＝面だけ・輪郭なし・既定の黒", () => {
	const [p] = packMLLayers([L("f", "fill")]), t = buildMLTable(p, [PG(), LN(), PT()], { zoom: 10 });
	assert.deepEqual(rec(t, 0), { fill: 0x000000ff, line: 0, w8: 0, r8: 0, vis: 1 });
	assert.equal(rec(t, 1).vis, 0); assert.equal(rec(t, 2).vis, 0);   // 線・点は描かない＝隠す
	assert.deepEqual([...t.drawn.f], [1, 0, 0]);
});
test("line の層＝線と面の輪郭（既定 1px 黒）・塗らない", () => {
	const [p] = packMLLayers([L("l", "line")]), t = buildMLTable(p, [PG(), LN(), PT()], { zoom: 10 });
	assert.deepEqual(rec(t, 0), { fill: 0, line: 0x000000ff, w8: 8, r8: 0, vis: 1 });
	assert.equal(rec(t, 1).w8, 8); assert.equal(rec(t, 2).vis, 0);
});
test("circle の既定（黒・半径 5）と不透明度 0＝描かない（色 α0 は既定色なので半径 0 で消す）", () => {
	const [p] = packMLLayers([L("c", "circle")]); assert.deepEqual(rec(buildMLTable(p, [PT()], { zoom: 10 }), 0), { fill: 0, line: 0x000000ff, w8: 0, r8: 20, vis: 1 });
	const [q] = packMLLayers([L("c", "circle", { paint: { "circle-color": "#f00", "circle-opacity": 0 } })]);
	assert.deepEqual(rec(buildMLTable(q, [PT()], { zoom: 10 }), 0), { fill: 0, line: 0, w8: 0, r8: 0, vis: 0 });
	const [r] = packMLLayers([L("l", "line", { paint: { "line-color": "transparent" } })]);
	assert.equal(rec(buildMLTable(r, [LN()], { zoom: 10 }), 0).w8, 0);   // "transparent" の線＝幅 0
});
test("ハイライト層＝2 枚目の pass は filter に当たる地物だけ", () => {
	const ps = packMLLayers([L("base", "fill", { paint: { "fill-color": "#0000ff" } }), L("hl", "fill", { filter: ["==", ["get", "n"], "B"], paint: { "fill-color": "#ff0000" } })]);
	const feats = [PG({ n: "A" }), PG({ n: "B" })], t0 = buildMLTable(ps[0], feats, { zoom: 10 }), t1 = buildMLTable(ps[1], feats, { zoom: 10 });
	assert.equal(rec(t0, 0).fill, 0x0000ffff); assert.equal(rec(t0, 1).fill, 0x0000ffff);
	assert.equal(rec(t1, 0).vis, 0); assert.equal(rec(t1, 1).fill, 0xff0000ff);
});
test("縁取り＝2 本の線の幅", () => {
	const ps = packMLLayers([L("case", "line", { paint: { "line-width": 12 } }), L("in", "line", { paint: { "line-width": 4, "line-color": "#ff0" } })]);
	assert.equal(rec(buildMLTable(ps[0], [LN()], { zoom: 10 }), 0).w8, 96); assert.equal(rec(buildMLTable(ps[1], [LN()], { zoom: 10 }), 0).w8, 32);
});
test("filter は MapLibre の意味（真偽でない条件＝偽）", () => {
	const [p] = packMLLayers([L("f", "fill", { filter: ["case", ["get", "flag"], true, false] })]), t = buildMLTable(p, [PG({ flag: true }), PG({ flag: "yes" })], { zoom: 10 });
	assert.equal(rec(t, 0).vis, 1); assert.equal(rec(t, 1).vis, 0);
});
test("zoom 域（minzoom 包含・maxzoom 排他）と zoomSensitivity", () => {
	const ps = packMLLayers([L("f", "fill", { minzoom: 10, maxzoom: 12 })]);
	assert.equal(rec(buildMLTable(ps[0], [PG()], { zoom: 9.9 }), 0).vis, 0);
	assert.equal(rec(buildMLTable(ps[0], [PG()], { zoom: 10 }), 0).vis, 1);
	assert.equal(rec(buildMLTable(ps[0], [PG()], { zoom: 12 }), 0).vis, 0);
	assert.deepEqual(zoomSensitivity(ps[0]), { bounds: [10, 12], expr: false });
	assert.equal(zoomSensitivity(packMLLayers([L("l", "line", { paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 4] } })])[0]).expr, true);
});
test("feature-state と既定値へ落ちる評価エラー", () => {
	const [p] = packMLLayers([L("f", "fill", { paint: { "fill-color": ["case", ["boolean", ["feature-state", "hover"], false], "#ff0000", "#0000ff"], "fill-opacity": ["get", "missing"] } })]);
	const t = buildMLTable(p, [PG(), PG()], { zoom: 10, states: new Map([[1, { hover: true }]]) });
	assert.equal(rec(t, 0).fill, 0x0000ffff); assert.equal(rec(t, 1).fill, 0xff0000ff);   // opacity は欠損＝null＝既定 1
});
test("線幅・半径の上限（表の u8）", () => {
	const [p] = packMLLayers([L("l", "line", { paint: { "line-width": 50 } })]); assert.equal(rec(buildMLTable(p, [LN()], { zoom: 10 }), 0).w8, 255);
});
test("隠した層（visibility none）は詰め方に残して表で効かせない", () => {
	const ps = packMLLayers([L("f", "fill", { layout: { visibility: "none" } }), L("l", "line")]);
	assert.equal(ps.length, 1);
	const t = buildMLTable(ps[0], [PG()], { zoom: 10 });
	assert.deepEqual(rec(t, 0), { fill: 0, line: 0x000000ff, w8: 8, r8: 0, vis: 1 });
	assert.deepEqual(t.active, ["l"]);
});
test("破線（第 4 語＝[線, 間] 1/8px×線幅）と円の縁（第 4 語＝縁の色・線幅の欄＝縁の幅）・中空の円（flags bit1）", () => {
	const [pl] = packMLLayers([L("l", "line", { paint: { "line-width": 4, "line-dasharray": [2, 1] } })]);
	const tl = buildMLTable(pl, [LN()], { zoom: 10 });
	assert.equal(tl.u32[3], ((64 << 16) | 32) >>> 0);   // 線 2×4px＝8px→64・間 1×4px＝4px→32
	const [pc] = packMLLayers([L("c", "circle", { paint: { "circle-color": "#ffff00", "circle-radius": 6, "circle-stroke-color": "#ff0000", "circle-stroke-width": 2 } })]);
	const tc = buildMLTable(pc, [PT()], { zoom: 10 }), b = tc.u32[2];
	assert.equal(tc.u32[3], 0xff0000ff); assert.equal(b >>> 24, 16); assert.equal((b >>> 8) & 255, 24); assert.equal(b & 3, 1);
	const [ph] = packMLLayers([L("h", "circle", { paint: { "circle-opacity": 0, "circle-stroke-color": "#0000ff", "circle-stroke-width": 3 } })]);
	const th = buildMLTable(ph, [PT()], { zoom: 10 });
	assert.equal(th.u32[1], 0); assert.equal(th.u32[2] & 3, 3); assert.equal(th.u32[3], 0x0000ffff);   // 中空＝塗り無し＋見える
	assert.deepEqual([...th.drawn.h], [1]);
});
