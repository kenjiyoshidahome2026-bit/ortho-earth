// ortho-vt PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	createRenderer, createLabelLayer, createTileManager,
	evalExpr, parseRGBA,
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
const clear = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.93, 0.93, 0.9, 1];

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

// カメラ：球半径 scale(device px) を web-mercator ズームに対応させる
const cam = { center: [139.767, 35.681], scale: 1, translate: [0, 0], dpr, clear };
function scaleForZoom(z, lat) { return Math.pow(2, z) * TILE / (2 * Math.PI) * Math.max(0.05, Math.cos(lat * D2R)) * dpr; }

function resize() {
	const w = window.innerWidth, h = window.innerHeight;
	for (const cv of [canvas, labelCanvas]) {
		cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
		cv.style.width = w + "px"; cv.style.height = h + "px";
	}
	cam.translate = [canvas.width / 2, canvas.height / 2];
	needsDraw = true;
}
window.addEventListener("resize", resize);

function setView(lon, lat, z) {
	cam.center = [lon, lat]; cam.scale = scaleForZoom(z, lat); needsDraw = true;
}
setView(139.767, 35.681, 16);
resize();

// --- 操作 ---
let drag = null;
canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointerup", () => drag = null);
canvas.addEventListener("pointermove", e => {
	if (!drag) return;
	const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY };
	const k = cam.scale / dpr;
	cam.center[0] -= dx / k * R2D / Math.max(0.2, Math.cos(cam.center[1] * D2R));
	cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] + dy / k * R2D));
	onMove();
});
canvas.addEventListener("wheel", e => { e.preventDefault(); cam.scale *= Math.exp(-e.deltaY * 0.001); onMove(); }, { passive: false });

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
