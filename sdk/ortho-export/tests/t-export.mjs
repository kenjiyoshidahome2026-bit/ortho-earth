// ortho-export の検定（合成の fetch＝網を使わない）：錨の算術・標高タイルの復号と補間・地形メッシュ・3D Tiles の束の座標の付け替え・出力ファイル。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { makeAnchor, lonLatToEcef, ecefToLonLat, ecefToGltfMatrix, tileGltfToEcefMatrix, mat4Mul, mat4Point, tileRange, lonToX, latToY } from "../src/geo.mjs";
import { encodePng, decodePng } from "../src/png.mjs";
import { createDem } from "../src/dem.mjs";
import { exportArea, stampGlb } from "../src/export.mjs";
import { reframeGlb } from "../src/buildings.mjs";
import { toGlb, glbToScene, parseGlb } from "glbconv";

let pass = 0;
const ok = (name, f) => { f(); pass++; console.log("✓", name); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

// ── 錨の算術 ──
ok("ECEF ⇄ 経緯度の往復", () => {
	const [x, y, z] = lonLatToEcef(139.7671, 35.6812, 40), [lon, lat, h] = ecefToLonLat(x, y, z);
	near(lon, 139.7671, 1e-9); near(lat, 35.6812, 1e-9); near(h, 40, 1e-4);
});
const anchor = makeAnchor({ lon: 139.7671, lat: 35.6812, height: 40 });
ok("錨の ENU：東へ 100 m・上へ 10 m が glTF で (100, 10, 0)", () => {
	const p = anchor.fromEnu([100, 0, 10]), g = anchor.toGltf(p);
	near(g[0], 100, 1e-6); near(g[1], 10, 1e-6); near(g[2], 0, 1e-6);
	const n = anchor.toGltf(anchor.fromEnu([0, 50, 0]));   // 北＝glTF の −Z
	near(n[2], -50, 1e-6); near(n[0], 0, 1e-6);
});
ok("錨の ENU は右手系（E×N=U）・glTF の (E,U,−N) も右手系", () => {
	const { E, N, U } = anchor, c = [E[1] * N[2] - E[2] * N[1], E[2] * N[0] - E[0] * N[2], E[0] * N[1] - E[1] * N[0]];
	for (let i = 0; i < 3; i++) near(c[i], U[i], 1e-12);
	const M = ecefToGltfMatrix(anchor), det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]);
	near(det, 1, 1e-9, "det");
});
ok("ecefToGltfMatrix は toGltf と同じ・tileGltfToEcef は Y-up→ECEF（gy→+z・gz→−y）", () => {
	const p = lonLatToEcef(139.77, 35.68, 55), a = anchor.toGltf(p), b = mat4Point(ecefToGltfMatrix(anchor), p);
	for (let i = 0; i < 3; i++) near(a[i], b[i], 1e-6);
	const q = mat4Point(tileGltfToEcefMatrix([1, 2, 3]), [10, 20, 30]);
	assert.deepEqual(q, [11, 2 - 30, 3 + 20]);
	const I = mat4Mul(tileGltfToEcefMatrix([0, 0, 0]), [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
	for (let i = 0; i < 16; i++) near(I[i], i % 5 === 0 ? 1 : 0, 1e-12);
});
ok("タイル範囲：bbox を覆う z17 のタイル", () => {
	const r = tileRange([139.7625, 35.6785, 139.7700, 35.6840], 17);
	assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
	assert.ok(lonToX(139.7625, 17) >= r.x0 && lonToX(139.7700, 17) <= r.x1 + 1);
	assert.ok(latToY(35.6840, 17) >= r.y0 && latToY(35.6785, 17) <= r.y1 + 1);
});

// ── 合成の fetch ──
const H_M = 20;   // 標高（m・ジオイド上）＝全画素
const GEOID = 36.7;
const demPng = (() => {   // dem_png：x = h/0.01 を RGB に
	const x = Math.round(H_M / 0.01), rgb = new Uint8Array(256 * 256 * 3);
	for (let i = 0; i < 256 * 256; i++) { rgb[i * 3] = (x >> 16) & 255; rgb[i * 3 + 1] = (x >> 8) & 255; rgb[i * 3 + 2] = x & 255; }
	return encodePng(256, 256, rgb);
})();
ok("PNG の読み書き（dem_png の値が戻る）", () => {
	const t = decodePng(demPng); assert.equal(t.w, 256); assert.equal(t.bpp, 3);
	const o = (100 * 256 + 7) * 3, x = (t.px[o] << 16) | (t.px[o + 1] << 8) | t.px[o + 2];
	near(x * 0.01, H_M, 1e-9);
});

// 3D Tiles の見本：錨から東 30 m・北 20 m・上 5 m の点を RTC に持つ三角形 1 枚（b3dm）
const P = anchor.fromEnu([30, 20, 5]);
const triGlb = toGlb({ rtc: P, bbox: [0, 0, 0, 10, 10, 0], prims: [{ positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), normals: null, uvs: null, colors: null, indices: new Uint32Array([0, 1, 2]), material: { name: "m", baseColor: [1, 0, 0, 1], doubleSided: true, image: null } }] }, { name: "t" })[0].bytes;
const b3dm = (() => {
	const ft = new TextEncoder().encode(JSON.stringify({ BATCH_LENGTH: 0 }).padEnd(24, " "));
	const out = new Uint8Array(28 + ft.length + triGlb.length), dv = new DataView(out.buffer);
	out.set([0x62, 0x33, 0x64, 0x6d], 0); dv.setUint32(4, 1, true); dv.setUint32(8, out.length, true); dv.setUint32(12, ft.length, true);
	out.set(ft, 28); out.set(triGlb, 28 + ft.length);
	return out;
})();
const bbox = [139.7625, 35.6785, 139.7700, 35.6840];
const D2R = Math.PI / 180;
const tileset = { asset: { version: "1.1" }, geometricError: 100, root: { boundingVolume: { region: [bbox[0] * D2R, bbox[1] * D2R, bbox[2] * D2R, bbox[3] * D2R, 0, 100] }, geometricError: 0, refine: "ADD", content: { uri: "a.b3dm" } } };
const hits = [];
const fetchFn = async (url) => {
	hits.push(url);
	const res = (body, type) => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), json: async () => JSON.parse(new TextDecoder().decode(body)), text: async () => new TextDecoder().decode(body) });
	if (url.includes("dem_png")) return res(demPng);
	if (url.includes("seamlessphoto")) return res(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
	if (url.endsWith("tileset.json")) return res(new TextEncoder().encode(JSON.stringify(tileset)));
	if (url.endsWith("a.b3dm")) return res(b3dm);
	if (url.includes("geoidcalc")) return res(new TextEncoder().encode(JSON.stringify({ OutputData: { geoidHeight: String(GEOID) } })));
	return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
};
globalThis.fetch = fetchFn;   // tiles3d.mjs（collectTiles）は global の fetch を使う

await (async () => {
	const dem = createDem({ fetchFn, zoom: 14 });
	const h = await dem.heightAt(139.7671, 35.6812);
	ok("DEM の双一次補間（全画素同じ値＝そのまま）", () => near(h, H_M, 1e-6));
})();

// ── 書き出し ──
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-export-"));
const r = await exportArea({ bbox, out, geoid: "auto", terrain: { zoom: 17, imagery: "seamlessphoto", segments: 8 }, buildings: { tilesets: ["https://example.test/13101/tileset.json"], split: false }, fetchFn });
ok("出力：anchor.json・terrain.glb・buildings.glb・README.md", () => {
	for (const f of ["anchor.json", "terrain.glb", "buildings.glb", "README.md"]) assert.ok(fs.existsSync(path.join(out, f)), f);
	const a = JSON.parse(fs.readFileSync(path.join(out, "anchor.json"), "utf8"));
	near(a.anchor.lon, (bbox[0] + bbox[2]) / 2, 1e-12); near(a.anchor.height, H_M + GEOID, 1e-6, "錨の高さ＝地面の楕円体高");
	assert.equal(a.frame, "enu"); near(a.geoid, GEOID, 1e-9);
	assert.ok(a.source.some(s => s.kind === "buildings" && s.license === "CC BY 4.0"));
	assert.ok(fs.readFileSync(path.join(out, "README.md"), "utf8").includes("CC BY 4.0"));
});
const terrainGlb = new Uint8Array(fs.readFileSync(path.join(out, "terrain.glb")));
const tScene = await glbToScene(terrainGlb, { anchor: false });   // glbconv は錨（extras）を RTC へ畳む＝ここは錨の座標のまま検める
ok("地形：面はタイルごと・頂点の高さ ≈ 0（錨＝地面）・幅 ≈ bbox の実寸・uv は 0..1・画像つき", () => {
	const { x0, x1, y0, y1 } = tileRange(bbox, 17), nTiles = (x1 - x0 + 1) * (y1 - y0 + 1);
	assert.equal(tScene.prims.length, nTiles, "tiles");
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const p of tScene.prims) {
		assert.ok(p.material.image && p.material.image.mime === "image/jpeg", "image");
		for (let i = 0; i < p.positions.length; i += 3) { minX = Math.min(minX, p.positions[i]); maxX = Math.max(maxX, p.positions[i]); minY = Math.min(minY, p.positions[i + 1]); maxY = Math.max(maxY, p.positions[i + 1]); }
		for (let i = 0; i < p.uvs.length; i++) assert.ok(p.uvs[i] >= -1e-6 && p.uvs[i] <= 1 + 1e-6, "uv");
		for (let i = 0; i < p.normals.length; i += 3) assert.ok(p.normals[i + 1] > 0.99, "normal up");
	}
	near(minY, 0, 0.05, "min y"); near(maxY, 0, 0.05, "max y");
	const widthM = (bbox[2] - bbox[0]) * D2R * 6378137 * Math.cos(35.68 * D2R);
	near(maxX - minX, widthM, widthM * 0.01, "width");
});
ok("地形 glb の asset.extras.orthoEarth に錨", () => {
	const { json } = parseGlb(terrainGlb);
	assert.equal(json.asset.extras.orthoEarth.frame, "enu"); near(json.asset.extras.orthoEarth.anchor.lat, (bbox[1] + bbox[3]) / 2, 1e-12);
});
const bGlb = new Uint8Array(fs.readFileSync(path.join(out, "buildings.glb")));
ok("建物（--attributes none）：RTC が外れ、親ノードの行列で RTC の点が錨の ENU（30, 20, 5）へ来る", () => {
	const { json } = parseGlb(bGlb);
	assert.ok(!json.extensions?.CESIUM_RTC && !(json.extensionsRequired || []).includes("CESIUM_RTC"), "no RTC");
	const root = json.nodes[json.scenes[json.scene ?? 0].nodes[0]];
	assert.ok(root.matrix && root.children.length >= 1, "root node");
	const expect = makeAnchor(r.anchor).toGltf(P);   // 書き出しの錨（bbox の中心・地面の高さ）で
	const got = mat4Point(root.matrix, [0, 0, 0]);
	for (let i = 0; i < 3; i++) near(got[i], expect[i], 1e-3, `axis ${i}`);
	// glb の +Y（上）10 m → ECEF の rtc+(0,0,10)
	const up = mat4Point(root.matrix, [0, 10, 0]), e2 = makeAnchor(r.anchor).toGltf([P[0], P[1], P[2] + 10]);
	for (let i = 0; i < 3; i++) near(up[i], e2[i], 1e-3, `up ${i}`);
	assert.equal(json.asset.extras.orthoEarth.frame, "enu");
});
ok("reframeGlb：元の glb の子ノードが親の下に残る", () => {
	const g = reframeGlb(triGlb, anchor), { json } = parseGlb(g);
	assert.equal(json.scenes[0].nodes.length, 1); assert.equal(json.nodes[json.scenes[0].nodes[0]].children.length, 1);
});
ok("stampGlb：extras を上書きせず足す", () => {
	const { json } = parseGlb(stampGlb(triGlb, { a: 1 }));
	assert.equal(json.asset.extras.orthoEarth.a, 1); assert.ok(json.asset.generator.startsWith("ortho-earth ortho-export"));
});
ok("網：地理院・PLATEAU・ジオイド API 以外へ出ない", () => {
	for (const u of hits) assert.ok(/cyberjapandata\.gsi\.go\.jp|example\.test|vldb\.gsi\.go\.jp/.test(u), u);
});
fs.rmSync(out, { recursive: true, force: true });
console.log(`\nPASS  ${pass}`);
