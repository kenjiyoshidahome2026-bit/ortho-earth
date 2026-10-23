// line-pattern を vtdraw の線で描く検定（geojson vt plan G-4・2026-10-22）。node packages/ortho-core/tests/linepat.mjs
// 守るもの：①外来の line-pattern の層＝画像の名前と層の line-opacity（lt.pat・lt.o・層で一度）を op に添え、線に沿う位相＝始点までの距離（dist＝語 6）を書く。dash は持たない
// ②色の語は色のまま（模様を描けない道＝色の線）・paint 表も今のまま ③破線と line-gradient は無効（MapLibre の spec）・ずらしが地物ごとの層は語 6 が空かない＝色の線
// ④結合（mergeTiles）が距離と名前を写す・chopDash（WebGPU の逃げ道）は刻まない ⑤シェーダ（GL classic・md・WebGPU）が u_lt.x＝2／patP.x＝2 で語 6 を読む
import assert from "node:assert/strict";
import { buildTileDrawList, linePatternOf } from "../src/build.ts";
import { mergeTiles, chopDash } from "../src/scene.ts";
import { normalizeMLLayer } from "../src/mlstyle.ts";
import { LINE_VS, LINE_MD_VS, LINE_FS } from "../src/gl/glsl.ts";
import { LINE_WGSL, mdLineWgsl, lineXWgsl } from "../src/gpu/wgsl.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const line = (coords, ends = [coords.length]) => ({ type: "LineString", props: {}, geom: { coords, ends } });
const tileOf = (feats, z = 14) => ({ z, x: 14552 >> (14 - z), y: 6451 >> (14 - z), layers: { road: { extent: 4096, features: feats } } });
const opOf = (feats, layer, { z = 14 } = {}) => buildTileDrawList(tileOf(feats, z), { layers: [normalizeMLLayer({ id: "r", type: "line", "source-layer": "road", ...layer })] }, [0, 0]).ops[0];
const P = { "line-width": 6, "line-pattern": "arrow", "line-color": "#00ff00" };
const L3 = [line([100, 100, 1000, 100, 1000, 900])];   // 900＋800

t("名前と層の line-opacity（層で一度）・名前でない値は模様なし", () => {
	assert.deepEqual(linePatternOf({ paint: { ...P, "line-opacity": 0.4 } }, 14, "ml"), { key: "p|arrow|0.4", pat: "arrow", o: 0.4 });
	assert.equal(linePatternOf({ paint: { ...P, "line-pattern": ["step", ["zoom"], "a", 15, "b"] } }, 14, "ml").pat, "a");
	assert.equal(linePatternOf({ paint: { ...P, "line-pattern": ["step", ["zoom"], "a", 15, "b"] } }, 15, "ml").pat, "b");
	assert.equal(linePatternOf({ paint: { "line-color": "#f00" } }, 14, "ml"), null);
	assert.equal(linePatternOf({ paint: { "line-pattern": "" } }, 14, "ml"), null);
});
t("op＝lt.pat と距離（dist）・dash は持たない・色の語は色のまま", () => {
	const op = opOf(L3, { paint: P });
	assert.equal(op.lt?.pat, "arrow"); assert.equal(op.lt.lut, undefined);
	assert.ok(op.dist); assert.equal(op.dash, undefined); assert.equal(op.dz, undefined);
	assert.deepEqual([...op.col.slice(0, 4)], [0, 255, 0, 255]);
	assert.equal(op.dist[0], 0); assert.ok(op.dist[1] > 0);   // 2 本目の線分は 900 タイル単位の先
	const dK = 2 ** (32 - 14) / 4096; assert.ok(Math.abs(op.dist[1] - 900 * dK) < 1e-3 * dK, String(op.dist[1]));
});
t("端と継ぎの層（線分を並べ直す道）も距離を書く", () => {
	const op = opOf(L3, { paint: P, layout: { "line-cap": "butt", "line-join": "miter" } });
	assert.ok(op.jf && op.dist && op.lt?.pat); assert.equal(op.dist.length, op.half.length);
});
t("破線と line-gradient は無効（MapLibre）", () => {
	const d = opOf(L3, { paint: { ...P, "line-dasharray": [2, 1] } });
	assert.equal(d.dash, undefined); assert.ok(d.dist && d.lt?.pat);
	const c = opOf(L3, { paint: { ...P, "line-dasharray": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } });   // CPU で刻む長さの模様も刻まない
	assert.equal(c.half.length, 2);
	const g = opOf(L3, { paint: { ...P, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#f00", 1, "#00f"] } });
	assert.equal(g.lt.lut, undefined); assert.deepEqual([...g.col.slice(0, 4)], [0, 255, 0, 255]);
});
t("ずらし：層で 1 つの値なら並ぶ・地物ごとなら色の線（語 6 が空かない）", () => {
	const u = opOf(L3, { paint: { ...P, "line-offset": 3 } });
	assert.ok(u.lt?.pat && u.dist && u.off);
	const f = opOf([{ ...L3[0], props: { o: 2 } }], { paint: { ...P, "line-offset": ["get", "o"] } });
	assert.equal(f.lt, undefined); assert.equal(f.dist, undefined);
});
t("結合は距離と名前を写す（模様の無いタイルの分は 0）・chopDash は刻まない", () => {
	const a = opOf(L3, { paint: P }), b = opOf(L3, { paint: { ...P, "line-pattern": null } });
	assert.equal(b.dist, undefined);
	const m = mergeTiles([{ key: "14/0/0", origin: [0, 0] }, { key: "14/1/0", origin: [0, 0] }], k => ({ ops: [k === "14/0/0" ? a : b] })).layers[0];
	assert.equal(m.lt, a.lt); assert.equal(m.dist.length, m.half.length); assert.equal(m.dash, undefined);
	assert.equal(m.dist[1], a.dist[1]); assert.equal(m.dist[3], 0);
	assert.equal(chopDash(m, [0, 0]), m);
});
t("シェーダ：u_lt.x＝2／patP.x＝2 で語 6 を読み、画像を線に沿って敷く", () => {
	for (const s of [LINE_VS, LINE_MD_VS]) assert.match(s, /u_dashP\.y > 0\.5 \|\| u_lt\.x > 1\.5/);
	assert.match(LINE_MD_VS, /if \(u_dashP\.y > 0\.5 \|\| u_lt\.x > 1\.5\) \{ dist0 = uintBitsToFloat\(B\.z\)/);
	assert.match(LINE_FS, /if \(u_lt\.x > 1\.5\) \{/); assert.match(LINE_FS, /textureSize\(u_ltTex, 0\)/);
	for (const s of [lineXWgsl(LINE_WGSL, "x"), mdLineWgsl(LINE_WGSL, "md")]) { assert.match(s, /P\.dashP\.y > 0\.5 \|\| P\.patP\.x > 1\.5/); assert.match(s, /textureDimensions\(ltTex, 0\)/); }
	assert.match(mdLineWgsl(LINE_WGSL, "md"), /if \(P\.dashP\.y > 0\.5 \|\| P\.patP\.x > 1\.5\) \{ dist0 = bitcast<f32>\(B\.z\)/);
});
console.log(`\nPASS  ${n}`);
