// glTF の見出し（src/gltf-meta.js・F4 2026-10-12）＝アニメの長さ・名前の既定・テクスチャ形式・feature ID・再生 spec の正規化
import { gltfMeta, normAnimation, rawGltfJson } from "../src/gltf-meta.js";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const J = v => JSON.stringify(v);
const json = {
	accessors: [{ min: [0], max: [2.5] }, { min: [0], max: [1] }, { min: [0], max: [4] }],
	animations: [{ name: "Walk", channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }, { sampler: 1, target: { node: 1, path: "translation" } }], samplers: [{ input: 0, output: 9 }, { input: 1, output: 9 }] }, { channels: [{ sampler: 0, target: { path: "weights" } }], samplers: [{ input: 2 }] }],
	images: [{ mimeType: "image/ktx2" }, { uri: "tex/a.webp" }, { uri: "b.JPG" }],
	extensionsUsed: ["KHR_texture_basisu", "EXT_mesh_features"], extensionsRequired: ["KHR_texture_basisu"],
	skins: [{}], meshes: [{ primitives: [{ attributes: { POSITION: 0, _FEATURE_ID_0: 3 }, targets: [{ POSITION: 4 }] }] }],
};
const m = gltfMeta(json);
ok("anim", J(m.animations) === J([{ index: 0, name: "Walk", duration: 2.5, channels: 2, paths: ["rotation", "translation"] }, { index: 1, name: "animation1", duration: 4, channels: 1, paths: ["weights"] }]), J(m.animations));
ok("skins.morph", m.skins === 1 && m.morphTargets === true);
ok("formats", J(m.textureFormats) === J(["jpeg", "ktx2", "webp"]));
ok("featureIds", m.featureIds === true && m.structuralMetadata === false && m.extensionsRequired[0] === "KHR_texture_basisu");
const e = gltfMeta({});
ok("empty", e.animations.length === 0 && e.skins === 0 && e.morphTargets === false && e.textureFormats.length === 0 && e.featureIds === false);
ok("batchid", gltfMeta({ meshes: [{ primitives: [{ attributes: { _BATCHID: 1 } }] }] }).featureIds === true);
ok("basisuOnly", gltfMeta({ extensionsUsed: ["KHR_texture_basisu"] }).textureFormats.join() === "ktx2");
const A = m.animations;
ok("norm.default", J(normAnimation(true, A)) === J({ name: "Walk", index: 0, duration: 2.5, time: 0, loop: true, speed: 1, playing: true }));
ok("norm.byName", normAnimation("animation1", A).index === 1 && normAnimation({ index: 1, time: -3, speed: 0.5, loop: false }, A).time === 0);
ok("norm.null", normAnimation(null, A) === null && normAnimation(false, A) === null);
let threw = false; try { normAnimation("Run", A); } catch { threw = true; } ok("norm.unknownThrows", threw);
threw = false; try { normAnimation(5, A); } catch { threw = true; } ok("norm.indexThrows", threw);
ok("norm.noAnims", normAnimation({}, []).name === null && normAnimation({}, []).duration === 0);
// GLB の JSON chunk・.gltf の文字列・ゴミ
{ const js = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_basisu"] })), jl = (js.length + 3) & ~3; const glb = new Uint8Array(12 + 8 + jl), dv = new DataView(glb.buffer);
	dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true); dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true); glb.set(js, 20); for (let i = 20 + js.length; i < 20 + jl; i++) glb[i] = 0x20;
	ok("raw.glb", rawGltfJson(glb)?.extensionsUsed?.[0] === "KHR_texture_basisu" && rawGltfJson(glb.buffer)?.asset?.version === "2.0");
	ok("raw.gltf", rawGltfJson(new TextEncoder().encode('  {"asset":{"version":"2.0"}}'))?.asset?.version === "2.0");
	ok("raw.junk", rawGltfJson(new Uint8Array([1, 2, 3])) === null && rawGltfJson(new TextEncoder().encode("hello")) === null); }
console.log(fail ? `gltf-meta: ${fail} failed` : "✓ gltf-meta PASS");
process.exit(fail ? 1 : 0);
