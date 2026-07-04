// ortho-vt PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	createRenderer, createLabelLayer, createTileManager,
	evalExpr, parseRGBA, cameraState, unproject, fetchR10, downsampleFlipped,
} from "ortho-vt";
import style from "./style-mono.js";

const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = document.getElementById("log");
const renderer = createRenderer(canvas);

// 国道おにぎり標識：番号(2901)は素の数字でなく本物の標識で描く。番号ごとにキャッシュ。
const SHIELD_H = 24, SHIELD_VW = 455, SHIELD_VH = 435, SHIELD_W = Math.round(SHIELD_H * SHIELD_VW / SHIELD_VH);
const SHIELD_PATH = new Path2D("m227 425c25 0 48-10 66-26 69-69 120-155 146-249 3-8 5-19 5-30 0-45-31-83-74-94-46-11-92-17-143-17s-97 6-143 17c-43 11-74 49-74 94 0 11 2 21 5 30 26 94 77 180 146 249 18 16 41 26 66 26z");
const shieldCache = new Map();
function kokudoShield(num) {
	let s = shieldCache.get(num);
	if (s) return s;
	const S = 3, cv = document.createElement("canvas");
	cv.width = SHIELD_W * S; cv.height = SHIELD_H * S;
	const g = cv.getContext("2d");
	g.scale(cv.width / SHIELD_VW, cv.height / SHIELD_VH);   // viewBox→canvas
	g.fillStyle = "#0140ff"; g.fill(SHIELD_PATH);
	g.lineJoin = "round"; g.strokeStyle = "#fff"; g.lineWidth = 16; g.stroke(SHIELD_PATH);
	// 小さい字（国道/ROUTE）は30pxで潰れるので省き、番号だけを中央に大きく。
	g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
	g.font = `bold ${num.length >= 3 ? 135 : 170}px sans-serif`;   // 桁数で自動調整（余白を残す）
	g.fillText(num, 238, 200);
	s = { img: cv, w: SHIELD_W, h: SHIELD_H };
	shieldCache.set(num, s);
	return s;
}
// 高速道路ナンバリング（E1・E20・C1・C2…）：盾形の青シールド。markers.jsに高速用が無いので新規。
const EXP_H = 23, EXP_VW = 400, EXP_VH = 440, EXP_W = Math.round(EXP_H * EXP_VW / EXP_VH);
const EXP_PATH = new Path2D("M60 40 H340 Q380 40 380 80 V200 Q380 330 200 410 Q20 330 20 200 V80 Q20 40 60 40 Z");
const expCache = new Map();
function expresswayShield(text) {
	let s = expCache.get(text);
	if (s) return s;
	const S = 3, cv = document.createElement("canvas");
	cv.width = EXP_W * S; cv.height = EXP_H * S;
	const g = cv.getContext("2d");
	g.scale(cv.width / EXP_VW, cv.height / EXP_VH);
	g.fillStyle = "#0d3b8c"; g.fill(EXP_PATH);
	g.lineJoin = "round"; g.strokeStyle = "#fff"; g.lineWidth = 18; g.stroke(EXP_PATH);
	g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
	g.font = `bold ${text.length >= 3 ? 135 : 175}px sans-serif`;
	g.fillText(text, 200, 205);
	s = { img: cv, w: EXP_W, h: EXP_H };
	expCache.set(text, s);
	return s;
}
function shieldFor(L) {   // 道路ON時のみ抽出済み。2901=国道おにぎり／2903・2904=高速ナンバリング盾
	if (L.code === 2901) return kokudoShield(L.text);
	if (L.code === 2903 || L.code === 2904) return expresswayShield(L.text);
	return null;
}

const labelLayer = createLabelLayer(labelCanvas, { shieldFor });

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

const tiles = createTileManager({
	style, tileUrl: TILE_URL,
	onChange: () => { needsDraw = true; },
});

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 68 * D2R;
const atmo = [0.5, 0.66, 0.96, 0.3];   // 大気色 rgb + 強さ（さりげなく）
const bldColor = [0.83, 0.83, 0.82];    // 建物色（静かなグレー）
const cam = { center: [139.767, 35.681], zoom: 16, pitch: 0, bearing: 0, dpr, clear, land, atmo, bldColor };

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
	if (e.metaKey) anchoredAt(e.clientX, e.clientY, () => { cam.bearing += e.deltaY * 0.01; });   // 軸回転(Cmd)。ctrl+wheelはトラックパッドのピンチ＝ズームに回す
	else anchoredAt(e.clientX, e.clientY, () => { cam.zoom = Math.max(2, Math.min(19, cam.zoom - e.deltaY * 0.002)); });  // ズーム（z2=地球全体〜z19。16超はベクタのオーバーズーム＝潰れず街路へ）
}, { passive: false });

document.getElementById("go").addEventListener("click", () => {
	setView(+document.getElementById("lon").value, +document.getElementById("lat").value, +document.getElementById("zoom").value);
});

// テーマ・チップ状態：静かな白黒の土台は常に全部見えている。チップは主題の「文字の表示」
// または「色の点火」を切り替えるだけ。すべて既取得データの再スタイル＝再取得・再デコードなし。
//   chimei/chikei … 文字（注記カテゴリ）の表示ON/OFF
//   rail/road/admin … 色の点火ON/OFF（OFFでも土台グレーは出ている）
const layerState = { chimei: true, chikei: false, rail: false, road: false, admin: false, shisetsu: false };
let styleSig = JSON.stringify(layerState);
const liOf = id => style.layers.findIndex(L => L.id === id);
const LI_RAILHI = liOf("rail-hi"), LI_RAILTR = liOf("railtr-hi"), LI_ROADHI = liOf("road-hi"), LI_ADMINHI = liOf("admin-hi");
const RAILTR_MINZOOM = 13.5;   // 駅の軌道は寄った時だけ（構内detail）
// 注記カテゴリ（実データ実測）。allowlist＝ONのテーマのカテゴリだけ描く（紙地図の全部盛りをやめる）。
// 各テーマチップは「色」と「その名前」を一緒に点火する：道路→IC/JCT、鉄道→駅、行政区域→行政単位名。
const CHIMEI_CODES = new Set([1401, 1402, 1403, 220]);        // 地名(常時)：主要都市・市・町村・地区
const CHOME_CODES = new Set([210]);                           // 丁目：粒度が一段細かい→寄った時(z14.5〜)だけ自動表示
const CHOME_MINZOOM = 14.5;
const CHIKEI_CODES = new Set([312, 316, 322, 345]);           // 地形：山(312/316)・河川・海/湾
const ROAD_CODES = new Set([2941, 2942, 412, 411, 2901, 2902, 2903, 2904]); // 道路ON：高速IC/JCT・都市高速JCT/路線名(首都高)・国道/高速番号
const RAIL_CODES = new Set([422, 421, 431]);                  // 鉄道ON：駅名・鉄道路線名・港
const GYOSEI_CODES = new Set([140, 110]);                     // 行政区域ON：都道府県・区（正式行政単位名）
const SURVEY_NOISE = new Set([7101, 7102, 7103, 7201, 7711]); // 標高点・水準点・水深（常に非表示）
// 施設＝他テーマに属さない残り全部（省庁・大学・神社・寺・大使館・郵便局…）。個別列挙の取りこぼしを防ぐ。
const CLAIMED = new Set([...CHIMEI_CODES, ...CHOME_CODES, ...CHIKEI_CODES, ...ROAD_CODES, ...RAIL_CODES, ...GYOSEI_CODES]);
function hiddenLi() {
	const h = new Set();   // "点火"層は既定で隠す（土台グレーが見えている）。ONで色が乗る。
	if (!layerState.rail) h.add(LI_RAILHI);
	if (!layerState.rail || cam.zoom < RAILTR_MINZOOM) h.add(LI_RAILTR);   // 駅の軌道は鉄道ON＋寄った時だけ
	if (!layerState.road) h.add(LI_ROADHI);
	if (!layerState.admin) h.add(LI_ADMINHI);
	return h;
}
function filterLabels(all) {
	return all.filter(L => {
		const c = L.code;
		return (layerState.chimei && CHIMEI_CODES.has(c))
			|| (layerState.chimei && cam.zoom >= CHOME_MINZOOM && CHOME_CODES.has(c))   // 丁目は寄った時だけ
			|| (layerState.chikei && CHIKEI_CODES.has(c))
			|| (layerState.road && ROAD_CODES.has(c))     // 道路ON＝IC/JCT/路線番号も点火
			|| (layerState.rail && RAIL_CODES.has(c))     // 鉄道ON＝駅名/路線名も点火
			|| (layerState.admin && GYOSEI_CODES.has(c))  // 行政区域ON＝行政単位名も点火
			|| (layerState.shisetsu && !CLAIMED.has(c) && !SURVEY_NOISE.has(c)); // 施設＝残り全部
	});
}

// LOD選択 or テーマ状態(styleSig)が変わった時だけシーンを再結合。原点は安定化（プルプル防止）。
function swapScene(order) {
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);
	if (sig === readySig || !order.length) return;
	if (!sceneOrigin || Math.abs(sceneOrigin[0] - cam.center[0]) > 0.4 || Math.abs(sceneOrigin[1] - cam.center[1]) > 0.4)
		sceneOrigin = [cam.center[0], cam.center[1]];
	renderer.setScene(tiles.buildScene(order, { origin: sceneOrigin, hidden: hiddenLi() }));
	lastLabels = filterLabels(tiles.labels(order)); labelLayer.setLabels(lastLabels);
	readySig = sig;
}

// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; layerState[k] = !layerState[k];
	b.classList.toggle("on", layerState[k]);
	styleSig = JSON.stringify(layerState); readySig = ""; needsDraw = true;
}));

// 標高アトラス（GEBCO R10）：視野を覆う R10 セル群を1枚のアトラスへ。寄ると高精細1枚、引くと複数枚を粗く。
const EARTH_M = 6371000, TERR_EXAG = 1.7;
let atlasKey = "", loadedCells = new Set();
const r10Cache = new Map();   // "cx,cy"(セル) → fetchR10結果（生タイル）。再取得を防ぐ
async function getRawCell(cellLng, cellLat) {
	const k = cellLng + "," + cellLat;
	if (r10Cache.has(k)) return r10Cache.get(k);
	const p = fetchR10(cellLng, cellLat); r10Cache.set(k, p); return p;
}
function viewCellRange() {
	const st = cameraState(cam, canvas.width, canvas.height);
	// 画面を密にサンプル（傾き時、地平線直下の"遠い地面"まで拾う）。宇宙に外れた点はnull→無視。
	let lo0 = cam.center[0], la0 = cam.center[1], lo1 = lo0, la1 = la0;
	const NX = 9, NY = 12;
	for (let jy = 0; jy < NY; jy++) for (let ix = 0; ix < NX; ix++) {
		const p = unproject(st, canvas.width * ix / (NX - 1), canvas.height * jy / (NY - 1));
		if (!p) continue;
		lo0 = Math.min(lo0, p[0]); lo1 = Math.max(lo1, p[0]);
		la0 = Math.min(la0, p[1]); la1 = Math.max(la1, p[1]);
	}
	const cx0 = Math.floor(lo0 / 10), cx1 = Math.floor(lo1 / 10), cy0 = Math.floor(la0 / 10), cy1 = Math.floor(la1 / 10);
	// 最大4×4。注視点(cam.center)のセルを中心に窓を置き、可視範囲[cx0..cx1]内へクランプ＝日本(3セル)は不動で点滅しない。
	const cellsX = Math.min(4, cx1 - cx0 + 1), cellsY = Math.min(4, cy1 - cy0 + 1);
	const ccx = Math.floor(cam.center[0] / 10), ccy = Math.floor(cam.center[1] / 10);
	const originCX = Math.max(cx0, Math.min(cx1 - cellsX + 1, ccx - (cellsX - 1 >> 1)));
	const originCY = Math.max(cy0, Math.min(cy1 - cellsY + 1, ccy - (cellsY - 1 >> 1)));
	const cellRes = Math.max(400, Math.floor(2048 / Math.max(cellsX, cellsY)));
	return { originCX, originCY, cellsX, cellsY, cellRes };
}
async function ensureElevation() {
	const r = viewCellRange();
	const key = [r.originCX, r.originCY, r.cellsX, r.cellsY, r.cellRes].join(",");
	if (key !== atlasKey) {
		atlasKey = key; loadedCells = new Set();
		renderer.setElevationAtlas({ originLng: r.originCX * 10, originLat: r.originCY * 10, cellsX: r.cellsX, cellsY: r.cellsY, cellRes: r.cellRes }, TERR_EXAG / EARTH_M);
		needsDraw = true;
	}
	for (let cy = 0; cy < r.cellsY; cy++) for (let cx = 0; cx < r.cellsX; cx++) {
		const ck = cx + "," + cy;
		if (loadedCells.has(ck)) continue;
		loadedCells.add(ck);
		getRawCell((r.originCX + cx) * 10, (r.originCY + cy) * 10).then(tile => {
			if (tile && atlasKey === key) { renderer.setElevationCell(cx, cy, downsampleFlipped(tile, r.cellRes), r.cellRes); needsDraw = true; }
		});
	}
}

function render() {
	ensureElevation();
	const { order, total } = tiles.update(cam, canvas.width, canvas.height);
	if (!moving) swapScene(order);                 // 停止時のみ再結合（移動中のタイルポップ＝チラチラ防止）
	renderer.draw(cam);                            // 毎フレーム投影更新＝ズームはカーソル中心に追従
	if (labelLayer.draw(cam)) needsDraw = true;    // ラベルはライブ（位置は毎フレーム、集合は間引き）
	logEl.textContent = `tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`;
}

function frame() {
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
