// 層の画面効果の検定（互換の計画 S-P1-4/5・2026-10-22）。node packages/ortho-core/tests/linefx.mjs
// 守るもの：①外来の層だけが fx＝[tx, ty, anchor, blur, rel] を持つ（translate・line-blur・vtdraw の円の circle-blur）・何も無い層と内蔵の層は持たない
// ②zoom の式はタイルの z で一度 ③結合（mergeTiles）と WebGPU の逃げ道（chopDash）が fx を写す ④シェーダ（GL classic・multi_draw の線と塗り）が u_tr・u_blur を読む
// ⑤fill-pattern＝画像の名前（pat）を層で一度・結合が写す・基図の振り分けで層を落とさない・塗りのシェーダが模様を引く
import assert from "node:assert/strict";
import { buildTileDrawList, layerFx, fillPatternOf } from "../src/build.ts";
import { mergeTiles, chopDash } from "../src/scene.ts";
import { normalizeMLLayer, splitMapLibreStyle } from "../src/mlstyle.ts";
import { readFileSync } from "node:fs";
import { LINE_VS, LINE_MD_VS, LINE_FS, FILL_VS, FILL_MD_VS, FILL_FS } from "../src/gl/glsl.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = coords => ({ type: "LineString", props: {}, geom: { coords, ends: [coords.length] } });
const poly = coords => ({ type: "Polygon", props: {}, geom: { coords: new Float32Array(coords), ends: [coords.length] } });
const tileOf = (feats, z = 14) => ({ z, x: 14552 >> (14 - z), y: 6451 >> (14 - z), layers: { road: { extent: 4096, features: feats } } });
const opsOf = (feats, layer, { ml = true, z = 14 } = {}) => buildTileDrawList(tileOf(feats, z), { layers: [ml ? normalizeMLLayer({ id: "r", "source-layer": "road", ...layer }) : { id: "r", "source-layer": "road", ...layer }] }, [0, 0]).ops;
const L1 = [line([100, 100, 1000, 100])];
const SQ = [poly([100, 100, 900, 100, 900, 900, 100, 900, 100, 100])];

t("line-translate・anchor・line-blur を fx に（外来の層だけ）", () => {
	const [op] = opsOf(L1, { type: "line", paint: { "line-width": 4, "line-translate": [3, -2], "line-translate-anchor": "viewport", "line-blur": 1.5 } });
	assert.deepEqual(op.fx, [3, -2, 1, 1.5, 0]);
	assert.equal(opsOf(L1, { type: "line", paint: { "line-width": 4 } })[0].fx, undefined);   // 何も無い層は持たない
	assert.equal(opsOf(L1, { type: "line", paint: { "line-width": 4, "line-translate": [3, 0] } }, { ml: false })[0].fx, undefined);   // 内蔵の層は読まない
});
t("fill-translate（既定の anchor は map）・zoom の式はタイルの z", () => {
	const [op] = opsOf(SQ, { type: "fill", paint: { "fill-color": "#f00", "fill-translate": ["interpolate", ["linear"], ["zoom"], 10, ["literal", [0, 0]], 20, ["literal", [0, 20]]] } }, { z: 15 });
	assert.equal(op.kind, "fill");
	assert.deepEqual(op.fx.map(v => +v.toFixed(6)), [0, 10, 0, 0, 0]);
});
t("circle-blur（vtdraw の円＝長さ 0 の線）は半径の割合（rel＝1・1 で頭打ち）", () => {
	assert.deepEqual(layerFx({ type: "line", paint: { "circle-blur": 0.5, "line-translate": [2, 0] } }, 14, "ml"), [2, 0, 0, 0.5, 1]);
	assert.deepEqual(layerFx({ type: "line", paint: { "circle-blur": 3 } }, 14, "ml"), [0, 0, 0, 1, 1]);
	assert.equal(layerFx({ type: "line", paint: { "circle-blur": 0, "line-blur": 0, "line-translate": [0, 0] } }, 14, "ml"), null);
});
t("結合と WebGPU の逃げ道：fx を写す（持たないタイルの分は最初に持つタイルの値）", () => {
	const [a] = opsOf(L1, { type: "line", paint: { "line-width": 4, "line-blur": 2 } }), [b] = opsOf(L1, { type: "line", paint: { "line-width": 4 } });
	const m = mergeTiles([{ key: "b", origin: [0, 0] }, { key: "a", origin: [0, 0] }], k => ({ ops: [k === "a" ? a : b] }));
	assert.deepEqual(m.layers[0].fx, [0, 0, 0, 2, 0]);
	const [d] = opsOf(L1, { type: "line", paint: { "line-width": 4, "line-blur": 2, "line-dasharray": [2, 1] } });
	assert.ok(d.dist); assert.deepEqual(chopDash(d, [0, 0]).fx, [0, 0, 0, 2, 0]);
	const [f] = opsOf(SQ, { type: "fill", paint: { "fill-translate": [1, 1] } });
	assert.deepEqual(mergeTiles([{ key: "f", origin: [0, 0] }], () => ({ ops: [f] })).layers[0].fx, [1, 1, 0, 0, 0]);
});
t("シェーダ：線（classic・multi_draw）は u_tr で端点と継ぎの相手をずらし u_blur で縁を薄める・塗りは u_tr で頂点をずらす", () => {
	for (const s of [LINE_VS, LINE_MD_VS]) assert.match(s, /if \(u_tr\.z != 0\.0\) \{ vec2 tr = trLL\(o \+ p1\); p0 \+= tr; p1 \+= tr; p2 \+= tr; p3 \+= tr; \}/);
	assert.match(LINE_FS, /uniform vec2 u_blur;/);
	assert.match(LINE_FS, /if \(u_blur\.x > 0\.0\) edge = /);
	for (const s of [FILL_VS, FILL_MD_VS]) assert.match(s, /dLL \+= trLL\(u_origin \+ dLL\);/);
	assert.match(FILL_MD_VS, /vec2 dLL = u_tileOff\[gl_DrawID\] \+ a_delta;[^\n]*\n\tdLL \+= trLL/);   // タイル原点差を足した後にずらす
});
t("fill-pattern：名前を層で一度（zoom の式はタイルの z・名前でない値は模様なし）・結合が写す", () => {
	const [op] = opsOf(SQ, { type: "fill", paint: { "fill-pattern": ["step", ["zoom"], "a", 15, "b"] } }, { z: 15 });
	assert.equal(op.pat, "b");
	assert.equal(opsOf(SQ, { type: "fill", paint: { "fill-pattern": "a" } }, { z: 14 })[0].pat, "a");
	assert.equal(fillPatternOf({ paint: { "fill-pattern": 3 } }, 14, "ml"), null);
	assert.equal(opsOf(SQ, { type: "fill", paint: { "fill-color": "#f00" } })[0].pat, undefined);
	assert.equal(mergeTiles([{ key: "f", origin: [0, 0] }], () => ({ ops: [op] })).layers[0].pat, "b");
});
t("基図の振り分けは fill-pattern の層を落とさない（旧＝層ごと飛ばした）", () => {
	const r = splitMapLibreStyle({ version: 8, sources: { v: { type: "vector", url: "x" } }, layers: [{ id: "w", type: "fill", source: "v", "source-layer": "l", paint: { "fill-pattern": "wetland" } }] });
	assert.deepEqual(r.base.map(L => L.id), ["w"]);
	assert.equal(r.skipped.length, 0);
});
t("シェーダ：塗りは模様の px（v_pat）を頂点で・FS は u_patP の位相と大きさで画像を引く（fill-color は読まない）", () => {
	for (const s of [FILL_VS, FILL_MD_VS]) assert.match(s, /v_pat = vec2\(dLL\.x, -dLL\.y \/ cos\(\(u_origin\.y \+ dLL\.y \* 0\.5\) \* 0\.017453293\)\) \* u_patK;/);
	assert.match(FILL_FS, /vec4 t = texture\(u_patTex, fract\(\(u_patP\.xy \+ v_pat\) \* u_patP\.zw\)\);/);
	// 模様の無い塗りでも標本器は unit 16（既定の unit 0 に md の整数テクスチャが残ると描画ごと無効＝t-mlcompat?g=style で踏んだ）
	const R = readFileSync(new URL("../src/gl/renderer.ts", import.meta.url), "utf8");
	assert.match(R, /gl\.uniform1i\(loc\(gl, prog, "u_patTex"\), PAT_UNIT\);\n\t\tif \(!name\)/);
});
console.log(`linefx: ${n} PASS`);
