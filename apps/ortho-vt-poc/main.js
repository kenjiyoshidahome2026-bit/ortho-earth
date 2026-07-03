// ortho-vt PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	createRenderer, createLabelLayer, createTileManager,
	evalExpr, parseRGBA,
} from "ortho-vt";

const STYLE_URL = "https://gsi-cyberjapan.github.io/optimal_bvmap/style/std.json";
const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = document.getElementById("log");
const renderer = createRenderer(canvas);
const labelLayer = createLabelLayer(labelCanvas);

const style = await (await fetch(STYLE_URL)).json();
const bg = style.layers.find(L => L.type === "background");
const clear = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.93, 0.93, 0.9, 1];

let dpr = Math.min(2, window.devicePixelRatio || 1);
let needsDraw = true, labelSig = "", lastLabels = [];

const tiles = createTileManager({
	renderer, style, tileUrl: TILE_URL,   // atlas なし＝ラベルは 2D レイヤーで描画
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
	needsDraw = true;
});
canvas.addEventListener("wheel", e => { e.preventDefault(); cam.scale *= Math.exp(-e.deltaY * 0.001); needsDraw = true; }, { passive: false });

document.getElementById("go").addEventListener("click", () => {
	setView(+document.getElementById("lon").value, +document.getElementById("lat").value, +document.getElementById("zoom").value);
});

function render() {
	const { z, order, fallback, total } = tiles.update(cam, canvas.width, canvas.height);
	renderer.draw(cam, fallback.length ? fallback.concat(order) : order);   // フォールバック下地→現z
	// ラベル集合は可視タイルが変わった時のみ再構築
	const sig = order.map(o => o.key).join("|");
	if (sig !== labelSig) { lastLabels = tiles.labels(order); labelLayer.setLabels(lastLabels); labelSig = sig; }
	const animating = labelLayer.draw(cam);
	if (animating) needsDraw = true;   // フェード継続中は描画を続ける
	logEl.textContent = `z=${z}  tiles=${order.length}/${total}  labels=${lastLabels.length}`;
}

function frame() {
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
