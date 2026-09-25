// Gint の式の契約の検定（gint draw spec.md §5・§6.1・§6.2＝説明書 docs/gint §2.3・§4 が約束する範囲）。node packages/ortho-core/tests/gint-expr.mjs
// 守るもの：①契約の演算子（globe.d.ts の一覧）がすべて fid 表まで届く ②評価規約（=== の比較・欠けた値・throw しない・入れ子の色の補間）
// ③fid 表の詰め方（width 1/8・radius 1/4・visible ビット・点は circle-color・opacity の掛け方・dash-id は 0）
import assert from "node:assert/strict";
import { buildFidStyle } from "../src/gl/gint/style.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const RED = "#ff0000", BLUE = "#0000ff";
const R = 0xff0000ff, B = 0x0000ffff;   // RGBA8（r<<24|g<<16|b<<8|a）
const poly = (properties = {}) => ({ properties, geometry: { type: "Polygon" } });
const point = (properties = {}) => ({ properties, geometry: { type: "Point" } });
// 1 地物の fid 表を読む
const rec = (paint, f = poly(), opts = {}) => {
	const { u32 } = buildFidStyle(paint, [f], opts);
	return { fill: u32[0] >>> 0, line: u32[1] >>> 0, w8: u32[2] >>> 24, dash: (u32[2] >>> 16) & 255, r4: (u32[2] >>> 8) & 255, vis: u32[2] & 1 };
};
const fill = (expr, props, opts) => rec({ "fill-color": expr }, poly(props), opts).fill;
const width = (expr, props, opts) => rec({ "line-width": expr }, poly(props), opts).w8 / 8;
const shown = (filter, f = poly({})) => rec({}, f, { filter }).vis === 1;

// ── 契約の演算子（データ）──
t("get・literal・has", () => {
	assert.equal(fill(["match", ["get", "k"], "a", RED, BLUE], { k: "a" }), R);
	assert.equal(fill(["literal", RED], {}), R);
	assert.equal(shown(["has", "k"], poly({ k: 0 })), true);
	assert.equal(shown(["has", "k"], poly({})), false);
});
t("feature-state（opts.states の実体）", () => {
	const paint = { "fill-color": ["case", ["==", ["feature-state", "sel"], true], RED, BLUE] };
	const { u32 } = buildFidStyle(paint, [poly(), poly()], { states: new Map([[1, { sel: true }]]) });
	assert.equal(u32[0] >>> 0, B); assert.equal(u32[4] >>> 0, R);
});
t("geometry-type＝GeoPBF の型名", () => {
	const e = ["match", ["geometry-type"], "Point", RED, BLUE];
	assert.equal(rec({ "fill-color": e }, point()).fill, R);
	assert.equal(rec({ "fill-color": e }, poly()).fill, B);
});
t("zoom＝評価時点の写し（opts.zoom）", () => {
	const e = ["interpolate", ["linear"], ["zoom"], 5, 1, 15, 3];
	assert.equal(width(e, {}, { zoom: 10 }), 2);
	assert.equal(width(e, {}, { zoom: 20 }), 3);
});
// ── 選ぶ ──
t("match（配列のラベル・fallback）", () => {
	const e = ["match", ["get", "地番"], ["道", "河川", "無地番"], RED, "筆界未定地", BLUE, "rgba(0,0,0,0)"];
	assert.equal(fill(e, { 地番: "河川" }), R);
	assert.equal(fill(e, { 地番: "筆界未定地" }), B);
	assert.equal(fill(e, { 地番: "1-1" }), 0);
});
t("case・step・coalesce", () => {
	assert.equal(fill(["case", [">", ["get", "v"], 5], RED, BLUE], { v: 9 }), R);
	assert.equal(fill(["case", [">", ["get", "v"], 5], RED, BLUE], { v: 1 }), B);
	const st = ["step", ["get", "v"], BLUE, 10, RED];
	assert.equal(fill(st, { v: 10 }), R); assert.equal(fill(st, { v: 9.9 }), B);
	assert.equal(fill(["step", ["coalesce", ["get", "v"], 100], BLUE, 10, RED], {}), R);
});
// ── 補間 ──
t("interpolate：linear・exponential・色・入れ子の色", () => {
	assert.equal(width(["interpolate", ["linear"], ["get", "v"], 0, 0, 10, 4], { v: 5 }), 2);
	assert.equal(width(["interpolate", ["exponential", 2], ["get", "v"], 0, 0, 2, 3], { v: 1 }), 1);   // (2^1−1)/(2^2−1)×3
	assert.equal(fill(["interpolate", ["linear"], ["get", "v"], 0, "#000000", 10, "#ffffff"], { v: 5 }), 0x808080ff);
	const nested = ["match", ["get", "k"], "a", ["interpolate", ["linear"], ["get", "v"], 0, "#000000", 10, "#ffffff"], BLUE];
	assert.equal(fill(nested, { k: "a", v: 5 }), 0x808080ff);
});
// ── 比較と論理 ──
t("== != > >= < <= ! all any in", () => {
	const f = { v: 5, s: "abc", k: "a" };
	for (const [e, want] of [[["==", ["get", "v"], 5], true], [["!=", ["get", "v"], 5], false], [[">", ["get", "v"], 4], true], [[">=", ["get", "v"], 5], true],
		[["<", ["get", "v"], 5], false], [["<=", ["get", "v"], 5], true], [["!", ["has", "v"]], false],
		[["all", ["has", "v"], ["==", ["get", "k"], "a"]], true], [["any", ["has", "zz"], ["==", ["get", "k"], "b"]], false],
		[["in", "b", ["get", "s"]], true], [["in", ["get", "k"], ["literal", ["a", "b"]]], true], [["in", "z", ["literal", ["a", "b"]]], false]])
		assert.equal(shown(e, poly(f)), want, JSON.stringify(e));
});
// ── 算術・型と文字・変数 ──
t("+ - * / % ^ min max", () => {
	for (const [e, want] of [[["+", 1, 2, 3], 6], [["-", 5, 2], 3], [["*", 2, 1.5], 3], [["/", 9, 3], 3], [["%", 7, 4], 3], [["^", 2, 3], 8],
		[["min", 4, 2, 9], 2], [["max", 1, 3, 2], 3]]) assert.equal(width(e, {}), want, JSON.stringify(e));
});
t("to-number・to-string・concat", () => {
	assert.equal(width(["to-number", ["get", "w"]], { w: "2.5" }), 2.5);
	assert.equal(fill(["match", ["to-string", ["get", "code"]], "13101", RED, BLUE], { code: 13101 }), R);
	assert.equal(fill(["match", ["concat", ["get", "a"], "-", ["get", "b"]], "x-y", RED, BLUE], { a: "x", b: "y" }), R);
});
t("let・var", () => assert.equal(width(["let", "w", ["get", "v"], ["*", ["var", "w"], 2]], { v: 1.5 }), 3));

// ── 評価規約（§6.2）──
t("=== の比較：文字の \"13101\" と数の 13101 は別", () => {
	assert.equal(fill(["match", ["get", "code"], "13101", RED, BLUE], { code: 13101 }), B);
	assert.equal(shown(["==", ["get", "code"], "13101"], poly({ code: 13101 })), false);
});
t("欠けた値：interpolate＝塗らない・step＝base・match＝fallback", () => {
	assert.equal(fill(["interpolate", ["linear"], ["get", "pop"], 0, RED, 10, BLUE], {}), 0);
	assert.equal(fill(["step", ["get", "pop"], RED, 10, BLUE], {}), R);
	assert.equal(fill(["match", ["get", "pop"], 1, RED, BLUE], {}), B);
});
t("throw しない：未知の演算子・壊れた式はその欄を既定へ（塗りなし・1 px・1.5 px）", () => {
	const r = rec({ "fill-color": ["frobnicate", 1], "line-width": ["get", ["frobnicate"]], "circle-radius": "x" }, point());
	assert.equal(r.fill, 0); assert.equal(r.w8, 8); assert.equal(r.r4, 6); assert.equal(r.vis, 1);
});

// ── fid 表の詰め方（§7.1）──
t("既定（プロパティ無し）：塗り 0・線色 0・幅 1・半径 1.5・visible・dash-id 0", () =>
	assert.deepEqual(rec({}), { fill: 0, line: 0, w8: 8, dash: 0, r4: 6, vis: 1 }));
t("line-width は 1/8・最大 31.875／circle-radius は 1/4・最大 63.75", () => {
	assert.equal(rec({ "line-width": 2.5 }).w8, 20); assert.equal(rec({ "line-width": 40 }).w8, 255);
	assert.equal(rec({ "circle-radius": 4 }).r4, 16); assert.equal(rec({ "circle-radius": 100 }).r4, 255);
	assert.equal(rec({ "line-width": 0 }).w8, 0);
});
t("点は circle-color・他は line-color（G 欄は 1 つ）", () => {
	const paint = { "line-color": RED, "circle-color": BLUE };
	assert.equal(rec(paint, point()).line, B); assert.equal(rec(paint, poly()).line, R);
	assert.equal(rec({ "line-color": RED }, point()).line, R);   // circle-color が無ければ line-color
});
t("opacity は α に掛ける（line-opacity は点の色にも）・α 0 は 0（描画側で既定色へ）", () => {
	assert.equal(rec({ "fill-color": RED, "fill-opacity": 0.5 }).fill, 0xff000080);
	assert.equal(rec({ "circle-color": RED, "line-opacity": 0.5 }, point()).line, 0xff000080);
	assert.equal(rec({ "line-color": RED, "line-opacity": 0 }).line, 0);
});
t("filter は visible ビットだけを落とす（スタイルは評価したまま）", () => {
	const r = rec({ "fill-color": RED }, poly({ v: 1 }), { filter: ["==", ["get", "v"], 2] });
	assert.equal(r.vis, 0); assert.equal(r.fill, R);
});
t("色の書式：#rgb #rgba #rrggbbaa rgb() hsl() 色名 transparent", () => {
	assert.equal(fill("#f00"), R); assert.equal(fill("#f008"), 0xff000088); assert.equal(fill("#ff000080"), 0xff000080);
	assert.equal(fill("rgb(255,0,0)"), R); assert.equal(fill("hsl(0,100%,50%)"), R); assert.equal(fill("red"), R); assert.equal(fill("transparent"), 0);
});

console.log(`\n✅ gint-expr ${n} 件`);
