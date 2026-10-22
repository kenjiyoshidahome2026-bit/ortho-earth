// line-cap／line-join の検定（互換の計画 S-P1-1・2026-10-22）。node packages/ortho-core/tests/linejoin.mjs
// 守るもの：①丸い端・丸い継ぎの層（内蔵 style の既定・明示の round）は jf を持たない＝今の絵 ②外来 MapLibre の層の既定は butt／miter／2（cj）
// ③継ぐ旗（JF_*）＝継ぐ相手は並びのすぐ前後（線分レコードは増やさない＝統合ロードマップの 8 語）・閉じた環の継ぎ目は別の旗・長さ 0 の線分は書かない
// ④破線は頂点を跨ぐ片だけが継ぐ ⑤ずらす層（line-offset）は丸のまま ⑥結合（merge）で持たないタイルの分は 0（端）
// ⑦シェーダ 2 本（GL classic・multi_draw）が旗と u_cj を読む（WebGPU は次の段＝今は丸）
import assert from "node:assert/strict";
import { buildTileDrawList, lineCapJoin, JF_PREV, JF_NEXT, JF_RING_START, JF_RING_END } from "../src/build.ts";
import { mergeTiles } from "../src/scene.ts";
import { normalizeMLLayer } from "../src/mlstyle.ts";
import { LINE_VS, LINE_MD_VS, LINE_FS } from "../src/gl/glsl.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = (coords, ends = [coords.length]) => ({ type: "LineString", props: {}, geom: { coords, ends } });
const tileOf = feats => ({ z: 14, x: 14552, y: 6451, layers: { road: { extent: 4096, features: feats } } });   // z14＝細分（700m）より短い線分は割らない
const opOf = (feats, layer, ml = true) => buildTileDrawList(tileOf(feats), { layers: [ml ? normalizeMLLayer({ id: "r", type: "line", "source-layer": "road", ...layer }) : { id: "r", type: "line", "source-layer": "road", ...layer }] }, [0, 0]).ops[0];
const L3 = [line([100, 100, 1000, 100, 1000, 900])];   // 直角に折れる 3 点＝線分 2 本
const pt = (a, i) => [a[i * 2], a[i * 2 + 1]];
const BUTT = 1, MITER = 1 << 2, BEVEL = 2 << 2, SQUARE = 2;

t("内蔵の層（出自が ml でない）の既定は丸＝jf を持たない（今の絵）", () => { const op = opOf(L3, {}, false); assert.equal(op.jf, undefined); assert.equal(op.cj, undefined); });
t("外来の層の既定＝butt・miter・miter-limit 2（cj＝1 | 1<<2 | 16<<4）", () => { const op = opOf(L3, {}); assert.equal(op.cj, BUTT | MITER | 16 << 4); assert.equal(op.jf.length, op.half.length); });
t("明示の round／round は jf を持たない", () => assert.equal(opOf(L3, { layout: { "line-cap": "round", "line-join": "round" } }).jf, undefined));
t("round の端と bevel の継ぎ・miter-limit の式（zoom）", () => assert.equal(opOf(L3, { layout: { "line-cap": "round", "line-join": "bevel", "line-miter-limit": ["step", ["zoom"], 1, 10, 3] } }).cj, BEVEL | 24 << 4));
t("square の端", () => assert.equal(opOf(L3, { layout: { "line-cap": "square" } }).cj & 3, SQUARE));
t("lineCapJoin：読めない値は既定", () => { assert.equal(lineCapJoin({ "line-cap": "nope", "line-join": 5 }, 10, "ml"), BUTT | MITER | 16 << 4); assert.equal(lineCapJoin(null, 10, undefined), 16 << 4); });
t("旗：始点は端・継ぎ目は互いに継ぐ・終点は端（継ぐ相手は並びのすぐ前後＝端点が一致）", () => {
	const op = opOf(L3, {});
	assert.equal(op.half.length, 2);
	assert.deepEqual([...op.jf], [JF_NEXT, JF_PREV]);
	assert.deepEqual(pt(op.P2, 0), pt(op.P1, 1));
});
t("閉じた環の継ぎ目は環の旗（並びの隣でない＝シェーダは丸に倒す）・途中は普通に継ぐ", () => {
	const op = opOf([line([100, 100, 1000, 100, 1000, 900, 100, 100])], {});
	const k = op.half.length - 1;
	assert.equal(op.jf[0], JF_RING_START | JF_NEXT); assert.equal(op.jf[k], JF_PREV | JF_RING_END);
	for (let i = 1; i < k; i++) assert.equal(op.jf[i], JF_PREV | JF_NEXT);
});
t("長さ 0 の線分は書かない＝前後が並びの隣で継ぐ", () => {
	const op = opOf([line([100, 100, 1000, 100, 1000, 100, 1000, 900])], {});
	assert.equal(op.half.length, 2);
	assert.deepEqual([...op.jf], [JF_NEXT, JF_PREV]);
});
t("丸の層は長さ 0 の線分も書く（丸点＝vtdraw の circle）", () => assert.equal(opOf([line([100, 100, 100, 100])], { layout: { "line-cap": "round", "line-join": "round" } }).half.length, 1));
t("別の線（MultiLineString の 2 本）はつながない", () => {
	const op = opOf([line([100, 100, 1000, 100, 1000, 100, 1000, 900], [4, 8])], {});
	assert.deepEqual([...op.jf], [0, 0]);
});
t("CPU で刻む破線：頂点を跨ぐ片だけが継ぐ・片の頭と尻は端（内蔵の層の px の模様・外来の層はシェーダの破線＝linedash.mjs）", () => {
	// 線 400 タイル単位＝模様 [4, 4]×(4096/256)＝64 単位の線と間。頂点 (1000,100) は 900 単位目＝線の片の途中（896〜960）
	const op = opOf(L3, { layout: { "line-cap": "butt" }, paint: { "line-width": 1, "line-dasharray": [4, 4] } }, false);
	const i = op.jf.indexOf(JF_PREV);
	assert.equal(op.jf.filter(f => f).length, 2); assert.equal(op.jf[i - 1], JF_NEXT);
	assert.deepEqual(pt(op.P2, i - 1), pt(op.P1, i));
});
t("line-offset の層は丸のまま（角の継ぎは miterSlides）", () => assert.equal(opOf(L3, { paint: { "line-offset": 2 } }).jf, undefined));
t("結合：jf を持たないタイルの分は 0（端）・旗はそのまま写す", () => {
	const a = opOf(L3, {}), b = opOf(L3, { layout: { "line-cap": "round", "line-join": "round" } });
	b.li = a.li;
	const s = mergeTiles([{ key: "a", origin: [0, 0] }, { key: "b", origin: [1, 2] }], k => ({ ops: [k === "a" ? a : b] }), { origin: [0, 0] });
	const m = s.layers[0];
	assert.equal(m.cj, a.cj); assert.deepEqual([...m.jf], [JF_NEXT, JF_PREV, 0, 0]);
	assert.ok(Math.abs(m.P1[4] - (b.P1[0] + 1)) < 1e-6);
});
t("シェーダ（GL classic・multi_draw）が旗と u_cj を読む・線分レコードは 2 texel のまま・FS が継ぎの切り口を画素の中心で測る", () => {
	assert.match(LINE_VS, /in float a_jf;/); assert.match(LINE_VS, /in vec2 a_p0;/); assert.match(LINE_VS, /in vec2 a_p3;/);
	assert.match(LINE_MD_VS, /int t0 = seg \* 2;/); assert.match(LINE_MD_VS, /B\.y & 15u/); assert.match(LINE_MD_VS, /int tp = t0 - 2;/); assert.match(LINE_MD_VS, /int tn = t0 \+ 2;/);
	for (const s of [LINE_VS, LINE_MD_VS]) assert.match(s, /uniform float u_cj;/);
	assert.match(LINE_FS, /gl_FragCoord/); assert.match(LINE_FS, /lineTail/);
});
console.log(`linejoin: ${n} PASS`);
