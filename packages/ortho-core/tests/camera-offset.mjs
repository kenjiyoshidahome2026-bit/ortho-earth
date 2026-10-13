// cameraState の cam.offset（注視点を画面の中心からずらす＝MapLibre の centerOffset・padding の中身の中心・2026-10-12 A3）：
// 無指定・[0,0]＝従来とビット同値／[150,-100]＝注視点が (W/2+150·dpr, H/2−100·dpr) に写る／camDist・eye 不変／unproject と往復／傾けても同じ。
import { cameraState, project, unproject } from "../src/camera.js";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const D2R = Math.PI / 180, W = 800, H = 600;
const base = { center: [139.76, 35.68], zoom: 12, pitch: 0, bearing: 0, fovy: 50 * D2R, dpr: 1 };
{
	const a = cameraState(base, W, H), b = cameraState({ ...base, offset: [0, 0] }, W, H), c = cameraState({ ...base, offset: undefined }, W, H);
	ok("offset 無指定＝[0,0]＝ビット同値", a.mvp.every((v, i) => v === b.mvp[i] && v === c.mvp[i]) && a.projection.every((v, i) => v === b.projection[i]));
}
for (const cam of [base, { ...base, pitch: 55 * D2R, bearing: 1.1, roll: 0.2 }, { ...base, dpr: 2 }]) {
	const st0 = cameraState(cam, W, H), st = cameraState({ ...cam, offset: [150, -100] }, W, H);
	const [x, y, f] = project(st, cam.center[0], cam.center[1]);
	ok(`注視点＝(W/2+150·dpr, H/2−100·dpr) pitch=${(cam.pitch / D2R).toFixed(0)} dpr=${cam.dpr}`, f > 0 && Math.abs(x - (W / 2 + 150 * cam.dpr)) < 1e-6 && Math.abs(y - (H / 2 - 100 * cam.dpr)) < 1e-6, `${x.toFixed(3)},${y.toFixed(3)}`);
	ok("camDist・eye 不変", st.camDist === st0.camDist && st.eye.every((v, i) => v === st0.eye[i]));
	const ll = unproject(st, W / 2 + 150 * cam.dpr, H / 2 - 100 * cam.dpr);
	ok("unproject の往復", ll && Math.abs(ll[0] - cam.center[0]) < 1e-9 && Math.abs(ll[1] - cam.center[1]) < 1e-9, ll && `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`);
	// 絵は平行移動しただけ＝他の点も同じ量だけずれる（真俯瞰の近傍で）
	if (!cam.pitch) {
		const [px0, py0] = project(st0, cam.center[0] + 0.01, cam.center[1] + 0.005), [px, py] = project(st, cam.center[0] + 0.01, cam.center[1] + 0.005);
		ok("他の点も同じ量だけずれる", Math.abs(px - px0 - 150 * cam.dpr) < 1e-6 && Math.abs(py - py0 + 100 * cam.dpr) < 1e-6);
	}
}
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ camera-offset 全 PASS");
process.exit(fail ? 1 : 0);
