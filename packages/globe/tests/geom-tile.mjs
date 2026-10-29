// 分類用 .geom タイル（3D Tiles 1.0 の Cesium 拡張）の読みの門（2026-10-29）：箱・円柱・楕円体・球を閉じた外向きの立体にし、
// 点ごとの内外の判定（inv＝ECEF → 単位の形）が内側＝true・外＝false。点群の分類（3d-tiles-point-cloud-classification）が使う。
// node tests/geom-tile.mjs
const { decodeGeom, insideUnit } = await import("../src/geom-tile.ts");
const { featureProperties } = await import("../src/mesh-features.ts");
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
// .geom を作る：箱 1（寸法 10,20,30・90° 回転）・円柱 1（半径 4・長さ 8）・楕円体 1（3,2,1）・球 1（半径 5）。並びの番号＝箱→円柱→楕円体→球
const I4 = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
const rotZ = (t) => [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];   // x → y・y → -x
const box = [10, 20, 30, ...rotZ([100, 0, 0])], cyl = [4, 8, ...I4([0, 100, 0])], ell = [3, 2, 1, ...I4([0, 0, 100])], sph = [5, -100, 0, 0];
const bin = new Float32Array([...box, ...cyl, ...ell, ...sph]);
const ftJ = { BOXES_LENGTH: 1, CYLINDERS_LENGTH: 1, ELLIPSOIDS_LENGTH: 1, SPHERES_LENGTH: 1, BOXES: { byteOffset: 0 }, CYLINDERS: { byteOffset: 19 * 4 }, ELLIPSOIDS: { byteOffset: 37 * 4 }, SPHERES: { byteOffset: 56 * 4 } };
const pad8 = s => s + " ".repeat((8 - (28 + s.length) % 8) % 8);
const jtxt = new TextEncoder().encode(pad8(JSON.stringify(ftJ))), btxt = new TextEncoder().encode(JSON.stringify({ name: ["b", "c", "e", "s"] }) + "  ");
const total = 28 + jtxt.length + bin.byteLength + btxt.length, ab = new ArrayBuffer(total), dv = new DataView(ab), u8 = new Uint8Array(ab);
u8.set(new TextEncoder().encode("geom"), 0); dv.setUint32(4, 1, true); dv.setUint32(8, total, true);
dv.setUint32(12, jtxt.length, true); dv.setUint32(16, bin.byteLength, true); dv.setUint32(20, btxt.length, true); dv.setUint32(24, 0, true);
u8.set(jtxt, 28); u8.set(new Uint8Array(bin.buffer), 28 + jtxt.length); u8.set(btxt, 28 + jtxt.length + bin.byteLength);
const T = I4([6378137, 0, 0]);   // タイルの変換＝赤道上
const g = decodeGeom(ab, T);
ok(g && g.parts.length === 4, `立体 4 つ（${g?.parts.length}）`);
ok(g.parts.map(p => p.id).join() === "0,1,2,3" && g.parts.map(p => p.shape).join() === "0,1,2,2", `番号と形（${g.parts.map(p => `${p.id}:${p.shape}`).join(" ")}）`);
ok(g.table && featureProperties(g.table, 2).name === "e", `バッチ表の名が引ける（${g.table && featureProperties(g.table, 2).name}）`);
const inside = (p, e) => { const I = p.inv, u = k => I[k] * e[0] + I[4 + k] * e[1] + I[8 + k] * e[2] + I[12 + k]; return insideUnit(p.shape, u(0), u(1), u(2)); };
const E = (x, y, z) => [6378137 + x, y, z];
for (const [p, name, inn, out] of [
	[g.parts[0], "箱（回転で x 幅 20）", E(100 + 9, 0, 0), E(100, 6, 0)],
	[g.parts[1], "円柱", E(3.5, 100, 3.9), E(0, 100, 4.1)],
	[g.parts[2], "楕円体", E(2.9, 0, 100), E(0, 2.1, 100)],
	[g.parts[3], "球", E(-100, 4.9, 0), E(-100, 5.1, 0)],
]) ok(inside(p, inn) && !inside(p, out), `${name}：内側＝true・外＝false`);
// 外向き：符号付き体積が正（分類の z-fail は外向き CCW の閉じた立体を要る）
for (const p of g.parts) {
	let V = 0; const P = p.pos;
	for (let i = 0; i < p.idx.length; i += 3) { const a = p.idx[i] * 3, b = p.idx[i + 1] * 3, c = p.idx[i + 2] * 3; V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6; }
	ok(V > 0, `立体 ${p.id} は外向き（体積 ${V.toFixed(0)}）`);
}
// 鏡映（det<0）でも外向きのまま
const gm = decodeGeom(ab, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 6378137, 0, 0, 1]);
ok(gm.parts.every(p => { let V = 0; const P = p.pos; for (let i = 0; i < p.idx.length; i += 3) { const a = p.idx[i] * 3, b = p.idx[i + 1] * 3, c = p.idx[i + 2] * 3; V += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]); } return V > 0; }), "鏡映の変換でも外向き");
console.log(fails ? `FAIL ${fails}` : "PASS");
process.exit(fails ? 1 : 0);
