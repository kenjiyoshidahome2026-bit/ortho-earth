#!/usr/bin/env node
// 統一 picking（deck.gl 差分 PR-1・2026-10-11）の純関数の常設検定：
//   ・points-gl の番号の焼き込みと読み戻し（decodeId・nearestId＝RGBA8 の窓から中心に一番近い 0 でない番号・GL の並び＝下の行が先）
//   ・czml-draw の印の当たり（nearestMark＝中心の距離 − 印の半径 ≤ r・一番近い物）
//   ・束の半直線の当たり（rayMeshes＝map.sampleHeight・2026-10-25：一番近い面・持ち上げ・剛体変換・箱の外れ・地物の番号）
// GPU の経路（FBO に描いて読む）は tests/t-pick.html（verify:ui）。
// 使い方：node packages/globe/tests/pick.mjs
import { decodeId, nearestId } from "../src/gadgets/points-gl.ts";
import { nearestMark } from "../src/gadgets/czml-draw.ts";
import { rayMeshes } from "../src/meshpick.ts";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const enc = id => [id & 255, (id >>> 8) & 255, (id >>> 16) & 255, (id >>> 24) & 255];   // FS_PICK と同じ焼き方

console.log("decodeId");
for (const id of [1, 255, 256, 65536, 16777216, 0xfffffffe]) ok(decodeId(...enc(id)) === id, `round trip ${id}`);
ok(decodeId(0, 0, 0, 0) === 0, "0＝無し");

console.log("nearestId");
const win = (side, put) => { const d = new Uint8Array(side * side * 4); for (const [i, j, id] of put) d.set(enc(id), (j * side + i) * 4); return d; };   // (i＝x, j＝GL の行＝下から)
ok(nearestId(win(5, []), 5) === null, "空の窓＝null");
{ const b = nearestId(win(5, [[2, 2, 7]]), 5); ok(b && b.id === 7 && b.distance === 0, "中心の 1 点＝距離 0"); }
{ const b = nearestId(win(5, [[0, 0, 3], [2, 3, 9]]), 5); ok(b && b.id === 9, `近い方（中心から 1）が勝つ: ${b?.id}`); ok(Math.abs(b.distance - 1) < 1e-9, "距離 1"); }
{ const b = nearestId(win(5, [[2, 4, 11]]), 5, true); ok(b && b.dy === -2, `GL の上の行（j=4）＝画面では上（dy=−2）: ${b?.dy}`); }
{ const b = nearestId(win(5, [[2, 4, 11]]), 5, false); ok(b && b.dy === 2, `flipY 無し＝dy=+2: ${b?.dy}`); }
{ const b = nearestId(win(3, [[0, 1, 5], [2, 1, 6]]), 3); ok(b && b.id === 5, "同じ距離＝先に出会った方（左）"); }

console.log("nearestMark");
const marks = [{ x: 100, y: 100, r: 4, tr: { id: "a" } }, { x: 130, y: 100, r: 10, tr: { id: "b" } }];
ok(nearestMark(marks, 300, 300, 6) === null, "遠い＝null");
ok(nearestMark(marks, 101, 101, 6)?.m.tr.id === "a", "a の上");
ok(nearestMark(marks, 115, 100, 6)?.m.tr.id === "b", "中点（a から 15・b から 15）＝半径の大きい b が届く（15−10=5 ≤ 6・a は 15−4=11 > 6）");
ok(nearestMark(marks, 108, 100, 6)?.m.tr.id === "a", "a から 8・b から 22＝a（8−4=4 ≤ 6）");
ok(nearestMark(marks, 111, 100, 0)?.m === undefined, "r=0 で a の縁の外（11−4=7 > 0）＝null");
ok(nearestMark([], 0, 0, 10) === null, "印なし＝null");

console.log("rayMeshes");
{
	// 原点 (1,0,0)（単位球の上・up＝+x）。原点相対で x＝高さの正方形（y,z ∈ [-0.01, 0.01]）を 2 枚＝高さ 0.001 と 0.002
	const sq = (h, id) => ({ pos: Float32Array.of(h, -0.01, -0.01, h, 0.01, -0.01, h, 0.01, 0.01, h, -0.01, 0.01), idx: Uint32Array.of(0, 1, 2, 0, 2, 3), origin: [1, 0, 0], features: { ids: Uint32Array.of(id, id, id, id) } });
	const down = [-1, 0, 0], from = [1.01, 0.001, 0.002];
	const a = sq(0.001, 5), b = sq(0.002, 9);
	const h1 = rayMeshes([a, b], from, down);
	ok(h1 && h1.item === 1 && Math.abs(h1.t - 0.008) < 1e-6, `上の面（高さ 0.002）に当たる: item ${h1?.item} t ${h1?.t}`);
	ok(h1?.featureId === 9, `地物の番号: ${h1?.featureId}`);
	ok(Math.abs(h1.world[0] - 1.002) < 1e-6, `交点の世界座標: ${h1?.world[0]}`);
	ok(rayMeshes([a, b], [1.01, 0.05, 0], down) === null, "正方形の外＝null");
	ok(rayMeshes([a], [1.0005, 0, 0], down) === null, "面より下から下ろす＝null（t > 0 だけ）");
	const lifted = { ...sq(0.001, 5), lift: 0.003 };
	const h2 = rayMeshes([lifted, b], from, down);
	ok(h2 && h2.item === 0 && Math.abs(h2.t - 0.006) < 1e-6, `持ち上げ（lift 0.003）＝高さ 0.004 の面が上: item ${h2?.item} t ${h2?.t}`);
	const moved = { ...sq(0.001, 5), xf: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.004, 0, 0) };   // 剛体変換＝+x に 0.004 平行移動
	const h3 = rayMeshes([moved], from, down);
	ok(h3 && Math.abs(h3.t - 0.005) < 1e-6, `剛体変換（xf）の先に当たる: t ${h3?.t}`);
	const hid = { ...sq(0.002, 9), hidden: true };
	ok(rayMeshes([hid], from, down) === null, "隠した束＝当てない");
	const slant = rayMeshes([a], [1.01, 0, 0], [-2, 0, 0]);
	ok(slant && Math.abs(slant.t - 0.0045) < 1e-6, `dir は単位でなくてよい（t は dir の倍数）: ${slant?.t}`);
}

if (fails) { console.error(`pick: ${fails} failed`); process.exit(1); }
console.log("pick: all passed");
