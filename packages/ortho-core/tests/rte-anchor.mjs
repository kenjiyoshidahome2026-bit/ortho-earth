// 地形パスの RTE の錨（2026-10-28・Cesium 例 shadows）：錨が遠い（経度 0・緯度 0＝基図のタイルが無い地図の main の原点）と、
// 頂点の相対ベクトルが ~1 の大きさになり f32 の mvp との積が深ズームで相殺を失う＝低い目で地形が目の前で何倍にも歪む。
// 錨＝カメラの注視点なら相対ベクトルは画面の中の距離＝桁落ちなし。renderer の terrOrigin（gl/gpu）が守る性質を、同じ式の CPU 模倣で確かめる。
import { cameraState, lonlatTo3D, projectInto } from "../src/camera.ts";
import * as mat from "../src/mat.ts";
let fails = 0;
const ok = (name, c, info = "") => { console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + info)); if (!c) fails++; };
const W = 1280, H = 720;
const cam = { center: [-75.61212589948566, 40.04253061141798], zoom: 21.645388850739415, pitch: 45 * Math.PI / 180, bearing: 0, roll: 0, dpr: 1, fovy: 0.6280287671649805, centerAlt: 95.72613210463422 };
const st = cameraState(cam, W, H);
const mvp32 = Float32Array.from(st.mvp);
// シェーダの式：clip = u_clipT（f64）+ u_mvp（f32）× rel（f32＝頂点3D − 原点3D）
function screenVia(origin, lon, lat, hM) {
	const oPt = lonlatTo3D(origin[0], origin[1]), cT = mat.transform(st.mvp, [oPt[0], oPt[1], oPt[2], 1]);
	const r = 1 + hM / 6371000, v = lonlatTo3D(lon, lat).map(x => x * r);
	const rel = Float32Array.from([v[0] - oPt[0], v[1] - oPt[1], v[2] - oPt[2]]);
	const c = [0, 0, 0, 0];
	for (let i = 0; i < 4; i++) c[i] = Math.fround(cT[i] + Math.fround(mvp32[i] * rel[0]) + Math.fround(mvp32[4 + i] * rel[1]) + Math.fround(mvp32[8 + i] * rel[2]));
	return [(c[0] / c[3] + 1) * 0.5 * W, (1 - c[1] / c[3]) * 0.5 * H, c[3]];
}
const P = [0, 0, 0];
// 目の 60 m 下の地面（標高 74 m）の点＝画面の下半分に写る
const pts = [[-75.61213, 40.0428, 74], [-75.6119, 40.0431, 74], [-75.6124, 40.0426, 74]];
let farErr = 0, nearErr = 0;
for (const [lon, lat, h] of pts) {
	projectInto(st, lon, lat, 1 + h / 6371000, P);
	const a = screenVia([0, 0], lon, lat, h), b = screenVia(cam.center, lon, lat, h);
	farErr = Math.max(farErr, Math.hypot(a[0] - P[0], a[1] - P[1]));
	nearErr = Math.max(nearErr, Math.hypot(b[0] - P[0], b[1] - P[1]));
}
ok("anchor at the camera target: the ground 60 m below the eye lands within 1 px of the f64 projection", nearErr < 1, `err ${nearErr.toFixed(2)} px`);
ok("anchor at lon 0 lat 0 (old main-origin default) loses the cancellation: error over 1 px (the GPU, with f32 trigonometry in deltaToRel on top, distorts by screen-fulls)", farErr > 1, `err ${farErr.toFixed(1)} px`);
console.log(`rte-anchor: far-anchor error ${farErr.toFixed(1)} px, target-anchor error ${nearErr.toFixed(3)} px`);
if (fails) { console.log(`rte-anchor: ${fails} FAIL`); process.exit(1); } else console.log("rte-anchor: all PASS");
