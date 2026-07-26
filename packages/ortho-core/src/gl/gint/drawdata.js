// cam → drawData（mvp/eye/origin/RTE錨/LODランク/視野bbox）。worker（gintworker）と embedded
// （renderworker 同居＝1canvas統合）の両モードで共用する「site 3 の心室」。
// 単位は device px 一本（s.width/height は device px、線幅は ×s.dpr 済みで返す）。

import { s } from './state.js';
import { cameraState, unproject, lonlatTo3D } from '../../camera.js';
import * as mat from '../../mat.js';

// Morton 整数（1e-7°）へ。antimeridian は下流の dlonE7 が畳むのでここは素直に。
const SE = 1e7;
export function toMortonX(lon) { return (Math.round((lon + 180) * SE)) >>> 0; }
export function toMortonY(lat) { return (Math.round((lat +  90) * SE)) >>> 0; }

// 現ズームが実描画レンジ内か（データ導出レンジ × style 指定レンジの積）。
export function zoomInRange(data) {
	const zoom = data.cam.zoom;
	const effMin = Math.max(s.minZoom ?? 0,  data.minZoom ?? 0);
	const effMax = Math.min(s.maxZoom ?? 22, data.maxZoom ?? 22);
	return zoom >= effMin && zoom <= effMax;
}

// data: { cam, lineWidth?, fillColor?, styleTable?, dashTable?, maskColor?, ptRadius?, minZoom?, maxZoom? }
// 副作用：s.cam（identify の unproject 用）と s.lastViewBbox（可視カリング/JS fallback 絞り込み）を更新。
export function computeDrawData(data) {
	// ── site 3：cam → mvp/eye/origin（v1 の d3 lastProj の建て替え）──
	const st = cameraState(data.cam, s.width, s.height);
	s.cam = st;                                    // identify の unproject 用（site 4）
	// 視野中心＝Morton 中心（origin が視野を追う＝精度）。ただし【1e-7° に量子化してから】錨を計算する：
	// 頂点デルタは round された u_ix_center 基準なのに、錨（origin_trig/clipT/origin_zr）を生の center から
	// 作ると ±0.5e-7° の不一致が「パンで毎フレーム変わる全体オフセット」になり z20+ で這う揺らぎ
	//（f32忠実シミュ実測: z20=0.15px/z22=0.55px/z23=1.3px → 量子化一致で全ズーム 0.000px）。
	// カメラ姿勢(st)は生の center のまま＝量子化するのは錨とデルタの「共通原点」だけ。
	const lonN = ((data.cam.center[0] % 360) + 540) % 360 - 180;
	const origin = [Math.round((lonN + 180) * 1e7) / 1e7 - 180,
	                Math.round((data.cam.center[1] + 90) * 1e7) / 1e7 - 90];
	// MVP相殺回避の錨＝原点3D の clip 位置と zr を float64(CPU)で先に確定（Float32 化前の st.mvp で）。
	// シェーダは頂点3D−原点3D（小・正確）だけを u_mvp で回し、この錨へ足す＝高ズームの桁落ちを断つ。
	const T = lonlatTo3D(origin[0], origin[1]);
	const clipT = mat.transform(st.mvp, [T[0], T[1], T[2], 1]);
	const originZr = mat.dot(T, st.eye) - 1;
	const drawData = {
		mvp:        st.mvp instanceof Float32Array ? st.mvp : Float32Array.from(st.mvp),
		eye:        st.eye,
		origin, clipT, originZr,
		originPt:   T,   // 原点3D（double算出）＝深度統合時の標高ドレープで絶対方向 dir=originPt+rel を組む錨
		zoom:       data.cam.zoom,                      // 低ズームのベタ塗り判定用（renderCleanScene が s.outlineZoom と比較）
		lineWidth:  (data.lineWidth ?? 1.0) * s.dpr,   // device px 一本化（shader は u_dpr=1 前提）
		fillColor:  data.fillColor,
		styleTable: data.styleTable,
		dashTable:  data.dashTable,
		maskColor:  data.maskColor,
		ptRadius:   (data.ptRadius ?? 1.5) * s.dpr,
	};

	// ── GPU Dynamic LOD 閾値：現ビューの 1px が覆う地表面積(sq-deg, cos-lat 補正) を rust get_phys_rank と
	// 同式で rank 化。この rank 未満の頂点(辺)は VS で discard＝毎フレームの描画頂点を桁で削減。
	// gap は「discard される辺=サブピクセル」なので原理的に不可視（VW eff-area の単調性＝strict superset）。
	{
		const c  = unproject(st, s.width * 0.5,       s.height * 0.5);
		const ex = unproject(st, s.width * 0.5 + 1.0, s.height * 0.5);
		const ey = unproject(st, s.width * 0.5,       s.height * 0.5 + 1.0);
		// フォールバック＝ズーム由来 rank（r↔z の既知対応 r=63-3z。w38↔z8.3 / w54↔z3 の梯子と同系）。
		// r=63-3z は 256px世界の z で下の物理式(pxArea)と厳密一致（旧512世界では3ランク粗い側にズレていた）。
		// 旧・既定 0（最細）は「チルトで画面中心が地球を外れる（空を向く）＝unproject不能」の全ビューで
		// LOD/tier が全滅＝海岸線41万辺をフル密度で毎フレーム描画し、GPU 200-700ms/フレームの過負荷になっていた
		//（実機 perf 実測。worker 分離時代は別スレッドで露見せず、1canvas統合で地図フレームごと道連れに）。
		let rank = Math.max(0, Math.min(63, Math.round(63 - 3 * data.cam.zoom)));
		if (c && ex && ey) {
			const cl = Math.cos(c[1] * Math.PI / 180);
			const ax = (ex[0] - c[0]) * cl, ay = ex[1] - c[1];
			const bx = (ey[0] - c[0]) * cl, by = ey[1] - c[1];
			const pxArea = Math.abs(ax * by - ay * bx);   // 1px が覆う地表面積 (sq-deg)
			// LOD_BIAS：閾値を下げるほど頂点を多く残す。0=物理px基準（1px未満を捨てる＝厳密で LOD が最も効く）。
			// イガイガ対策は丸キャップ(capsule SDF)で幾何的に解決済なので、bias は 0 でよい（正なら滑らか寄り・LODは弱まる）。
			const LOD_BIAS = 0;
			if (pxArea > 0) rank = Math.max(0, Math.min(63, Math.floor(1.5 * Math.log2(pxArea) + 61.524) - LOD_BIAS));
		}
		drawData.lodRank = rank;
	}

	// 視野コーナー → Morton 整数 bbox（JS polygon fallback の絞り込み＋可視チャンクカリング）。
	// 8点のどれかが unproject 不能（地球外/地平線が画面内）なら bbox は「部分」＝信頼できない
	// → null（カリング全描画・identify 全走査）。部分 bbox でカリングすると画面内の地物を誤って落とす。
	let vxMin = 0xFFFFFFFF, vyMin = 0xFFFFFFFF, vxMax = 0, vyMax = 0, nValid = 0;
	for (const [cx, cy] of [
		[0, 0], [s.width, 0], [0, s.height], [s.width, s.height],
		[s.width * .5, 0], [s.width * .5, s.height], [0, s.height * .5], [s.width, s.height * .5],
	]) {
		const g = unproject(st, cx, cy);
		if (!g || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) continue;
		nValid++;
		const vx = toMortonX(g[0]), vy = toMortonY(g[1]);
		if (vx < vxMin) vxMin = vx; if (vx > vxMax) vxMax = vx;
		if (vy < vyMin) vyMin = vy; if (vy > vyMax) vyMax = vy;
	}
	if (nValid === 8 && vxMin <= vxMax) {
		s.lastViewBbox = [vxMin, vyMin, vxMax, vyMax];
	} else {
		// コーナー逆写像が欠ける＝地平線が画面内（チルト）。従来は null＝カリング全滅だったが、
		// 可視地表は「カメラ直下点を中心とする地平キャップ」に必ず収まる＝保守的 bbox は常に作れる。
		// 半角 = acos(1/|eye|)（+0.5°余白）。広すぎる（>45°＝全球級）・極近傍・antimeridian 跨ぎは従来どおり null。
		const e = st.eye, eyeLen = Math.hypot(e[0], e[1], e[2]);
		const half = Math.acos(Math.min(1, 1 / eyeLen)) * 180 / Math.PI + 0.5;
		const nLat = Math.asin(e[1] / eyeLen) * 180 / Math.PI;
		const nLon = Math.atan2(e[2], e[0]) * 180 / Math.PI;
		const lonHalf = half / Math.max(Math.cos(Math.min(85, Math.abs(nLat) + half) * Math.PI / 180), 1e-3);
		s.lastViewBbox = (half < 45 && Math.abs(nLat) + half < 85 && nLon - lonHalf > -180 && nLon + lonHalf < 180)
			? [toMortonX(nLon - lonHalf), toMortonY(nLat - half), toMortonX(nLon + lonHalf), toMortonY(nLat + half)]
			: null;
	}

	return drawData;
}
