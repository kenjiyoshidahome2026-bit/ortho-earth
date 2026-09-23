// 3D Tiles の検定試料（t-tiles3d・#41）を作る＝node tests/fixtures/tiles3d/make.mjs
// 東京駅（139.7671, 35.6812・楕円体高 40m）に ENU の根。親＝赤い大きな板（粗い）・子＝青い箱 4 棟（1 棟は RTC_CENTER）＋点群（緑）＋インスタンス（黄の箱 9 個）＋外部 tileset（紫の箱）
import { writeFileSync } from "node:fs";
const lon = 139.7671 * Math.PI / 180, lat = 35.6812 * Math.PI / 180, h0 = 40;
const a = 6378137, e2 = 0.00669437999014, N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
const O = [(N + h0) * Math.cos(lat) * Math.cos(lon), (N + h0) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h0) * Math.sin(lat)];
const E = [-Math.sin(lon), Math.cos(lon), 0], Nn = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)], U = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
const ENU = [...E, 0, ...Nn, 0, ...U, 0, ...O, 1];   // 列優先
const pad4 = (b, fill = 0x20) => { const n = (4 - b.length % 4) % 4; return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b; };
const pad8 = (b, fill = 0x20) => { const n = (8 - b.length % 8) % 8; return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b; };
// glTF の箱（Y-up：幅 w（x）・奥行 d（z）・高さ h（y）・底が y=0・中心 (cx, cz)）
function boxGlb(w, d, h, color, cx = 0, cz = 0) {
	const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y0 = 0, y1 = h;
	const faces = [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
		[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
		[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]]];
	const pos = [], nrm = [], idx = [];
	faces.forEach((f, i) => { for (let k = 0; k < 4; k++) { pos.push(...f[k]); nrm.push(...f[4]); } idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3); });
	const P = Buffer.from(new Float32Array(pos).buffer), Nb = Buffer.from(new Float32Array(nrm).buffer), I = Buffer.from(new Uint16Array(idx).buffer);
	const bin = pad4(Buffer.concat([P, Nb, pad4(I, 0)]), 0);
	const mn = [Math.min(x0, x1), y0, Math.min(z0, z1)], mx = [Math.max(x0, x1), y1, Math.max(z0, z1)];
	const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 } }],
		buffers: [{ byteLength: bin.length }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.length }, { buffer: 0, byteOffset: P.length, byteLength: Nb.length }, { buffer: 0, byteOffset: P.length + Nb.length, byteLength: I.length }],
		accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: mn, max: mx }, { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: "VEC3" }, { bufferView: 2, componentType: 5123, count: idx.length, type: "SCALAR" }] };
	const J = pad4(Buffer.from(JSON.stringify(json)));
	const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
	const cj = Buffer.alloc(8); cj.writeUInt32LE(J.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
	const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
	return Buffer.concat([head, cj, J, cb, bin]);
}
function wrap(magic, ftJson, ftBin, glbOrBody, extraHeader = null) {
	const fj = pad8(Buffer.from(JSON.stringify(ftJson))), fb = pad8(ftBin || Buffer.alloc(0), 0);
	const hl = extraHeader ? 32 : 28, head = Buffer.alloc(hl);
	head.write(magic, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(hl + fj.length + fb.length + glbOrBody.length, 8);
	head.writeUInt32LE(fj.length, 12); head.writeUInt32LE(fb.length, 16); head.writeUInt32LE(0, 20); head.writeUInt32LE(0, 24);
	if (extraHeader) head.writeUInt32LE(extraHeader, 28);
	return Buffer.concat([head, fj, fb, glbOrBody]);
}
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
writeFileSync("ext-box.b3dm", wrap("b3dm", { BATCH_LENGTH: 0 }, null, boxGlb(60, 60, 60, [0.6, 0.1, 0.8, 1], 0, 280)));
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
