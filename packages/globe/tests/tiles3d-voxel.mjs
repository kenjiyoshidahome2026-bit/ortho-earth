// 3D Tiles の voxel（glTF の EXT_primitive_voxels＋KHR_implicit_shapes・tileset の 3DTILES_content_voxels・2026-10-23）の node 検定（網なし・fixtures/tiles3d-voxel＝make.mjs）。
// worker の解き（decodeTile3D → decodeModel）が voxel のプリミティブを plugin-voxel の VoxelData の形（box＝単位立方体 → ECEF の transform・region＝経緯度高）で返すか：
//   padding を剥ぐ・noData・属性の名（class の性質名 → propertyAttributes → 属性）・Uint8 の RGBA・heightOffset の持ち上げ・形が無い時は境界体積・plugin が無い（voxels:false）＝飛ばして数える。
import { readFileSync } from "node:fs";
import { decodeTile3D } from "../src/tiles3d-decode.ts";
import { density0, densityC, REGION1 } from "./fixtures/tiles3d-voxel/make.mjs";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const dir = new URL("./fixtures/tiles3d-voxel/", import.meta.url);
const ts = JSON.parse(readFileSync(new URL("tileset.json", dir), "utf8")), T = ts.root.transform;
const load = f => { const b = readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const decode = (f, o = {}) => decodeTile3D(load(f), { transform: T, textures: false, baseUri: dir.href, voxels: {}, ...o });
const m4pt = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const m4vec = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
/** ENU（東・北・上 m）→ ECEF（根の transform） */
const enu = (e, n, u) => [0, 1, 2].map(k => T[12 + k] + T[k] * e + T[4 + k] * n + T[8 + k] * u);
const close3 = (a, b, eps = 1e-3) => a.every((v, k) => near(v, b[k], eps));

// 子 0＝box（KHR_implicit_shapes）・Float32・padding・noData・transform
const c0 = await decode("child0.glb");
ok("child0.shape", c0 && c0.voxels.length === 1 && c0.batches.length === 0 && c0.points.length === 0 && c0.stats.voxels === 1 && c0.stats.voxelsSkipped === 0, JSON.stringify(c0?.stats));
const v0 = c0.voxels[0];
ok("child0.dims", v0.shape === "box" && v0.dims.join() === "8,6,8" && v0.components === 1 && v0.values instanceof Float32Array && v0.values.length === 384 && v0.property === "_DENSITY");
ok("child0.padding", !Array.from(v0.values).some(x => x === 999) && near(v0.values[1], density0(1, 0, 0)) && near(v0.values[8 * 6 * 7 + 8 * 5 + 7], density0(7, 5, 7)), `${v0.values[1]} ${v0.values[383]}`);
ok("child0.noData", v0.noData === -1 && v0.values[0] === -1);
// 単位立方体の隅＝glTF (−50,−40,−50)＋(−100,40,100) → ENU (−150, −50, 0)、(1,1,1)＝glTF (−50, 80, 150)… 東 −50・北 −150・上 80
ok("child0.transform", v0.transform.length === 16 && close3(m4pt(v0.transform, [0, 0, 0]), enu(-150, -50, 0)) && close3(m4pt(v0.transform, [1, 1, 1]), enu(-50, -150, 80)), `${m4pt(v0.transform, [0, 0, 0])} vs ${enu(-150, -50, 0)}`);
ok("child0.axes", close3(m4vec(v0.transform, [1, 0, 0]), m4vec(T, [100, 0, 0])) && close3(m4vec(v0.transform, [0, 1, 0]), m4vec(T, [0, 0, 80])) && close3(m4vec(v0.transform, [0, 0, 1]), m4vec(T, [0, -100, 0])));   // 列＝x 東 100・y 上 80・z 南 100

// 子 1＝EXT_implicit_ellipsoid_region → region（度）・Uint8 の RGBA
const c1 = await decode("child1.glb");
const v1 = c1.voxels[0];
ok("child1.region", c1.voxels.length === 1 && v1.shape === "region" && v1.region.length === 6 && v1.region.every((v, k) => near(v, REGION1[k], 1e-9)) && v1.transform === undefined, `${v1?.region}`);
ok("child1.rgba", v1.components === 4 && v1.values instanceof Uint8Array && v1.values.length === 4 * 4 * 2 * 4 && v1.values[0] === 255 && v1.values[1] === 30 && v1.values[3] === 255 && v1.dims.join() === "4,4,2" && v1.property === "_COLOR" && v1.noData === undefined);

// heightOffset（baseH＝−10）＝box の平行移動が中心の上向きに 10 m・region は高さに足す
const up = await decode("child0.glb", { baseH: -10 });
const dt = [0, 1, 2].map(k => up.voxels[0].transform[12 + k] - v0.transform[12 + k]);
ok("heightOffset.box", near(Math.hypot(...dt), 10, 1e-3) && dt.every((v, k) => near(v / 10, T[8 + k], 5e-3)), `${dt}`);
const up1 = await decode("child1.glb", { baseH: -10 });
ok("heightOffset.region", near(up1.voxels[0].region[4], 50) && near(up1.voxels[0].region[5], 130));

// tileset の経路＝glTF に形が無い・3DTILES_content_voxels の dimensions＋タイルの境界体積（ECEF の box）・property は class の性質名 → propertyAttributes → _DENSITY
const tc = JSON.parse(readFileSync(new URL("tileset-content.json", dir), "utf8")), b = tc.root.boundingVolume.box;
const volume = { box: [...m4pt(T, [b[0], b[1], b[2]]), ...m4vec(T, [b[3], b[4], b[5]]), ...m4vec(T, [b[6], b[7], b[8]]), ...m4vec(T, [b[9], b[10], b[11]])] };
const cc = await decode("content.glb", { voxels: { property: "density", declared: tc.root.content.extensions["3DTILES_content_voxels"], volume } });
const vc = cc.voxels[0];
ok("content.shape", cc.voxels.length === 1 && vc.shape === "box" && vc.dims.join() === "4,4,4" && vc.values.length === 64 && vc.property === "_DENSITY" && near(vc.values[63], densityC(3, 3, 3)), JSON.stringify(cc.stats));
ok("content.transform", close3(m4pt(vc.transform, [0, 0, 0]), enu(-150, 100, 0)) && close3(m4pt(vc.transform, [1, 1, 1]), enu(-50, 200, 80)), `${m4pt(vc.transform, [0, 0, 0])} vs ${enu(-150, 100, 0)}`);
const noVol = await decode("content.glb", { voxels: { declared: tc.root.content.extensions["3DTILES_content_voxels"] } });   // 境界体積も形も無い＝飛ばす
ok("content.noVolume", noVol.voxels.length === 0 && noVol.stats.voxelsSkipped === 1);
const noDecl = await decode("content.glb", { voxels: { volume } });   // dimensions が無い＝飛ばす
ok("content.noDecl", noDecl.voxels.length === 0 && noDecl.stats.voxelsSkipped === 1);

// plugin が無い（voxels:false）＝飛ばして数える（点にも三角形にもならない）
const fb = await decode("child0.glb", { voxels: false });
ok("fallback.skip", fb.voxels.length === 0 && fb.stats.voxelsSkipped === 1 && fb.points.length === 0 && fb.batches.length === 0, JSON.stringify(fb.stats));

console.log(fail ? `tiles3d-voxel: ${fail} FAIL` : "tiles3d-voxel: all ok"); process.exit(fail ? 1 : 0);
