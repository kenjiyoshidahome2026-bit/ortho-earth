// ortho-japan PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	createRenderer, createLabelLayer,
	evalExpr, parseRGBA, cameraState, unproject,
} from "ortho-japan";
import { createGeopbf } from "geopbf";
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（標高と同じ）。読み出しはキー不要
import style from "./style-mono.js";
import { shieldFor } from "./shields.js";
import { createThemes, defaultLayerState, CHOME_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";
import { createTerrain } from "./terrain.js";
import { createPipeline } from "./pipeline.js";

const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = document.getElementById("log");
const renderer = createRenderer(canvas);
const EARTH_M = 6371000, TERR_EXAG = 1.0;   // 標高は実スケール（誇張しない＝地形を歪めない）。ラベル・地形・建物で共有

const labelLayer = createLabelLayer(labelCanvas, { shieldFor, elevBase: TERR_EXAG / EARTH_M });

const bg = style.layers.find(L => L.type === "background");
const land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
const clear = [0.03, 0.04, 0.07, 1];   // 宇宙（球の外側）

let dpr = Math.min(2, window.devicePixelRatio || 1);
let needsDraw = true, readySig = "", lastLabels = [], sceneOrigin = null;
let moving = false, settleT = null;
// 移動中は幾何を再結合しない（タイルのポップ＝チラチラ防止）。停止後に再結合。
function onMove() {
	moving = true; needsDraw = true;
	clearTimeout(settleT);
	settleT = setTimeout(() => { moving = false; needsDraw = true; }, 150);
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が非同期で結合→setScene）。
const { tiles, requestMerge } = createPipeline({ renderer, style, tileUrl: TILE_URL, requestDraw: () => { needsDraw = true; } });

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 65 * D2R;   // 半透明の山と割り切り、独立峰をドラマチックに立てる。隠れ線は「透けている」で説明可
const atmo = [0.5, 0.66, 0.96, 0.3];   // 大気色 rgb + 強さ（さりげなく）
const bldColor = [0.83, 0.83, 0.82];    // 建物色（静かなグレー）
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
const cam = { center: [139.767, 35.681], zoom: 16, pitch: 0, bearing: 0, dpr };
renderer.set("view", { clear, land, atmo, bldColor });

function resize() {
	const w = window.innerWidth, h = window.innerHeight;
	for (const cv of [canvas, labelCanvas]) {
		cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
		cv.style.width = w + "px"; cv.style.height = h + "px";
	}
	needsDraw = true;
}
window.addEventListener("resize", resize);

resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
let drag = null;
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("pointerdown", e => {
	drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, tilt: e.button === 2 || e.shiftKey || e.ctrlKey };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", e => {
	if (drag && !drag.tilt && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) overlay.identifyAt(e.clientX, e.clientY);   // 動いていない＝クリック→identify
	drag = null;
});
canvas.addEventListener("pointermove", e => {
	if (!drag) return;
	const dxp = e.clientX - drag.x, dyp = e.clientY - drag.y;
	if (drag.tilt) {
		cam.bearing += dxp * 0.006;
		cam.pitch = Math.max(0, Math.min(MAXPITCH, cam.pitch + dyp * 0.005));
	} else {
		// unproject でつかんだ地点をカーソル下に保つパン
		const st = cameraState(cam, canvas.width, canvas.height);
		const a = unproject(st, drag.x * dpr, drag.y * dpr), b = unproject(st, e.clientX * dpr, e.clientY * dpr);
		if (a && b) { cam.center[0] -= (b[0] - a[0]); cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] - (b[1] - a[1]))); }
	}
	drag.x = e.clientX; drag.y = e.clientY;
	onMove();
});
// カーソル下の地点を固定したままカメラ変更を適用（ズーム/軸回転の中心＝マウス）。チルト時も unproject で正確。
function anchoredAt(clientX, clientY, mutate) {
	const st0 = cameraState(cam, canvas.width, canvas.height);
	const a = unproject(st0, clientX * dpr, clientY * dpr);
	mutate();
	if (a) {
		const st1 = cameraState(cam, canvas.width, canvas.height);
		const b = unproject(st1, clientX * dpr, clientY * dpr);
		if (b) { cam.center[0] += a[0] - b[0]; cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] + a[1] - b[1])); }
	}
	onMove();
}
canvas.addEventListener("wheel", e => {
	e.preventDefault();
	if (e.metaKey) anchoredAt(e.clientX, e.clientY, () => { cam.bearing += e.deltaY * 0.01; });   // 軸回転(Cmd)。ctrl+wheelはトラックパッドのピンチ＝ズームに回す
	else anchoredAt(e.clientX, e.clientY, () => { cam.zoom = Math.max(2, Math.min(19, cam.zoom - e.deltaY * 0.002)); });  // ズーム（z2=地球全体〜z19。16超はベクタのオーバーズーム＝潰れず街路へ）
}, { passive: false });

// テーマ・チップ状態：静かな白黒の土台は常に全部見えている。チップは主題の「文字の表示」
// または「色の点火」を切り替えるだけ。すべて既取得データの再スタイル＝再取得・再デコードなし。
//   chimei/chikei … 文字（注記カテゴリ）の表示ON/OFF
//   rail/road/admin … 色の点火ON/OFF（OFFでも土台グレーは出ている）
const layerState = { ...defaultLayerState };   // UIトグル状態は main が保持・変更（チップで反転）
let styleSig = JSON.stringify(layerState);
const themes = createThemes(style);            // 分類（allowlist）は themes.js の純関数（layerState と zoom を引数で受ける）

// LOD選択 or テーマ状態(styleSig)が変わった時だけシーンを再結合。原点は安定化（プルプル防止）。
let zoomAtBuild = -1;
function swapScene(order) {
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);
	if (sig === readySig || !order.length) return;
	if (!sceneOrigin || Math.abs(sceneOrigin[0] - cam.center[0]) > 0.4 || Math.abs(sceneOrigin[1] - cam.center[1]) > 0.4)
		sceneOrigin = [cam.center[0], cam.center[1]];
	requestMerge("main", order, sceneOrigin, themes.hiddenLi(layerState, cam.zoom));   // 結合は scene worker（非同期）→ 応答で setScene
	lastLabels = themes.filterLabels(tiles.labels(order), layerState, cam.zoom).map(L => {
		// 都道府県は大きく薄い背景ラベルに（コピーしてキャッシュ側を壊さない）。他はそのまま。
		const o = L.code === 140 ? { ...L, size: L.size * 1.25, color: [L.color[0], L.color[1], L.color[2], L.color[3] * 0.5] } : L;
		o.elev = terrain.sampleElev(L.anchor[0], L.anchor[1]);   // 標高付与（傾き時に地物と一致）
		return o;
	});
	labelLayer.setLabels(lastLabels);
	readySig = sig; zoomAtBuild = cam.zoom;
}

// 粗い下地（base スロット）：移動中も常に敷き直して先端の空白・ちらつきを消す。低zで少数＝安く広い。
let baseSig = "";
function swapBase(coarseOrder) {
	const sig = coarseOrder.map(o => o.key).join("|") + "#" + styleSig;
	if (sig === baseSig || !coarseOrder.length) return;
	requestMerge("base", coarseOrder, [cam.center[0], cam.center[1]], themes.hiddenLi(layerState, cam.zoom));   // 下地も scene worker で結合
	baseSig = sig;
}

// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; layerState[k] = !layerState[k];
	b.classList.toggle("on", layerState[k]);
	styleSig = JSON.stringify(layerState); readySig = ""; needsDraw = true;
}));

// コンパス兼リセット：3D（傾き or 回転）の時だけ表示。針は方位を指し、押すと水平・北向きへスッと戻る。
const resetBtn = document.getElementById("reset");
const resetSvg = resetBtn.querySelector("svg");
const shortBearing = () => ((cam.bearing + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;   // 最短回転へ正規化
function updateCompass() {
	const is3D = cam.pitch > 0.005 || Math.abs(shortBearing()) > 0.005;
	resetBtn.style.display = is3D ? "flex" : "none";
	if (is3D) resetSvg.style.transform = `rotate(${-cam.bearing * 180 / Math.PI}deg)`;
}
resetBtn.addEventListener("click", () => {
	const p0 = cam.pitch, b0 = shortBearing(), t0 = performance.now(), dur = 350;
	const step = () => {
		const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k);   // smoothstep
		cam.pitch = p0 * (1 - e); cam.bearing = b0 * (1 - e); onMove();
		if (k < 1) requestAnimationFrame(step);
		else { cam.pitch = 0; cam.bearing = 0; onMove(); }
	};
	requestAnimationFrame(step);
});

// 標高アトラス（altpbf 多解像度・R90/R10/R01）。実装は terrain.js。
// ensure() を毎フレーム呼び、sampleElev() でラベル標高を得る（傾き時に地物と一致）。
const terrain = createTerrain({ renderer, cam, canvas, requestDraw: () => { needsDraw = true; }, exag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com" });

function render() {
	// パン/チルト中（ズーム不変）は詳細も再結合。ズーム中はLODポップ回避で停止まで待つ。
	const zoomStable = Math.abs(cam.zoom - zoomAtBuild) < 0.12;
	// 地形アトラスもズーム中は再構築しない：cellRes/セル数が連続変化して全再ロード＆勾配密度の跳びで
	// 陰影がチラつくため。ズーム中は現アトラスを再投影（球面メッシュなので拡縮は追従）、停止後に再構築。
	if (!moving || zoomStable) terrain.ensure();
	const { order, coarseOrder, total } = tiles.update(cam, canvas.width, canvas.height);
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	if (!moving || zoomStable) swapScene(order);
	renderer.draw(cam, { skipBase: !moving });     // 静止時は粗い下地を隠す（LOD痕/二重線を消す）。移動中だけ空白埋め
	updateCompass();                               // 3D時のみコンパス表示・針を方位に追従
	if (labelLayer.draw(cam)) needsDraw = true;    // ラベルはライブ（位置は毎フレーム、集合は間引き）
	logEl.textContent = `tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`;
}

// --- 統合スパイク：geopbf/e-Stat を overlay に描き、クリックで identify（実装は overlay.js）---
const overlay = createOverlay({ renderer, cam, canvas, dpr, requestDraw: () => { needsDraw = true; } });
window.__loadOverlay = overlay.loadOverlay;   // geopbf 名から（全球等）
window.__loadEstat = overlay.loadEstat;
window.__tokyo = () => overlay.loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域
// 初期 overlay なし（全球 land は検証用。__tokyo() や __loadOverlay(name) で任意に）

function frame() {
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
