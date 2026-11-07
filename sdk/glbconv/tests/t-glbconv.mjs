#!/usr/bin/env node
// glbconv の常設検定。Draco の要らない合成 GLB を組んで、全形式を一周する。
// 中身の検め方＝①書いた物を自分で読み直して頂点数・三角形数が合う（glb/gltf）②他形式はヘッダと件数を数える
// ③zip は unzip -t（CRC）が通る ④CESIUM_RTC が glb/gltf/3dtiles で保たれる。
import { convert, convertToFile, glbToScene, parseGlb, buildGlb, sceneStats, FORMATS } from "../src/index.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const enc = new TextEncoder();

// ── 合成 GLB（四面体 2 個・テクスチャ 1 枚・CESIUM_RTC つき）──
function makeGlb() {
	const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
	const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
	const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
	const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
	const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]);   // 中身は見ないので短い印だけ
	const parts = [pos, nrm, uv, idx, png];
	const views = []; let off = 0; const chunks = [];
	for (const p of parts) {
		const b = p instanceof Uint8Array ? p : new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
		const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); off += pad; }
		views.push({ buffer: 0, byteOffset: off, byteLength: b.length });
		chunks.push(b); off += b.length;
	}
	const bin = new Uint8Array(off); { let o = 0; for (const c of chunks) { bin.set(c, o); o += c.length; } }
	const json = {
		asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0, translation: [10, 0, 0] }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
		materials: [{ name: "skin", doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1], baseColorTexture: { index: 0 } } }],
		textures: [{ source: 0 }], images: [{ mimeType: "image/png", bufferView: 4 }],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] },
			{ bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
			{ bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
			{ bufferView: 3, componentType: 5123, count: 12, type: "SCALAR" },
		],
		bufferViews: views, buffers: [{ byteLength: bin.length }],
		extensions: { CESIUM_RTC: { center: [-3960801, 3345835, 3702212] } }, extensionsUsed: ["CESIUM_RTC"],
	};
	return buildGlb(json, bin);
}

const glb = makeGlb();
t("合成 GLB が読める", parseGlb(glb).json.meshes.length === 1);

const scene = await glbToScene(glb);
const st = sceneStats(scene);
t("シーン＝4 頂点・4 三角形・テクスチャ 1", st.vertices === 4 && st.triangles === 4 && st.textures === 1, JSON.stringify(st));
t("ノードの平行移動が頂点に畳まれている", scene.prims[0].positions[0] === 10);
t("CESIUM_RTC を拾う", scene.rtc && scene.rtc[0] === -3960801);

// ── 各形式 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glbconv-"));
for (const f of Object.keys(FORMATS)) {
	const files = await convert(glb, f, { name: "t" });
	t(`${f}: ファイルが出る`, files.length >= 1 && files.every(x => x.bytes?.length > 0), JSON.stringify(files.map(x => [x.name, x.bytes?.length])));
}

// glb 往復（書いた物を読み直す）
const back = await glbToScene((await convert(glb, "glb", { name: "t" }))[0].bytes);
t("GLB 往復で頂点・三角形・RTC が保たれる",
	sceneStats(back).vertices === 4 && sceneStats(back).triangles === 4 && back.rtc[0] === -3960801);
t("GLB 往復でテクスチャが残る", !!back.prims[0].material.image?.bytes?.length);

// gltf（分離）
const gl = await convert(glb, "gltf", { name: "t" });
const gj = JSON.parse(new TextDecoder().decode(gl[0].bytes));
t("glTF は .bin を外部参照", gj.buffers[0].uri === "t.bin" && gj.buffers[0].byteLength === gl[1].bytes.length);
t("glTF に POSITION の min/max がある（仕様の必須）", Array.isArray(gj.accessors[0].min) && Array.isArray(gj.accessors[0].max));

// gltf-embedded
const ge = await convert(glb, "gltf-embedded", { name: "t" });
const gje = JSON.parse(new TextDecoder().decode(ge[0].bytes));
t("glTF（1 ファイル）は data URI", String(gje.buffers[0].uri).startsWith("data:application/octet-stream;base64,"));

// obj
const obj = await convert(glb, "obj", { name: "t" });
const objText = new TextDecoder().decode(obj[0].bytes);
t("OBJ：頂点 4・面 4・mtllib・RTC コメント",
	(objText.match(/^v /gm) || []).length === 4 && (objText.match(/^f /gm) || []).length === 4
	&& objText.includes("mtllib t.mtl") && objText.includes("CESIUM_RTC"));
t("OBJ：MTL とテクスチャ画像が付く", obj.some(f => f.name === "t.mtl") && obj.some(f => f.name.endsWith(".png")));

// ply / stl
const ply = (await convert(glb, "ply", { name: "t" }))[0].bytes;
const plyHead = new TextDecoder().decode(ply.subarray(0, 400));
t("PLY：binary_little_endian・頂点 4・面 4", plyHead.startsWith("ply\nformat binary_little_endian")
	&& /element vertex 4/.test(plyHead) && /element face 4/.test(plyHead));
const stl = (await convert(glb, "stl", { name: "t" }))[0].bytes;
t("STL：ヘッダ 84＋50×面数", stl.length === 84 + 4 * 50 && new DataView(stl.buffer).getUint32(80, true) === 4);

// usdz（無圧縮 zip・64 byte 境界・先頭が usd）
const usdz = (await convert(glb, "usdz", { name: "t" }))[0].bytes;
const uf = path.join(tmp, "t.usdz"); fs.writeFileSync(uf, usdz);
{
	const dv = new DataView(usdz.buffer, usdz.byteOffset, usdz.byteLength);
	const nameLen = dv.getUint16(26, true), extraLen = dv.getUint16(28, true);
	const first = new TextDecoder().decode(usdz.subarray(30, 30 + nameLen));
	t("USDZ：先頭が .usda・無圧縮・データ先頭が 64 byte 境界",
		first.endsWith(".usda") && dv.getUint16(8, true) === 0 && ((30 + nameLen + extraLen) % 64) === 0,
		`first=${first} at=${30 + nameLen + extraLen}`);
	try { execFileSync("unzip", ["-t", uf], { encoding: "utf8" }); t("USDZ：zip として壊れていない", true); }
	catch (e) { t("USDZ：zip として壊れていない", false, String(e.stdout || e.message).slice(0, 200)); }
	const usda = new TextDecoder().decode(usdz).match(/#usda 1\.0[\s\S]*?\n\)/);
	t("USDZ：usda のヘッダが仕様の形", !!usda && /upAxis = "Y"/.test(usda[0]));
}

// 3dtiles
const tiles = await convert(glb, "3dtiles", { name: "t" });
const ts = JSON.parse(new TextDecoder().decode(tiles[0].bytes));
t("3D Tiles：tileset.json＋model.glb", tiles[0].name === "t/tileset.json" && tiles[1].name === "t/model.glb");
t("3D Tiles：境界球が RTC の近く（±100m）", Math.hypot(ts.root.boundingVolume.sphere[0] - (-3960801), ts.root.boundingVolume.sphere[1] - 3345835, ts.root.boundingVolume.sphere[2] - 3702212) < 100,
	JSON.stringify(ts.root.boundingVolume));
t("3D Tiles：content が model.glb", ts.root.content.uri === "model.glb");

// bundle（zip）
const bun = await convertToFile(glb, "obj", { name: "t" });
const zf = path.join(tmp, "t.zip"); fs.writeFileSync(zf, bun.bytes);
try { execFileSync("unzip", ["-t", zf], { encoding: "utf8" }); t("bundle：複数ファイルは zip に畳まれ CRC が通る（名前に形式が入る）", bun.name === "t-obj.zip", bun.name); }
catch (e) { t("bundle：複数ファイルは zip に畳まれ CRC が通る", false, String(e.stdout || e.message).slice(0, 200)); }

// Draco は注入口＝渡さなければ理由が分かる例外
try { await glbToScene(buildGlb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
	meshes: [{ primitives: [{ attributes: {}, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }],
	bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }], buffers: [{ byteLength: 4 }] }, new Uint8Array(4)));
	t("Draco：decodeDraco 無しは理由つきで落ちる", false);
} catch (e) { t("Draco：decodeDraco 無しは理由つきで落ちる", /decodeDraco/.test(e.message), e.message); }

fs.rmSync(tmp, { recursive: true, force: true });
// ── 錨（asset.extras.orthoEarth＝Unity との往復・2026-11-07）：RTC の無い glb の錨を ECEF（CESIUM_RTC）へ畳む ──
{
	const { toGlb, anchorOf } = await import("../src/index.ts");
	const A = { lon: 139.7671, lat: 35.6812, height: 40 };
	const stamp = (bytes, heading) => { const { json, bin } = parseGlb(bytes); json.asset.extras = { orthoEarth: { anchor: A, frame: "enu", heading } }; return buildGlb(json, bin); };
	// 頂点＝東 100 m・上 10 m（glTF の (E, U, −N)）
	const src = toGlb({ rtc: null, bbox: [0, 0, 0, 100, 10, 0], prims: [{ positions: new Float32Array([100, 10, 0, 0, 0, 0, 0, 0, -50]), normals: null, uvs: null, colors: null, indices: new Uint32Array([0, 1, 2]), material: { name: "m", baseColor: [1, 1, 1, 1], doubleSided: true, image: null } }] }, { name: "a" })[0].bytes;
	const oe = anchorOf(parseGlb(stamp(src, 0)).json);
	const enuToEcef = (e, n, u) => [0, 1, 2].map(k => oe.ecef[k] + oe.E[k] * e + oe.N[k] * n + oe.U[k] * u);
	const sc = await glbToScene(stamp(src, 0));
	t("anchor: rtc＝錨の ECEF", sc.rtc && Math.abs(sc.rtc[0] - oe.ecef[0]) < 1e-6 && Math.abs(Math.hypot(...sc.rtc) - (6378137 + 40) * 0.9995) < 20000, String(sc.rtc));
	const back = (p, i) => [sc.rtc[0] + p[i], sc.rtc[1] - p[i + 2], sc.rtc[2] + p[i + 1]];   // RTC 相対 Y-up → ECEF（ecef = rtc + (x, −z, y)）
	const v0 = back(sc.prims[0].positions, 0), w0 = enuToEcef(100, 0, 10);
	t("anchor: 東 100・上 10 の頂点が ECEF で合う", v0.every((v, k) => Math.abs(v - w0[k]) < 2e-3), `${v0} vs ${w0}`);
	const v2 = back(sc.prims[0].positions, 6), w2 = enuToEcef(0, 50, 0);   // −Z＝北 50 m
	t("anchor: −Z＝北", v2.every((v, k) => Math.abs(v - w2[k]) < 2e-3));
	const sh = await glbToScene(stamp(src, 90));   // heading 90＝模型の北が東を向く＝(0,0,−50) は東 50 m へ
	const v3 = back(sh.prims[0].positions, 6), w3 = enuToEcef(50, 0, 0);
	t("anchor: heading 90 で北が東へ", v3.every((v, k) => Math.abs(v - w3[k]) < 2e-3), `${v3} vs ${w3}`);
	const off = await glbToScene(stamp(src, 0), { anchor: false });
	t("anchor: anchor=false で畳まない", off.rtc === null && off.prims[0].positions[0] === 100);
	const plain = await glbToScene(src);
	t("anchor: extras が無ければ従来どおり", plain.rtc === null);
	const tiles = await convert(stamp(src, 0), "3dtiles", { name: "a" });
	const ts = JSON.parse(new TextDecoder().decode(tiles.find(f => f.name.endsWith("tileset.json")).bytes));
	const g = parseGlb(tiles.find(f => f.name.endsWith(".glb")).bytes).json;
	t("anchor: 3dtiles の glb が CESIUM_RTC を持つ", g.extensions?.CESIUM_RTC?.center?.length === 3 && !!ts.root);
}
console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
