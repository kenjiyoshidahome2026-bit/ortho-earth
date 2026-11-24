// チルトのドラッグの向き（#1206）：既定＝従来（下へドラッグで俯角が増える）／tiltDrag:"maplibre"＝MapLibre と同じ（下へで減る・方位 0.8°/px・俯角 0.5°/px）。
// 合成イベント（DOM 無し）で createInput を回す：右ボタンのドラッグ・Ctrl＋左ドラッグ・2 本指の平行縦ドラッグ。
import { createInput, tiltDragRates } from "../src/input.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const D2R = Math.PI / 180;

globalThis.window ??= new EventTarget();
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
const ev = (type, o) => Object.assign(new Event(type), { pointerId: 1, pointerType: "mouse", button: 0, shiftKey: false, ctrlKey: false, preventDefault() {}, ...o });

function rig(tiltDrag) {
	const canvas = new EventTarget();
	canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
	canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {}; canvas.style = {};
	const cam = { lon: 139.7, lat: 35.7, zoom: 12, pitch: 30 * D2R, bearing: 0 };
	const ac = new AbortController();
	createInput({ canvas, cam, size: { w: 800, h: 600 }, dpr: 1, maxPitch: 80 * D2R, onMove() {}, signal: ac.signal, ...(tiltDrag && { tiltDrag }) });
	return { canvas, cam, ac };
}
// マウス：start から (dx, dy) だけ動かす（右ボタン or Ctrl＋左）
function mouseTilt(tiltDrag, dx, dy, how = "right") {
	const { canvas, cam, ac } = rig(tiltDrag);
	const btn = how === "right" ? { button: 2 } : { button: 0, ctrlKey: true };
	const p0 = cam.pitch, b0 = cam.bearing;
	canvas.dispatchEvent(ev("pointerdown", { clientX: 400, clientY: 300, ...btn }));
	canvas.dispatchEvent(ev("pointermove", { clientX: 400 + dx, clientY: 300 + dy, ...btn }));
	const r = { dp: cam.pitch - p0, db: cam.bearing - b0 };
	ac.abort();
	return r;
}
// 2 本指の平行縦ドラッグ（判定窓 12px を越えてから 1 段動かす）
function touchTilt(tiltDrag, dy) {
	const { canvas, cam, ac } = rig(tiltDrag);
	const t = (type, id, x, y) => canvas.dispatchEvent(ev(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y }));
	t("pointerdown", 1, 350, 300); t("pointerdown", 2, 450, 300);
	for (let y = 304; y <= 320; y += 4) { t("pointermove", 1, 350, y); t("pointermove", 2, 450, y); }   // 小刻みに＝ここでチルトにロック
	const p0 = cam.pitch;
	t("pointermove", 1, 350, 320 + dy); t("pointermove", 2, 450, 320 + dy);
	const dp = cam.pitch - p0;
	ac.abort();
	return dp;
}

{
	const o = tiltDragRates(), m = tiltDragRates("maplibre");
	ok("既定の係数は従来のまま（0.006 / 0.005 rad/px）", o.bearing === 0.006 && o.pitch === 0.005);
	ok("maplibre の係数＝MapLibre（方位 0.8°/px・俯角 −0.5°/px）", near(m.bearing, 0.8 * D2R) && near(m.pitch, -0.5 * D2R));
}
for (const how of ["right", "ctrl"]) {
	const d0 = mouseTilt(undefined, 0, 20, how), m0 = mouseTilt("maplibre", 0, 20, how);
	ok(`[${how}] 既定：下へ 20px で俯角が増える（従来）`, near(d0.dp, 20 * 0.005), (d0.dp / D2R).toFixed(2) + "°");
	ok(`[${how}] maplibre：下へ 20px で俯角が 10° 減る`, near(m0.dp, -10 * D2R), (m0.dp / D2R).toFixed(2) + "°");
	const m1 = mouseTilt("maplibre", 0, -20, how);
	ok(`[${how}] maplibre：上へ 20px で俯角が 10° 増える`, near(m1.dp, 10 * D2R), (m1.dp / D2R).toFixed(2) + "°");
	const b0 = mouseTilt(undefined, 20, 0, how), b1 = mouseTilt("maplibre", 20, 0, how);
	ok(`[${how}] 方位：右へで増える（既定 0.006 rad/px・maplibre 16°）`, near(b0.db, 0.12) && near(b1.db, 16 * D2R), `${(b0.db / D2R).toFixed(2)}° / ${(b1.db / D2R).toFixed(2)}°`);
}
{
	const d = touchTilt(undefined, 20), m = touchTilt("maplibre", 20);
	ok("2 本指：既定は下へで俯角が増える（マウスと同じ向き）", near(d, 20 * 0.005), (d / D2R).toFixed(2) + "°");
	ok("2 本指：maplibre は下へで俯角が 10° 減る（MapLibre の touchPitch と同じ）", near(m, -10 * D2R), (m / D2R).toFixed(2) + "°");
}
{
	const m = mouseTilt("maplibre", 0, 200);   // 30° から 100° 起こす＝0 で止まる
	ok("maplibre：0° で止まる（clampPitch）", near(m.dp, -30 * D2R), (m.dp / D2R).toFixed(2) + "°");
}

console.log(fail ? `\n${fail} FAIL` : "\nall PASS");
process.exit(fail ? 1 : 0);
