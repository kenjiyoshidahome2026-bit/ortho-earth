// 地面アトラスの窓（RTT ドレープ・2026-09-21）＝両バックエンド共通の純関数。
// 3 段（近/中/遠）：近＝視野中心 ±1 画面幅（zoom を 1/4 段で量子化＝ズーム中に毎フレーム作り直さない）、中＝6 倍、遠＝36 倍。
// 原点は半幅の 1/4 刻みにスナップ＝カメラが窓幅の 1/8 動いた時だけ再合成（標本化は正確な窓座標で行う＝絵は飛ばない）。
export const GND_SCALES = [1, 6, 36];
export function groundWindows(cam, W, H) {
	const dpr = cam.dpr || 1, zq = Math.floor(cam.zoom * 4) / 4;
	const capW = 360 * (W / dpr) / (256 * Math.pow(2, zq)), capH = capW * H / W;
	const out = [];
	for (const k of GND_SCALES) {
		const hw = capW * k, hh = capH * k, step = hw / 4;
		const cx = Math.round(cam.center[0] / step) * step, cy = Math.round(cam.center[1] / step) * step;
		out.push([cx - hw, Math.max(-85, cy - hh), cx + hw, Math.min(85, cy + hh)]);
	}
	return out;
}
export const windowsKey = wins => wins.map(w => w.map(v => v.toFixed(6)).join(",")).join("|");
