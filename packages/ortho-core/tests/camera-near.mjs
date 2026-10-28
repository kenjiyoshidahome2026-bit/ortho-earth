// cam.near（near 面の上限［m］・2026-10-28）：Cesium 例 google-photorealistic-3d-tiles-with-building-insert＝globe:false で目標点が楕円体
// （3D Tiles の地面の 1.6 km 下）に落ち、注視距離 6 km の 8%＝500 m の near 面が目の前の Google タイルを切った（足元が真っ白）。
// cam.near＝Cesium の frustum.near（1 m）を上限にすると、目の 2 m 先の点が描かれ、無指定なら従来どおり切れる（ビット同値）。
import { cameraState, worldRadiusM } from "../src/camera.ts";
import * as mat from "../src/mat.ts";
let fails = 0;
const ok = (name, c, info = "") => { console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + info)); if (!c) fails++; };
const W = 960, H = 720, R = worldRadiusM();
const base = { center: [-104.9480658058411, 39.746824880505564], zoom: 14.3, pitch: 72.05 * Math.PI / 180, bearing: 95.04 * Math.PI / 180, roll: 0, dpr: 1 };
const clipZ = (st, d) => {   // 目から視線方向へ d［m］の点の NDC z（-1 より小さい＝near 面の手前＝切れる）
	const p = mat.add(st.eye, mat.scale(viewDir(st), d / R));
	const c = mat.transform(st.mvp, [p[0], p[1], p[2], 1]);
	return c[2] / c[3];
};
// 視線方向＝画面中心のレイ（invMvp で NDC (0,0,-1)→(0,0,1) を結ぶ）
const viewDir = st => { const a = mat.transform(st.invMvp, [0, 0, -1, 1]), b = mat.transform(st.invMvp, [0, 0, 1, 1]); return mat.norm(mat.sub([b[0] / b[3], b[1] / b[3], b[2] / b[3]], [a[0] / a[3], a[1] / a[3], a[2] / a[3]])); };
const st0 = cameraState(base, W, H), st1 = cameraState({ ...base, near: 1 }, W, H);
const distM = st0.camDist * R;
ok("注視距離は 6 km 前後", distM > 5000 && distM < 7000, distM.toFixed(0));
ok("無指定：目の 100 m 先は near 面の手前（切れる＝従来）", clipZ(st0, 100) < -1, clipZ(st0, 100).toFixed(3));
ok("near:1：目の 2 m 先が描かれる", clipZ(st1, 2) >= -1 && clipZ(st1, 2) < 1, clipZ(st1, 2).toFixed(3));
ok("near:1：目の 0.5 m 先は切れる", clipZ(st1, 0.5) < -1, clipZ(st1, 0.5).toFixed(3));
ok("near:1 でも目と注視点は同じ", Math.hypot(...mat.sub(st0.eye, st1.eye)) < 1e-12 && Math.abs(st0.camDist - st1.camDist) < 1e-15);
const stBig = cameraState({ ...base, near: 1e6 }, W, H);
ok("上限が従来より遠い時は従来のまま（min）", stBig.mvp.every((v, i) => v === st0.mvp[i]));
const stNull = cameraState({ ...base, near: 0 }, W, H);
ok("near:0＝無指定と同じ（ビット同値）", stNull.mvp.every((v, i) => v === st0.mvp[i]));
if (fails) { console.log(`FAIL ${fails}`); process.exit(1); } console.log("PASS camera-near");
