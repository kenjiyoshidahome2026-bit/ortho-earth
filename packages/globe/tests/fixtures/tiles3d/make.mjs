// 3D Tiles の検定試料（t-tiles3d・#41）を作る＝node tests/fixtures/tiles3d/make.mjs
// 東京駅（139.7671, 35.6812・楕円体高 40m）に ENU の根。親＝赤い大きな板（粗い）・子＝青い箱 4 棟（1 棟は RTC_CENTER）＋点群（緑）＋インスタンス（黄の箱 9 個）＋外部 tileset（紫の箱）
import { writeFileSync } from "node:fs";
import { ENU, boxGlb, wrap } from "../tiles3d-lib.mjs";
const box = (cx, cy, cz, hx, hy, hz) => ({ box: [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz] });
// 親＝赤い板 600×600×20（ENU の z-up＝glTF では y が上・z が南）
writeFileSync("parent.b3dm", wrap("b3dm", { BATCH_LENGTH: 0 }, null, boxGlb(600, 600, 20, [0.9, 0.1, 0.1, 1])));
// 子＝青い箱 4 棟（ENU 東 x・北 y）。glTF の z＝−北。子 3 は RTC_CENTER（東 150・北 −150）で置く
const kids = [[-150, 150, 120], [150, 150, 80], [-150, -150, 160], [150, -150, 100]];
kids.forEach(([ex, ny, h], i) => {
	if (i === 3) writeFileSync(`child${i}.b3dm`, wrap("b3dm", { BATCH_LENGTH: 0, RTC_CENTER: [ex, ny, 0] }, null, boxGlb(100, 100, h, [0.1, 0.2, 0.95, 1], 0, 0)));
	else writeFileSync(`child${i}.b3dm`, wrap("b3dm", { BATCH_LENGTH: 0 }, null, boxGlb(100, 100, h, [0.1, 0.2, 0.95, 1], ex, -ny)));
});
// 点群＝緑の格子 30×30（東 −60..60・北 −60..60・高さ 5m）＝RGB
{
	const n = 900, P = new Float32Array(n * 3), C = new Uint8Array(n * 3);
	for (let i = 0; i < n; i++) { P[i*3] = -60 + (i % 30) * 4; P[i*3+1] = -60 + Math.floor(i / 30) * 4; P[i*3+2] = 5; C[i*3] = 20; C[i*3+1] = 230; C[i*3+2] = 40; }
	const bin = Buffer.concat([Buffer.from(P.buffer), Buffer.from(C.buffer)]);
	writeFileSync("points.pnts", wrap("pnts", { POINTS_LENGTH: n, POSITION: { byteOffset: 0 }, RGB: { byteOffset: P.byteLength } }, bin, Buffer.alloc(0)));
}
// インスタンス＝黄の箱 9 個（北 250 の列・東 −200..200）
{
	const n = 9, P = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { P[i*3] = -200 + i * 50; P[i*3+1] = 250; P[i*3+2] = 0; }
	writeFileSync("inst.i3dm", wrap("i3dm", { INSTANCES_LENGTH: n, POSITION: { byteOffset: 0 } }, Buffer.from(P.buffer), boxGlb(20, 20, 30, [0.95, 0.85, 0.1, 1]), 1));
}
// 外部 tileset＝紫の箱（東 0・北 −280）
// 地物 1 つ（_BATCHID 0＋batch table）＝3D Tiles の当たり（W7・t-plugin?v=tiles3d）
writeFileSync("ext-box.b3dm", wrap("b3dm", { BATCH_LENGTH: 1 }, null, boxGlb(60, 60, 60, [0.6, 0.1, 0.8, 1], 0, 280, true), null, { name: ["purple"], height: [60] }));
writeFileSync("ext.json", JSON.stringify({ asset: { version: "1.0" }, geometricError: 0, root: { boundingVolume: box(0, -280, 30, 40, 40, 40), geometricError: 0, content: { uri: "ext-box.b3dm" } } }, null, 1));
writeFileSync("tileset.json", JSON.stringify({
	asset: { version: "1.0" }, geometricError: 400,
	root: { transform: ENU, boundingVolume: box(0, 0, 80, 320, 320, 100), geometricError: 150, refine: "REPLACE", content: { uri: "parent.b3dm" },
		children: [
			...kids.map(([ex, ny, h], i) => ({ boundingVolume: box(ex, ny, h / 2, 50, 50, h / 2), geometricError: 0, content: { uri: `child${i}.b3dm` } })),
			{ boundingVolume: box(0, 0, 5, 62, 62, 2), geometricError: 0, content: { uri: "points.pnts" } },
			{ boundingVolume: box(0, 250, 15, 215, 15, 15), geometricError: 0, content: { uri: "inst.i3dm" } },
			{ boundingVolume: box(0, -280, 30, 40, 40, 40), geometricError: 0, content: { uri: "ext.json" } },
		] },
}, null, 1));
console.log("ok");
