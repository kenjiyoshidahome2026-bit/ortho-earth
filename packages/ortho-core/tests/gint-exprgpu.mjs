// fid 表を GPU で組む（geopbf 改良点 ⑦）の Node 側の検定：node packages/ortho-core/tests/gint-exprgpu.mjs
// GPU は無い＝①属性列の符号化（attrcols）②辞書の表（dictTables）③式→WGSL の形（主な演算子が文に落ちる・列の添字・状態の鍵）
// ④載せない式を断る（CPU へ落ちる口）⑤paintKeys（鍵の収集）。値の一致（GPU 対 buildFidStyle）は globe/tests/t-gintexpr.html（verify:webgpu・器でも回る）が見る
import assert from "node:assert/strict";
import { Dict, encodeValue, newKinds, paintKeys, buildPropColumns, buildStateColumns, buildGeomColumn, encodeStateRow, T_UNDEF, T_NUM, T_STR, T_BOOL, T_NULL } from "../src/gint/attrcols.ts";
import { compileFidStyleWGSL, dictTables } from "../src/gpu/gintexpr.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };
const f32 = v => { const f = new Float32Array(1), u = new Uint32Array(f.buffer); f[0] = v; return u[0]; };

t("① 値の符号化（型・中身・統計）", () => {
	const d = new Dict(), K = newKinds();
	assert.deepEqual(encodeValue(undefined, d, K), [T_UNDEF, 0]);
	assert.deepEqual(encodeValue(null, d, K), [T_NULL, 0]);
	assert.deepEqual(encodeValue(2.5, d, K), [T_NUM, f32(2.5)]);
	assert.deepEqual(encodeValue(true, d, K), [T_BOOL, 1]);
	assert.deepEqual(encodeValue("", d, K), [T_STR, 0]);          // "" は id 0（truthy が偽になる唯一の文字列）
	assert.deepEqual(encodeValue("a", d, K), [T_STR, 1]);
	assert.deepEqual(encodeValue("a", d, K), [T_STR, 1]);         // 同じ文字列は同じ id
	assert.deepEqual(encodeValue("12", d, K), [T_STR, 2]);
	assert.deepEqual(encodeValue([1], d, K), [T_UNDEF, 0]);       // 配列＝載せない（other）
	assert.deepEqual(K, { undef: true, nul: true, num: true, bool: true, str: true, numStr: true, other: true });
	assert.equal(d.size, 3);
});
t("① 属性列（鍵ごと・列優先）・geometry-type 列・state 列", () => {
	const feats = [{ properties: { v: 1, k: "x" }, geometry: { type: "Point" } }, { properties: { k: "y" }, geometry: { type: "Polygon" } }, { properties: null, geometry: null }];
	const d = new Dict();
	const { data, kinds, count } = buildPropColumns(feats, ["v", "k"], d);
	assert.equal(count, 3);
	assert.deepEqual([...data], [T_NUM, f32(1), T_UNDEF, 0, T_UNDEF, 0, T_STR, d.map.get("x"), T_STR, d.map.get("y"), T_UNDEF, 0]);
	assert.equal(kinds.get("v").num, true); assert.equal(kinds.get("v").undef, true); assert.equal(kinds.get("k").str, true);
	const g = buildGeomColumn(feats, d);
	assert.deepEqual([...g], [d.map.get("Point"), d.map.get("Polygon"), 0]);
	const st = buildStateColumns(new Map([[1, { hover: true, w: "3" }], [9, { hover: true }]]), ["hover", "w"], 3, d);   // fid 9＝範囲外は捨てる
	assert.deepEqual([...st], [0, 0, T_BOOL, 1, 0, 0, 0, 0, T_STR, d.map.get("3"), 0, 0]);
	assert.deepEqual(encodeStateRow({ w: 2 }, ["hover", "w"], d), [[T_UNDEF, 0], [T_NUM, f32(2)]]);
	assert.deepEqual(encodeStateRow(undefined, ["hover"], d), [[T_UNDEF, 0]]);
});
t("② 辞書の表＝Number(s) と parseRGBA(s)", () => {
	const d = new Dict(); for (const s of ["12", " 7 ", "abc", "#ff0000", "rgba(0,128,255,0.5)"]) d.intern(s);
	const { dnum, dcol } = dictTables(d);
	assert.equal(dnum.length, d.size * 2); assert.equal(dcol.length, d.size * 4);
	assert.deepEqual([dnum[0], dnum[1]], [f32(0), 0]);                  // ""＝Number("")＝0
	assert.deepEqual([dnum[2], dnum[3]], [f32(12), 0]);
	assert.deepEqual([dnum[4], dnum[5]], [f32(7), 0]);
	assert.equal(dnum[7], 1);                                            // "abc"＝NaN 旗
	assert.deepEqual([...dcol.slice(8, 12)], [0, 0, 0, 1]);                 // " 7 "＝色として読めない＝黒（parseRGBA）
	assert.deepEqual([...dcol.slice(16, 20)], [1, 0, 0, 1]);                // "#ff0000"
	assert.deepEqual([...dcol.slice(20, 24)].map(x => +x.toFixed(4)), [0, +(128 / 255).toFixed(4), 1, 0.5]);
});
t("⑤ paintKeys＝式が読む鍵（get/has・feature-state・geometry-type・zoom・動的な鍵）", () => {
	const k = paintKeys({ "fill-color": ["match", ["get", "a"], "x", ["interpolate", ["linear"], ["zoom"], 0, "#000", 1, ["feature-state", "s"]], "#fff"], "line-width": ["case", ["has", "b"], 1, 2] }, ["==", ["geometry-type"], "Point"]);
	assert.deepEqual([...k.props].sort(), ["a", "b"]); assert.deepEqual([...k.states], ["s"]); assert.equal(k.geom, true); assert.equal(k.zoom, true); assert.equal(k.dyn, false);
	assert.equal(paintKeys({ "fill-color": ["get", ["get", "k"]] }).dyn, true);
	assert.equal(paintKeys({ "line-color": "#fff" }).geom, true);   // G 欄＝点か否かで circle/line を選ぶ＝geometry 列が要る
});
const feats = [{ properties: { v: 1, k: "a", s: "12" }, geometry: { type: "Point" } }, { properties: { v: 2, k: "b" }, geometry: { type: "Polygon" } }];
const setup = (paint, filter, o = {}) => {
	const dict = new Dict(), keys = paintKeys(paint, filter), propKeys = [...keys.props].sort(), stateKeys = [...keys.states].sort();
	const cols = buildPropColumns(feats, propKeys, dict);
	return { r: compileFidStyleWGSL(paint, filter, { propKeys, stateKeys, kinds: cols.kinds, dict, ...o }), dict, propKeys, stateKeys };
};
t("③ 式→WGSL の形（主な演算子・列の添字・状態の鍵・旗）", () => {
	const paint = { "fill-color": ["interpolate", ["exponential", 2], ["get", "v"], 0, "#ff0000", 10, ["match", ["get", "k"], ["a", "b"], ["interpolate", ["linear"], ["to-number", ["get", "s"]], 0, "#000000", 100, "#ffffff"], "#0000ff"]],
		"fill-opacity": ["case", ["all", ["has", "v"], [">", ["get", "v"], 0]], 1, 0.5], "line-color": ["coalesce", ["feature-state", "col"], "#00ff00"], "circle-color": ["step", ["zoom"], "#111111", 5, "#222222"],
		"line-width": ["let", "x", ["*", ["get", "v"], 2], ["min", ["var", "x"], 8, ["abs", ["-", ["get", "v"]]]]], "circle-radius": ["^", ["%", ["/", ["+", ["get", "v"], 1], 2], 7], 0.5] };
	const filter = ["any", ["in", ["get", "k"], ["literal", ["a", 1]]], ["!", ["==", ["feature-state", "sel"], true]], ["<=", ["get", "v"], ["zoom"]]];
	const { r, dict, propKeys, stateKeys } = setup(paint, filter);
	assert.equal(r.error, undefined, r.error);
	assert.deepEqual(propKeys, ["k", "s", "v"]); assert.deepEqual(stateKeys, ["col", "sel"]);
	assert.equal(r.usesZoom, true); assert.equal(r.usesState, true); assert.equal(r.filterUsesState, true); assert.equal(r.filterUsesZoom, true); assert.equal(r.usesGeom, true);
	assert.equal(r.slots, 1);   // 入れ子の interpolate（evalExpr 経由）だけが slot を持つ（根の色の補間は丸め無しの直の lerp）
	const w = r.wgsl;
	for (const need of ["@compute @workgroup_size(64)", "var<private> cols: array<vec4f, 1>", "P(2u, fid)", "P(0u, fid)", "S(0u, fid)", "S(1u, fid)", "U.zoom", "lerpV(", "lerpT(", "packColor(", "u8(", "if (!vtruthy(", "flags = 0u", "outR[fid] = vec4u(fill, line, (w8 << 24u) | (r8 << 8u) | flags, 0u);", "let isPt = geom[fid] == ", "npow(", "nmod(", "ndiv(", "nadd(", "nmul(", "nsub(", "nabs("])
		assert.ok(w.includes(need), "wgsl lacks " + need);
	assert.ok(!w.split("\n").some(l => /undefined|NaN|\[object/.test(l.replace(/\/\/.*$/, ""))), "wgsl has a JS leak");   // 注釈を除いた文に JS の値が漏れていない
	assert.ok(dict.map.has("#ff0000") && dict.map.has("Point") && dict.map.has("MultiPoint"), "literals and geometry names interned");
	assert.equal((w.match(/P\(1u, fid\)/g) || []).length, 1);   // ["get","s"] は 1 回
});
t("③ 文字列の数（\"12\"）を数の文脈で読む列は載る（辞書の Number 表で引く）・2^24 を超える整数リテラルは断る", () => {
	assert.equal(setup({ "line-width": ["to-number", ["get", "s"]] }, [">", ["get", "s"], 5]).r.error, undefined);
	assert.match(setup({}, ["==", ["get", "v"], 123456789]).r.error, /f32/);
	assert.equal(setup({}, ["==", ["get", "v"], 16777216]).r.error, undefined);
});
t("④ 載せない式を断る（CPU へ落ちる口）", () => {
	const bad = {
		"ML 出自": setup({ "fill-color": "#fff" }, null, { origin: "ml" }),
		"文字列どうしの大小比較": setup({}, ["<", ["get", "k"], "m"]),
		"文字列を足す +": setup({ "line-width": ["+", ["get", "k"], 1] }),
		"min の文字列を足す": setup({ "line-width": ["+", ["min", ["get", "s"], 3], 1] }),
		"配列のリテラル": setup({ "fill-color": ["literal", [1, 2]] }),
		"get の 2 引数": setup({ "fill-color": ["get", "k", ["literal", {}]] }),
		"動的な鍵": setup({ "fill-color": ["get", ["get", "k"]] }),
		"未対応の演算子（concat）": setup({ "fill-color": ["concat", ["get", "k"], "x"] }),
		"未対応の補間（cubic-bezier）": setup({ "line-width": ["interpolate", ["cubic-bezier", 0, 0, 1, 1], ["get", "v"], 0, 1, 1, 2] }),
		"in の動的な集合": setup({}, ["in", ["get", "k"], ["get", "s"]]),
		"var の未束縛": setup({ "line-width": ["var", "x"] }),
	};
	for (const [name, { r }] of Object.entries(bad)) assert.ok(r.error, name + " should be refused");
	assert.equal(setup({ "fill-color": ["case", ["<", ["get", "v"], 5], "#fff", "#000"] }).r.error, undefined);   // 数と数の比較は載る
	assert.equal(setup({}, ["<", ["get", "s"], 5]).r.error, undefined);   // 数の文字列 < 数＝Number(s) で比べる＝載る（文字列どうしだけ断る）
	assert.equal(setup({ "fill-color": ["match", ["get", "k"], ["get", "s"], "#fff", "#000"] }).r.error, undefined);   // match のラベルは配列＝データ（expr.js と同じ＝["get","s"] は 2 つの文字列ラベル）
});
console.log(`gint-exprgpu: ${n} tests passed`);
