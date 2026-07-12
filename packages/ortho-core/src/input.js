// 入力コントローラ（カメラ操作の所作）＝苦労の結晶を一箇所に：
// ・パン＝grab-point（掴んだ地点をカーソル下に保つ）＋レート方式の併走。球の縁では幾何が縮退する
//   （光線が球を外す＝unproject null で凍る／縁際でヤコビアン爆発＝すっぽ抜け）ため、レートを
//   ①球外れ時のフォールバック ②縁の爆発の頭打ち に使う＝低ズーム/縁でも張り付かない。消すと再発する。
// ・anchoredAt＝カーソル下の地点を固定したままズーム/軸回転。アンカー不成立（空/地平線の向こう）や
//   補正が画面スパン超（地平線際の遠地点＝1目盛りで数十km飛ぶ）は補正を捨て中心回転へ退避＝「暴れたら大人しい方」。
// ・タッチ＝Google/Apple が世界に教育した2本指の語彙に乗る（v1 ortho-map の pinch+twist の移植＋チルト追加）：
//   1本指=パン／2本指ひらく=ズーム（重心アンカー）／2本指ひねる=回転／2本指の平行縦ドラッグ=チルト。
//   チルトは開始の判定窓（〜12px）で「間隔・角度ほぼ不変＋縦優勢」の時だけロック＝ズームと混ざって酔わない（Googleと同じ裁き）。
//   3本指以上は関知しない＝iPadOS のシステムジェスチャ（コピー/取り消し）に譲る。
// ・座標は常に canvas ローカル（evXY）＝#map がページのどこに置かれても幾何が狂わない（埋め込み対応）。
// アプリ固有の反応（identify・ホバー・フライト中断）はコールバックで注入＝エンジンは地図の掴み方だけを知る。
import { cameraState, unproject } from "./camera.js";
const D2R = Math.PI / 180;

// createInput({ canvas, cam, size, dpr, maxPitch, zoomMin, zoomMax, onMove, onGesture, onClick, onHover })
//   size＝{w,h}（device px・呼び出し側の resize が更新する参照を共有）。onGesture＝掴んだ/回した瞬間（フライト中断用）。
//   onClick(x,y)＝動かず離した（<4px）＝クリック。onHover(x,y)＝ドラッグ外の移動。座標はローカルCSS px。
// 戻り値 { evXY, anchoredAt }＝座標変換とアンカー適用は他所（計器・将来のジェスチャ）からも使える。
export function createInput({ canvas, cam, size, dpr, maxPitch, zoomMin = 1, zoomMax = 19, onMove, onGesture = () => {}, onClick = () => {}, onHover = () => {} }) {
	let drag = null;              // 1本指/マウスのドラッグ状態
	const touches = new Map();    // アクティブなタッチポインタ pointerId → {x,y}
	let pinch = null;             // 2本指状態 { d,a,cx,cy（前フレーム）, sd,sa,sx,sy（開始）, mode: null|"tilt"|"free" }
	const evXY = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	const clampPitch = v => Math.max(0, Math.min(maxPitch, v));
	const clampZoom = v => Math.max(zoomMin, Math.min(zoomMax, v));
	const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));   // 角度差を(-π,π]へ（atan2跨ぎの跳び防止）

	// パン共通：画面上の移動 (fx,fy)→(tx,ty) を grab＋レート併走で球へ。1本指・マウス・2本指重心、全て同じ所作。
	function panBy(fx, fy, tx, ty) {
		const dxp = tx - fx, dyp = ty - fy;
		const st = cameraState(cam, size.w, size.h);
		const a = unproject(st, fx * dpr, fy * dpr), b = unproject(st, tx * dpr, ty * dpr);
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
		onMove();
	}

	canvas.addEventListener("contextmenu", e => e.preventDefault());
	canvas.addEventListener("pointerdown", e => {
		onGesture();   // 掴んだ瞬間＝主導権は人（呼び出し側がフライト中断等）
		const [x, y] = evXY(e);
		try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベント（テスト）はcapture不可＝無視 */ }
		if (e.pointerType === "touch") {
			touches.set(e.pointerId, { x, y });
			if (touches.size === 2) { drag = null; pinch = startPinch(); return; }   // 2本目＝2本指ジェスチャ開始（クリック判定も放棄）
			if (touches.size > 2) { pinch = null; return; }                          // 3本以上＝OSのジェスチャに譲る
		}
		drag = { x, y, x0: x, y0: y, tilt: e.button === 2 || e.shiftKey || e.ctrlKey };
	});
	const lift = e => {
		if (e.pointerType === "touch" && touches.has(e.pointerId)) {
			touches.delete(e.pointerId);
			if (touches.size === 1) {   // 2本→1本：残った指でそのままパン継続（x0=NaN＝ピンチ後の誤クリックを構造的に断つ）
				pinch = null;
				const t = [...touches.values()][0];
				drag = { x: t.x, y: t.y, x0: NaN, y0: NaN, tilt: false };
				return;
			}
			if (touches.size === 0) pinch = null;
		}
		const [x, y] = evXY(e);
		if (drag && !drag.tilt && Math.hypot(x - drag.x0, y - drag.y0) < 4) onClick(x, y);   // 動いていない＝クリック（NaNは偽）
		drag = null;
	};
	canvas.addEventListener("pointerup", lift);
	canvas.addEventListener("pointercancel", lift);
	canvas.addEventListener("pointermove", e => {
		const [ex, ey] = evXY(e);
		if (e.pointerType === "touch" && touches.has(e.pointerId)) {
			const t = touches.get(e.pointerId); t.x = ex; t.y = ey;
			if (pinch && touches.size === 2) { movePinch(); return; }
			if (touches.size > 2) return;
		}
		if (!drag) { onHover(ex, ey); return; }
		if (drag.tilt) {
			cam.bearing += (ex - drag.x) * 0.006;
			cam.pitch = clampPitch(cam.pitch + (ey - drag.y) * 0.005);
			onMove();
		} else panBy(drag.x, drag.y, ex, ey);
		drag.x = ex; drag.y = ey;
	});

	function startPinch() {
		const [p, q] = [...touches.values()];
		const d = Math.hypot(q.x - p.x, q.y - p.y) || 1, a = Math.atan2(q.y - p.y, q.x - p.x);
		const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2;
		return { d, a, cx, cy, p0: { ...p }, q0: { ...q }, mode: null };
	}
	function movePinch() {
		const [p, q] = [...touches.values()];   // Mapの列挙順＝挿入順で安定＝p0/q0と同じ指が対応
		const d = Math.hypot(q.x - p.x, q.y - p.y) || 1, a = Math.atan2(q.y - p.y, q.x - p.x);
		const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2;
		// モード判定：開始から十分動くまで保留。判定材料は「指ごとの始点からの変位ベクトル」＝
		// pointermove が片指ずつ届いても歪まない（間隔/角度の瞬間値は到着順で跳ぶため使わない）。
		// 2本が平行（内積>0.7）かつ縦優勢＝チルトにロック、それ以外＝自由（ズーム+回転+パンの合成）。
		if (!pinch.mode) {
			const ux = p.x - pinch.p0.x, uy = p.y - pinch.p0.y, vx = q.x - pinch.q0.x, vy = q.y - pinch.q0.y;
			const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
			if (Math.max(lu, lv) > 12) {
				const parallel = lu > 4 && lv > 4 && (ux * vx + uy * vy) > 0.7 * lu * lv;
				const vertical = Math.abs(uy + vy) > 2 * Math.abs(ux + vx);
				pinch.mode = parallel && vertical ? "tilt" : "free";
			}
		}
		if (pinch.mode === "tilt") {
			cam.pitch = clampPitch(cam.pitch + (cy - pinch.cy) * 0.005);   // マウス右ドラッグと同係数＝手触りを揃える
			onMove();
		} else if (pinch.mode === "free") {
			panBy(pinch.cx, pinch.cy, cx, cy);                             // 重心＝掴み点（1本指と同じ所作）
			const da = wrapAngle(a - pinch.a), dz = Math.log2(d / pinch.d);
			anchoredAt(cx, cy, () => {
				cam.zoom = clampZoom(cam.zoom + dz);
				cam.bearing -= da;   // 指の間の線が地図に貼り付く向き（コンパス針=rotate(-bearing)から導出。実機で逆なら符号1つ）
			});
		}
		pinch.d = d; pinch.a = a; pinch.cx = cx; pinch.cy = cy;
	}

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
		else anchoredAt(wx, wy, () => { cam.zoom = clampZoom(cam.zoom - e.deltaY * 0.002); });  // ズーム
	}, { passive: false });
	return { evXY, anchoredAt };
}
