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
// ・手触り（2026-10-12 A2＝MapLibre 整合）：ドラッグ慣性（pan・rotate・pitch＝MapLibre の inertia の定数そのまま）・ダブルクリック／ダブルタップで z+1（shift で z−1）・
//   shift+ドラッグのボックスズーム（矩形→ onBoxZoom(bbox)）・キーボード +/−・handler ごとの on/off（scrollZoom・dragPan・dragRotate・keyboard・doubleClickZoom・
//   boxZoom・touchZoomRotate・touchRotate・touchPitch・cooperativeGestures）・interactive:false＝全部 off・zoomSnap（目盛りに吸着）。
import { cameraState, unproject, lonlatTo3D, WORLD_PX, betaOf, geodeticOf } from "./camera.ts";
import { dot, cross, add, scale } from "./mat.ts";
import type { CameraPose } from "./camera.ts";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** 入力が動かすカメラ（pitch/bearing は必ず数） */
export interface InputCamera extends CameraPose { pitch: number; bearing: number }
export interface InertiaOptions { linearity: number; maxSpeed: number; deceleration: number; ease: [number, number, number, number] }
export interface InertiaRecord { t: number; v: number }
export interface InertiaRecord2 { t: number; vx: number; vy: number }
export interface Inertia { dur: number; amount: number; ease: (x: number) => number }
export interface Inertia2 { dur: number; ax: number; ay: number; ease: (x: number) => number }
export type HandlerName = "scrollZoom" | "dragPan" | "dragRotate" | "keyboard" | "doubleClickZoom" | "boxZoom" | "touchZoomRotate" | "touchRotate" | "touchPitch" | "cooperativeGestures";
export interface BoxZoomInfo { bbox?: [number, number, number, number]; x0?: number; y0?: number; x1?: number; y1?: number }
export interface InputOptions {
	canvas: HTMLCanvasElement; cam: CameraPose; size: { w: number; h: number }; dpr: number; maxPitch: number; zoomMin?: number; zoomMax?: number;
	onMove: () => void; onGesture?: () => void; onClick?: (x: number, y: number) => void; onHover?: (x: number, y: number) => void; blocked?: (() => boolean) | null; signal?: AbortSignal;
	wheelZoom?: "linear" | "maplibre"; handlers?: Partial<Record<HandlerName, boolean>>; interactive?: boolean; cooperativeGestures?: boolean; zoomSnap?: number;
	onBoxZoom?: (phase: "start" | "end" | "cancel", d: BoxZoomInfo) => void; onBlocked?: (kind: "wheel" | "touch") => void;
}
export interface InputController {
	evXY(e: { clientX: number; clientY: number }): [number, number];
	anchoredAt(x: number, y: number, fn: () => void): void;
	setMaxPitch(v: number): void; setZoomMin(v: number): void;
	setHandler(name: HandlerName, on: boolean): void; handlerOn(name: HandlerName): boolean;
	stop(): void; cancelDrag(): void; setZoomSnap(v: number): void; zoomSnap(): number;
}
interface Drag { x: number; y: number; x0: number; y0: number; tilt: boolean; off?: boolean; recs?: InertiaRecord2[] }
interface Touch { x: number; y: number }
interface Pinch { d: number; a: number; cx: number; cy: number; p0: Touch; q0: Touch; mode: null | "tilt" | "free" }
interface Box { x0: number; y0: number; x: number; y: number; el: HTMLDivElement | null }
interface Ease { x: number; y: number; z0: number; z1: number; t0: number; ms?: number }
type InertiaPlan = { kind: "tilt"; dur: number; b: Inertia | null; p: Inertia | null } | { kind: "pan"; dur: number; v: Inertia2 };

// フォーカスが文字入力系（入力・複数行・プルダウン・編集可能領域）にあるか＝キーボードのカメラ操作/
// ショートカットを譲る対象。SELECT を含む＝プルダウンの矢印/文字送りを地図に奪わせない（印刷/建物データ管理 の
// 設定 select で顕在化）。呼び出し側のショートカット群と ortho-core の矢印操作で同じ判定を使い回す。
export const isTypingTarget = (el: Element | null = document.activeElement): boolean => {
	const t = el && el.tagName;
	return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || !!(el && (el as HTMLElement).isContentEditable);
};

// createInput({ canvas, cam, size, dpr, maxPitch, zoomMin, zoomMax, onMove, onGesture, onClick, onHover })
//   size＝{w,h}（device px・呼び出し側の resize が更新する参照を共有）。onGesture＝掴んだ/回した瞬間（フライト中断用）。
//   onClick(x,y)＝動かず離した（<4px）＝クリック。onHover(x,y)＝ドラッグ外の移動。座標はローカルCSS px。
//   blocked()＝真ならキーボードのカメラ操作を止める（モーダル表示中など・呼び出し側が注入）。文字入力中は自前で判定。
// 戻り値 { evXY, anchoredAt }＝座標変換とアンカー適用は他所（計器・将来のジェスチャ）からも使える。
// MapLibre の慣性の定数（handler_inertia.ts・6.x）：pan＝px、rotate＝度、pitch＝度。speed＝amount·linearity/秒 を maxSpeed で頭打ち、
// 減速 deceleration で止まるまでの dur、進む量＝speed·dur/2（等減速）。記録の窓は直近 160ms。
export const INERTIA: { pan: InertiaOptions; rotate: InertiaOptions; pitch: InertiaOptions } = {
	pan: { linearity: 0.3, maxSpeed: 1400, deceleration: 2500, ease: [0, 0, 0.3, 1] },
	rotate: { linearity: 0.25, maxSpeed: 180, deceleration: 720, ease: [0, 0, 0.25, 1] },
	pitch: { linearity: 0.3, maxSpeed: 90, deceleration: 1000, ease: [0, 0, 0.3, 1] },
};
export const INERTIA_WINDOW_MS = 160;
// cubic-bezier(x1,y1,x2,y2) の y(x)（CSS の timing-function と同じ・x を二分探索で解く＝MapLibre の unitbezier と同じ答え）
export function bezierEase(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
	const bz = (a: number, b: number, t: number): number => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
	return x => {
		if (x <= 0) return 0; if (x >= 1) return 1;
		let lo = 0, hi = 1;
		for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (bz(x1, x2, mid) < x) lo = mid; else hi = mid; }
		return bz(y1, y2, (lo + hi) / 2);
	};
}
// 記録 records＝[{ t, v }]（v＝1 フレームの変化量・px か度）→ 慣性 { dur(ms), amount, ease }。無ければ null。
// MapLibre の calculateEasing と同じ式：speed＝Σv·linearity／(窓の秒)・|speed|≤maxSpeed・dur＝|speed|/(deceleration·linearity)・amount＝speed·dur/2
export function inertiaOf(records: readonly InertiaRecord[], now: number, o: InertiaOptions = INERTIA.pan): Inertia | null {
	const recs = records.filter(r => now - r.t <= INERTIA_WINDOW_MS);
	if (recs.length < 2) return null;
	const span = recs[recs.length - 1].t - recs[0].t;
	const sum = recs.reduce((a, r) => a + r.v, 0);
	if (!(span > 0) || sum === 0) return null;
	const speed = Math.max(-o.maxSpeed, Math.min(o.maxSpeed, sum * o.linearity / (span / 1000)));
	const dur = Math.abs(speed) / (o.deceleration * o.linearity);
	if (!(dur > 0)) return null;
	return { dur: dur * 1000, amount: speed * (dur / 2), ease: bezierEase(...o.ease) };
}
// 2 次元（pan）＝向きは保って大きさで頭打ち（MapLibre と同じ：速度ベクトルの mag を clamp）
export function inertiaOf2(records: readonly InertiaRecord2[], now: number, o: InertiaOptions = INERTIA.pan): Inertia2 | null {
	const recs = records.filter(r => now - r.t <= INERTIA_WINDOW_MS);
	if (recs.length < 2) return null;
	const span = recs[recs.length - 1].t - recs[0].t;
	const sx = recs.reduce((a, r) => a + r.vx, 0), sy = recs.reduce((a, r) => a + r.vy, 0), mag = Math.hypot(sx, sy);
	if (!(span > 0) || mag === 0) return null;
	const sp = Math.min(o.maxSpeed, mag * o.linearity / (span / 1000));
	const dur = sp / (o.deceleration * o.linearity);
	if (!(dur > 0)) return null;
	return { dur: dur * 1000, ax: sx / mag * sp * (dur / 2), ay: sy / mag * sp * (dur / 2), ease: bezierEase(...o.ease) };
}
// zoomSnap＝目盛り（0＝無し）に吸着
export const snapZoom = (z: number, snap: number): number => snap > 0 ? Math.round(z / snap) * snap : z;
export const HANDLER_NAMES: readonly HandlerName[] = ["scrollZoom", "dragPan", "dragRotate", "keyboard", "doubleClickZoom", "boxZoom", "touchZoomRotate", "touchRotate", "touchPitch", "cooperativeGestures"];

export function createInput({ canvas, cam: cam0, size, dpr, maxPitch, zoomMin = 2, zoomMax = 20, onMove, onGesture = () => {}, onClick = () => {}, onHover = () => {}, blocked, signal, wheelZoom = "linear",
	handlers = {}, interactive = true, cooperativeGestures = false, zoomSnap = 0, onBoxZoom = () => {}, onBlocked = () => {} }: InputOptions): InputController {
	const cam = cam0 as InputCamera;   // 入力は pitch/bearing を数として扱う（globe の cam は常に数・公開の型は CameraPose＝types/input.d.ts と同じ口）
	// handler の on/off（MapLibre の map.scrollZoom.disable() …）。interactive:false＝全部 off（cooperativeGestures は「協調モード」の旗＝既定 off）
	const H = Object.fromEntries(HANDLER_NAMES.map(n => [n, n === "cooperativeGestures" ? !!cooperativeGestures : interactive !== false && handlers[n] !== false])) as Record<HandlerName, boolean>;
	let zoomSnapCur = +zoomSnap || 0;
	// wheelZoom＝ホイール 1 目盛りのズーム量："linear"（従来＝deltaY×0.002）｜"maplibre"（MapLibre の ScrollZoomHandler と同じ）2026-09-30：
	//   種類の見分け（value＝deltaY・行モードは ×40）：4.000244140625 の倍数＝マウスのホイール（wheel）／|value|<4＝トラックパッド／それ以外は前の事象からの間隔で（|間隔×value|<200＝トラックパッド）
	//   量＝log2(2/(1+e^(−|value|×rate)))・rate＝wheel 1/450（100 で 0.15 段）／trackpad 1/100（4.5 倍敏感＝本人「ref の方が感度がいい」＝トラックパッドを 1/450 で受けていた）
	let wType: "wheel" | "trackpad" | null = null, wLastT = 0;
	// マウスのホイール（wheel）は MapLibre と同じく 200ms かけて滑らかに寄せる（目盛りごとの段差＝引っ掛かりを溶かす・トラックパッドは即時）。目標 z は目盛りが来るたびに積む・錨はホイールの位置
	let ease: Ease | null = null;   // { x, y, z0, z1, t0 }
	const EASE_MS = 200, easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
	const tickEase = (): void => {
		if (!ease) return;
		const k = Math.min(1, (performance.now() - ease.t0) / (ease.ms || EASE_MS)), z = ease.z0 + (ease.z1 - ease.z0) * easeOut(k), e = ease;
		anchoredAt(e.x, e.y, () => { cam.zoom = clampZoom(z); });
		if (k < 1) requestAnimationFrame(tickEase); else ease = null;
	};
	const wheelDz = (dy: number, mode: number): number => {
		if (wheelZoom !== "maplibre") return -dy * 0.002;
		const value = mode === 1 ? dy * 40 : dy, now = performance.now(), dt = now - wLastT; wLastT = now;
		if (value !== 0 && value % 4.000244140625 === 0) wType = "wheel";
		else if (value !== 0 && Math.abs(value) < 4) wType = "trackpad";
		else if (dt > 400 || !wType) wType = Math.abs(dt * value) < 200 ? "trackpad" : "wheel";
		const rate = wType === "wheel" ? 1 / 450 : 1 / 100;
		return -Math.sign(value) * Math.log2(2 / (1 + Math.exp(-Math.abs(value) * rate)));
	};
	let drag: Drag | null = null;              // 1本指/マウスのドラッグ状態
	let ptr: [number, number] | null = null;               // 直近のマウス位置（CSS px）＝キーボードのズーム/回転アンカー。マウスが地図外なら null（＝画面中心へ退避）
	const touches = new Map<number, Touch>();    // アクティブなタッチポインタ pointerId → {x,y}
	let pinch: Pinch | null = null;             // 2本指状態 { d,a,cx,cy（前フレーム）, sd,sa,sx,sy（開始）, mode: null|"tilt"|"free" }
	const evXY = (e: { clientX: number; clientY: number }): [number, number] => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	let maxPitchCur = maxPitch;   // 実行時に変えられる（編集ガジェット＝真上固定 setMaxPitch(0)・解除で戻す）
	const clampPitch = (v: number): number => Math.max(0, Math.min(maxPitchCur, v));
	let zoomMinCur = zoomMin;   // 実行時に変えられる（編集ガジェット＝z2.5 の床・解除で戻す）
	const clampZoom = (v: number): number => Math.max(zoomMinCur, Math.min(zoomMax, v));
	const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));   // 角度差を(-π,π]へ（atan2跨ぎの跳び防止）

	// versor回転（v1 ortho/d3-versor の自由回転の移植）：掴んだ地点a→今カーソル下bの大円回転を姿勢に合成し、
	// (lon,lat,bearing) へ分解し直す。このカメラ族は全球回転で閉じている（pitch/zoomは注視点相対＝回しても不変）
	// ので、チルト・周辺部・極でも厳密＝掴んだ地点がカーソルに正確に貼り付く。極越えも自然（天地はbearingが引き受ける）。
	function rotateGrab(a: ArrayLike<number>, b: ArrayLike<number>): void {
		const ua = lonlatTo3D(a[0], a[1]), ub = lonlatTo3D(b[0], b[1]);
		const x = cross(ua, ub), s = Math.hypot(x[0], x[1], x[2]);
		if (s < 1e-12) return;                                        // 無回転（同一点/対蹠点）
		const th = Math.min(Math.atan2(s, dot(ua, ub)), 0.5);         // 1イベント上限≈29°＝limb際の過敏さの頭打ち（旧「縁の爆発」のversor版。追従は次イベントが担う）
		const k = scale(x, 1 / s);
		const cs = Math.cos(th), sn = -Math.sin(th), oc = 1 - cs;     // -th回転＝R⁻¹（世界がaをbへ回る時、カメラ基底は逆へ回る）
		const rot = (v: ArrayLike<number>): number[] => add(add(scale(v, cs), scale(cross(k, v), sn)), scale(k, dot(k, v) * oc));   // Rodrigues
		// この関数の内部は徹頭徹尾 β単位球の幾何（lonlatTo3D＝β球点・接基底も β で組む）。
		// 出入口だけ測地緯度と変換（球では恒等＝従来とビット同値）。
		const lo = cam.center[0] * D2R, la = betaOf(cam.center[1]) * D2R;
		const north = [-Math.sin(la) * Math.cos(lo), Math.cos(la), -Math.sin(la) * Math.sin(lo)];    // β球の接基底（camera.jsの式のβ版）
		const east = [-Math.sin(lo), 0, Math.cos(lo)];
		const f = add(scale(north, Math.cos(cam.bearing)), scale(east, Math.sin(cam.bearing)));      // 画面上方向の地表向き
		const T2 = rot(lonlatTo3D(cam.center[0], cam.center[1])), f2 = rot(f);
		const lat2 = Math.asin(Math.max(-1, Math.min(1, T2[1]))) * R2D, lon2 = Math.atan2(T2[2], T2[0]) * R2D;   // lat2＝β
		const lo2 = lon2 * D2R, la2 = lat2 * D2R;
		const north2 = [-Math.sin(la2) * Math.cos(lo2), Math.cos(la2), -Math.sin(la2) * Math.sin(lo2)];
		const east2 = [-Math.sin(lo2), 0, Math.cos(lo2)];
		cam.center = [lon2, geodeticOf(lat2)];
		cam.bearing = Math.atan2(dot(f2, east2), dot(f2, north2));    // 毎回ベクトルから再導出＝累積誤差なし
	}

	// 地球の見かけ半径（CSS px）＝1/radPerCssPx。z2で163px・z0で41px・z-1で20px・z-5以下は1px未満。
	// レート方式の 360/(2^z·WORLD_PX) 度/px は「この半径の球を掴んだ時の角速度」そのもの＝球が大きい間は正しいが、
	// 球が点に潰れる太陽系圏（z<0）では発散する（z-17で18万度/px＝指1pxでぐるぐる）。→ 掴めない大きさになったら周回へ。
	const globePx = (): number => Math.pow(2, cam.zoom) * WORLD_PX / (2 * Math.PI);
	const ORBIT_PX = 40;        // 地球の見かけ半径がこれ未満＝指より小さい＝もう「掴む」対象ではない
	const ORBIT_RATE = 0.005;   // rad/CSSpx＝ortho-solar（別URLの太陽系劇場）の周回と同じ手触りに揃える

	// 周回（太陽系圏のパン）：掴む球が無いので「地球を軸に視点を回す」へ役目が変わる＝画面px当たり一定角。
	// 回転は versor と同じ道（rotateGrab に a=新中心・b=現中心を渡す＝その逆回転がカメラに乗る）＝
	// 極越えも bearing の引き受けも既存と同一で、太陽系圏から戻った時に姿勢が壊れない。
	function orbitBy(fx: number, fy: number, tx: number, ty: number): void {
		const dx = (tx - fx) * ORBIT_RATE, dy = (ty - fy) * ORBIT_RATE, th = Math.hypot(dx, dy);
		if (th < 1e-9) return;
		const lo = cam.center[0] * D2R, la = betaOf(cam.center[1]) * D2R;   // β球の接基底（rotateGrab と同じ流儀）
		const north = [-Math.sin(la) * Math.cos(lo), Math.cos(la), -Math.sin(la) * Math.sin(lo)];
		const east = [-Math.sin(lo), 0, Math.cos(lo)];
		const cb = Math.cos(cam.bearing), sb = Math.sin(cam.bearing);
		const up = add(scale(north, cb), scale(east, sb));         // 画面上＝bearing方向の地表接線（cameraState と同式）
		const right = add(scale(east, cb), scale(north, -sb));     // 画面右
		// 指を右へ＝世界が右へ流れる＝注視点は左(-right)へ／指を下へ＝注視点は上(+up)へ（レート方式の符号を継承）
		const t = scale(add(scale(right, -dx), scale(up, dy)), 1 / th);
		const T = lonlatTo3D(cam.center[0], cam.center[1]);
		const T2 = add(scale(T, Math.cos(th)), scale(t, Math.sin(th)));   // 厳密回転（近似の伸びなし）
		const lat2 = Math.asin(Math.max(-1, Math.min(1, T2[1]))) * R2D, lon2 = Math.atan2(T2[2], T2[0]) * R2D;   // lat2＝β
		rotateGrab([lon2, geodeticOf(lat2)], cam.center);   // rotateGrab の口は測地緯度（球では恒等）
		onMove();
	}

	// パン共通：画面上の移動 (fx,fy)→(tx,ty)。1本指・マウス・2本指重心、全て同じ所作＝versor回転。
	// 球を外した時（空を掴んだ＝unproject null で凍る）だけレート方式で回す。消すと縁で再発する。
	function panBy(fx: number, fy: number, tx: number, ty: number): void {
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
		stopInertia(); ease = null;   // 慣性・ズームの滑りも人が掴んだら止める
		const [x, y] = evXY(e);
		try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベント（テスト）はcapture不可＝無視 */ }
		if (e.pointerType === "touch") {
			touches.set(e.pointerId, { x, y });
			if (touches.size === 2) { drag = null; pinch = (H.touchZoomRotate || H.touchPitch) ? startPinch() : null; return; }   // 2本目＝2本指ジェスチャ開始（クリック判定も放棄）
			if (touches.size > 2) { pinch = null; return; }                          // 3本以上＝OSのジェスチャに譲る
		}
		// shift＋左ドラッグ＝ボックスズーム（MapLibre の BoxZoomHandler）。右ボタン／ctrl＝回転・チルト（dragRotate）。旧＝shift もチルトだった（2026-10-12 A2 で MapLibre に揃えた）
		if (e.pointerType !== "touch" && e.button === 0 && e.shiftKey && H.boxZoom) { box = { x0: x, y0: y, x: x, y: y, el: null }; drag = null; return; }
		const tilt = e.button === 2 || e.ctrlKey;
		drag = { x, y, x0: x, y0: y, tilt, off: tilt ? !H.dragRotate : !H.dragPan || (e.pointerType === "touch" && H.cooperativeGestures), recs: [] };   // off＝動かさない（クリック判定だけ残す）
		if (drag.off && e.pointerType === "touch" && H.cooperativeGestures && H.dragPan) onBlocked("touch");
	});
	const lift = (e: PointerEvent): void => {
		if (e.pointerType === "touch" && touches.has(e.pointerId)) {
			touches.delete(e.pointerId);
			if (touches.size === 1) {   // 2本→1本：残った指でそのままパン継続（x0=NaN＝ピンチ後の誤クリックを構造的に断つ）
				pinch = null;
				const t = [...touches.values()][0];
				drag = { x: t.x, y: t.y, x0: NaN, y0: NaN, tilt: false };   // TODO(ts): recs が無い＝この後の pointermove（drag.off 偽）で drag.recs.push が TypeError を投げる（元の JS からの潜在バグ・挙動は変えない）
				return;
			}
			if (touches.size === 2) { pinch = startPinch(); drag = null; return; }   // 3本→2本＝残った2本で仕切り直し（旧: pinch=null のまま全指を離すまで無反応）
			if (touches.size === 0) pinch = null;
		}
		const [x, y] = evXY(e);
		if (box) { endBox(x, y); return; }
		if (drag && !drag.tilt && Math.hypot(x - drag.x0, y - drag.y0) < 4) {   // 動いていない＝クリック（NaNは偽）
			const now = performance.now();
			if (e.pointerType === "touch" && H.doubleClickZoom && lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) { lastTap = null; drag = null; zoomEase(x, y, cam.zoom + 1, 300); return; }   // ダブルタップ＝z+1（MapLibre の TapZoomHandler）
			lastTap = e.pointerType === "touch" ? { t: now, x, y } : null;
			onClick(x, y);
		} else if (drag && !drag.off && drag.recs!.length) startInertia(drag);   // 離した勢いで滑る（MapLibre の inertia）
		drag = null;
	};
	canvas.addEventListener("pointerup", lift);
	canvas.addEventListener("pointercancel", lift);
	canvas.addEventListener("pointerleave", e => { if (e.pointerType !== "touch") ptr = null; });   // マウスが地図外へ＝アンカー位置を手放す（キーボードは画面中心へ）
	canvas.addEventListener("pointermove", e => {
		const [ex, ey] = evXY(e);
		if (e.pointerType !== "touch") ptr = [ex, ey];   // マウスの現在地を記録＝キーボードのズーム/回転アンカー
		if (e.pointerType === "touch" && touches.has(e.pointerId)) {
			const t = touches.get(e.pointerId)!; t.x = ex; t.y = ey;
			if (pinch && touches.size === 2) { movePinch(); return; }
			if (touches.size > 2) return;
		}
		if (box) { box.x = ex; box.y = ey; drawBox(); return; }
		if (!drag) { onHover(ex, ey); return; }
		if (drag.off) { drag.x = ex; drag.y = ey; return; }   // handler off＝掴んでも動かない（MapLibre の dragPan.disable()）
		const now = performance.now();
		if (drag.tilt) {
			const db = (ex - drag.x) * 0.006, dp = clampPitch(cam.pitch + (ey - drag.y) * 0.005) - cam.pitch;
			cam.bearing += db; cam.pitch += dp;
			drag.recs!.push({ t: now, vx: db * R2D, vy: dp * R2D });
			onMove();
		} else { panBy(drag.x, drag.y, ex, ey); drag.recs!.push({ t: now, vx: ex - drag.x, vy: ey - drag.y }); }
		if (drag.recs!.length > 64) drag.recs!.splice(0, drag.recs!.length - 64);
		drag.x = ex; drag.y = ey;
	});
	canvas.addEventListener("dblclick", e => {   // ダブルクリック＝z+1（shift で z−1・MapLibre の DoubleClickZoomHandler・カーソル下を固定）
		if (!H.doubleClickZoom || (e as PointerEvent).pointerType === "touch") return;
		e.preventDefault(); onGesture();
		const [x, y] = evXY(e);
		zoomEase(x, y, cam.zoom + (e.shiftKey ? -1 : 1), 300);
	});
	let box: Box | null = null, lastTap: { t: number; x: number; y: number } | null = null, inertia: { plan: InertiaPlan; t0: number; last: { x: number; y: number; b: number; p: number } } | null = null;
	// ズームの滑り（ホイールの目盛り・ダブルクリック・キーボード +/−）＝anchoredAt を ms かけて easeOut・目盛り（zoomSnap）に吸着
	function zoomEase(x: number, y: number, z1: number, ms: number): void {
		const wasEasing = !!ease;
		ease = { x, y, z0: cam.zoom, z1: clampZoom(snapZoom(z1, zoomSnapCur)), t0: performance.now(), ms };
		if (!wasEasing) requestAnimationFrame(tickEase);
	}
	// 慣性＝離した時の直近 160ms の記録から MapLibre と同じ式で「どれだけ・どれくらいの時間で」を決め、rAF で進める（pan は画面中心の掴み点で versor）
	function startInertia(d: Drag): void {
		const now = performance.now();
		let plan: InertiaPlan;
		const recs = d.recs!;
		if (d.tilt) {
			const b = inertiaOf(recs.map(r => ({ t: r.t, v: r.vx })), now, INERTIA.rotate), p = inertiaOf(recs.map(r => ({ t: r.t, v: r.vy })), now, INERTIA.pitch);
			if (!b && !p) return;
			plan = { kind: "tilt", dur: Math.max(b?.dur || 0, p?.dur || 0), b, p };
		} else {
			const v = inertiaOf2(recs, now, INERTIA.pan);
			if (!v) return;
			plan = { kind: "pan", dur: v.dur, v };
		}
		if (!(plan.dur > 0)) return;
		inertia = { plan, t0: now, last: { x: 0, y: 0, b: 0, p: 0 } };
		requestAnimationFrame(tickInertia);
	}
	function tickInertia(): void {
		if (!inertia) return;
		const { plan, t0, last } = inertia, k = Math.min(1, (performance.now() - t0) / plan.dur);
		if (plan.kind === "pan") {
			const e = plan.v.ease(k), x = plan.v.ax * e, y = plan.v.ay * e;
			const cx = size.w / dpr / 2, cy = size.h / dpr / 2;
			panBy(cx, cy, cx + (x - last.x), cy + (y - last.y));
			last.x = x; last.y = y;
		} else {
			const b = plan.b ? plan.b.amount * plan.b.ease(Math.min(1, (performance.now() - t0) / plan.b.dur)) : 0;
			const p = plan.p ? plan.p.amount * plan.p.ease(Math.min(1, (performance.now() - t0) / plan.p.dur)) : 0;
			cam.bearing += (b - last.b) * D2R; cam.pitch = clampPitch(cam.pitch + (p - last.p) * D2R);
			last.b = b; last.p = p;
			onMove();
		}
		if (k < 1) requestAnimationFrame(tickInertia); else inertia = null;
	}
	function stopInertia(): void { inertia = null; }
	// ボックスズーム（shift＋左ドラッグ）＝点線の矩形を容れ物に描き、離したら四隅を逆投影して bbox を onBoxZoom へ（呼び出し側が fitBounds）
	function drawBox(): void {
		const bx = box!;
		if (!bx.el) {
			const el = document.createElement("div");
			el.className = "ortho-boxzoom";
			Object.assign(el.style, { position: "absolute", boxSizing: "border-box", border: "2px dotted #202020", background: "rgba(0,0,0,.1)", pointerEvents: "none", zIndex: 9 });
			(canvas.parentElement || document.body).appendChild(el); bx.el = el;
			onBoxZoom("start", { x0: bx.x0, y0: bx.y0 });
		}
		const r = canvas.getBoundingClientRect(), pr = (canvas.parentElement || document.body).getBoundingClientRect();
		const l = Math.min(bx.x0, bx.x) + r.left - pr.left, t = Math.min(bx.y0, bx.y) + r.top - pr.top;
		Object.assign(bx.el.style, { left: `${l}px`, top: `${t}px`, width: `${Math.abs(bx.x - bx.x0)}px`, height: `${Math.abs(bx.y - bx.y0)}px` });
	}
	function endBox(x: number, y: number): void {
		const b = box!; box = null;
		if (b.el) b.el.remove();
		if (!b.el || Math.abs(x - b.x0) < 4 || Math.abs(y - b.y0) < 4) { if (b.el) onBoxZoom("cancel", {}); return; }
		const st = cameraState(cam, size.w, size.h), xs = [Math.min(b.x0, x), Math.max(b.x0, x)], ys = [Math.min(b.y0, y), Math.max(b.y0, y)];
		const pts = [[xs[0], ys[0]], [xs[1], ys[0]], [xs[0], ys[1]], [xs[1], ys[1]], [(xs[0] + xs[1]) / 2, ys[0]], [(xs[0] + xs[1]) / 2, ys[1]], [xs[0], (ys[0] + ys[1]) / 2], [xs[1], (ys[0] + ys[1]) / 2]]
			.map(([px, py]) => unproject(st, px * dpr, py * dpr));
		if (pts.some(p => !p)) { onBoxZoom("cancel", {}); return; }   // 球の外（空）を囲んだ＝何もしない
		const lons = pts.map(p => p![0]), lats = pts.map(p => p![1]);
		let w = Math.min(...lons), e = Math.max(...lons);
		if (e - w > 180) { const a = lons.filter(v => v >= 0), c = lons.filter(v => v < 0); w = Math.min(...a); e = Math.max(...c); }   // ±180 を跨ぐ＝西>東で返す
		onBoxZoom("end", { bbox: [w, Math.min(...lats), e, Math.max(...lats)], x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] });
	}

	function startPinch(): Pinch {
		const [p, q] = [...touches.values()];
		const d = Math.hypot(q.x - p.x, q.y - p.y) || 1, a = Math.atan2(q.y - p.y, q.x - p.x);
		const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2;
		return { d, a, cx, cy, p0: { ...p }, q0: { ...q }, mode: null };
	}
	function movePinch(): void {
		const pc = pinch!;
		const [p, q] = [...touches.values()];   // Mapの列挙順＝挿入順で安定＝p0/q0と同じ指が対応
		const d = Math.hypot(q.x - p.x, q.y - p.y) || 1, a = Math.atan2(q.y - p.y, q.x - p.x);
		const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2;
		// モード判定：開始から十分動くまで保留。判定材料は「指ごとの始点からの変位ベクトル」＝
		// pointermove が片指ずつ届いても歪まない（間隔/角度の瞬間値は到着順で跳ぶため使わない）。
		// 2本が平行（内積>0.7）かつ縦優勢＝チルトにロック、それ以外＝自由（ズーム+回転+パンの合成）。
		if (!pc.mode) {
			const ux = p.x - pc.p0.x, uy = p.y - pc.p0.y, vx = q.x - pc.q0.x, vy = q.y - pc.q0.y;
			const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
			if (Math.max(lu, lv) > 12) {
				const parallel = lu > 4 && lv > 4 && (ux * vx + uy * vy) > 0.7 * lu * lv;
				const vertical = Math.abs(uy + vy) > 2 * Math.abs(ux + vx);
				// 太陽系圏はチルト封印＝地面が無い深さで pitch を溜めると、戻った時に地球が傾いたままになる
				// （この距離では pitch は実質「南北の周回」と同義＝二重の操作系になる）。2本指縦は素直に周回＋ズームへ。
				pc.mode = parallel && vertical && globePx() >= ORBIT_PX && H.touchPitch ? "tilt" : "free";
			}
		}
		if (pc.mode === "tilt") {
			if (H.touchPitch) { cam.pitch = clampPitch(cam.pitch + (cy - pc.cy) * 0.005); onMove(); }   // マウス右ドラッグと同係数＝手触りを揃える（touchPitch off＝動かない）
		} else if (pc.mode === "free") {
			if (H.dragPan) panBy(pc.cx, pc.cy, cx, cy);                             // 重心＝掴み点（1本指と同じ所作）
			const da = H.touchZoomRotate && H.touchRotate ? wrapAngle(a - pc.a) : 0, dz = H.touchZoomRotate ? Math.log2(d / pc.d) : 0;
			if (da || dz) anchoredAt(cx, cy, () => {
				cam.zoom = clampZoom(cam.zoom + dz);
				cam.bearing -= da;   // 指の間の線が地図に貼り付く向き（コンパス針=rotate(-bearing)から導出。実機で逆なら符号1つ）
			});
		}
		pc.d = d; pc.a = a; pc.cx = cx; pc.cy = cy;
	}

	function anchoredAt(px: number, py: number, mutate: () => void): void {   // px/py＝canvasローカルCSS座標
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
		if (!H.scrollZoom) return;   // scrollZoom off＝頁のスクロールに譲る（MapLibre と同じ・preventDefault もしない）
		if (H.cooperativeGestures && !(e.ctrlKey || e.metaKey)) { onBlocked("wheel"); return; }   // 協調モード＝修飾キー無しのホイールは頁に譲る（MapLibre の cooperativeGestures）
		e.preventDefault();
		onGesture();   // ホイールでも主導権は人
		stopInertia();
		const [wx, wy] = evXY(e);
		if (!H.cooperativeGestures && (ROTKEY_IS_META ? e.metaKey : e.ctrlKey)) anchoredAt(wx, wy, () => { cam.bearing += e.deltaY * 0.01; });   // 軸回転（⌘/Ctrl＋ホイール・協調モードでは修飾キー＝ズーム）
		else {
			const dz = wheelDz(e.deltaY, e.deltaMode);
			if (wheelZoom === "maplibre" && wType === "wheel") { const from = ease ? ease.z1 : cam.zoom; const wasEasing = !!ease; ease = { x: wx, y: wy, z0: cam.zoom, z1: clampZoom(snapZoom(from + dz, zoomSnapCur)), t0: performance.now() }; if (!wasEasing) tickEase(); }   // 滑らかに（上）
			else anchoredAt(wx, wy, () => { cam.zoom = clampZoom(cam.zoom + dz); });  // 即時（トラックパッド／従来）
		}
	}, { passive: false });

	// キーボードによる連続カメラ操作（押しっぱなしで動き続ける＝毎フレーム微小デルタ）：
	//   矢印単独＝パン（掴み点=画面中心の versor パン＝チルト/回転中でも画面基準で正しく動く）
	//   Shift+↑↓＝ズーム／Shift+←→＝回転（どちらも画面中心アンカー＝寄せた中心が動かない）
	//   ⌘/Ctrl+↑↓＝チルト（上=起こす・下=倒す）
	// 修飾の優先＝チルト > ズーム/回転 > パン。入力欄フォーカス中は素通し（そちらのカーソル移動を邪魔しない）。
	const KB_PAN = 9, KB_ZOOM = 0.028, KB_ROT = 0.022, KB_PITCH = 0.018;   // 1フレーム当たりの移動量（60fps基準の手触り）
	const ARROWS: Record<string, 1 | undefined> = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
	const held = new Set<string>();
	let kbdRaf = 0, mod = { shift: false, ctrl: false, meta: false };
	function kbdFrame(): void {
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
		if (!H.keyboard || isTypingTarget() || blocked?.()) return;   // keyboard off・文字入力中・モーダル表示中(blocked)は地図に奪わせない
		if ((e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") && !e.ctrlKey && !e.metaKey) {   // +/−＝1 段（MapLibre の KeyboardHandler・アンカーはマウス位置か画面中心）
			e.preventDefault(); onGesture();
			const ax = ptr ? ptr[0] : size.w / dpr / 2, ay = ptr ? ptr[1] : size.h / dpr / 2;
			zoomEase(ax, ay, cam.zoom + (e.key === "-" || e.key === "_" ? -1 : 1), 300);
			return;
		}
		if (!ARROWS[e.key]) return;
		e.preventDefault();                                              // ページスクロール/履歴移動を止める
		if (!held.size) onGesture();                                     // 操作開始＝フライト中断（主導権は人）
		held.add(e.key);
		if (!kbdRaf) kbdRaf = requestAnimationFrame(kbdFrame);
	}, { signal });
	window.addEventListener("keyup", e => { mod = { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey }; if (ARROWS[e.key]) held.delete(e.key); }, { signal });
	window.addEventListener("blur", () => held.clear(), { signal });    // フォーカスを失ったら押下状態を捨てる（キー詰まり防止）

	return { evXY, anchoredAt, setMaxPitch: v => { maxPitchCur = v; }, setZoomMin: v => { zoomMinCur = v; },
		// A2：handler の on/off・慣性と滑りの停止・zoomSnap
		setHandler: (name, on) => { if (name in H) H[name] = !!on; },
		handlerOn: name => !!H[name],
		stop: () => { stopInertia(); ease = null; },
		cancelDrag: () => { drag = null; box = null; },   // 掴みを捨てる（層の mousedown の preventDefault＝MapLibre の「地図のドラッグを止める」・C8）
		setZoomSnap: v => { zoomSnapCur = Math.max(0, +v || 0); },
		zoomSnap: () => zoomSnapCur };
}
