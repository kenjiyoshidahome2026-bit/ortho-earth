// 3D Tiles のタイルの transform（PDOK の 3D Basisvoorziening＝根に ECEF の行列・2026-10-22）＝Node 単体。
// 合成の tileset（根に ENU→ECEF の行列・子は外部 tileset）と、その局所系（Y-up）の三角形 1 枚の glb を fetch の差し替えで配る。
//   ・collectLeafTiles：行列を根から積んで葉へ（xf）・box の境界体積も行列を通して街の矩形で枝刈り
//   ・decodeBatch：頂点に行列を掛ける＝Delft に立つ・水平な三角形の法線は鉛直
import { collectLeafTiles, decodeBatch } from "../src/meshdecode.ts";

let fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "ok " : "NG "} ${name}${extra ? "  " + extra : ""}`); if (!cond) fail++; };

// Delft の ENU→ECEF（列優先 4x4）
const D2R = Math.PI / 180, lon0 = 4.3571 * D2R, lat0 = 52.0116 * D2R, a = 6378137, e2 = 6.69437999014e-3;
const N = a / Math.sqrt(1 - e2 * Math.sin(lat0) ** 2);
const O = [N * Math.cos(lat0) * Math.cos(lon0), N * Math.cos(lat0) * Math.sin(lon0), N * (1 - e2) * Math.sin(lat0)];
const E = [-Math.sin(lon0), Math.cos(lon0), 0], Nn = [-Math.sin(lat0) * Math.cos(lon0), -Math.sin(lat0) * Math.sin(lon0), Math.cos(lat0)], U = [Math.cos(lat0) * Math.cos(lon0), Math.cos(lat0) * Math.sin(lon0), Math.sin(lat0)];
const XF = [...E, 0, ...Nn, 0, ...U, 0, ...O, 1];

// 局所系（Z-up＝ENU）の box：中心 (0,0,10)・半軸 50m／50m／10m。別の街（Amsterdam の辺り）の枝は (60km 北) に置く
const box = (cx, cy) => [cx, cy, 10, 50, 0, 0, 0, 50, 0, 0, 0, 10];
const root = { transform: XF, boundingVolume: { box: [0, 0, 0, 1e5, 0, 0, 0, 1e5, 0, 0, 0, 100] }, geometricError: 100,
	children: [{ boundingVolume: { box: box(0, 0) }, content: { uri: "sub/delft.json" } }, { boundingVolume: { box: box(0, 60000) }, content: { uri: "sub/far.json" } }] };
const sub = name => ({ root: { boundingVolume: { box: box(0, 0) }, content: { uri: name + ".glb" } } });

// glb：三角形 1 枚（局所 Y-up＝glTF。地面から 5m の水平面・東西南北に ±20m）・法線は +Y（＝上）
function glb() {
	const pos = new Float32Array([-20, 5, 20, 20, 5, 20, 0, 5, -20]), nrm = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
	const bin = new Uint8Array(pos.byteLength + nrm.byteLength); bin.set(new Uint8Array(pos.buffer), 0); bin.set(new Uint8Array(nrm.buffer), pos.byteLength);
	const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
		buffers: [{ byteLength: bin.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: nrm.byteLength }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-20, 5, -20], max: [20, 5, 20] }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" }] };
	let js = JSON.stringify(json); while (js.length % 4) js += " ";
	const jb = new TextEncoder().encode(js), total = 12 + 8 + jb.length + 8 + bin.length;
	const out = new Uint8Array(total), dv = new DataView(out.buffer);
	dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
	dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(jb, 20);
	dv.setUint32(20 + jb.length, bin.length, true); dv.setUint32(24 + jb.length, 0x004E4942, true); out.set(bin, 28 + jb.length);
	return out.buffer;
}
const files = { "https://t.test/tileset.json": { root }, "https://t.test/sub/delft.json": sub("delft"), "https://t.test/sub/far.json": sub("far") };
const seen = [];
globalThis.fetch = async (u) => {
	seen.push(String(u));
	if (String(u).endsWith(".glb")) return new Response(glb(), { status: 200 });
	const j = files[String(u)];
	return j ? new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } }) : new Response("nf", { status: 404 });
};

// 1) 走査：Delft の矩形で切ると far の外部 tileset は開かない・葉に xf（根の行列）
const clip = [4.336, 51.978, 4.393, 52.026];
const leaves = await collectLeafTiles("https://t.test/tileset.json", 0, null, null, clip);
ok("clip keeps only Delft branch", leaves.length === 1 && leaves[0].uri === "https://t.test/sub/delft.glb" && !seen.some(u => u.includes("far")), JSON.stringify(leaves.map(l => l.uri)));
ok("leaf carries root transform", !!leaves[0]?.xf && leaves[0].xf.every((v, i) => Math.abs(v - XF[i]) < 1e-6));
ok("leaf center is Delft", !!leaves[0]?.center && Math.abs(leaves[0].center[0] - 4.3571) < 1e-3 && Math.abs(leaves[0].center[1] - 52.0116) < 1e-3, JSON.stringify(leaves[0]?.center));
// 行列なし（PLATEAU・3DBAG）の葉には xf が付かない
files["https://t.test/plain.json"] = { root: { boundingVolume: { region: [lon0 - 1e-3, lat0 - 1e-3, lon0 + 1e-3, lat0 + 1e-3, 0, 30] }, content: { uri: "x.glb" } } };
const plain = await collectLeafTiles("https://t.test/plain.json");
ok("no transform → no xf", plain.length === 1 && plain[0].xf === undefined);

// 2) 頂点：行列を掛けて Delft に立つ（bbox）・法線は鉛直（ortho 系＝ECEF の (x, z, y)）
const mesh = await decodeBatch("t/", leaves, null, null);
ok("decoded", !!mesh && mesh.idx.length === 3);
if (mesh) {
	const b = mesh.bbox;
	ok("placed at Delft", Math.abs((b[0] + b[2]) / 2 - 4.3571) < 1e-3 && Math.abs((b[1] + b[3]) / 2 - 52.0116) < 1e-3 && b[2] - b[0] < 1e-3, JSON.stringify(b.map(v => +v.toFixed(5))));
	const up = [U[0], U[2], U[1]], n = [mesh.nrm[0], mesh.nrm[1], mesh.nrm[2]], l = Math.hypot(...n) || 1;
	const dot = (n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) / l;
	ok("normal is vertical", Math.abs(Math.abs(dot) - 1) < 0.02, `dot=${dot.toFixed(4)}`);
}
console.log(fail ? `tileset-transform: ${fail} NG` : "tileset-transform: all ok");
process.exit(fail ? 1 : 0);
