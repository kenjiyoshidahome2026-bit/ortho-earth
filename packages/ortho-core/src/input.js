// 入力コントローラ（カメラ操作の所作）＝苦労の結晶を一箇所に：
// ・パン＝grab-point（掴んだ地点をカーソル下に保つ）＋レート方式の併走。球の縁では幾何が縮退する
//   （光線が球を外す＝unproject null で凍る／縁際でヤコビアン爆発＝すっぽ抜け）ため、レートを
//   ①球外れ時のフォールバック ②縁の爆発の頭打ち に使う＝低ズーム/縁でも張り付かない。消すと再発する。
// ・anchoredAt＝カーソル下の地点を固定したままズーム/軸回転。アンカー不成立（空/地平線の向こう）や
//   補正が画面スパン超（地平線際の遠地点＝1目盛りで数十km飛ぶ）は補正を捨て中心回転へ退避＝「暴れたら大人しい方」。
// ・座標は常に canvas ローカル（evXY）＝#map がページのどこに置かれても幾何が狂わない（埋め込み対応）。
// アプリ固有の反応（identify・ホバー・フライト中断）はコールバックで注入＝エンジンは地図の掴み方だけを知る。
import { cameraState, unproject } from "./camera.js";
const D2R = Math.PI / 180;

// createInput({ canvas, cam, size, dpr, maxPitch, zoomMin, zoomMax, onMove, onGesture, onClick, onHover })
//   size＝{w,h}（device px・呼び出し側の resize が更新する参照を共有）。onGesture＝掴んだ/回した瞬間（フライト中断用）。
//   onClick(x,y)＝動かず離した（<4px）＝クリック。onHover(x,y)＝ドラッグ外の移動。座標はローカルCSS px。
// 戻り値 { evXY, anchoredAt }＝座標変換とアンカー適用は他所（計器・将来のジェスチャ）からも使える。
export function createInput({ canvas, cam, size, dpr, maxPitch, zoomMin = 1, zoomMax = 19, onMove, onGesture = () => {}, onClick = () => {}, onHover = () => {} }) {
	let drag = null;
	const evXY = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	canvas.addEventListener("contextmenu", e => e.preventDefault());
	canvas.addEventListener("pointerdown", e => {
		onGesture();   // 掴んだ瞬間＝主導権は人（呼び出し側がフライト中断等）
		const [x, y] = evXY(e);
		drag = { x, y, x0: x, y0: y, tilt: e.button === 2 || e.shiftKey || e.ctrlKey };
		canvas.setPointerCapture(e.pointerId);
	});
	canvas.addEventListener("pointerup", e => {
		const [x, y] = evXY(e);
		if (drag && !drag.tilt && Math.hypot(x - drag.x0, y - drag.y0) < 4) onClick(x, y);   // 動いていない＝クリック
		drag = null;
	});
	canvas.addEventListener("pointermove", e => {
		const [ex, ey] = evXY(e);
		if (!drag) { onHover(ex, ey); return; }
		const dxp = ex - drag.x, dyp = ey - drag.y;
		if (drag.tilt) {
			cam.bearing += dxp * 0.006;
			cam.pitch = Math.max(0, Math.min(maxPitch, cam.pitch + dyp * 0.005));
		} else {
			const st = cameraState(cam, size.w, size.h);
			const a = unproject(st, drag.x * dpr, drag.y * dpr), b = unproject(st, ex * dpr, ey * dpr);
			const degPerPx = 360 / (Math.pow(2, cam.zoom) * 512);                        // ズームでの1CSSpx当たり経度（概算）
			const rLon = -dxp * degPerPx / Math.max(0.2, Math.cos(cam.center[1] * D2R)); // レート方式（高緯度ほど経度を伸ばす）
			const rLat = dyp * degPerPx;
			let dLon = rLon, dLat = rLat;                                                // 既定＝レート（球外れ時のフォールバック）
			if (a && b) {
				const gLon = -(b[0] - a[0]), gLat = -(b[1] - a[1]);                      // grab-point（正確）
				if (Math.hypot(gLon, gLat) <= Math.hypot(rLon, rLat) * 6) { dLon = gLon; dLat = gLat; }  // 暴れてなければ採用、縁の爆発はレートへ退避
			}
			cam.center[0] += dLon;
			cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] + dLat));
		}
		drag.x = ex; drag.y = ey;
		onMove();
	});
	function anchoredAt(px, py, mutate) {   // px/py＝canvasローカルCSS座標
		const st0 = cameraState(cam, size.w, size.h);
		const a = unproject(st0, px * dpr, py * dpr);
		mutate();
		if (a) {
			const st1 = cameraState(cam, size.w, size.h);
			const b = unproject(st1, px * dpr, py * dpr);
			const spanDeg = 360 / (Math.pow(2, cam.zoom) * 512) * Math.max(size.w, size.h);   // 画面いっぱい分の度数（概算）
			if (b && Math.hypot(a[0] - b[0], a[1] - b[1]) <= spanDeg) {
				cam.center[0] += a[0] - b[0];
				cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] + a[1] - b[1]));
			}
		}
		onMove();
	}
	// 回転修飾キー：Macは⌘（ctrl+wheelはトラックパッドのピンチ＝ズームに温存）、Mac以外は⌘が無いのでCtrl。
	const ROTKEY_IS_META = /Mac/.test(navigator.platform);
	canvas.addEventListener("wheel", e => {
		e.preventDefault();
		onGesture();   // ホイールでも主導権は人
		const [wx, wy] = evXY(e);
		if (ROTKEY_IS_META ? e.metaKey : e.ctrlKey) anchoredAt(wx, wy, () => { cam.bearing += e.deltaY * 0.01; });   // 軸回転（⌘/Ctrl＋ホイール）
		else anchoredAt(wx, wy, () => { cam.zoom = Math.max(zoomMin, Math.min(zoomMax, cam.zoom - e.deltaY * 0.002)); });  // ズーム
	}, { passive: false });
	return { evXY, anchoredAt };
}
