// glTF の PBR 材質の読み取り（#46 段 2・2026-09-26）＝Node 単体。合成の glb（三角形 1 枚）を decodeModel に通し、
// metallicRoughness・normalTexture の scale・occlusionTexture の strength・emissive×KHR_materials_emissive_strength が batches[].pbr に載ること、
// KHR_materials_pbrSpecularGlossiness は金属 0・粗さ 1 に倒れること、材質無しは既定（金属 1・粗さ 1＝glTF の既定＝白い MR テクスチャに factor が掛かる）を見る。
// 画像は読まない（textures:false）＝テクスチャ参照は null（描画側が 1×1 の既定で埋める）。
import { decodeModel } from "@ortho-earth/globe/meshdecode.js";
let n = 0, bad = 0;
const ok = (name, c, x = "") => { n++; if (!c) bad++; console.log(`${c ? "✓" : "✗"} ${name}${x ? ` (${x})` : ""}`); };
const pad4 = b => { const k = (4 - b.length % 4) % 4; return k ? Buffer.concat([b, Buffer.alloc(k, 0x20)]) : b; };
function glb(mat) {
	const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0], nrm = [0, 0, 1, 0, 0, 1, 0, 0, 1], uv = [0, 0, 1, 0, 0, 1], idx = [0, 1, 2];
	const P = Buffer.from(new Float32Array(pos).buffer), Nb = Buffer.from(new Float32Array(nrm).buffer), U = Buffer.from(new Float32Array(uv).buffer), I = Buffer.from(new Uint16Array(idx).buffer);
	const bin = pad4(Buffer.concat([P, Nb, U, pad4(I)]));
	const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, ...(mat ? { material: 0 } : {}) }] }], ...(mat ? { materials: [mat] } : {}),
		textures: [{ source: 0 }], images: [{ uri: "data:image/png;base64,iVBORw0KGgo=" }],   // 参照先（画像は読まない）
		buffers: [{ byteLength: bin.length }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.length }, { buffer: 0, byteOffset: P.length, byteLength: Nb.length }, { buffer: 0, byteOffset: P.length + Nb.length, byteLength: U.length }, { buffer: 0, byteOffset: P.length + Nb.length + U.length, byteLength: I.length }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" }, { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" }] };
	const J = pad4(Buffer.from(JSON.stringify(json)));
	const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
	const cj = Buffer.alloc(8); cj.writeUInt32LE(J.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
	const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
	const b = Buffer.concat([head, cj, J, cb, bin]); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const dec = mat => decodeModel(glb(mat), { at: [139.7, 35.7], textures: false });
const near = (a, b) => Math.abs(a - b) < 1e-6;

const full = await dec({ pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1], metallicFactor: 0.9, roughnessFactor: 0.3, metallicRoughnessTexture: { index: 0 } },
	normalTexture: { index: 0, scale: 0.5 }, occlusionTexture: { index: 0, strength: 0.7 }, emissiveFactor: [0.1, 0.2, 0.3], emissiveTexture: { index: 0 }, extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 } } });
const p = full.batches[0].pbr;
ok("metallic/roughness の factor", near(p.metallic, 0.9) && near(p.roughness, 0.3));
ok("normalTexture.scale・occlusionTexture.strength", near(p.normalScale, 0.5) && near(p.occlusion, 0.7));
ok("emissive×emissive_strength", near(p.emissive[0], 0.2) && near(p.emissive[1], 0.4) && near(p.emissive[2], 0.6));
ok("画像を読まない＝材質テクスチャは null（描画側の既定で埋まる）", full.batches[0].texMR === null && full.batches[0].texN === null && full.batches[0].texOcc === null && full.batches[0].texEm === null);
ok("baseColor の factor は頂点色に（255,128,64）", full.batches[0].mesh.col[0] === 255 && full.batches[0].mesh.col[1] === 128 && full.batches[0].mesh.col[2] === 64);

const sg = await dec({ extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseFactor: [0.2, 0.4, 0.6, 1] } } });
ok("SpecularGlossiness＝金属 0・粗さ 1・拡散色は baseColor", near(sg.batches[0].pbr.metallic, 0) && near(sg.batches[0].pbr.roughness, 1) && sg.batches[0].mesh.col[2] === 153);

const none = await dec(null);
ok("材質無し＝glTF の既定（金属 1・粗さ 1・発光 0）", near(none.batches[0].pbr.metallic, 1) && near(none.batches[0].pbr.roughness, 1) && none.batches[0].pbr.emissive.every(v => v === 0));

console.log(bad ? `\nFAIL  ${bad}/${n}` : `\nPASS  ${n} 件すべて`);
process.exit(bad ? 1 : 0);
