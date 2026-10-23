// 3D Tiles の voxel（glTF の EXT_primitive_voxels＋KHR_implicit_shapes・tileset の 3DTILES_content_voxels・2026-10-23）の検定試料（t-tiles3d-voxel・tiles3d-voxel.mjs）を作る＝node tests/fixtures/tiles3d-voxel/make.mjs
// 東京駅（139.7671, 35.6812・楕円体高 40m）に ENU の根（tiles3d と同じ）。glTF は Y-up＝x が東・y が上・z が南。
//   tileset.json（glTF に形がある経路）：
//     子 0（南西）＝KHR_implicit_shapes の box（size 100×80×100・中心が原点・ノードの平行移動で ENU (−100, −100, 40) に）・Float32 の _DENSITY（8×6×8・padding 1）・noData −1・EXT_structural_metadata の class "vox"
//     子 1（東）＝EXT_implicit_ellipsoid_region（経緯度の枠・高さ 40〜120 m）・Uint8 の RGBA（_COLOR・4×4×2・赤）
//   tileset-content.json（Cesium の tileset の経路）：root.content の 3DTILES_content_voxels（dimensions 4×4×4・class "vox"）＋box の境界体積（ENU (−100, 150, 40)＝北西・半軸 50/50/40）・glb は属性（_DENSITY）だけ・形は無い
import { writeFileSync } from "node:fs";
import { ENU, pad4 } from "../tiles3d-lib.mjs";
const LON = 139.7671, LAT = 35.6812, D2R = Math.PI / 180;
const F32 = a => Buffer.from(new Float32Array(a).buffer);
function glb(json, parts) {   // parts＝Buffer の列（bufferView を順に・4 byte 詰め）
	const views = [], chunks = []; let off = 0;
	for (const b of parts) { const p = pad4(b, 0); views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(p); off += p.length; }
	const bin = Buffer.concat(chunks);
	const J = pad4(Buffer.from(JSON.stringify({ ...json, buffers: [{ byteLength: bin.length }], bufferViews: views })));
	const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
	const cj = Buffer.alloc(8); cj.writeUInt32LE(J.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
	const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
	return Buffer.concat([head, cj, J, cb, bin]);
}
const VOXEL_MODE = 2147483647;
const META = { schema: { id: "voxels", classes: { vox: { properties: { density: { type: "SCALAR", componentType: "FLOAT32" } } } } }, propertyAttributes: [{ class: "vox", properties: { density: { attribute: "_DENSITY" } } }] };
/** 子 0 の値（padding 込み・x が最速）＝内側は f(i,j,k)＝(i + j·8 + k·48) / 384・(0,0,0) だけ noData −1・padding は 999（剥げたか見る） */
export const density0 = (i, j, k) => (i === 0 && j === 0 && k === 0) ? -1 : (i + j * 8 + k * 48) / 384;
function child0() {
	const dims = [8, 6, 8], full = [10, 8, 10], v = new Float32Array(full[0] * full[1] * full[2]).fill(999);
	for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) v[(i + 1) + full[0] * ((j + 1) + full[1] * (k + 1))] = density0(i, j, k);
	return glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_primitive_voxels", "KHR_implicit_shapes", "EXT_structural_metadata"],
		extensions: { KHR_implicit_shapes: { shapes: [{ type: "box", box: { size: [100, 80, 100] } }] }, EXT_structural_metadata: META },
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [-100, 40, 100] }],   // ENU (−100, −100, 40)＝glTF (x 東, y 上, z 南)
		meshes: [{ primitives: [{ mode: VOXEL_MODE, attributes: { _DENSITY: 0 }, extensions: { EXT_primitive_voxels: { shape: 0, dimensions: dims, padding: { before: [1, 1, 1], after: [1, 1, 1] }, noData: { _DENSITY: [-1] } } } }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: v.length, type: "SCALAR" }] }, [F32(v)]);
}
export const REGION1 = [LON + 0.001, LAT - 0.001, LON + 0.003, LAT + 0.001, 40, 120];   // 度・m
function child1() {
	const dims = [4, 4, 2], n = dims[0] * dims[1] * dims[2], c = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) c.set([255, 30, 30, 255], i * 4);
	return glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_primitive_voxels", "KHR_implicit_shapes", "EXT_implicit_ellipsoid_region"],
		extensions: { KHR_implicit_shapes: { shapes: [{ type: "box", extensions: { EXT_implicit_ellipsoid_region: { semiMajorAxisRadius: 6378137, semiMinorAxisRadius: 6356752.314245, minLongitude: REGION1[0] * D2R, minLatitude: REGION1[1] * D2R, maxLongitude: REGION1[2] * D2R, maxLatitude: REGION1[3] * D2R, minHeight: REGION1[4], maxHeight: REGION1[5] } } }] } },
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ mode: VOXEL_MODE, attributes: { _COLOR: 0 }, extensions: { EXT_primitive_voxels: { shape: 0, dimensions: dims } } }] }],
		accessors: [{ bufferView: 0, componentType: 5121, normalized: true, count: n, type: "VEC4" }] }, [Buffer.from(c.buffer)]);
}
/** content の値（4×4×4）＝(i + j·4 + k·16) / 64 */
export const densityC = (i, j, k) => (i + j * 4 + k * 16) / 64;
function content() {
	const dims = [4, 4, 4], v = new Float32Array(64);
	for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) v[i + 4 * (j + 4 * k)] = densityC(i, j, k);
	return glb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_structural_metadata"], extensions: { EXT_structural_metadata: META },
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ mode: VOXEL_MODE, attributes: { _DENSITY: 0 } }] }],   // 形も EXT_primitive_voxels も無い＝tileset の宣言と境界体積で置く
		accessors: [{ bufferView: 0, componentType: 5126, count: 64, type: "SCALAR" }] }, [F32(v)]);
}
const dir = new URL("./", import.meta.url);
writeFileSync(new URL("child0.glb", dir), child0());
writeFileSync(new URL("child1.glb", dir), child1());
writeFileSync(new URL("content.glb", dir), content());
const r1 = REGION1.map((v, i) => i < 4 ? v * D2R : v);
writeFileSync(new URL("tileset.json", dir), JSON.stringify({ asset: { version: "1.1" }, geometricError: 400, extensionsUsed: ["EXT_primitive_voxels"],
	root: { transform: ENU, boundingVolume: { box: [0, 0, 80, 300, 0, 0, 0, 300, 0, 0, 0, 80] }, geometricError: 100, refine: "REPLACE", children: [
		{ boundingVolume: { box: [-100, -100, 40, 50, 0, 0, 0, 50, 0, 0, 0, 40] }, geometricError: 0, content: { uri: "child0.glb" } },
		{ boundingVolume: { region: r1 }, geometricError: 0, content: { uri: "child1.glb" } }] } }, null, 1));
writeFileSync(new URL("tileset-content.json", dir), JSON.stringify({ asset: { version: "1.1" }, geometricError: 400, extensionsUsed: ["3DTILES_content_voxels"], schema: META.schema,
	root: { transform: ENU, boundingVolume: { box: [-100, 150, 40, 50, 0, 0, 0, 50, 0, 0, 0, 40] }, geometricError: 0, refine: "REPLACE",
		content: { uri: "content.glb", extensions: { "3DTILES_content_voxels": { class: "vox", dimensions: [4, 4, 4] } } } } }, null, 1));
console.log("tiles3d-voxel: child0.glb child1.glb content.glb tileset.json tileset-content.json");
