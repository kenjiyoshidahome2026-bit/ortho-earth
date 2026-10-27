// 地面アトラスの窓（RTT ドレープ・2026-09-21）＝両バックエンド共通の純関数。
// 段（細かい順）：前景（強いチルト時のみ）／近／中／遠。
//   近＝視野中心 ±1 画面幅（zoom を 1/4 段で量子化＝ズーム中に毎フレーム作り直さない）、中＝6 倍、遠＝36 倍、地平線（遠の外が写る時だけ・2026-10-26）。
//   前景＝画面下 3/4 の地点を中心に、中心とのカメラ距離比 r（≥1.3 の時だけ）で縮尺を上げた窓＝チルトの手前が近窓の解像度で
//   甘くなる件の根治（本人指摘 9/21）。r は 1/4 段で量子化＝チルト中に毎フレーム作り直さない。
// 原点は半幅の 1/4 刻みにスナップ＝カメラが窓幅の 1/8 動いた時だけ再合成（標本化は正確な窓座標で行う＝絵は飛ばない）。
import { cameraState, unproject, lonlatTo3D } from "./camera.ts";
import type { CameraPose, LonLat } from "./camera.ts";

/** 地面アトラスの窓＝[西, 南, 東, 北]（度） */
export type GroundWindow = [number, number, number, number];

const GND_SCALES = [1, 6, 36];
const snapWin = (cx: number, cy: number, hw: number, hh: number): GroundWindow => {
	const step = hw / 4, sx = Math.round(cx / step) * step, sy = Math.round(cy / step) * step;
	return [sx - hw, Math.max(-90, sy - hh), sx + hw, Math.min(90, sy + hh)];   // 極まで（画像層の極の蓋＝raster.ts buildPoleCapMesh が乗る）
};
/** 窓の列（細かい順）。fg＝先頭が前景の窓・wide＝前景で 4 段が埋まり、遠窓を地平線まで広げた */
export type GroundWindows = GroundWindow[] & { fg?: boolean; wide?: boolean };
/** liftM＝遠景層の最大標高（m）：持ち上がった遠景は海面球の地平線より先まで映る＝地平線の窓を其処まで伸ばす（0＝海面の地平線まで） */
export function groundWindows(cam: CameraPose, W: number, H: number, liftM = 0): GroundWindows {
	const dpr = cam.dpr || 1;
	// 宙の注視点（centerAlt＞0：上空の模型を数 m から見る trackedEntity 等）：zoom は注視点までの距離＝地面は遥かに遠い。
	// 窓は「画面中心の地面」を中心に、目から地面までの距離に合わせた zoom で取る（旧＝注視点の zoom のまま＝数 m 四方の窓＝地面が下地の色）
	let zoom = cam.zoom, cx = cam.center[0], cy = cam.center[1];
	if ((cam.centerAlt || 0) > 0) {
		const st = cameraState(cam, W, H), pc = unproject(st, W / 2, H / 2);
		if (pc) { const q = lonlatTo3D(pc[0], pc[1]); zoom -= Math.log2(Math.max(1, Math.hypot(q[0] - st.eye[0], q[1] - st.eye[1], q[2] - st.eye[2]) / st.camDist)); cx = pc[0]; cy = pc[1]; }
		else zoom -= Math.log2(Math.max(1, (Math.hypot(st.eye[0], st.eye[1], st.eye[2]) - 1) / st.camDist));   // 空を見ている＝目の高さ
	}
	const zq = Math.floor(zoom * 4) / 4;
	const capW = 360 * (W / dpr) / (256 * Math.pow(2, zq)), capH = capW * H / W;
	const out: GroundWindows = [];
	// 前景：画面中心と画面下 90% の地点のカメラ距離比。両方が球上（チルトで下端が空＝null なら無し）
	if ((cam.pitch || 0) > 0.06) {
		const st = cameraState(cam, W, H);
		const pc = unproject(st, W / 2, H / 2), pb = unproject(st, W / 2, H * 0.9), pf = unproject(st, W / 2, H * 0.75);
		if (pc && pb && pf) {
			const d = (p: LonLat): number => { const q = lonlatTo3D(p[0], p[1]); return Math.hypot(q[0] - st.eye[0], q[1] - st.eye[1], q[2] - st.eye[2]); };
			const r = Math.pow(2, Math.floor(Math.log2(Math.max(1, d(pc) / d(pb))) * 4) / 4);   // 1/4 段で量子化
			if (r >= 1.3) { out.push(snapWin(pf[0], pf[1], capW / r * 1.1, capH / r * 1.1)); out.fg = true; }
		}
	}
	for (const k of GND_SCALES) out.push(snapWin(cx, cy, capW * k, capH * k));
	// 地平線の窓：低い目で斜めに見る（数十 m から 3D Tiles を見る等）と、遠窓（36 倍）の外の地面が画面に残る＝下地の色の帯（Cesium の baseColor の青）。
	// 画面の上辺の地面（空なら地平線）が遠窓の外なら、そこまで届く窓を足す（段が 4 つ埋まっていれば遠窓を広げる）。最大 36×36 倍
	const reach = groundReach(cam, W, H, cx, cy, liftM);
	if (reach > 0) {
		const k = Math.min(GND_SCALES[2] * 36, Math.pow(2, Math.ceil(Math.log2(1.05 * reach / Math.min(capW * Math.cos(cy * Math.PI / 180), capH)) * 2) / 2));   // √2 刻み＝カメラが動くたびに作り直さない
		if (k > GND_SCALES[2]) { const w = snapWin(cx, cy, capW * k, capH * k); if (out.length < 4) out.push(w); else { out[3] = w; out.wide = true; } }
	}
	return out;
}
// 画面の上辺（左・中・右）に写る一番遠い地面までの角距離（度）。空を見る点は地平線（目から接する所）まで
function groundReach(cam: CameraPose, W: number, H: number, cx: number, cy: number, liftM = 0): number {
	const st = cameraState(cam, W, H), e = st.eye, eL = Math.hypot(e[0], e[1], e[2]);
	if (!(eL > 1)) return 0;
	const c = lonlatTo3D(cx, cy), ang = (q: number[]) => Math.acos(Math.max(-1, Math.min(1, (q[0] * c[0] + q[1] * c[1] + q[2] * c[2]) / Math.hypot(q[0], q[1], q[2])))) * 180 / Math.PI;
	let far = 0, sky = false;
	for (const sx of [0, W / 2, W]) { const p = unproject(st, sx, 0); if (p) far = Math.max(far, ang(lonlatTo3D(p[0], p[1]))); else sky = true; }
	if (sky) far = Math.max(far, ang(e) + (Math.acos(1 / eL) + (liftM > 0 ? Math.acos(1 / (1 + liftM / 6378137)) : 0)) * 180 / Math.PI);   // 目の真下からの地平線までの角（＋海面に接した視線が持ち上がった地面に届くまでの角）
	return far;
}
/** 各窓のアトラスの一辺（N＝細かい窓の一辺）：前景と近は N・中と遠は N/2。広げた遠窓は N（粗くなる分を少し戻す） */
export const groundSizes = (wins: GroundWindows, N: number): number[] => wins.map((_, i) => (i === 0 || (wins.fg && i === 1) || (wins.wide && i === 3) ? N : N >> 1));
export const windowsKey = (wins: readonly (readonly number[])[]): string => wins.map(w => w.map(v => v.toFixed(6)).join(",")).join("|");
