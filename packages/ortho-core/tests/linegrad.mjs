// line-gradient を vtdraw の線で描く検定（geojson vt plan G-3・2026-10-22）。node packages/ortho-core/tests/linegrad.mjs
// 守るもの：①外来の line-gradient の層＝色の見本（lt.lut＝["line-progress"] を 256 段・line-opacity を掛ける）を op に添え、色の語（col）は線分の始点・終点の進み（unorm16×2）
// ②進み＝geom.prog（geojson の線・geojsonvt）があれば頂点の値・細分の小片へ補う。無ければ環の頭からの長さ÷全長（vector の線の近似）
// ③色の語を進みに使う層は paint 表を持たない・CPU で刻む破線とは並ばない（色で描く）・見本の無い層は今のまま
// ④結合（mergeTiles）が見本を写す・WebGPU の逃げ道（chopDash）は片の両端へ進みを補う ⑤シェーダ（GL classic・md・WebGPU）が色の語を進みとして読む＝線分レコードは 8 語のまま
import assert from "node:assert/strict";
import { buildTileDrawList, lineGradientOf, LG_N } from "../src/build.ts";
import { mergeTiles, chopDash } from "../src/scene.ts";
import { normalizeMLLayer } from "../src/mlstyle.ts";
import { LINE_VS, LINE_MD_VS, LINE_FS } from "../src/gl/glsl.ts";
import { LINE_WGSL, mdLineWgsl, lineXWgsl } from "../src/gpu/wgsl.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = (coords, ends = [coords.length], prog) => ({ type: "LineString", props: {}, geom: { coords, ends, ...(prog ? { prog: Float32Array.from(prog) } : {}) } });
const tileOf = (feats, z = 14) => ({ z, x: 14552 >> (14 - z), y: 6451 >> (14 - z), layers: { road: { extent: 4096, features: feats } } });
const opOf = (feats, layer, { z = 14 } = {}) => buildTileDrawList(tileOf(feats, z), { layers: [normalizeMLLayer({ id: "r", type: "line", "source-layer": "road", ...layer })] }, [0, 0]).ops[0];
const G = { "line-width": 4, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#ff0000", 1, "#0000ff"] };
const prog = op => { const a = []; for (let k = 0; k < op.half.length; k++) a.push([(op.col[k * 4] | op.col[k * 4 + 1] << 8) / 65535, (op.col[k * 4 + 2] | op.col[k * 4 + 3] << 8) / 65535]); return a; };
const near = (a, b, e = 2e-5) => Math.abs(a - b) <= e;
const L3 = [line([100, 100, 1000, 100, 1000, 900])];   // 900＋800＝1700

t("見本：256 段の RGBA8・頭は赤・尻は青・真ん中は紫・line-opacity を掛ける", () => {
	const g = lineGradientOf({ paint: { ...G, "line-opacity": 0.5 } }, 14, "ml");
	assert.equal(LG_N, 256); assert.equal(g.lut.length, 256 * 4);
	assert.deepEqual([...g.lut.slice(0, 4)], [255, 0, 0, 128]);
	assert.deepEqual([...g.lut.slice(255 * 4)], [0, 0, 255, 128]);
	assert.ok(Math.abs(g.lut[128 * 4] - 127) <= 1 && Math.abs(g.lut[128 * 4 + 2] - 128) <= 1);
	assert.notEqual(g.key, lineGradientOf({ paint: G }, 14, "ml").key);   // 濃さが違えば別の見本
	assert.equal(lineGradientOf({ paint: { "line-color": "#f00" } }, 14, "ml"), null);
});
t("色の語＝線分の進み（vector の線＝環の長さの割合）・見本を添える・paint 表は持たない", () => {
	const op = opOf(L3, { paint: G });
	assert.ok(op.lt?.lut); assert.equal(op.pt, undefined);
	const p = prog(op);
	assert.equal(p.length, 2);
	assert.ok(near(p[0][0], 0) && near(p[0][1], 900 / 1700) && near(p[1][0], 900 / 1700) && near(p[1][1], 1), JSON.stringify(p));
});
t("geom.prog（geojson の線）があれば頂点の値", () => {
	const p = prog(opOf([line([100, 100, 1000, 100, 1000, 900], undefined, [0.2, 0.5, 0.8])], { paint: G }));
	assert.ok(near(p[0][0], 0.2) && near(p[0][1], 0.5) && near(p[1][0], 0.5) && near(p[1][1], 0.8), JSON.stringify(p));
});
t("細分の小片へ補う＝隣の線分の尻と頭が続く（z8＝700 m で割る）", () => {
	const p = prog(opOf([line([100, 2000, 3000, 2000], undefined, [0.1, 0.9])], { paint: G, layout: { "line-cap": "round", "line-join": "round" } }, { z: 8 }));
	assert.ok(p.length > 4, String(p.length));
	assert.ok(near(p[0][0], 0.1) && near(p[p.length - 1][1], 0.9));
	for (let j = 0; j + 1 < p.length; j++) assert.ok(near(p[j][1], p[j + 1][0]) && p[j][1] > p[j][0], JSON.stringify(p.slice(j, j + 2)));
});
t("見本の無い層＝色の語は色（今のまま）・CPU で刻む破線とは並ばない", () => {
	const op = opOf(L3, { paint: { "line-color": "#00ff00", "line-width": 2 } });
	assert.equal(op.lt, undefined); assert.deepEqual([...op.col.slice(0, 4)], [0, 255, 0, 255]);
	const d = opOf(L3, { paint: { ...G, "line-dasharray": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } });   // 10 個＝CPU で刻む
	assert.equal(d.lt, undefined);
	const s = opOf(L3, { paint: { ...G, "line-dasharray": [2, 1] } });   // シェーダの破線とは並ぶ
	assert.ok(s.lt && s.dist);
});
t("結合が見本を写す・chopDash は片の両端へ進みを補う", () => {
	const op = opOf(L3, { paint: { ...G, "line-dasharray": [2, 1] } });
	const m = mergeTiles([{ key: "14/0/0", origin: [0, 0] }], () => ({ ops: [op] })).layers[0];
	assert.equal(m.lt, op.lt);
	const c = chopDash(m, [0, 0]);
	assert.equal(c.lt, op.lt);
	const p = prog(c);
	assert.ok(p.length > 4 && p.every(([a, b]) => a >= 0 && b <= 1 && b >= a), JSON.stringify(p.slice(0, 3)));
	for (let j = 0; j + 1 < p.length; j++) assert.ok(p[j + 1][0] >= p[j][1] - 2e-5);   // 片は頭から順＝進みは減らない
});
t("シェーダは色の語を進みとして読む（GL classic・md・WebGPU classic・md）", () => {
	for (const s of [LINE_VS, LINE_MD_VS]) assert.match(s, /v_gp = u_lt\.x > 0\.5/);
	assert.match(LINE_FS, /texture\(u_ltTex/);
	for (const s of [lineXWgsl(LINE_WGSL, "x"), mdLineWgsl(LINE_WGSL, "md")]) { assert.match(s, /o\.gp = select/); assert.match(s, /textureSampleLevel\(ltTex/); }
});
console.log(`\nPASS  ${n}`);
