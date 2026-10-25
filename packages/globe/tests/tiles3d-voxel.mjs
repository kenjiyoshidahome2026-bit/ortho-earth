// 3D Tiles の voxel（glTF の EXT_primitive_voxels＋KHR_implicit_shapes・tileset の 3DTILES_content_voxels・2026-10-23）の node 検定（網なし・fixtures/tiles3d-voxel＝make.mjs）。
// worker の解き（decodeTile3D → decodeModel）が voxel のプリミティブを voxel の VoxelData の形（box＝単位立方体 → ECEF の transform・region＝経緯度高）で返すか：
//   padding を剥ぐ・noData・属性の名（class の性質名 → propertyAttributes → 属性）・Uint8 の RGBA・heightOffset の持ち上げ・形が無い時は境界体積・plugin が無い（voxels:false）＝飛ばして数える。
import { readFileSync } from "node:fs";
import { decodeTile3D } from "../src/tiles3d-decode.ts";
import { density0, densityC, REGION1, cylgColor, CYLG, cylcDensity, CYLC } from "./fixtures/tiles3d-voxel/make.mjs";
import { volumeAt, cylinderOf, cylinderFrame, CYL_BV } from "../src/tiles3d-implicit.ts";

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

// cylinder（2026-10-26）＝glTF の形の経路：[半径, 高さ, 角度] → [半径, 角度, 高さ]・局所は 3D Tiles の向き（x 東・y 北・z 上）・角度は glTF ＋180°
const cg = await decode("cylg.glb"), vg = cg.voxels[0];
ok("cylg.shape", cg.voxels.length === 1 && vg.shape === "cylinder" && vg.dims.join() === "4,6,2" && vg.components === 4 && vg.values instanceof Uint8Array && vg.property === "_COLOR", JSON.stringify({ s: vg?.shape, d: vg?.dims, st: cg.stats }));
ok("cylg.reorder", [[0, 0, 0], [3, 1, 5], [2, 0, 4], [1, 1, 2]].every(([i, j, k]) => { const o = (i + 4 * (k + 6 * j)) * 4; return cylgColor(i, j, k).every((v, c) => vg.values[o + c] === v); }), Array.from(vg.values.slice(0, 8)).join());
ok("cylg.range", vg.cylinder.radius.join() === "20,60" && vg.cylinder.height.join() === "-40,40" && near(vg.cylinder.angle[0], 90, 1e-9) && near(vg.cylinder.angle[1], 270, 1e-9), JSON.stringify(vg.cylinder));
const XG = vg.cylinder.transform;   // 局所 m → ECEF＝原点が ENU (200, 250, 80)・列＝東・北・上
ok("cylg.transform", close3(m4pt(XG, [0, 0, 0]), enu(200, 250, 40)) && close3(m4vec(XG, [1, 0, 0]), m4vec(T, [1, 0, 0])) && close3(m4vec(XG, [0, 1, 0]), m4vec(T, [0, 1, 0])) && close3(m4vec(XG, [0, 0, 1]), m4vec(T, [0, 0, 1])), `${m4pt(XG, [0, 0, 0])} vs ${enu(200, 250, 40)}`);
// 角度の向き＝glTF の角度 a（0＝glTF の −x・反時計回り）の点 → 契約の角度 a + 180° の点（同じ ECEF）
const gl2enu = (a, r) => [-r * Math.cos(a), 0, r * Math.sin(a)];   // glTF の局所（x, y 上, z）の点＝角度 0 が −x・反時計回り（+y から見て）＝z が −北…の逆を確かめる
ok("cylg.angle", [-Math.PI / 2, 0, Math.PI / 4].every(a => { const g = gl2enu(a, 40), e = [CYLG.at[0] + g[0], CYLG.at[1] - g[2], 0], b = (a * 180 / Math.PI + 180) * Math.PI / 180;
	return close3(m4pt(XG, [40 * Math.cos(b), 40 * Math.sin(b), 0]), enu(e[0], e[1], 40)); }));
const ug = await decode("cylg.glb", { baseH: -10 });
ok("cylg.heightOffset", near(Math.hypot(...[0, 1, 2].map(k => ug.voxels[0].cylinder.transform[12 + k] - XG[12 + k])), 10, 1e-3));
// cylinder＝Cesium の tileset の経路：境界体積（3DTILES_bounding_volume_cylinder）＋宣言 [半径, 角度, 高さ]・glb は glTF の並び。全周＝範囲に +180°（添字の半周ずれ）
const tcy = JSON.parse(readFileSync(new URL("tileset-cylinder-content.json", dir), "utf8")), bvc = tcy.root.boundingVolume;
const F = cylinderFrame(cylinderOf(bvc)), mul4 = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
const cvol = { cylinder: { transform: mul4(T, F.M), radius: F.r, height: F.z, angle: [F.a[0] * 180 / Math.PI, F.a[1] * 180 / Math.PI] } };   // gadgets/tiles3d.ts voxVolume と同じ
const cc2 = await decode("cylc.glb", { voxels: { property: "density", declared: tcy.root.content.extensions["3DTILES_content_voxels"], volume: cvol } }), vcy = cc2.voxels[0];
ok("cylc.shape", cc2.voxels.length === 1 && vcy.shape === "cylinder" && vcy.dims.join() === CYLC.dims.join() && vcy.property === "_DENSITY" && vcy.values.length === 64, JSON.stringify({ s: vcy?.shape, d: vcy?.dims, st: cc2.stats }));
ok("cylc.order", [0, 1, 2, 3].every(i => [0, 1].every(j => [0, 3, 7].every(a => near(vcy.values[i + 4 * (a + 8 * j)], cylcDensity(a))))));
ok("cylc.fullShift", near(vcy.cylinder.angle[0], 0, 1e-9) && near(vcy.cylinder.angle[1], 360, 1e-9) && vcy.cylinder.radius.join() === "0,50" && vcy.cylinder.height.join() === "-30,30", JSON.stringify(vcy.cylinder));
ok("cylc.transform", close3(m4pt(vcy.cylinder.transform, [0, 0, 0]), enu(...CYLC.translation)));
const half = await decode("cylc.glb", { voxels: { declared: tcy.root.content.extensions["3DTILES_content_voxels"], volume: { cylinder: { ...cvol.cylinder, angle: [-180, 0] } } } });   // 全周でない＝並びも範囲もそのまま
ok("cylc.partial", half.voxels[0].cylinder.angle.join() === "-180,0");
// implicit の分け方＝(半径, 角度, 高さ)・QUADTREE は高さを分けない
const root = { extensions: { [CYL_BV]: { minRadius: 10, maxRadius: 50, height: 60 } } };
const o1 = cylinderOf(volumeAt(root, { level: 1, x: 1, y: 0, z: 1 }, 8)), q1 = cylinderOf(volumeAt(root, { level: 2, x: 0, y: 3 }, 4));
ok("implicit.octree", near(o1.minRadius, 30) && near(o1.maxRadius, 50) && near(o1.minAngle, -Math.PI) && near(o1.maxAngle, 0) && near(o1.minHeight, 0) && near(o1.maxHeight, 30), JSON.stringify(o1));
ok("implicit.quadtree", near(q1.minRadius, 10) && near(q1.maxRadius, 20) && near(q1.minAngle, Math.PI / 2) && near(q1.maxAngle, Math.PI) && near(q1.minHeight, -30) && near(q1.maxHeight, 30), JSON.stringify(q1));
const rot = cylinderFrame({ minRadius: 0, maxRadius: 1, height: 2, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], translation: [1, 2, 3] });   // z まわり 90°＝局所 x → y
ok("cylinderFrame", close3(rot.M.slice(0, 3), [0, 1, 0]) && close3(rot.M.slice(4, 7), [-1, 0, 0]) && close3(rot.M.slice(12, 15), [1, 2, 3]) && rot.z.join() === "-1,1");

// plugin が無い（voxels:false）＝飛ばして数える（点にも三角形にもならない）
const fb = await decode("child0.glb", { voxels: false });
ok("fallback.skip", fb.voxels.length === 0 && fb.stats.voxelsSkipped === 1 && fb.points.length === 0 && fb.batches.length === 0, JSON.stringify(fb.stats));

console.log(fail ? `tiles3d-voxel: ${fail} FAIL` : "tiles3d-voxel: all ok"); process.exit(fail ? 1 : 0);
