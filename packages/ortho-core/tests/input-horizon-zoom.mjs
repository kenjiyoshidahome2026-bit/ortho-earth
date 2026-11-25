// 深いチルトの地平線際のホイールズーム（2026-11-25 本人「深くチルトをかけて zoom-in/out すると少しジタバタ」）：
// カーソル下の錨（海面の球の点）は地平線に近いほど遠い＝旧は 1 目盛り（0.2 段）で注視点が km 単位で飛び、カーソルが地平線の上に出た目盛りは 0（中心ズーム）＝
// 「km 飛ぶ／止まる」が交互に来た（z13・75° で地平線のすぐ下 36 km → 上で 0）。anchorWeight で掠め角 8° 未満の錨を連続に弱める。
// 合成の wheel イベント（DOM 無し）で createInput を回し、カーソルの y を画面の上から下へ走査して 1 目盛りの注視点の移動量を測る。
import { createInput, anchorWeight, ANCHOR_GRAZE } from "../src/input.ts";
import { cameraState, unproject, project } from "../src/camera.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const D2R = Math.PI / 180, M = 6371000;
globalThis.window ??= new EventTarget();
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
const W = 1200, H = 800;

function rig(zoom, pitchDeg) {
	const canvas = new EventTarget();
	canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H });
	canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {}; canvas.style = {};
	const cam = { center: [139.7, 35.7], zoom, pitch: pitchDeg * D2R, bearing: 0, dpr: 1 };
	const ac = new AbortController();
	createInput({ canvas, cam, size: { w: W, h: H }, dpr: 1, maxPitch: 85 * D2R, zoomMin: 2, zoomMax: 22, onMove() {}, signal: ac.signal });
	return { canvas, cam, ac };
}
const wheel = (canvas, x, y, deltaY) => canvas.dispatchEvent(Object.assign(new Event("wheel"), { clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault() {} }));
const distM = (a, b) => Math.hypot((a[0] - b[0]) * Math.cos(a[1] * D2R), a[1] - b[1]) * D2R * M;

// 1 目盛り（deltaY ∓100＝0.2 段）での注視点の移動量［m］
function stepMove(zoom, pitch, x, y, deltaY) {
	const { canvas, cam, ac } = rig(zoom, pitch);
	const c0 = cam.center.slice();
	wheel(canvas, x, y, deltaY);
	ac.abort();
	return distM(c0, cam.center);
}

for (const [zoom, pitch] of [[16, 75], [13, 75], [18, 75], [15, 85]]) {
	for (const deltaY of [-100, 100]) {
		const rows = [];
		for (let y = 2; y <= H / 2; y += 2) rows.push({ y, m: stepMove(zoom, pitch, W / 2 + 150, y, deltaY) });
		const mid = stepMove(zoom, pitch, W / 2 + 150, H * 0.75, deltaY);   // 画面の下（掠め角が大きい＝厳密に貼り付く所）の移動量が物差し
		const max = Math.max(...rows.map(r => r.m));
		let jump = 0; for (let i = 1; i < rows.length; i++) jump = Math.max(jump, Math.abs(rows[i].m - rows[i - 1].m));
		const tag = `z${zoom} ${pitch}° ${deltaY < 0 ? "in" : "out"}`;
		ok(`${tag}：地平線際でも 1 目盛りの注視点の移動は画面の下の 6 倍以内`, max <= 6 * mid, `最大 ${max.toFixed(0)} m／下 ${mid.toFixed(0)} m`);
		ok(`${tag}：カーソルを 2 px 動かした時の移動量の差は画面の下の移動量以内（地平線で跳ばない）`, jump <= mid, `最大の差 ${jump.toFixed(0)} m`);
	}
}

// 掠め角が ANCHOR_GRAZE 以上の所は従来どおり厳密に貼り付く（錨がカーソルの下に残る）
{
	const { canvas, cam, ac } = rig(16, 75);
	const x = 800, y = 600, st0 = cameraState(cam, W, H), a = unproject(st0, x, y);
	ok("画面の下の錨は重み 1", anchorWeight(st0, a) === 1, anchorWeight(st0, a).toFixed(3));
	for (let i = 0; i < 5; i++) wheel(canvas, x, y, -100);
	const p = project(cameraState(cam, W, H), a[0], a[1]);
	ok("画面の下：5 目盛り寄っても錨はカーソルの下（< 1e-6 px）", Math.hypot(p[0] - x, p[1] - y) < 1e-6, Math.hypot(p[0] - x, p[1] - y).toExponential(1) + " px");
	ac.abort();
}
// 重みは地平線で 0・掠め角 ANCHOR_GRAZE で 1（単調）
{
	const { cam, ac } = rig(16, 75); ac.abort();
	const st = cameraState(cam, W, H);
	let prev = -1, mono = true, w0 = null;
	for (let y = 0; y <= H; y += 1) { const a = unproject(st, W / 2, y); if (!a) continue; const w = anchorWeight(st, a); if (w0 == null) w0 = w; if (w < prev - 1e-12) mono = false; prev = w; }
	ok("重みは地平線のすぐ下でほぼ 0、画面の下へ単調に増えて 1", w0 < 0.05 && mono && prev === 1, `地平線際 ${w0?.toFixed(3)}`);
	ok("ANCHOR_GRAZE＝8°", Math.abs(ANCHOR_GRAZE - 8 * D2R) < 1e-15);
}

console.log(fail ? `\n${fail} FAIL` : "\nall PASS");
process.exit(fail ? 1 : 0);
