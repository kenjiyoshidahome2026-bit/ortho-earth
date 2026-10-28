// bboxVisible（メッシュのバッチのカリング・2026-10-28）：Cesium 例 google-photorealistic-3d-tiles-with-building-insert＝globe:false で注視点が楕円体（Google タイルの
// 地面＝楕円体高 1600 m の 1.6 km 下）、目は地面の 260 m 上。旧 meshBboxVisible は bbox を海面（radius 1）で射影したので、目の手前 750 m のタイルが
// 画面の下へ外れて落とされ、足元が床の色（白）になった。重心の高さ（radius）で射影すれば見える。目の足元が bbox 内／目の面を跨ぐ bbox も可視。
import { cameraState, worldRadiusM, bboxVisible, movedBbox, betaToLonLat, betaRadiusOf, lonlatTo3D, setEllipsoid } from "../src/camera.ts";
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
const o = lonlatTo3D(foot[0], foot[1]).map(v => v * ground);
ok("betaRadiusOf(centroid) = radius", Math.abs(betaRadiusOf(o) - ground) < 1e-9, String(betaRadiusOf(o)));
}
if (fails) { console.log(`${fails} failed`); process.exit(1); } else console.log("all passed");
