// cameraState の cam.roll（視線まわりの回転［rad］・MapLibre の roll と同じ向き・2026-10-12 A1）：
// 無指定＝0＝従来とビット同値／正の roll＝絵が画面上で時計回りに回る（北の点が右へ）／注視点は動かない／camDist・eye は不変。
// 併せて viewurl の roll トークンと flight の easePlan の roll 補間。
import { cameraState, project } from "../src/camera.js";
import { parseViewHash, buildViewHash } from "../src/viewurl.js";
import { easePlan } from "../src/flight.js";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const D2R = Math.PI / 180, W = 800, H = 600;
const base = { center: [139.76, 35.68], zoom: 12, pitch: 0, bearing: 0, fovy: 50 * D2R, dpr: 1 };

{
	const a = cameraState(base, W, H), b = cameraState({ ...base, roll: 0 }, W, H), c = cameraState({ ...base, roll: undefined }, W, H);
	ok("roll 無指定＝0＝ビット同値", a.mvp.every((v, i) => v === b.mvp[i] && v === c.mvp[i]));
}
{
	const st0 = cameraState(base, W, H), st = cameraState({ ...base, roll: 90 * D2R }, W, H);
	const [cx, cy, cf] = project(st, base.center[0], base.center[1]);
	ok("注視点は画面の中心のまま", cf > 0 && Math.hypot(cx - W / 2, cy - H / 2) < 1e-6, `${cx.toFixed(3)},${cy.toFixed(3)}`);
	const [nx0, ny0] = project(st0, base.center[0], base.center[1] + 0.01);
	const [nx, ny] = project(st, base.center[0], base.center[1] + 0.01);
	ok("roll 0＝北の点は上", Math.abs(nx0 - W / 2) < 1e-6 && ny0 < H / 2 - 10, `${nx0.toFixed(1)},${ny0.toFixed(1)}`);
	ok("roll +90°＝北の点は右（絵が時計回り）", nx > W / 2 + 10 && Math.abs(ny - H / 2) < 1e-6, `${nx.toFixed(1)},${ny.toFixed(1)}`);
	ok("中心からの距離は同じ", Math.abs(Math.hypot(nx - W / 2, ny - H / 2) - Math.hypot(nx0 - W / 2, ny0 - H / 2)) < 1e-6);
	ok("camDist・eye は不変", st.camDist === st0.camDist && st.eye.every((v, i) => Math.abs(v - st0.eye[i]) < 1e-15));
	const stN = cameraState({ ...base, roll: -90 * D2R }, W, H), [mx] = project(stN, base.center[0], base.center[1] + 0.01);
	ok("roll −90°＝北の点は左", mx < W / 2 - 10, mx.toFixed(1));
}
{
	// 傾けて方位を振っても roll は視線軸まわり＝注視点は中心・北の点までの距離は不変
	const tb = { ...base, pitch: 50 * D2R, bearing: 0.7 }, st0 = cameraState(tb, W, H), st = cameraState({ ...tb, roll: 30 * D2R }, W, H);
	const [cx, cy] = project(st, tb.center[0], tb.center[1]);
	const d0 = Math.hypot(...project(st0, tb.center[0], tb.center[1] + 0.003).slice(0, 2).map((v, i) => v - [W / 2, H / 2][i]));
	const d1 = Math.hypot(...project(st, tb.center[0], tb.center[1] + 0.003).slice(0, 2).map((v, i) => v - [W / 2, H / 2][i]));
	ok("チルト＋方位＋roll＝注視点は中心", Math.hypot(cx - W / 2, cy - H / 2) < 1e-6);
	ok("チルト＋方位＋roll＝中心からの距離は不変", Math.abs(d0 - d1) < 1e-6, `${d0.toFixed(3)} vs ${d1.toFixed(3)}`);
}
{
	const h = buildViewHash({ center: [139.76, 35.68], zoom: 12, pitch: 45 * D2R, bearing: -30 * D2R, roll: 15 * D2R });
	ok("buildViewHash の roll トークン", h === "#12.00/35.68000/139.76000/45t/-30r/15roll", h);
	const v = parseViewHash(h);
	ok("parseViewHash の roll", v && Math.abs(v.roll - 15 * D2R) < 1e-12 && Math.abs(v.bearing + 30 * D2R) < 1e-12 && Math.abs(v.pitch - 45 * D2R) < 1e-12);
	ok("roll 0 は書かない・読めば 0", buildViewHash({ center: [0, 0], zoom: 3, pitch: 0, bearing: 0, roll: 0 }) === "#3.00/0.00000/0.00000" && parseViewHash("#3/0/0").roll === 0);
}
{
	const env = { viewW: () => 800, maxPitch: 1.5, minZoom: 0 };
	const cam0 = { lon: 0, lat: 0, zoom: 5, pitch: 0, bearing: 0, roll: 0 };
	const p = easePlan(cam0, env, { roll: 0.5 }, 1000);
	ok("easePlan の roll 補間（半分で中間・終わりで目標）", Math.abs(p.at(1000).roll - 0.5) < 1e-12 && p.at(500).roll > 0.2 && p.at(500).roll < 0.3 && p.at(0).roll === 0);
	ok("easePlan の roll 省略＝今の値", easePlan({ ...cam0, roll: 0.3 }, env, { zoom: 6 }, 1000).at(1000).roll === 0.3);
}
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ camera-roll 全 PASS");
process.exit(fail ? 1 : 0);
