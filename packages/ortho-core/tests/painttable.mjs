// paint 表の (b) 類の検定（vt perf plan §5「(b) 類の段取り」の 1・2026-10-22）。node packages/ortho-core/tests/painttable.mjs
// 守るもの：①(b) の判定＝外来の塗りと線で、色か不透明度が地物に依り（kind data）、zoom・feature-state・global-state を読まず、属性を名前で読むだけ（鍵＝読む属性の名）
// ②tile worker の op：rows（鍵の組・重なりなし）・cols（行の焼いた色）・rid（頂点／線分ごとの行）。どの頂点／線分も焼いた色の語＝その行の cols（端と継ぎ・CPU の破線・隙間つきの道筋でも）
// ③行の組を属性に戻して評価した色（ptRowColor・段 2 の書き換えの口）＝焼いた色 ④図郭外の水域は持たない ⑤シェーダは md の変種だけが表を読む
import assert from "node:assert/strict";
import { buildTileDrawList } from "../src/build.ts";
import { normalizeMLLayer } from "../src/mlstyle.ts";
import { layerPaintTable, ptRowColor, PT_GEOM } from "../src/painttable.ts";
import { FILL_VS, FILL_MD_VS, LINE_VS, LINE_MD_VS, ATLAS_FILL_VS, ATLAS_FILL_MD_VS } from "../src/gl/glsl.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = (coords, props) => ({ type: "LineString", props, geom: { coords, ends: [coords.length] } });
const poly = (coords, props) => ({ type: "Polygon", props, geom: { coords: new Float32Array(coords), ends: [coords.length] } });
const tileOf = feats => ({ z: 14, x: 14552, y: 6451, layers: { road: { extent: 4096, features: feats } } });
const opsOf = (feats, layer, ml = true) => buildTileDrawList(tileOf(feats), { layers: [ml ? normalizeMLLayer({ id: "r", "source-layer": "road", ...layer }) : { id: "r", "source-layer": "road", ...layer }] }, [0, 0]).ops;
const M = ["match", ["get", "class"], "a", "#ff0000", "b", "#00ff00", "#0000ff"];
const LINES = ["a", "b", "a", "c", null].map((c, i) => line([100, 100 + i * 200, 900, 100 + i * 200, 900, 150 + i * 200], c == null ? {} : { class: c }));
const POLYS = ["a", "b", "a"].map((c, i) => poly([100 + i * 1000, 100, 900 + i * 1000, 100, 900 + i * 1000, 900, 100 + i * 1000, 900, 100 + i * 1000, 100], { class: c, w: i }));

t("(b) の判定：地物を名前で読む色・不透明度だけ（鍵＝読む属性の名・並べた順）", () => {
	assert.deepEqual(layerPaintTable("line", { "line-color": M }, "ml").keys, ["class"]);
	assert.deepEqual(layerPaintTable("fill", { "fill-color": "#f00", "fill-opacity": ["case", ["has", "x"], 0.5, ["get", "o"]] }, "ml").keys, ["o", "x"]);
	assert.deepEqual(layerPaintTable("fill", { "fill-color": ["match", ["geometry-type"], "Polygon", "#f00", "#000"] }, "ml").keys, [PT_GEOM]);
	assert.deepEqual(layerPaintTable("line", { "line-color": ["get", "k", ["literal", { k: "#f00" }]], "line-opacity": ["get", "o"] }, "ml").keys, ["o"]);   // 3 引数の get は物から読む
	assert.equal(layerPaintTable("line", { "line-color": "#f00", "line-width": ["get", "w"] }, "ml"), null);   // 色は定数（線幅は段 2）
	assert.equal(layerPaintTable("line", { "line-color": ["interpolate", ["linear"], ["zoom"], 10, "#000", 12, "#fff"] }, "ml"), null);   // zoom だけ＝pz（(a) 類）
	assert.equal(layerPaintTable("line", { "line-color": ["interpolate", ["linear"], ["zoom"], 10, ["get", "c"], 12, "#fff"] }, "ml"), null);   // zoom×data＝焼くまま
	assert.equal(layerPaintTable("line", { "line-color": M, "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0, 12, 1] }, "ml"), null);   // 不透明度が zoom
	assert.equal(layerPaintTable("line", { "line-color": ["case", ["boolean", ["feature-state", "h"], false], "#f00", ["get", "c"]] }, "ml"), null);   // feature-state（段 3）
	assert.equal(layerPaintTable("line", { "line-color": ["case", ["global-state", "g"], "#f00", ["get", "c"]] }, "ml"), null);
	assert.equal(layerPaintTable("line", { "line-color": ["get", ["concat", "c", "1"]] }, "ml"), null);   // 名前が式
	assert.equal(layerPaintTable("line", { "line-color": ["case", ["==", ["id"], 1], "#f00", "#000"] }, "ml"), null);   // id＝行が地物の数
	assert.equal(layerPaintTable("line", { "line-color": ["get", "c", ["properties"]] }, "ml"), null);
	assert.equal(layerPaintTable("line", { "line-color": M }, undefined), null);   // 内蔵の層
	assert.equal(layerPaintTable("symbol", { "text-color": M }, "ml"), null);
});

// どの頂点／線分も、焼いた色の語＝その行の cols
const check = (op, unit) => {
	const pt = op.pt, c32 = new Uint32Array(op.col.buffer, op.col.byteOffset, op.col.byteLength >> 2);
	assert.ok(pt, "pt");
	assert.equal(pt.rid.length, c32.length, "rid の数＝" + unit);
	assert.equal(pt.cols.length, pt.rows.length);
	assert.equal(new Set(pt.rows.map(r => JSON.stringify(r))).size, pt.rows.length, "組は重ならない");
	for (let i = 0; i < c32.length; i++) assert.equal(pt.cols[pt.rid[i]], c32[i], `${unit} ${i}`);
	return pt;
};
t("線：rows・cols・rid（線分ごと）＝焼いた色・無い属性は null", () => {
	const op = opsOf(LINES, { type: "line", paint: { "line-color": M, "line-opacity": ["case", ["has", "class"], 1, 0.5] } })[0];
	const pt = check(op, "線分");
	assert.deepEqual(pt.keys, ["class"]);
	assert.deepEqual(pt.rows, [["a"], ["b"], ["c"], [null]]);
	assert.deepEqual([...pt.rid], [0, 0, 1, 1, 0, 0, 2, 2, 3, 3]);
});
t("線：端と継ぎ（jf）・CPU で刻む破線・隙間つき・ずらしの道筋でも行が揃う", () => {
	for (const extra of [{ layout: { "line-cap": "butt", "line-join": "miter" } }, { paint: { "line-dasharray": [2, 1], "line-gap-width": 3 } }, { paint: { "line-gap-width": 4 } }, { paint: { "line-offset": ["get", "w"] } }, { paint: { "line-dasharray": [2, 1] } }]) {
		const op = opsOf(LINES, { type: "line", ...extra, paint: { "line-color": M, ...(extra.paint || {}) } })[0];
		check(op, "線分 " + JSON.stringify(extra));
	}
});
t("塗り：rid は頂点ごと・行の評価（ptRowColor）＝焼いた色", () => {
	const paint = { "fill-color": M, "fill-opacity": ["/", ["+", ["get", "w"], 1], 4] };
	const op = opsOf(POLYS, { type: "fill", paint })[0];
	const pt = check(op, "頂点");
	assert.deepEqual(pt.keys, ["class", "w"]);
	assert.equal(pt.rows.length, 3);
	const L = layerPaintTable("fill", normalizeMLLayer({ id: "x", type: "fill", paint }).paint, "ml"), v = new Float32Array(4);
	for (let r = 0; r < pt.rows.length; r++) {
		ptRowColor(L, pt.keys, pt.rows[r], v);
		const c = pt.cols[r];
		assert.deepEqual([...v].map(x => Math.round(x * 255)), [c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24], "行 " + r);
	}
});
t("(b) でない層・内蔵の層は pt を持たない", () => {
	assert.equal(opsOf(LINES, { type: "line", paint: { "line-color": "#f00" } })[0].pt, undefined);
	assert.equal(opsOf(LINES, { type: "line", paint: { "line-color": M } }, false)[0].pt, undefined);
});
t("シェーダ：md の変種（塗り・線・地面アトラス）だけが表を読む", () => {
	for (const s of [FILL_MD_VS, LINE_MD_VS, ATLAS_FILL_MD_VS]) { assert.ok(s.includes("uniform float u_pt;") && s.includes("ptColor("), "md"); }
	for (const s of [FILL_VS, LINE_VS, ATLAS_FILL_VS]) assert.ok(!s.includes("u_pt;"), "classic");
	assert.ok(LINE_MD_VS.includes("ptColor(int(B.x & 65535u))"));
	assert.ok(FILL_MD_VS.includes("ptColor(ptRowOf(a_color))"));
});
console.log(`painttable: ${n} tests passed`);
