// 入力コントローラ（カメラ操作の所作）＝苦労の結晶を一箇所に：
// ・パン＝versor（v1 ortho の自由回転）：掴んだ地点→カーソル下の大円回転を姿勢に合成し (lon,lat,bearing) へ
//   分解し直す＝チルト・周辺部・極でも厳密に貼り付き、極越えも自然（north-up は放棄、bearing が天地を引き受ける）。
//   球の縁では光線が球を外す（unproject null＝凍る）ため、レート方式を球外れ時のフォールバックに残す。消すと再発する。
//   limb 際の過敏さ（掴み点が縁ほど1pxの回転角が発散）は1イベント0.5radの頭打ちで受ける。
// ・anchoredAt＝カーソル下の地点を固定したままズーム/軸回転。補正も同じversor＝アンカーが正確に貼り付く。
//   アンカー不成立（空/地平線の向こう）は補正を捨て中心回転へ退避＝「暴れたら大人しい方」。
// ・タッチ＝Google/Apple が世界に教育した2本指の語彙に乗る（v1 ortho-map の pinch+twist の移植＋チルト追加）：
//   1本指=パン／2本指ひらく=ズーム（重心アンカー）／2本指ひねる=回転／2本指の平行縦ドラッグ=チルト。
//   チルトは開始の判定窓（〜12px）で「間隔・角度ほぼ不変＋縦優勢」の時だけロック＝ズームと混ざって酔わない（Googleと同じ裁き）。
//   3本指以上は関知しない＝iPadOS のシステムジェスチャ（コピー/取り消し）に譲る。
// ・座標は常に canvas ローカル（evXY）＝#map がページのどこに置かれても幾何が狂わない（埋め込み対応）。
// アプリ固有の反応（identify・ホバー・フライト中断）はコールバックで注入＝エンジンは地図の掴み方だけを知る。
import { cameraState, unproject, lonlatTo3D, WORLD_PX } from "./camera.js";
import { dot, cross, add, scale } from "./mat.js";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// フォーカスが文字入力系（入力・複数行・プルダウン・編集可能領域）にあるか＝キーボードのカメラ操作/
// ショートカットを譲る対象。SELECT を含む＝プルダウンの矢印/文字送りを地図に奪わせない（印刷/PLATEAU の
// 設定 select で顕在化）。呼び出し側のショートカット群と ortho-core の矢印操作で同じ判定を使い回す。
export const isTypingTarget = (el = document.activeElement) => {
	const t = el && el.tagName;
	return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || !!(el && el.isContentEditable);
};

// createInput({ canvas, cam, size, dpr, maxPitch, zoomMin, zoomMax, onMove, onGesture, onClick, onHover })
//   size＝{w,h}（device px・呼び出し側の resize が更新する参照を共有）。onGesture＝掴んだ/回した瞬間（フライト中断用）。
//   onClick(x,y)＝動かず離した（<4px）＝クリック。onHover(x,y)＝ドラッグ外の移動。座標はローカルCSS px。
//   blocked()＝真ならキーボードのカメラ操作を止める（モーダル表示中など・呼び出し側が注入）。文字入力中は自前で判定。
// 戻り値 { evXY, anchoredAt }＝座標変換とアンカー適用は他所（計器・将来のジェスチャ）からも使える。
export function createInput({ canvas, cam, size, dpr, maxPitch, zoomMin = 2, zoomMax = 20, onMove, onGesture = () => {}, onClick = () => {}, onHover = () => {}, blocked, signal }) {
	let drag = null;              // 1本指/マウスのドラッグ状態
	let ptr = null;               // 直近のマウス位置（CSS px）＝キーボードのズーム/回転アンカー。マウスが地図外なら null（＝画面中心へ退避）
	const touches = new Map();    // アクティブなタッチポインタ pointerId → {x,y}
	let pinch = null;             // 2本指状態 { d,a,cx,cy（前フレーム）, sd,sa,sx,sy（開始）, mode: null|"tilt"|"free" }
	const evXY = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	const clampPitch = v => Math.max(0, Math.min(maxPitch, v));
	const clampZoom = v => Math.max(zoomMin, Math.min(zoomMax, v));
	const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));   // 角度差を(-π,π]へ（atan2跨ぎの跳び防止）

	// versor回転（v1 ortho/d3-versor の自由回転の移植）：掴んだ地点a→今カーソル下bの大円回転を姿勢に合成し、
	// (lon,lat,bearing) へ分解し直す。このカメラ族は全球回転で閉じている（pitch/zoomは注視点相対＝回しても不変）
	// ので、チルト・周辺部・極でも厳密＝掴んだ地点がカーソルに正確に貼り付く。極越えも自然（天地はbearingが引き受ける）。
	function rotateGrab(a, b) {
		const ua = lonlatTo3D(a[0], a[1]), ub = lonlatTo3D(b[0], b[1]);
		const x = cross(ua, ub), s = Math.hypot(x[0], x[1], x[2]);
		if (s < 1e-12) return;                                        // 無回転（同一点/対蹠点）
		const th = Math.min(Math.atan2(s, dot(ua, ub)), 0.5);         // 1イベント上限≈29°＝limb際の過敏さの頭打ち（旧「縁の爆発」のversor版。追従は次イベントが担う）
		const k = scale(x, 1 / s);
		const cs = Math.cos(th), sn = -Math.sin(th), oc = 1 - cs;     // -th回転＝R⁻¹（世界がaをbへ回る時、カメラ基底は逆へ回る）
		const rot = v => add(add(scale(v, cs), scale(cross(k, v), sn)), scale(k, dot(k, v) * oc));   // Rodrigues
		const lo = cam.center[0] * D2R, la = cam.center[1] * D2R;
		const north = [-Math.sin(la) * Math.cos(lo), Math.cos(la), -Math.sin(la) * Math.sin(lo)];    // camera.jsと同式
		const east = [-Math.sin(lo), 0, Math.cos(lo)];
		const f = add(scale(north, Math.cos(cam.bearing)), scale(east, Math.sin(cam.bearing)));      // 画面上方向の地表向き
		const T2 = rot(lonlatTo3D(cam.center[0], cam.center[1])), f2 = rot(f);
		const lat2 = Math.asin(Math.max(-1, Math.min(1, T2[1]))) * R2D, lon2 = Math.atan2(T2[2], T2[0]) * R2D;
		const lo2 = lon2 * D2R, la2 = lat2 * D2R;
		const north2 = [-Math.sin(la2) * Math.cos(lo2), Math.cos(la2), -Math.sin(la2) * Math.sin(lo2)];
		const east2 = [-Math.sin(lo2), 0, Math.cos(lo2)];
		cam.center = [lon2, lat2];
		cam.bearing = Math.atan2(dot(f2, east2), dot(f2, north2));    // 毎回ベクトルから再導出＝累積誤差なし
	}

	// 地球の見かけ半径（CSS px）＝1/radPerCssPx。z2で163px・z0で41px・z-1で20px・z-5以下は1px未満。
	// レート方式の 360/(2^z·WORLD_PX) 度/px は「この半径の球を掴んだ時の角速度」そのもの＝球が大きい間は正しいが、
	// 球が点に潰れる太陽系圏（z<0）では発散する（z-17で18万度/px＝指1pxでぐるぐる）。→ 掴めない大きさになったら周回へ。
	const globePx = () => Math.pow(2, cam.zoom) * WORLD_PX / (2 * Math.PI);
	const ORBIT_PX = 40;        // 地球の見かけ半径がこれ未満＝指より小さい＝もう「掴む」対象ではない
	const ORBIT_RATE = 0.005;   // rad/CSSpx＝ortho-solar（別URLの太陽系劇場）の周回と同じ手触りに揃える

	// 周回（太陽系圏のパン）：掴む球が無いので「地球を軸に視点を回す」へ役目が変わる＝画面px当たり一定角。
	// 回転は versor と同じ道（rotateGrab に a=新中心・b=現中心を渡す＝その逆回転がカメラに乗る）＝
	// 極越えも bearing の引き受けも既存と同一で、太陽系圏から戻った時に姿勢が壊れない。
	function orbitBy(fx, fy, tx, ty) {
		const dx = (tx - fx) * ORBIT_RATE, dy = (ty - fy) * ORBIT_RATE, th = Math.hypot(dx, dy);
		if (th < 1e-9) return;
		const lo = cam.center[0] * D2R, la = cam.center[1] * D2R;
		const north = [-Math.sin(la) * Math.cos(lo), Math.cos(la), -Math.sin(la) * Math.sin(lo)];
		const east = [-Math.sin(lo), 0, Math.cos(lo)];
		const cb = Math.cos(cam.bearing), sb = Math.sin(cam.bearing);
		const up = add(scale(north, cb), scale(east, sb));         // 画面上＝bearing方向の地表接線（cameraState と同式）
		const right = add(scale(east, cb), scale(north, -sb));     // 画面右
		// 指を右へ＝世界が右へ流れる＝注視点は左(-right)へ／指を下へ＝注視点は上(+up)へ（レート方式の符号を継承）
		const t = scale(add(scale(right, -dx), scale(up, dy)), 1 / th);
		const T = lonlatTo3D(cam.center[0], cam.center[1]);
		const T2 = add(scale(T, Math.cos(th)), scale(t, Math.sin(th)));   // 厳密回転（近似の伸びなし）
		const lat2 = Math.asin(Math.max(-1, Math.min(1, T2[1]))) * R2D, lon2 = Math.atan2(T2[2], T2[0]) * R2D;
		rotateGrab([lon2, lat2], cam.center);
		onMove();
	}

	// パン共通：画面上の移動 (fx,fy)→(tx,ty)。1本指・マウス・2本指重心、全て同じ所作＝versor回転。
	// 球を外した時（空を掴んだ＝unproject null で凍る）だけレート方式で回す。消すと縁で再発する。
	function panBy(fx, fy, tx, ty) {
		if (globePx() < ORBIT_PX) return orbitBy(fx, fy, tx, ty);   // 太陽系圏＝掴む球が無い→周回（発散するレート方式には入れない）
		const st = cameraState(cam, size.w, size.h);
		const a = unproject(st, fx * dpr, fy * dpr), b = unproject(st, tx * dpr, ty * dpr);
		if (a && b) rotateGrab(a, b);
		else {
			const degPerPx = 360 / (Math.pow(2, cam.zoom) * WORLD_PX);                               // ズームでの1CSSpx当たり経度（概算）
			cam.center[0] += -(tx - fx) * degPerPx / Math.max(0.2, Math.cos(cam.center[1] * D2R));   // 高緯度ほど経度を伸ばす
			cam.center[1] = Math.max(-90, Math.min(90, cam.center[1] + (ty - fy) * degPerPx));
		}
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
			if (touches.size === 2) { pinch = startPinch(); drag = null; return; }   // 3本→2本＝残った2本で仕切り直し（旧: pinch=null のまま全指を離すまで無反応）
			if (touches.size === 0) pinch = null;
		}
		const [x, y] = evXY(e);
		if (drag && !drag.tilt && Math.hypot(x - drag.x0, y - drag.y0) < 4) onClick(x, y);   // 動いていない＝クリック（NaNは偽）
		drag = null;
	};
	canvas.addEventListener("pointerup", lift);
	canvas.addEventListener("pointercancel", lift);
	canvas.addEventListener("pointerleave", e => { if (e.pointerType !== "touch") ptr = null; });   // マウスが地図外へ＝アンカー位置を手放す（キーボードは画面中心へ）
	canvas.addEventListener("pointermove", e => {
		const [ex, ey] = evXY(e);
		if (e.pointerType !== "touch") ptr = [ex, ey];   // マウスの現在地を記録＝キーボードのズーム/回転アンカー
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
				// 太陽系圏はチルト封印＝地面が無い深さで pitch を溜めると、戻った時に地球が傾いたままになる
				// （この距離では pitch は実質「南北の周回」と同義＝二重の操作系になる）。2本指縦は素直に周回＋ズームへ。
				pinch.mode = parallel && vertical && globePx() >= ORBIT_PX ? "tilt" : "free";
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
		// 太陽系圏＝地球が数px以下＝アンカーが立っても「1pxの点を指の位置へ戻す」巨大回転になる（＝暴れる）。
		// この深さの主役は画面中心の地球＝中心ズームが正しい（「暴れたら大人しい方」の原則をそのまま適用）。
		const a = globePx() < ORBIT_PX ? null : unproject(st0, px * dpr, py * dpr);
		mutate();
		if (a) {
			const st1 = cameraState(cam, size.w, size.h);
			const b = unproject(st1, px * dpr, py * dpr);
			if (b) rotateGrab(a, b);   // アンカー点aを元のカーソル位置へ戻す回転（versor・厳密）。不成立（空/地平線の向こう）は中心回転のまま
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

	// キーボードによる連続カメラ操作（押しっぱなしで動き続ける＝毎フレーム微小デルタ）：
	//   矢印単独＝パン（掴み点=画面中心の versor パン＝チルト/回転中でも画面基準で正しく動く）
	//   Shift+↑↓＝ズーム／Shift+←→＝回転（どちらも画面中心アンカー＝寄せた中心が動かない）
	//   ⌘/Ctrl+↑↓＝チルト（上=起こす・下=倒す）
	// 修飾の優先＝チルト > ズーム/回転 > パン。入力欄フォーカス中は素通し（そちらのカーソル移動を邪魔しない）。
	const KB_PAN = 9, KB_ZOOM = 0.028, KB_ROT = 0.022, KB_PITCH = 0.018;   // 1フレーム当たりの移動量（60fps基準の手触り）
	const ARROWS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
	const held = new Set();
	let kbdRaf = 0, mod = { shift: false, ctrl: false, meta: false };
	function kbdFrame() {
		if (!held.size) { kbdRaf = 0; return; }
		const cx = size.w / dpr / 2, cy = size.h / dpr / 2;   // 画面中心（CSS px）＝パン掴み点・アンカーの退避先
		const up = held.has("ArrowUp") ? 1 : 0, dn = held.has("ArrowDown") ? 1 : 0, lf = held.has("ArrowLeft") ? 1 : 0, rt = held.has("ArrowRight") ? 1 : 0;
		if (mod.ctrl || mod.meta) {                                        // チルト（上=起こす／下=倒す）
			if (up || dn) { cam.pitch = clampPitch(cam.pitch + (up - dn) * KB_PITCH); onMove(); }
		} else if (mod.shift) {                                           // ズーム（上下）＋回転（左右）＝マウス位置を軸に（無ければ画面中心）一括
			const dz = (up - dn) * KB_ZOOM, db = (rt - lf) * KB_ROT;
			const ax = ptr ? ptr[0] : cx, ay = ptr ? ptr[1] : cy;
			if (dz || db) anchoredAt(ax, ay, () => { cam.zoom = clampZoom(cam.zoom + dz); cam.bearing += db; });
		} else {                                                          // パン（← 西を見る＝掴み点を右へ、↑ 北を見る＝掴み点を下へ）
			const tx = cx + (lf - rt) * KB_PAN, ty = cy + (up - dn) * KB_PAN;
			if (tx !== cx || ty !== cy) panBy(cx, cy, tx, ty);
		}
		kbdRaf = requestAnimationFrame(kbdFrame);
	}
	window.addEventListener("keydown", e => {
		mod = { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey };   // 修飾は毎イベントで最新化（押しっぱ中のShift追加/解除に追従）
		if (!ARROWS[e.key] || isTypingTarget() || blocked?.()) return;   // 文字入力中・モーダル表示中(blocked)は矢印を地図に奪わせない
		e.preventDefault();                                              // ページスクロール/履歴移動を止める
		if (!held.size) onGesture();                                     // 操作開始＝フライト中断（主導権は人）
		held.add(e.key);
		if (!kbdRaf) kbdRaf = requestAnimationFrame(kbdFrame);
	}, { signal });
	window.addEventListener("keyup", e => { mod = { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey }; if (ARROWS[e.key]) held.delete(e.key); }, { signal });
	window.addEventListener("blur", () => held.clear(), { signal });    // フォーカスを失ったら押下状態を捨てる（キー詰まり防止）

	return { evXY, anchoredAt };
}
