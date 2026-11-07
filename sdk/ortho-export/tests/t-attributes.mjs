// ortho-export の検定（2）：PLATEAU の建物属性（b3dm の batch table）と棟ごとのノード・webp テクスチャの焼き直し。網は使わない。
//   見本＝千代田区の実タイル（2026-11-07 に調べた形）を小さく真似た b3dm：Draco（_BATCHID・NORMAL・POSITION・TEXCOORD_0）＋CESIUM_RTC＋
//   EXT_texture_webp（fallback の source なし）＋batch table（JSON の配列・attributes のネスト・binary の DOUBLE/BYTE）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import draco3d from "draco3d";
import { makeAnchor } from "../src/geo.mjs";
import { exportArea } from "../src/export.mjs";
import { readB3dm, batchTableRows, attributeTable, createDracoDecoder, featureIdOf } from "../src/features.mjs";
import { transcodeGlbImages, imageSize, foreignImages } from "../src/textures.mjs";
import { parseGlb, buildGlb, glbToScene } from "glbconv";

let pass = 0;
const ok = async (name, f) => { await f(); pass++; console.log("✓", name); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);
const enc = new TextEncoder();
const pad = (u8, fill = 0) => { const p = (8 - (u8.length % 8)) % 8; if (!p) return u8; const o = new Uint8Array(u8.length + p).fill(fill); o.set(u8); return o; };

const bbox = [139.7625, 35.6785, 139.7700, 35.6840];
const D2R = Math.PI / 180;
const anchor0 = makeAnchor({ lon: 139.76625, lat: 35.68125, height: 40 });   // RTC の基準（タイルの中心）

// ── 見本のタイル：棟 0（錨の東 10 m の箱の屋根 2 枚・テクスチャ）と棟 1（bbox の外・北へ 2 km）──
// タイルの glTF 座標（Y-up）＝ECEF の (x, z, −y) − RTC。各棟は 1 枚の正方形（三角形 2 つ）を高さ 10 m に置く
const RTC = anchor0.ecef;
const enuToTile = enu => { const p = anchor0.fromEnu(enu); return [p[0] - RTC[0], p[2] - RTC[2], -(p[1] - RTC[1])]; };
const quads = [[10, 0], [0, 2000]];   // ENU の (e, n)
const pos = [], nrm = [], uv = [], bid = [], idx = [];
for (const [b, [e, n]] of quads.entries()) {
	const base = pos.length / 3;
	for (const [de, dn] of [[0, 0], [5, 0], [5, 5], [0, 5]]) {
		pos.push(...enuToTile([e + de, n + dn, 10]));
		const up = anchor0.U; nrm.push(up[0], up[2], -up[1]);
		uv.push(de / 5, dn / 5); bid.push(b);
	}
	idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
const E = await draco3d.createEncoderModule({});
const dracoBytes = (() => {
	const builder = new E.MeshBuilder(), mesh = new E.Mesh(), encoder = new E.Encoder();
	builder.AddFacesToMesh(mesh, idx.length / 3, new Uint32Array(idx));
	const ids = {
		POSITION: builder.AddFloatAttributeToMesh(mesh, E.POSITION, pos.length / 3, 3, new Float32Array(pos)),
		NORMAL: builder.AddFloatAttributeToMesh(mesh, E.NORMAL, pos.length / 3, 3, new Float32Array(nrm)),
		TEXCOORD_0: builder.AddFloatAttributeToMesh(mesh, E.TEX_COORD, pos.length / 3, 2, new Float32Array(uv)),
		_BATCHID: builder.AddFloatAttributeToMesh(mesh, E.GENERIC, pos.length / 3, 1, new Float32Array(bid)),
	};
	encoder.SetSpeedOptions(5, 5);
	const out = new E.DracoInt8Array(), len = encoder.EncodeMeshToDracoBuffer(mesh, out);
	const u8 = new Uint8Array(len); for (let i = 0; i < len; i++) u8[i] = out.GetValue(i) & 255;
	E.destroy(out); E.destroy(encoder); E.destroy(mesh); E.destroy(builder);
	return { u8, ids };
})();
// webp の頭（VP8L・幅 4096×高さ 2048）＋中身は飾り＝変換器は注入した偽物
const webp = (() => {
	const w = 4096 - 1, h = 2048 - 1, v = (w & 0x3fff) | ((h & 0x3fff) << 14);
	const b = new Uint8Array(40); b.set(enc.encode("RIFF"), 0); b.set(enc.encode("WEBP"), 8); b.set(enc.encode("VP8L"), 12);
	b[20] = 0x2f; b[21] = v & 255; b[22] = (v >> 8) & 255; b[23] = (v >> 16) & 255; b[24] = (v >>> 24) & 255;
	return b;
})();
const tileGlb = (() => {
	const bin = new Uint8Array(pad(webp).length + pad(dracoBytes.u8).length);
	bin.set(webp, 0); bin.set(dracoBytes.u8, pad(webp).length);
	const nv = pos.length / 3;
	const json = {
		asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		extensionsUsed: ["CESIUM_RTC", "EXT_texture_webp", "KHR_draco_mesh_compression"], extensionsRequired: ["CESIUM_RTC", "EXT_texture_webp", "KHR_draco_mesh_compression"],
		extensions: { CESIUM_RTC: { center: RTC } },
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: webp.length }, { buffer: 0, byteOffset: pad(webp).length, byteLength: dracoBytes.u8.length }],
		buffers: [{ byteLength: bin.length }],
		images: [{ mimeType: "image/webp", bufferView: 0 }],
		samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
		textures: [{ sampler: 0, extensions: { EXT_texture_webp: { source: 0 } } }],
		materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 0 }, metallicFactor: 0, roughnessFactor: 0 } }],
		accessors: [
			{ componentType: 5126, count: nv, type: "VEC3" }, { componentType: 5126, count: nv, type: "VEC3" }, { componentType: 5126, count: nv, type: "VEC2" },
			{ componentType: 5126, count: nv, type: "SCALAR" }, { componentType: 5125, count: idx.length, type: "SCALAR" },
		],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, _BATCHID: 3 }, indices: 4, material: 0, mode: 4,
			extensions: { KHR_draco_mesh_compression: { bufferView: 1, attributes: dracoBytes.ids } } }] }],
	};
	return buildGlb(json, bin);
})();
const bt = {
	gml_id: ["bldg_aaaa-0001", "bldg_bbbb-0002"],
	meshcode: ["53394611", "53394621"],
	"bldg:measuredHeight": [8.2, null],
	"gml:name": [null, "遠いビル"],
	attributes: [
		{ "bldg:class": "普通建物", "bldg:usage": "業務施設", "bldg:storeysAboveGround": 9999,
			"gen:genericAttribute": [{ type: "string", name: "建物ID", value: "13101-bldg-508" }],
			"uro:BuildingIDAttribute": [{ "uro:buildingID": "13101-bldg-508", "uro:prefecture": "東京都" }] },
		{ "bldg:usage": "商業施設" },
	],
	"全部 null": [null, null],
	specifiedFloorAreaRate: { byteOffset: 0, componentType: "DOUBLE", type: "SCALAR" },
	_lod: { byteOffset: 16, componentType: "BYTE", type: "SCALAR" },
	_x: { byteOffset: 24, componentType: "DOUBLE", type: "SCALAR" },
	_y: { byteOffset: 40, componentType: "DOUBLE", type: "SCALAR" },
};
const cx0 = (() => { const p = anchor0.fromEnu([12.5, 2.5, 10]); return Math.atan2(p[1], p[0]) * 180 / Math.PI; })();   // 棟の中心の経度（batch table の _x）
const btBin = (() => {
	const b = new Uint8Array(56), dv = new DataView(b.buffer);
	dv.setFloat64(0, 1300, true); dv.setFloat64(8, 600, true); dv.setInt8(16, 2); dv.setInt8(17, 2);
	dv.setFloat64(24, cx0, true); dv.setFloat64(32, cx0, true);
	dv.setFloat64(40, anchor0.lat + 2.5 / 111000, true); dv.setFloat64(48, anchor0.lat + 2002.5 / 111000, true);   // 棟 1 は北へ 2 km＝bbox の外
	return b;
})();
const b3dm = (() => {
	const ft = pad(enc.encode(JSON.stringify({ BATCH_LENGTH: 2 })), 0x20), btj = pad(enc.encode(JSON.stringify(bt)), 0x20), glb = tileGlb;
	const out = new Uint8Array(28 + ft.length + btj.length + btBin.length + glb.length), dv = new DataView(out.buffer);
	out.set(enc.encode("b3dm"), 0); dv.setUint32(4, 1, true); dv.setUint32(8, out.length, true);
	dv.setUint32(12, ft.length, true); dv.setUint32(16, 0, true); dv.setUint32(20, btj.length, true); dv.setUint32(24, btBin.length, true);
	let o = 28; out.set(ft, o); o += ft.length; out.set(btj, o); o += btj.length; out.set(btBin, o); o += btBin.length; out.set(glb, o);
	return out;
})();

// ── 読み口 ──
await ok("readB3dm：feature table・batch table（JSON と binary）・glb を分ける", () => {
	const t = readB3dm(b3dm);
	assert.equal(t.batchLength, 2); assert.equal(t.bt.bin.length, btBin.length);
	assert.equal(new TextDecoder().decode(t.glb.subarray(0, 4)), "glTF");
	const rows = batchTableRows(t.bt, 2);
	assert.equal(rows[0].gml_id, "bldg_aaaa-0001"); assert.equal(featureIdOf(rows[1]), "bldg_bbbb-0002");
	assert.equal(rows[0].specifiedFloorAreaRate, 1300); assert.equal(rows[1].specifiedFloorAreaRate, 600); assert.equal(rows[0]._lod, 2);
	assert.equal(rows[0].attributes["bldg:usage"], "業務施設");
});
await ok("attributeTable：入れ子は / で平ら・genericAttribute は name をキーに・null と _ のキーは落ちる・値の並びは keys と同じ", () => {
	const rows = batchTableRows(readB3dm(b3dm).bt, 2);
	const t = attributeTable(rows.map(row => ({ id: row.gml_id, row })));
	const get = (i, k) => t.buildings[i].values[t.keys.indexOf(k)];
	assert.equal(t.buildings.length, 2); for (const b of t.buildings) assert.equal(b.values.length, t.keys.length);
	assert.equal(get(0, "bldg:usage"), "業務施設"); assert.equal(get(1, "bldg:usage"), "商業施設");
	assert.equal(get(0, "gen:genericAttribute/建物ID"), "13101-bldg-508");
	assert.equal(get(0, "uro:BuildingIDAttribute/uro:prefecture"), "東京都");
	assert.equal(get(0, "bldg:measuredHeight"), "8.2"); assert.equal(get(1, "bldg:measuredHeight"), "");
	assert.equal(get(1, "gml:name"), "遠いビル");
	assert.ok(!t.keys.includes("全部 null") && !t.keys.some(k => k.startsWith("_")), t.keys.join(","));
});
await ok("Draco（draco3d）：_BATCHID・TEXCOORD_0 が戻る", async () => {
	const dd = await createDracoDecoder();
	const d = dd(dracoBytes.u8, dracoBytes.ids);
	assert.equal(d.attributes.POSITION.value.length, pos.length); assert.equal(d.indices.value.length, idx.length);
	assert.deepEqual([...new Set(d.attributes._BATCHID.value)].sort(), [0, 1]);
});
await ok("imageSize：webp（VP8L）・png・jpeg", () => {
	assert.deepEqual(imageSize(webp), { w: 4096, h: 2048 });
	const png = new Uint8Array(32); png.set([0x89, 0x50, 0x4e, 0x47], 0); new DataView(png.buffer).setUint32(16, 300); new DataView(png.buffer).setUint32(20, 200);
	assert.deepEqual(imageSize(png), { w: 300, h: 200 });
	const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 70, 3, 0, 0, 0, 0]);
	assert.deepEqual(imageSize(jpg), { w: 70, h: 50 });
});

// ── 書き出し（棟ごと・webp → jpeg）──
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 0xff, 0xd9]);
const calls = [];
const fakeConverter = { name: "fake", convert: (bytes, from, to, o) => { calls.push({ from, to, ...o, n: bytes.length }); return JPEG; } };
const tileset = { asset: { version: "1.0" }, geometricError: 100, root: { boundingVolume: { region: [bbox[0] * D2R, bbox[1] * D2R, bbox[2] * D2R, bbox[3] * D2R, 0, 100] }, geometricError: 0, refine: "REPLACE", content: { uri: "data/data0.b3dm" } } };
const fetchFn = async url => {
	const res = body => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), json: async () => JSON.parse(new TextDecoder().decode(body)) });
	if (url.endsWith("tileset.json")) return res(enc.encode(JSON.stringify(tileset)));
	if (url.endsWith("data0.b3dm")) return res(b3dm);
	return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
};
globalThis.fetch = fetchFn;
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-export-attr-"));
const anchor = { lon: anchor0.lon, lat: anchor0.lat, height: 40 };
const r = await exportArea({ bbox, out, anchor, geoid: 36.7, terrain: null, buildings: { tilesets: ["https://example.test/13101/tileset.json"] }, textures: { converter: fakeConverter, maxSize: 2048 }, fetchFn });
const glb = new Uint8Array(fs.readFileSync(path.join(out, "buildings.glb")));
const { json } = parseGlb(glb);
await ok("棟ごと：bbox の中の棟だけ・ノード名＝gml_id・extras.plateau＝batch table の行", () => {
	const names = json.scenes[0].nodes.map(i => json.nodes[i].name);
	assert.deepEqual(names, ["bldg_aaaa-0001"]);
	const n = json.nodes[json.scenes[0].nodes[0]];
	assert.equal(n.extras.plateau.attributes["bldg:usage"], "業務施設"); assert.equal(n.extras.plateau.specifiedFloorAreaRate, 1300);
	assert.ok(!n.matrix, "頂点は錨の座標＝行列なし");
	assert.ok(!json.extensionsUsed?.includes("KHR_draco_mesh_compression") && !json.extensions?.CESIUM_RTC, "無圧縮・RTC なし");
	assert.equal(json.asset.extras.orthoEarth.features.count, 1);
});
await ok("棟の頂点が錨の glTF（E, U, −N）で正しい所（東 10..15 m・北 0..5 m・上 10 m）", async () => {
	const s = await glbToScene(glb, { anchor: false });
	const P = s.prims[0].positions;
	let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
	near(mn[0], 10, 0.01, "E min"); near(mx[0], 15, 0.01, "E max");
	near(mn[1], 10, 0.01, "U"); near(mx[1], 10, 0.01, "U");
	near(mn[2], -5, 0.01, "−N min"); near(mx[2], 0, 0.01, "−N max");
	assert.equal(s.prims[0].indices.length, 6);
	const N = s.prims[0].normals; near(N[1], 1, 1e-3, "normal up");
});
await ok("テクスチャ：webp → jpeg（長辺の上限を渡す）・EXT_texture_webp が消え、素の source で辿れる", () => {
	assert.equal(calls.length, 1); assert.equal(calls[0].from, "image/webp"); assert.equal(calls[0].to, "image/jpeg"); assert.equal(calls[0].maxSize, 2048);
	assert.deepEqual(json.images.map(i => i.mimeType), ["image/jpeg"]);
	assert.ok(!(json.extensionsUsed || []).includes("EXT_texture_webp") && !(json.extensionsRequired || []).includes("EXT_texture_webp"));
	const t = json.textures[json.materials[0].pbrMetallicRoughness.baseColorTexture.index];
	assert.equal(t.source, 0); assert.ok(!t.extensions);
	assert.equal(foreignImages(glb), 0);
});
await ok("buildings.attributes.json：Unity（JsonUtility）向けの表", () => {
	const t = JSON.parse(fs.readFileSync(path.join(out, "buildings.attributes.json"), "utf8"));
	assert.equal(t.buildings.length, 1); assert.equal(t.buildings[0].id, "bldg_aaaa-0001");
	assert.equal(t.buildings[0].values[t.keys.indexOf("bldg:usage")], "業務施設");
	assert.ok(fs.readFileSync(path.join(out, "README.md"), "utf8").includes("Building attributes"));
	assert.ok(r.files.some(f => f.name === "buildings.attributes.json"));
});
await ok("--no-clip：bbox の外の棟も残る", async () => {
	const o2 = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-export-attr-"));
	await exportArea({ bbox, out: o2, anchor, geoid: 36.7, terrain: null, buildings: { tilesets: ["https://example.test/13101/tileset.json"], clip: false }, textures: { converter: fakeConverter }, fetchFn });
	const j = parseGlb(new Uint8Array(fs.readFileSync(path.join(o2, "buildings.glb")))).json;
	assert.deepEqual(j.scenes[0].nodes.map(i => j.nodes[i].name).sort(), ["bldg_aaaa-0001", "bldg_bbbb-0002"]);
	assert.equal(j.materials.length, 1, "棟を割っても材質は 1 つ");
	assert.equal(j.images.length, 1, "画像も 1 枚");
	fs.rmSync(o2, { recursive: true, force: true });
});
await ok("--attributes none：Draco のまま束ねる・webp も jpeg へ", async () => {
	const o3 = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-export-attr-"));
	await exportArea({ bbox, out: o3, anchor, geoid: 36.7, terrain: null, buildings: { tilesets: ["https://example.test/13101/tileset.json"], split: false }, textures: { converter: fakeConverter }, fetchFn });
	const j = parseGlb(new Uint8Array(fs.readFileSync(path.join(o3, "buildings.glb")))).json;
	assert.ok(j.extensionsUsed.includes("KHR_draco_mesh_compression")); assert.deepEqual(j.images.map(i => i.mimeType), ["image/jpeg"]);
	assert.ok(!fs.existsSync(path.join(o3, "buildings.attributes.json")));
	fs.rmSync(o3, { recursive: true, force: true });
});
await ok("変換器が無い時は、何を入れればよいかを言って落ちる", async () => {
	await assert.rejects(transcodeGlbImages(tileGlb, { converter: null }), /sharp|dwebp|ffmpeg|sips/);
});
fs.rmSync(out, { recursive: true, force: true });
console.log(`\nPASS  ${pass}`);
