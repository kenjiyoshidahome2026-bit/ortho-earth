// 注視点の高さの付け替え（rebaseCenterAlt・2026-11-25）：目と視線をそのままに注視点を見えている地面の高さへ移す＝絵が変わらない。
// 動機＝本人「深いチルトで zoom-in/out すると少し上下している」（朝倉の山・地面 365 m・75°）：海抜 0 の注視点へ寄ると目が地面すれすれを滑り、やがて潜る。
import { cameraState, project, rebaseCenterAlt, worldRadiusM } from "../src/camera.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const D2R = Math.PI / 180, M = worldRadiusM(), W = 1440, H = 900;
const eyeAlt = st => (Math.hypot(...st.eye) - 1) * M;

for (const [name, cam] of [
	["朝倉 z15.88・75°", { center: [130.72625, 33.24707], zoom: 15.88, pitch: 75 * D2R, bearing: 2 * D2R, dpr: 1 }],
	["60°・方位 130°・dpr 2", { center: [138.73, 35.36], zoom: 14.2, pitch: 60 * D2R, bearing: 130 * D2R, dpr: 2 }],
	["真上", { center: [10, -45], zoom: 12, pitch: 0, bearing: 0.3, dpr: 1 }],
	["注視点のずらしあり", { center: [130.7, 33.2], zoom: 15, pitch: 70 * D2R, bearing: -1, dpr: 1, offset: [120, -40] }],
	["高さ 200 m から付け替え", { center: [130.7, 33.2], zoom: 15, pitch: 70 * D2R, bearing: -1, dpr: 1, centerAlt: 200 }],
]) {
	const alt = 365, st0 = cameraState(cam, W, H), r = rebaseCenterAlt(cam, W, H, alt);
	if (!r) { ok(`${name}：付け替えられる`, false); continue; }
	const cam1 = { ...cam, ...r, centerAlt: alt }, st1 = cameraState(cam1, W, H);
	const dEye = Math.hypot(st1.eye[0] - st0.eye[0], st1.eye[1] - st0.eye[1], st1.eye[2] - st0.eye[2]) * M;
	ok(`${name}：目の位置が変わらない（< 1 mm）`, dEye < 1e-3, dEye.toExponential(1) + " m");
	// 絵が変わらない＝周りの地面の点（海面と 365 m）の画面位置が同じ
	let worst = 0;
	for (const [dx, dy] of [[0, 0], [0.004, 0.002], [-0.003, 0.006], [0.002, -0.001]]) for (const rad of [1, 1 + alt / M]) {
		const a = project(st0, cam.center[0] + dx, cam.center[1] + dy, rad), b = project(st1, cam.center[0] + dx, cam.center[1] + dy, rad);
		if (a[2] > 0 && b[2] > 0) worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
	}
	ok(`${name}：絵が動かない（< 0.01 px）`, worst < 0.01, worst.toExponential(1) + " px");
	// 新しい注視点は高さ alt の球の上で、画面の中心（ずらし込み）に写る
	const c = project(st1, r.center[0], r.center[1], 1 + alt / M), off = cam.offset || [0, 0], dpr = cam.dpr || 1;
	ok(`${name}：新しい注視点は画面の中心`, Math.hypot(c[0] - (W / 2 + off[0] * dpr), c[1] - (H / 2 + off[1] * dpr)) < 0.01);
	ok(`${name}：寄った分だけ zoom が上がる（注視点が近くなる）`, cam.pitch === 0 ? r.zoom > cam.zoom : r.zoom > cam.zoom || (cam.centerAlt || 0) > alt, `${cam.zoom} → ${r.zoom.toFixed(3)}`);
}
// 動機の数字：海抜 0 の注視点へ 1 段寄ると目は地面（365 m）の下へ潜る／地面の注視点なら目は地面の上に残る
{
	const cam = { center: [130.72625, 33.24707], zoom: 15.88, pitch: 75 * D2R, bearing: 2 * D2R, dpr: 1 }, alt = 365;
	const sea = eyeAlt(cameraState({ ...cam, zoom: cam.zoom + 1 }, W, H));
	const r = rebaseCenterAlt(cam, W, H, alt), gnd = eyeAlt(cameraState({ ...cam, ...r, centerAlt: alt, zoom: r.zoom + 1 }, W, H)), gnd3 = eyeAlt(cameraState({ ...cam, ...r, centerAlt: alt, zoom: r.zoom + 3 }, W, H));
	ok("海抜 0 の注視点：1 段寄ると目が地面（365 m）より下", sea < alt, `目の高さ ${sea.toFixed(0)} m`);
	ok("地面の注視点：1 段・3 段寄っても目は地面より上", gnd > alt && gnd3 > alt, `${gnd.toFixed(0)} m・${gnd3.toFixed(0)} m`);
}
// 当たらない時は null：目が球の中（地面が目より高い）
{
	const cam = { center: [130.7, 33.2], zoom: 17, pitch: 75 * D2R, bearing: 0, dpr: 1 };
	ok("目より高い地面は null（呼び手は何もしない）", rebaseCenterAlt(cam, W, H, 3000) === null, `目 ${eyeAlt(cameraState(cam, W, H)).toFixed(0)} m`);
}
console.log(fail ? `\n${fail} FAIL` : "\nall PASS");
process.exit(fail ? 1 : 0);
