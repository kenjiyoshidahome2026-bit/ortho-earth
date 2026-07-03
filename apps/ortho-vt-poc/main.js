// ortho-vt PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	createRenderer, createLabelLayer, createTileManager,
	evalExpr, parseRGBA, cameraState, unproject,
} from "ortho-vt";
import style from "./style-mono.js";

const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = document.getElementById("log");
const renderer = createRenderer(canvas);
const labelLayer = createLabelLayer(labelCanvas);

const bg = style.layers.find(L => L.type === "background");
const land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
const clear = [0.03, 0.04, 0.07, 1];   // 宇宙（球の外側）

let dpr = Math.min(2, window.devicePixelRatio || 1);
let needsDraw = true, readySig = "", lastLabels = [];
let moving = false, moveTimer = null, baseSig = "";
const SETTLE_MS = 120;   // 移動停止とみなすまでの時間

// 移動イベント：ラベルは描かず幾何のみ。停止後に確定描画（ラベル描画）。
function onMove() {
	moving = true; needsDraw = true;
	clearTimeout(moveTimer);
	moveTimer = setTimeout(() => { moving = false; needsDraw = true; }, SETTLE_MS);
}

const tiles = createTileManager({
	style, tileUrl: TILE_URL,
	onChange: () => { needsDraw = true; },
});

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 68 * D2R;
const cam = { center: [139.767, 35.681], zoom: 16, pitch: 0, bearing: 0, dpr, clear, land };

function resize() {
	const w = window.innerWidth, h = window.innerHeight;
	for (const cv of [canvas, labelCanvas]) {
		cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
		cv.style.width = w + "px"; cv.style.height = h + "px";
	}
	needsDraw = true;
}
window.addEventListener("resize", resize);

function setView(lon, lat, z) { cam.center = [lon, lat]; cam.zoom = z; needsDraw = true; }
resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
let drag = null;
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("pointerdown", e => {
	drag = { x: e.clientX, y: e.clientY, tilt: e.button === 2 || e.shiftKey || e.ctrlKey };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", () => drag = null);
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
	if (e.ctrlKey || e.metaKey) anchoredAt(e.clientX, e.clientY, () => { cam.bearing += e.deltaY * 0.01; });   // 軸回転
	else anchoredAt(e.clientX, e.clientY, () => { cam.zoom = Math.max(4, Math.min(16, cam.zoom - e.deltaY * 0.002)); });  // ズーム
}, { passive: false });

document.getElementById("go").addEventListener("click", () => {
	setView(+document.getElementById("lon").value, +document.getElementById("lat").value, +document.getElementById("zoom").value);
});

// 結合シーンを一括スワップ（前の完成シーンを置き換える）。ラベルも同時に更新。
function swapScene(order) {
	const sig = order.map(o => o.key).join("|");
	if (sig === readySig || !order.length) return false;
	renderer.setScene(tiles.buildScene(order));
	lastLabels = tiles.labels(order); labelLayer.setLabels(lastLabels);
	readySig = sig;
	return true;
}

function render() {
	const { z, order, total, coarseOrder } = tiles.update(cam, canvas.width, canvas.height);
	// 粗い下書き（underlay）：粗タイル集合が変わった時のみ差し替え
	const bsig = coarseOrder.map(o => o.key).join("|");
	if (bsig !== baseSig && coarseOrder.length) { renderer.setScene(tiles.buildScene(coarseOrder), "base"); baseSig = bsig; }
	const fullyReady = total > 0 && order.length === total;
	if (fullyReady || !moving) swapScene(order);   // 全揃い、または停止時は部分でも確定
	renderer.draw(cam);
	if (moving) {
		labelLayer.clear();                          // 移動中はラベル非表示（カクつき回避）
	} else {
		if (labelLayer.draw(cam)) needsDraw = true;  // 停止時に描画（フェード継続中は続行）
	}
	logEl.textContent = `z=${z}  tiles=${order.length}/${total}  labels=${lastLabels.length}`;
}

function frame() {
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
