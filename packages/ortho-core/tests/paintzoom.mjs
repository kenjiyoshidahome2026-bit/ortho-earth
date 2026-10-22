// ズーム連続の paint の検定（描画の統合ロードマップ 波 4 の 14＝V-Ph3 の paint 表と S-P1-2 の一本化・2026-10-22）。node packages/ortho-core/tests/paintzoom.mjs
// 守るもの：①地物に依らない式（kind constant／zoom）で zoom を読む色・不透明度・線幅だけが差し替えの式（pz）を持つ（data・zoom×data・global-state・line-gap-width の層は焼くまま）
// ②外来の層だけ（内蔵の層は持たない）③今の z で評価した値＝同じ z で作ったタイルの焼いた値（色の量子化の内）・評価エラーの既定も build.ts と同じ
// ④結合（mergeTiles）と WebGPU の逃げ道（chopDash）が pz を写す ⑤シェーダ（GL classic・multi_draw の線と塗り）が u_pz・u_pzC を読み、描き手が 4 か所で置く
// ⑦setPaintProperty の速い道（paintFast）：新しい値が地物に依らない色・不透明度・線幅・ずらしだけ（線幅は CPU で刻む破線・隙間つきを除く・ずらしは前の層が角の継ぎを持つ時）
// ⑥line-offset（波 4 の 14 の続き）：地物に依らないずらし（定数も・0 と隙間つきは除く）は pz.of＝u_pzO で置く・今の z で 0 でも角の継ぎを持つ・シェーダの破線と並ぶ
//   （md の線分プールは語 6＝距離・語 7＝tS/tE）・chopDash はずらしを写す・WebGPU は md の破線の列だけ tr.w で読む
import assert from "node:assert/strict";
import { buildTileDrawList, paintFast } from "../src/build.ts";
import { mergeTiles, chopDash } from "../src/scene.ts";
import { normalizeMLLayer } from "../src/mlstyle.ts";
import { layerPaintZoom, evalPaintZoom } from "../src/paintzoom.ts";
import { readFileSync } from "node:fs";
import { LINE_VS, LINE_MD_VS, FILL_VS, FILL_MD_VS } from "../src/gl/glsl.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = coords => ({ type: "LineString", props: { k: 3 }, geom: { coords, ends: [coords.length] } });
const poly = coords => ({ type: "Polygon", props: { k: 3 }, geom: { coords: new Float32Array(coords), ends: [coords.length] } });
const tileOf = (feats, z = 14) => ({ z, x: 14552 >> (14 - z), y: 6451 >> (14 - z), layers: { road: { extent: 4096, features: feats } } });
const opsOf = (feats, layer, { ml = true, z = 14 } = {}) => buildTileDrawList(tileOf(feats, z), { layers: [ml ? normalizeMLLayer({ id: "r", "source-layer": "road", ...layer }) : { id: "r", "source-layer": "road", ...layer }] }, [0, 0]).ops;
const L1 = [line([100, 100, 1000, 100])];
const SQ = [poly([100, 100, 900, 100, 900, 900, 100, 900, 100, 100])];
const ZW = ["interpolate", ["exponential", 1.5], ["zoom"], 10, 1, 18, 30];
const ZC = ["interpolate", ["linear"], ["zoom"], 10, "#0000ff", 18, "#ff0000"];

t("zoom だけの線幅・色・不透明度は pz を持つ・定数だけ・地物を読む式は持たない", () => {
	assert.deepEqual(layerPaintZoom("line", { "line-width": ZW }, "ml"), { o: "ml", w: ZW });
	assert.deepEqual(layerPaintZoom("line", { "line-color": ZC, "line-opacity": 0.5 }, "ml"), { o: "ml", c: ZC, a: 0.5 });
	assert.deepEqual(layerPaintZoom("line", { "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0, 12, 1] }, "ml"), { o: "ml", c: "#000", a: ["interpolate", ["linear"], ["zoom"], 10, 0, 12, 1] });   // 色の式が無い＝#000（build.ts と同じ）
	assert.deepEqual(layerPaintZoom("fill", { "fill-color": ZC }, "ml"), { o: "ml", c: ZC });
	assert.equal(layerPaintZoom("line", { "line-width": 3, "line-color": "#f00" }, "ml"), null);   // 定数だけ＝焼いた値で正しい
	assert.equal(layerPaintZoom("line", { "line-color": ["get", "c"], "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0, 12, 1] }, "ml"), null);   // 不透明度は zoom でも色が地物を読む＝焼くまま
	assert.equal(layerPaintZoom("line", { "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["get", "w"], 18, 30] }, "ml"), null);   // zoom×data＝焼くまま
	assert.equal(layerPaintZoom("line", { "line-width": ["*", ["zoom"], ["global-state", "k"]] }, "ml"), null);   // 実行時の状態を読む
	assert.equal(layerPaintZoom("line", { "line-width": ZW, "line-gap-width": 2 }, "ml"), null);   // 両脇の 2 本のずらしは焼いた線幅で決まる
	assert.deepEqual(layerPaintZoom("line", { "line-width": ZW, "line-color": ["get", "c"] }, "ml"), { o: "ml", w: ZW });   // 線幅だけ
});
t("外来の層だけが op に pz を添える（線と塗り）", () => {
	assert.deepEqual(opsOf(L1, { type: "line", paint: { "line-width": ZW } })[0].pz.w, normalizeMLLayer({ id: "x", type: "line", paint: { "line-width": ZW } }).paint["line-width"]);
	assert.ok(opsOf(SQ, { type: "fill", paint: { "fill-color": ZC } })[0].pz.c);
	assert.equal(opsOf(L1, { type: "line", paint: { "line-width": 3 } })[0].pz, undefined);
	assert.equal(opsOf(L1, { type: "line", paint: { "line-width": ZW } }, { ml: false })[0].pz, undefined);   // 内蔵の層は今までどおり
});
t("今の z の値＝同じ z で作ったタイルの焼いた値（線幅・色・塗り）", () => {
	for (const z of [11, 13, 15]) {
		const [lo] = opsOf(L1, { type: "line", paint: { "line-width": ZW, "line-color": ZC, "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.2, 18, 1] } }, { z });
		const v = evalPaintZoom(lo.pz, z);
		assert.ok(Math.abs(v.hw - lo.half[0]) < 1e-5, `${z}: ${v.hw} ≠ ${lo.half[0]}`);
		for (let i = 0; i < 4; i++) assert.ok(Math.abs(v.c[i] * 255 - lo.col[i]) <= 0.5 + 1e-6, `${z}: c${i} ${v.c[i] * 255} ≠ ${lo.col[i]}`);
		const [fo] = opsOf(SQ, { type: "fill", paint: { "fill-color": ZC, "fill-opacity": 0.5 } }, { z });
		const f = evalPaintZoom(fo.pz, z);
		for (let i = 0; i < 4; i++) assert.ok(Math.abs(f.c[i] * 255 - fo.col[i]) <= 0.5 + 1e-6);
	}
	assert.equal(evalPaintZoom({ o: "ml", w: ["interpolate", ["linear"], ["zoom"], 10, -2, 12, 4] }, 10).hw, 0.5);   // 0 以下＝1px（build.ts と同じ）
	assert.deepEqual(evalPaintZoom({ o: "ml", c: "#ff0000", a: ["interpolate", ["linear"], ["zoom"], 10, -1, 12, 3] }, 10).c, [1, 0, 0, 0]);   // 不透明度は 0〜1 に
});
t("結合と chopDash が pz を写す", () => {
	const a = opsOf(L1, { type: "line", paint: { "line-width": ZW, "line-dasharray": [2, 1] } })[0];
	const s = mergeTiles([{ key: "a", origin: [0, 0] }, { key: "b", origin: [0, 0] }], () => ({ ops: [a] }), { origin: [0, 0] });
	assert.equal(s.layers[0].pz, a.pz);
	assert.equal(chopDash(a, [0, 0]).pz, a.pz);
	const f = opsOf(SQ, { type: "fill", paint: { "fill-color": ZC } })[0];
	assert.equal(mergeTiles([{ key: "a", origin: [0, 0] }], () => ({ ops: [f] }), { origin: [0, 0] }).layers[0].pz, f.pz);
});
t("シェーダと描き手：u_pz で色と線幅を差し替える・破線の尺は floor(z) の線幅・4 か所で置く・WebGPU は読まない", () => {
	for (const s of [LINE_VS, LINE_MD_VS]) {
		assert.match(s, /if \(u_pz\.y > 0\.5\) hw0 = u_pz\.z;/);
		assert.match(s, /if \(u_pz\.x > 0\.5\) col0 = u_pzC;/);
		assert.match(s, /\(u_dashP\.w \/ max\(2\.0 \* hwD, 1e-3\)\)/);
	}
	for (const s of [FILL_VS, FILL_MD_VS]) assert.match(s, /v_color = u_pz\.x > 0\.5 \? u_pzC : a_color;/);
	const src = f => readFileSync(new URL(f, import.meta.url), "utf8");
	const gl = src("../src/gl/renderer.ts");
	assert.equal(gl.match(/setPz\((md!\.)?(fill|line)Prog, pzOver\.get\((e|d)\.li\) \?\? (e|d)\.pz, cam\);/g).length, 4);
	assert.match(gl, /gl\.uniform4f\(linePzLoc, 0, 0, 0, 0\); gl\.uniform2f\(linePzOLoc, 0, 0\); \};/);   // 境界線などの線は差し替えない
	const gpu = src("../src/gpu/renderer.ts");
	assert.equal(gpu.match(/\bpz\b/g).length, 3);   // WebGPU は色・線幅を読まない（破線でずらす md の列のずらしだけ＝⑥）
});
const ZO = ["interpolate", ["linear"], ["zoom"], 12, 0, 16, 8];
t("ずらし：地物に依らない式（定数も）は pz.of・0・地物を読む式・隙間つきは持たない", () => {
	assert.deepEqual(layerPaintZoom("line", { "line-offset": ZO }, "ml"), { o: "ml", of: ZO });
	assert.deepEqual(layerPaintZoom("line", { "line-offset": -3 }, "ml"), { o: "ml", of: -3 });   // 定数も＝線分プールの語 6 を空ける
	assert.equal(layerPaintZoom("line", { "line-offset": 0 }, "ml"), null);
	assert.equal(layerPaintZoom("line", { "line-offset": ["get", "o"] }, "ml"), null);
	assert.equal(layerPaintZoom("line", { "line-offset": 2, "line-gap-width": 1 }, "ml"), null);
	assert.equal(evalPaintZoom({ o: "ml", of: ZO }, 14).off, 4);
	assert.equal(evalPaintZoom({ o: "ml", of: ["get", "o"] }, 14).off, 0);   // 不正値＝0（build.ts と同じ）
	assert.equal(evalPaintZoom({ o: "ml", w: ZW }, 14).off, null);
});
t("ずらし：今の z で 0 の層も [off, tS, tE] を持つ（角の継ぎ）・破線はシェーダ（dist）と並ぶ・0 の層はずらさない層（端と継ぎ）", () => {
	const L3 = [line([100, 100, 1000, 100, 1000, 900])];
	const a = opsOf(L3, { type: "line", paint: { "line-offset": ZO } }, { z: 12 })[0];
	assert.ok(a.off && a.pz.of); assert.equal(a.off[0], 0);
	assert.deepEqual([...a.off].filter((v, i) => i % 3 && v).map(Math.abs), [1, 1]);   // 直角の角＝t＝±1（今の z で 0 でも・細分の途中は 0）
	const d = opsOf(L3, { type: "line", paint: { "line-offset": 3, "line-dasharray": [2, 1] } })[0];
	assert.ok(d.dist && d.off && d.dash); assert.equal(d.half.length, 2);   // 刻まない
	const c = chopDash(d, [0, 0]);
	assert.equal(c.off.length, c.half.length * 3); assert.equal(c.off[0], 3); assert.equal(c.off[1], 0);   // 片の頭は線の端＝0
	const last = c.half.length - 1; assert.equal(c.off[last * 3 + 2], 0);
	const z = opsOf(L3, { type: "line", paint: { "line-offset": 0 } })[0];
	assert.equal(z.off, undefined); assert.ok(z.jf);   // 0＝ずらさない層＝端と継ぎ
	assert.equal(opsOf(L3, { type: "line", paint: { "line-offset": ["get", "o"], "line-dasharray": [2, 1] } })[0].dist, undefined);   // 地物ごと＝CPU で刻む
});
t("ずらし：シェーダは u_pzO・md の破線の列は語 7 の角の継ぎを残す・scene worker は語 6＝距離・語 7＝tS/tE・WebGPU md は tr.w", () => {
	for (const s of [LINE_VS, LINE_MD_VS]) assert.match(s, /if \(u_pzO\.x > 0\.5\) off0\.x = u_pzO\.y;/);
	assert.match(LINE_MD_VS, /if \(u_dashP\.y > 0\.5\) \{ dist0 = uintBitsToFloat\(B\.z\); off0\.x = 0\.0; \}/);
	const src = f => readFileSync(new URL(f, import.meta.url), "utf8");
	assert.match(src("../src/gl/renderer.ts"), /if \(oL\) gl\.uniform2f\(oL, m\.off != null \? 1 : 0, m\.off \?\? 0\);/);
	const sw = src("../src/workers/sceneworker.ts");
	assert.match(sw, /if \(d32\) seg\[o \+ 6\] = d32\[i\]; else if \(f32\) seg\[o \+ 6\] = f32\[i \* 3\];/);
	assert.match(sw, /if \(f32\) seg\[o \+ 7\] = /);
	assert.match(src("../src/gpu/wgsl.ts"), /dist0 = bitcast<f32>\(B\.z\); off0\.x = P\.tr\.w;/);
	assert.match(src("../src/gpu/renderer.ts"), /dOff: dash && L\.pz\?\.of != null \? L\.pz : null/);
});
t("setPaintProperty の速い道：地物に依らない新しい値だけ・形を焼く性質は作り直す", () => {
	const F = (type, prev, next, key) => paintFast(type, prev, next, key, "ml");
	assert.equal(F("line", { "line-color": ["get", "c"] }, { "line-color": "#f00" }, "line-color").c, "#f00");   // 前が地物ごとでも＝層の値で上書き
	assert.equal(F("fill", { "fill-color": "#0f0" }, { "fill-color": "#0f0", "fill-opacity": 0.5 }, "fill-opacity").a, 0.5);
	assert.equal(F("line", {}, { "line-color": ["get", "c"] }, "line-color"), null);   // 地物を読む＝作り直す
	assert.equal(F("line", {}, { "line-color": ["global-state", "k"] }, "line-color"), null);
	assert.equal(F("line", { "line-width": 2 }, { "line-width": 6 }, "line-width").w, 6);   // 色の式が無い層も #000 で上書き（焼いた値と同じ）
	assert.ok(F("line", {}, { "line-width": 6, "line-dasharray": [2, 1] }, "line-width"));   // シェーダの破線＝片の長さを焼いていない
	assert.equal(F("line", {}, { "line-width": 6, "line-dasharray": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }, "line-width"), null);   // CPU で刻む破線
	assert.equal(F("line", {}, { "line-width": 6, "line-dasharray": [2, 1], "line-offset": ["get", "o"] }, "line-width"), null);
	assert.equal(F("line", {}, { "line-width": 6, "line-gap-width": 2 }, "line-width"), null);   // 両脇のずらしは線幅から焼く
	assert.equal(F("line", { "line-offset": 3 }, { "line-offset": 9 }, "line-offset").of, 9);
	assert.equal(F("line", {}, { "line-offset": 9 }, "line-offset"), null);   // 前の線分は角の継ぎを持たない
	assert.equal(F("line", { "line-offset": 3 }, { "line-offset": 0 }, "line-offset"), null);   // 0＝ずらさない層（端と継ぎ）＝作り直す
	assert.equal(F("line", {}, { "line-blur": 2 }, "line-blur"), null);
	assert.equal(F("line", {}, { "fill-color": "#f00" }, "fill-color"), null);
	assert.equal(F("symbol", {}, { "text-color": "#f00" }, "text-color"), null);
	const src = f => readFileSync(new URL(f, import.meta.url), "utf8");
	assert.equal(src("../src/gl/renderer.ts").match(/setPz\((md!\.)?(fill|line)Prog, pzOver\.get\((e|d)\.li\) \?\? (e|d)\.pz, cam\);/g).length, 4);   // 層の上書きを先に読む
});
console.log(`paintzoom: ${n} PASS`);
