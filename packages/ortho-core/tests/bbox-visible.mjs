// bboxVisible（メッシュのバッチのカリング・2026-10-28）：Cesium 例 google-photorealistic-3d-tiles-with-building-insert＝globe:false で注視点が楕円体（Google タイルの
// 地面＝楕円体高 1600 m の 1.6 km 下）、目は地面の 260 m 上。旧 meshBboxVisible は bbox を海面（radius 1）で射影したので、目の手前 750 m のタイルが
// 画面の下へ外れて落とされ、足元が床の色（白）になった。重心の高さ（radius）で射影すれば見える。目の足元が bbox 内／目の面を跨ぐ bbox も可視。
import { cameraState, worldRadiusM, bboxVisible, liftedBboxVisible, movedBbox, betaToLonLat, betaRadiusOf, betaGeo, ellNormal3D, lonlatTo3D, setEllipsoid } from "../src/camera.ts";
let fails = 0;
const ok = (name, c, info = "") => { console.log((c ? "PASS " : "FAIL ") + name + (c ? "" : "  " + info)); if (!c) fails++; };
for (const ell of [false, true]) {
setEllipsoid(ell); console.log(ell ? "-- WGS84 ellipsoid (facade)" : "-- sphere");
const W = 960, H = 720, R = worldRadiusM(), pad = 0.5 * Math.max(W, H);
const cam = { center: [-104.9480658058411, 39.746824880505564], zoom: 14.3, pitch: 72.05 * Math.PI / 180, bearing: 95.04 * Math.PI / 180, roll: 0, dpr: 1, near: 1 };
const st = cameraState(cam, W, H), foot = betaToLonLat(st.eye);
const cosLat = Math.cos(foot[1] * Math.PI / 180);
const tile = (distM, sizeM = 100) => {   // 目の足元から方位（bearing）へ distM の 100 m 四方
	const cx = foot[0] + distM * Math.sin(cam.bearing) / (111320 * cosLat), cy = foot[1] + distM * Math.cos(cam.bearing) / 111320;
	const dl = sizeM / 2 / (111320 * cosLat), dp = sizeM / 2 / 111320;
	return [cx - dl, cy - dp, cx + dl, cy + dp];
};
const ground = 1 + 1600 / R;   // デンバーの地面（楕円体高 1600 m）
for (const d of [100, 300, 500, 700]) {
	ok(`tile ${d} m ahead at ground height visible`, bboxVisible(st, tile(d), cam.center, null, pad, ground));
	ok(`tile ${d} m ahead at sea level (old behaviour) culled`, !bboxVisible(st, tile(d), cam.center, null, pad, 1));
}
ok("tile under the foot visible (foot inside)", bboxVisible(st, tile(0), cam.center, foot, pad, 1));
ok("tile 2 km behind the camera culled", !bboxVisible(st, tile(-2000), cam.center, foot, pad, ground));
ok("tile 2 km ahead visible", bboxVisible(st, tile(2000), cam.center, foot, pad, ground));
ok("tile beyond the horizon culled", !bboxVisible(st, [cam.center[0] + 20, cam.center[1], cam.center[0] + 21, cam.center[1] + 1], cam.center, foot, pad, ground));

// liftedBboxVisible（2026-10-31）：地形へ持ち上げる模型（CLAMP_TO_GROUND＝原点は海面・持ち上げはシェーダ）は、注視点の地面が高い所（Cesium の
// physically-based-materials＝標高 1,740 m のメキシコの砂漠・目の 156 m 先のトラック）で原点の高さ（海面）だと画面の下へ外れて落ちた。注視点の地面の高さでも試す
if (ell) {
	const D2R = Math.PI / 180, fovy = 60 * D2R, dist = 156.51, H2 = 720, W2 = 960;
	const zoom = Math.log2(Math.PI * H2 * R / (Math.tan(fovy / 2) * 256 * dist));
	const cam2 = { center: [-103.97638108842978, 27.231362741748466], zoom, pitch: 74.535 * D2R, bearing: 80.536 * D2R, roll: 0, dpr: 1, near: 1, fovy, centerAlt: 1738.89 };
	const st2 = cameraState(cam2, W2, H2), pad2 = 0.5 * Math.max(W2, H2), truck = [-103.97717802518181, 27.231195893408035, -103.97654764013281, 27.231397880138157];
	const groundR = 1 + 1738.89 / R;
	ok("truck at sea level (origin) culled", !bboxVisible(st2, truck, cam2.center, null, pad2, 1));
	ok("truck lifted: visible by the target ground height", liftedBboxVisible(st2, truck, cam2.center, null, pad2, 1, groundR));
	ok("truck noLift (groundRadius 0) stays culled", !liftedBboxVisible(st2, truck, cam2.center, null, pad2, 1, 0));
	ok("2 km behind the camera stays culled even lifted", !liftedBboxVisible(st, tile(-2000), cam.center, foot, pad, 1, ground));
}
// movedBbox（2026-10-28）：setTransform で動かした模型（Cesium の牛乳トラック）は読み込んだ場所の bbox で間引かれて消えた＝xf（L＋xt）で動いた先の箱
{
	const box = tile(0, 10), oll = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], org = lonlatTo3D(oll[0], oll[1]);
	const far = lonlatTo3D(oll[0], oll[1] + 1000 / 111320), xt = far.map((v, i) => v - org[i]);
	const xf = [1, 0, 0, 0, 1, 0, 0, 0, 1, ...xt];
	const mb = movedBbox(box, org, xf), mc = [(mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2];
	ok("movedBbox follows the translation (1 km north)", Math.abs(mc[1] - (oll[1] + 1000 / 111320)) < 2e-6 && Math.abs(mc[0] - oll[0]) < 2e-6, JSON.stringify(mc));
	ok("movedBbox holds the batch in any turn", mb[3] - mb[1] >= (box[3] - box[1]) && mb[2] - mb[0] >= (box[2] - box[0]));
	ok("movedBbox without a transform is the bbox", movedBbox(box, org, null) === box);
	const k2 = movedBbox(box, org, [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]);
	ok("movedBbox grows with the scale", k2[3] - k2[1] >= 2 * (box[3] - box[1]) * 0.99);
}
// 目より高い物（2026-10-29・Cesium の localtofixedframe：目 5000 m・5 km 先の 5500 m の模型が消えた）＝projectInto の手前半球は u·E ≥ radius
{
	const eyeR = Math.hypot(...st.eye), high = eyeR + 500 / R;
	const cam2 = { ...cam, zoom: 11, pitch: 89 * Math.PI / 180 }, st2 = cameraState(cam2, W, H), f2 = betaToLonLat(st2.eye), h2 = Math.hypot(...st2.eye) + 500 / R;
	const ahead = (distM, sizeM) => { const c = Math.cos(f2[1] * Math.PI / 180), cx = f2[0] + distM * Math.sin(cam.bearing) / (111320 * c), cy = f2[1] + distM * Math.cos(cam.bearing) / 111320, dl = sizeM / 2 / (111320 * c), dp = sizeM / 2 / 111320; return [cx - dl, cy - dp, cx + dl, cy + dp]; };
	ok("a model 500 m above a level camera's eye, 5 km ahead, visible", bboxVisible(st2, ahead(5000, 30), cam2.center, null, pad, h2));
	ok("a model 500 m above the eye beyond the horizon culled", !bboxVisible(st, [cam.center[0] + 20, cam.center[1], cam.center[0] + 20.001, cam.center[1] + 0.001], cam.center, foot, pad, high));
	ok("a model 500 m above the eye behind the camera culled", !bboxVisible(st, tile(-2000, 20), cam.center, foot, pad, high));
}
// betaGeo（2026-10-30・Cesium の czml-model-data-url）：高さ 10 km の模型の重心を betaToLonLat（動径沿い）で経緯度にすると 37° で 29 m 北＝目の 8 m 先の
// 4 m の箱が 29 m 北の箱で間引かれて消えた。楕円体の法線沿いに戻せば元の場所
{
	const h = 10000 / R, u = lonlatTo3D(-77, 37), n = ellNormal3D(-77, 37), P = u.map((v, i) => v + h * n[i]), g = betaGeo(P);
	ok("betaGeo puts a point 10 km up back at its latitude", Math.abs(g[1] - 37) < 1e-7 && Math.abs(g[0] + 77) < 1e-9, JSON.stringify(g));
	ok("betaGeo radius = 1 + height", Math.abs(g[2] - 1 - h) < 1e-9, String((g[2] - 1) * R));
	const dl = 2 / (111320 * Math.cos(37 * Math.PI / 180)), dp = 2 / 111320, box = [-77 - dl, 37 - dp, -77 + dl, 37 + dp];
	const mb = movedBbox(box, P, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
	ok("movedBbox of a model 10 km up stays on its place", mb[1] <= 37 && mb[3] >= 37 && mb[3] - mb[1] < 1e-4, JSON.stringify(mb));
	const g0 = betaGeo(lonlatTo3D(139.7, 35.6));
	ok("betaGeo on the surface = betaToLonLat, radius 1", Math.abs(g0[1] - betaToLonLat(lonlatTo3D(139.7, 35.6))[1]) < 1e-9 && Math.abs(g0[2] - 1) < 1e-12, JSON.stringify(g0));
	// the cloud shell: one whole-globe batch with its origin at the Earth's centre, turned by the wind (t-clouds windCovers, 2026-10-31)
	const ws = movedBbox([-180, -90, 180, 90], [0, 0, 0], [0.998, 0, 0.069, 0, 1, 0, -0.069, 0, 0.998, 0, 0, 0]);
	ok("movedBbox of a whole-globe batch about the centre stays finite and covers the view", ws.every(Number.isFinite) && bboxVisible(st, ws, cam.center, foot, pad, betaGeo([0, 0, 0])[2]), JSON.stringify(ws));
}
const o = lonlatTo3D(foot[0], foot[1]).map(v => v * ground);
ok("betaRadiusOf(centroid) = radius", Math.abs(betaRadiusOf(o) - ground) < 1e-9, String(betaRadiusOf(o)));
}
if (fails) { console.log(`${fails} failed`); process.exit(1); } else console.log("all passed");
