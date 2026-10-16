// 3D Tiles の試料づくりの共通部品（tiles3d/make.mjs・tiles3d-implicit/make.mjs）＝東京駅の ENU・glTF の箱・b3dm 等の包み・詰め
const lon = 139.7671 * Math.PI / 180, lat = 35.6812 * Math.PI / 180, h0 = 40;
const a = 6378137, e2 = 0.00669437999014, N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
const O = [(N + h0) * Math.cos(lat) * Math.cos(lon), (N + h0) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h0) * Math.sin(lat)];
const E = [-Math.sin(lon), Math.cos(lon), 0], Nn = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)], U = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
export const ENU = [...E, 0, ...Nn, 0, ...U, 0, ...O, 1];   // 列優先
export const pad4 = (b, fill = 0x20) => { const n = (4 - b.length % 4) % 4; return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b; };
export const pad8 = (b, fill = 0x20) => { const n = (8 - b.length % 8) % 8; return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b; };
// glTF の箱（Y-up：幅 w（x）・奥行 d（z）・高さ h（y）・底が y=0・中心 (cx, cz)）
export function boxGlb(w, d, h, color, cx = 0, cz = 0, batchId = false) {   // batchId＝頂点の _BATCHID（全部 0・W7 の当たりの試料）
	const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y0 = 0, y1 = h;
	const faces = [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
		[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
		[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]]];
	const pos = [], nrm = [], idx = [];
	faces.forEach((f, i) => { for (let k = 0; k < 4; k++) { pos.push(...f[k]); nrm.push(...f[4]); } idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3); });
	const P = Buffer.from(new Float32Array(pos).buffer), Nb = Buffer.from(new Float32Array(nrm).buffer), I = Buffer.from(new Uint16Array(idx).buffer);
	const Bid = batchId ? Buffer.from(new Float32Array(pos.length / 3).buffer) : Buffer.alloc(0);
	const bin = pad4(Buffer.concat([P, Nb, pad4(I, 0), Bid]), 0);
	const mn = [Math.min(x0, x1), y0, Math.min(z0, z1)], mx = [Math.max(x0, x1), y1, Math.max(z0, z1)];
	const json = { asset: { version: "2.0", ...(batchId ? { copyright: "Fixture Survey; Test Imagery" } : {}) }, scene: 0,   // copyright＝出典の試料（W8・t-googletiles）
		 scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, ...(batchId ? { _BATCHID: 3 } : {}) }, indices: 2, material: 0 }] }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 } }],
		buffers: [{ byteLength: bin.length }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.length }, { buffer: 0, byteOffset: P.length, byteLength: Nb.length }, { buffer: 0, byteOffset: P.length + Nb.length, byteLength: I.length }, ...(batchId ? [{ buffer: 0, byteOffset: P.length + Nb.length + pad4(I, 0).length, byteLength: Bid.length }] : [])],
		accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: mn, max: mx }, { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: "VEC3" }, { bufferView: 2, componentType: 5123, count: idx.length, type: "SCALAR" }, ...(batchId ? [{ bufferView: 3, componentType: 5126, count: pos.length / 3, type: "SCALAR" }] : [])] };
	const J = pad4(Buffer.from(JSON.stringify(json)));
	const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
	const cj = Buffer.alloc(8); cj.writeUInt32LE(J.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
	const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
	return Buffer.concat([head, cj, J, cb, bin]);
}
export function wrap(magic, ftJson, ftBin, glbOrBody, extraHeader = null, btJson = null) {   // btJson＝batch table（b3dm・W7）
	const fj = pad8(Buffer.from(JSON.stringify(ftJson))), fb = pad8(ftBin || Buffer.alloc(0), 0), bj = btJson ? pad8(Buffer.from(JSON.stringify(btJson))) : Buffer.alloc(0);
	const hl = extraHeader ? 32 : 28, head = Buffer.alloc(hl);
	head.write(magic, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(hl + fj.length + fb.length + bj.length + glbOrBody.length, 8);
	head.writeUInt32LE(fj.length, 12); head.writeUInt32LE(fb.length, 16); head.writeUInt32LE(bj.length, 20); head.writeUInt32LE(0, 24);
	if (extraHeader) head.writeUInt32LE(extraHeader, 28);
	return Buffer.concat([head, fj, fb, bj, glbOrBody]);
}
