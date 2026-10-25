// 地面アトラスの窓（RTT ドレープ・2026-09-21）＝両バックエンド共通の純関数。
// 段（細かい順）：前景（強いチルト時のみ）／近／中／遠。
//   近＝視野中心 ±1 画面幅（zoom を 1/4 段で量子化＝ズーム中に毎フレーム作り直さない）、中＝6 倍、遠＝36 倍。
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
export function groundWindows(cam: CameraPose, W: number, H: number): GroundWindow[] {
	const dpr = cam.dpr || 1, zq = Math.floor(cam.zoom * 4) / 4;
	const capW = 360 * (W / dpr) / (256 * Math.pow(2, zq)), capH = capW * H / W;
	const out: GroundWindow[] = [];
	// 前景：画面中心と画面下 90% の地点のカメラ距離比。両方が球上（チルトで下端が空＝null なら無し）
	if ((cam.pitch || 0) > 0.06) {
		const st = cameraState(cam, W, H);
		const pc = unproject(st, W / 2, H / 2), pb = unproject(st, W / 2, H * 0.9), pf = unproject(st, W / 2, H * 0.75);
		if (pc && pb && pf) {
			const d = (p: LonLat): number => { const q = lonlatTo3D(p[0], p[1]); return Math.hypot(q[0] - st.eye[0], q[1] - st.eye[1], q[2] - st.eye[2]); };
			const r = Math.pow(2, Math.floor(Math.log2(Math.max(1, d(pc) / d(pb))) * 4) / 4);   // 1/4 段で量子化
			if (r >= 1.3) out.push(snapWin(pf[0], pf[1], capW / r * 1.1, capH / r * 1.1));
		}
	}
	for (const k of GND_SCALES) out.push(snapWin(cam.center[0], cam.center[1], capW * k, capH * k));
	return out;
}
export const windowsKey = (wins: readonly (readonly number[])[]): string => wins.map(w => w.map(v => v.toFixed(6)).join(",")).join("|");
