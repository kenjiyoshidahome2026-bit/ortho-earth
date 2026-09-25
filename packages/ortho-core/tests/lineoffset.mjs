// line-offset の検定（src/build.js・scene.js・#49・2026-09-25）。node packages/ortho-core/tests/lineoffset.mjs
// 守るもの：①層が持つ時だけ線分ごとの off（画面 px）を添える＝持たない層は 0 バイト ②式（zoom・属性）が評価される
// ③破線と併用できる ④結合（merge）で持たないタイルの分は 0 で埋まる ⑤シェーダ 3 本（GL classic・multi_draw・WGSL）が off を読む
// ⑥角の継ぎ（miterSlides）＝隣り合う線分のずらした端点が同じ所に着く（線分ごとの法線だけだと細かく折れる線が点々に散る）
import assert from "node:assert/strict";
import { buildTileDrawList, miterSlides } from "../src/build.js";
import { mergeTiles } from "../src/scene.js";
import { convertLayer } from "../src/mlstyle.js";
import { LINE_VS, LINE_MD_VS } from "../src/gl/glsl.js";
import { LINE_WGSL, LINE_SH_WGSL } from "../src/gpu/wgsl.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

const tile = { z: 10, x: 900, y: 400, layers: { road: { extent: 4096, features: [
	{ type: "LineString", props: { k: 3 }, geom: { coords: [0, 2048, 4096, 2048], ends: [4] } },
	{ type: "LineString", props: { k: -2 }, geom: { coords: [0, 1000, 4096, 1000], ends: [4] } },
] } } };
const offs = op => op.off.filter((_, i) => i % 3 === 0);   // [off, tS, tE]×線分 の off だけ
const opOf = paint => buildTileDrawList(tile, { layers: [convertLayer({ id: "r", type: "line", "source-layer": "road", paint: { "line-width": 2, ...paint } })] }, [0, 0]).ops[0];

t("line-offset なしの層は off を持たない（従来どおりの 4 本）", () => assert.equal(opOf({}).off, undefined));
t("数の line-offset は全線分に同じ値（[off, tS, tE]×線分）", () => { const op = opOf({ "line-offset": 4 }); assert.equal(op.off.length, op.half.length * 3); assert.ok(offs(op).every(v => v === 4)); });
t("負の値（左へ）もそのまま", () => assert.ok(offs(opOf({ "line-offset": -1.5 })).every(v => v === -1.5)));
t("属性の式は地物ごと", () => { const op = opOf({ "line-offset": ["get", "k"] }); assert.deepEqual([...new Set(offs(op))].sort(), [-2, 3]); });
t("zoom の式（z10 で 0）＝全部 0 なら持たない", () => assert.equal(opOf({ "line-offset": ["step", ["zoom"], 0, 12, 5] }).off, undefined));
t("読めない値は 0（線は消さない）", () => { const op = opOf({ "line-offset": ["get", "nope"] }); assert.ok(op.half.length > 0); assert.equal(op.off, undefined); });
t("破線と併用＝片ごとに off が付く", () => { const op = opOf({ "line-offset": 2, "line-dasharray": [2, 1] }); assert.ok(op.half.length > 10); assert.equal(op.off.length, op.half.length * 3); });
t("結合：持つタイルと持たないタイルが混ざっても長さが揃い、持たない分は 0", () => {
	const a = { ops: [{ ...opOf({ "line-offset": 3 }), li: 0 }] }, b = { ops: [{ ...opOf({}), li: 0 }] };
	const geom = { "10/900/400": a, "10/901/400": b };
	const m = mergeTiles([{ key: "10/900/400", origin: [0, 0] }, { key: "10/901/400", origin: [0, 0] }], k => geom[k]);
	const L = m.layers[0], na = a.ops[0].half.length;
	assert.equal(L.off.length, L.half.length * 3);
	assert.ok(offs({ off: L.off.subarray(0, na * 3) }).every(v => v === 3) && L.off.subarray(na * 3).every(v => v === 0));
});
t("結合：どのタイルも持たない層は off を作らない", () => {
	const g = { ops: [{ ...opOf({}), li: 0 }] };
	assert.equal(mergeTiles([{ key: "10/900/400", origin: [0, 0] }], () => g).layers[0].off, undefined);
});
// ⑥ 角の継ぎ：端点 P＋off×(n＋d×t) が隣の線分と一致する（タイル座標＝y 下向き・右＝(-dy,dx)）
const joinGap = (coords, off) => {
	const [tS, tE] = miterSlides(coords, 0, coords.length), n = coords.length / 2 - 1;
	const seg = k => { const ax = coords[k * 2], ay = coords[k * 2 + 1], bx = coords[k * 2 + 2], by = coords[k * 2 + 3], l = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / l, dy = (by - ay) / l;
		return { s: [ax + off * (-dy + dx * tS[k]), ay + off * (dx + dy * tS[k])], e: [bx + off * (-dy + dx * tE[k]), by + off * (dx + dy * tE[k])] }; };
	let worst = 0; for (let k = 0; k + 1 < n; k++) { const a = seg(k).e, b = seg(k + 1).s; worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1])); }
	return { worst, tS, tE };
};
t("角の継ぎ：直角の右折（東→南）は t＝−1／+1 で端点が一致", () => { const r = joinGap([0, 0, 10, 0, 10, 10], 2); assert.ok(r.worst < 1e-9, r.worst); assert.ok(Math.abs(r.tE[0] + 1) < 1e-9 && Math.abs(r.tS[1] - 1) < 1e-9); });
t("角の継ぎ：ぎざぎざの線（30 点）でも端点が一致＝散らない", () => {
	const c = []; for (let i = 0; i < 30; i++) c.push(i * 3, (i % 2) * 1 + (i % 5) * 0.4);   // 折れは 90° 未満（限界の内）
	assert.ok(joinGap(c, 5).worst < 1e-4);   // t は Float32
});
t("角の継ぎ：線の頭と尻は 0・閉じた環は一周つなぐ", () => {
	const open = miterSlides([0, 0, 10, 0, 10, 10], 0, 6); assert.equal(open[0][0], 0); assert.equal(open[1][1], 0);
	const ring = miterSlides([0, 0, 10, 0, 10, 10, 0, 10, 0, 0], 0, 10); assert.ok(ring[0][0] !== 0 && ring[1][3] !== 0);
});
t("角の継ぎ：鋭角は |t|≤1 で打ち切り・折り返しは 0・長さ 0 の線分でも NaN にならない", () => {
	const [s1, e1] = miterSlides([0, 0, 10, 0, 0, 0.1], 0, 6); assert.ok(Math.abs(e1[0]) <= 1 && Math.abs(s1[1]) <= 1);
	const [s2, e2] = miterSlides([0, 0, 10, 0, 10, 0, 20, 0], 0, 8); assert.ok([...s2, ...e2].every(Number.isFinite));
});
t("組み立て：line-offset の層は線分ごとに角の継ぎ（t）を添える＝細分の途中は 0", () => {
	const tl = { z: 10, x: 900, y: 400, layers: { road: { extent: 4096, features: [{ type: "LineString", props: {}, geom: { coords: [0, 0, 2000, 0, 2000, 2000], ends: [6] } }] } } };
	const op = buildTileDrawList(tl, { layers: [{ id: "r", type: "line", "source-layer": "road", paint: { "line-width": 2, "line-offset": 3 } }] }, [0, 0]).ops[0];
	const ts = []; for (let i = 0; i < op.half.length; i++) ts.push([op.off[i * 3 + 1], op.off[i * 3 + 2]]);
	assert.ok(ts.some(([, e]) => Math.abs(e + 1) < 1e-6) && ts.some(([s]) => Math.abs(s - 1) < 1e-6), JSON.stringify(ts));   // 角（右折）の両側
	assert.equal(ts.filter(([s, e]) => s || e).length, 2);   // 角に接する 2 片だけ
});
t("シェーダ：GL classic は a_off（vec3）・multi_draw は線分プールの 3・4 語目・WGSL は location 5（影の派生も）", () => {
	assert.match(LINE_VS, /in vec3 a_off;/); assert.match(LINE_VS, /vec3 off0 = a_off/);
	assert.match(LINE_MD_VS, /vec3 off0 = vec3\(uintBitsToFloat\(B\.z\), unpackSnorm2x16\(B\.w\) \* 2\.0\)/);
	for (const w of [LINE_WGSL, LINE_SH_WGSL]) { assert.match(w, /@location\(5\) offT: vec3f/); assert.match(w, /sa \+= \(perp \+ dirS \* offT\.y\) \* offPx/); }
	assert.match(LINE_VS, /sa \+= \(perp \+ dir \* off0\.y\) \* offPx/);
});

console.log(`\n✅ lineoffset ${n} 件`);
