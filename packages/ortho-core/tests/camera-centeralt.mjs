// cameraState の cam.centerAlt（注視点の高さ［m］＝MapLibre の transform.elevation・2026-09-30）：
// 無指定＝従来とビット同値／指定＝注視点を測地法線に沿って持ち上げ、カメラはそこから同じ camDist＝持ち上げた点が画面の中心に写る。
import { cameraState, project, worldRadiusM } from "../src/camera.js";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const W = 800, H = 600, base = { center: [138.73, 35.36], zoom: 13, pitch: 60 * Math.PI / 180, bearing: 0.4, fovy: 0.8, dpr: 1 };

// 無指定・0・undefined＝同じ行列
{
	const a = cameraState(base, W, H), b = cameraState({ ...base, centerAlt: 0 }, W, H), c = cameraState({ ...base, centerAlt: undefined }, W, H);
	ok("centerAlt 無指定＝0＝ビット同値", a.mvp.every((v, i) => v === b.mvp[i] && v === c.mvp[i]));
}
// 持ち上げた注視点が画面の中心に写る／海面の中心点は中心より下（手前）にずれる
{
	const alt = 3000, st = cameraState({ ...base, centerAlt: alt }, W, H), R = worldRadiusM();
	const [x, y, f] = project(st, base.center[0], base.center[1], 1 + alt / R);
	ok("持ち上げた注視点＝画面の中心", f > 0 && Math.hypot(x - W / 2, y - H / 2) < 0.01, `${x.toFixed(3)},${y.toFixed(3)}`);
	const [x0, y0] = project(st, base.center[0], base.center[1], 1);
	ok("海面の中心点は中心より下（傾けた分だけ手前）", Math.abs(x0 - W / 2) < 0.01 && y0 > H / 2 + 10, `${x0.toFixed(1)},${y0.toFixed(1)}`);
	// camDist は変わらない（ズーム↔距離の式は不変）
	const st0 = cameraState(base, W, H);
	ok("camDist 不変", Math.abs(st.camDist - st0.camDist) < 1e-15);
	// eye は測地法線に沿って alt/R だけ上がる
	const d = st.eye.map((v, i) => v - st0.eye[i]), len = Math.hypot(...d);
	ok("eye の移動量＝alt/R", Math.abs(len - alt / R) < 1e-9, `${len.toExponential(3)} vs ${(alt / R).toExponential(3)}`);
}
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ camera-centeralt 全 PASS");
process.exit(fail ? 1 : 0);
