// ortho-japan PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	createRenderer, createLabelLayer, createTileManager,
	evalExpr, parseRGBA, cameraState, unproject, downsampleFlipped,
	buildGeoJSONOverlay, pointInFeature,
} from "ortho-japan";
import { geopbf, createGeopbf } from "geopbf";
import { createTileLoader } from "altpbf";
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（標高と同じ）。読み出しはキー不要
import style from "./style-mono.js";

const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = document.getElementById("log");
const renderer = createRenderer(canvas);
const EARTH_M = 6371000, TERR_EXAG = 1.7;   // 標高スケール（ラベル・地形・建物で共有）

// 国道おにぎり標識：番号(2901)は素の数字でなく本物の標識で描く。番号ごとにキャッシュ。
const SHIELD_H = 24, SHIELD_VW = 455, SHIELD_VH = 435, SHIELD_W = Math.round(SHIELD_H * SHIELD_VW / SHIELD_VH);
const SHIELD_PATH = new Path2D("m227 425c25 0 48-10 66-26 69-69 120-155 146-249 3-8 5-19 5-30 0-45-31-83-74-94-46-11-92-17-143-17s-97 6-143 17c-43 11-74 49-74 94 0 11 2 21 5 30 26 94 77 180 146 249 18 16 41 26 66 26z");
const shieldCache = new Map();
// ラベルcanvas（DPRスケール済み）へ viewBox 座標で直接ベクター描画。焼き付け画像を挟まず常にシャープ。
function kokudoShield(num) {
	let s = shieldCache.get(num);
	if (s) return s;
	s = { w: SHIELD_W, h: SHIELD_H, draw(g, cx, cy) {
		g.save();
		g.translate(cx - SHIELD_W / 2, cy - SHIELD_H / 2); g.scale(SHIELD_W / SHIELD_VW, SHIELD_H / SHIELD_VH);
		g.fillStyle = "#0140ff"; g.fill(SHIELD_PATH);
		g.lineJoin = "round"; g.strokeStyle = "#fff"; g.lineWidth = 16; g.stroke(SHIELD_PATH);
		g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
		g.font = `bold ${num.length >= 3 ? 135 : 170}px sans-serif`;   // 国道/ROUTEの小字は省き番号だけ大きく
		g.fillText(num, 238, 200);
		g.restore();
	} };
	shieldCache.set(num, s);
	return s;
}
// 高速道路ナンバリング（E1・E1A・E88・C4・CA…）：緑の角丸長方形＋白フチ＋白文字。実標識に準拠。
const EXP_H = 22, EXP_VW = 220, EXP_VH = 150, EXP_W = Math.round(EXP_H * EXP_VW / EXP_VH);
const expCache = new Map();
function expresswayShield(text) {
	let s = expCache.get(text);
	if (s) return s;
	s = { w: EXP_W, h: EXP_H, draw(g, cx, cy) {
		g.save();
		g.translate(cx - EXP_W / 2, cy - EXP_H / 2); g.scale(EXP_W / EXP_VW, EXP_H / EXP_VH);
		g.beginPath(); g.roundRect(4, 4, EXP_VW - 8, EXP_VH - 8, 30); g.fillStyle = "#0a7a3e"; g.fill();   // 緑の角丸
		g.beginPath(); g.roundRect(17, 17, EXP_VW - 34, EXP_VH - 34, 18); g.lineWidth = 10; g.strokeStyle = "#fff"; g.stroke();   // 白フチ
		g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
		g.font = `bold ${text.length >= 3 ? 66 : 86}px sans-serif`;
		g.fillText(text, EXP_VW / 2, EXP_VH / 2 + 4);
		g.restore();
	} };
	expCache.set(text, s);
	return s;
}
function shieldFor(L) {   // 道路ON時のみ抽出済み。2901=国道おにぎり／2903・2904=高速ナンバリング盾
	if (L.code === 2901) return kokudoShield(L.text);
	if (L.code === 2903 || L.code === 2904) return expresswayShield(L.text);
	return null;
}

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

// scene worker：タイル geometry を保持し、結合(merge)も担う。メインは geometry を一切持たず、
// 結合済みバッファを GL に上げるだけ。
const sceneWorker = new Worker(new URL("./sceneworker.js", import.meta.url), { type: "module" });
const latestMerge = { base: 0, main: 0 };
let mergeId = 0;
sceneWorker.onmessage = e => {
	if (e.data.type !== "scene" || e.data.id !== latestMerge[e.data.slot]) return;   // 古い merge 結果は捨てる
	renderer.setScene(e.data.scene, e.data.slot);
	needsDraw = true;
};
function requestMerge(slot, order, origin, hidden) {
	const id = ++mergeId; latestMerge[slot] = id;
	sceneWorker.postMessage({ type: "merge", id, slot, order: order.map(o => ({ key: o.key, origin: o.origin, z: o.z })), origin, hidden: hidden && hidden.size ? [...hidden] : null });
}
function collectTileBuffers(dl, buildings) {
	const bufs = [];
	for (const op of dl.ops) { if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer); else bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer); }
	if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
	return bufs;
}

// タイル worker プール：fetch→decode→tessellation。geometry は scene worker へ転送し、
// メインにはメタ＋ラベルだけ返す（重い処理も geometry もメインに残さない）。
const NW = Math.min(4, (navigator.hardwareConcurrency || 4) - 1) || 2;
const tileWorkers = [], pending = new Map();
let wIdx = 0, reqId = 0;
for (let i = 0; i < NW; i++) {
	const w = new Worker(new URL("./tileworker.js", import.meta.url), { type: "module" });
	w.onmessage = e => {
		const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
		if (!e.data.ok) { p.reject(new Error(e.data.error)); return; }
		sceneWorker.postMessage({ type: "tile", key: p.key, ops: e.data.dl.ops, buildings: e.data.buildings }, collectTileBuffers(e.data.dl, e.data.buildings));
		p.resolve({ origin: e.data.origin, labels: e.data.labels, z: e.data.z });   // メタ＋ラベルのみ
	};
	w.postMessage({ type: "init", style });
	tileWorkers.push(w);
}
function workerBuildTile(t) {
	const id = ++reqId, key = `${t.z}/${t.x}/${t.y}`, w = tileWorkers[wIdx = (wIdx + 1) % NW];
	w.postMessage({ id, url: TILE_URL(t.z, t.x, t.y), z: t.z, x: t.x, y: t.y });
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject, key }));
}

const tiles = createTileManager({
	style, tileUrl: TILE_URL,
	onChange: () => { needsDraw = true; },
	buildTile: workerBuildTile,
});

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 55 * D2R;   // 裏抜けが出る過度なチルトを踏ませない（3Dの見応えは十分・安全域で頭打ち）
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

resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
let drag = null;
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("pointerdown", e => {
	drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, tilt: e.button === 2 || e.shiftKey || e.ctrlKey };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", e => {
	if (drag && !drag.tilt && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) identifyAt(e.clientX, e.clientY);   // 動いていない＝クリック→identify
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
const layerState = { chimei: true, chikei: false, rail: false, road: false, admin: false, shisetsu: false };
let styleSig = JSON.stringify(layerState);
const liOf = id => style.layers.findIndex(L => L.id === id);
const LI_RAILHI = liOf("rail-hi"), LI_RAILTR = liOf("railtr-hi"), LI_ROADHI = liOf("road-hi"), LI_ADMINHI = liOf("admin-hi");
const RAILTR_MINZOOM = 13.5;   // 駅の軌道は寄った時だけ（構内detail）
// 注記カテゴリ（実データ実測）。allowlist＝ONのテーマのカテゴリだけ描く（紙地図の全部盛りをやめる）。
// 各テーマチップは「色」と「その名前」を一緒に点火する：道路→IC/JCT、鉄道→駅、行政区域→行政単位名。
const CHIMEI_CODES = new Set([140, 1401, 1402, 1403, 220, 110]);   // 地名(常時)：都道府県・主要都市・市・町村・地区・区
const CHOME_CODES = new Set([210]);                           // 丁目：粒度が一段細かい→寄った時(z14.5〜)だけ自動表示
const CHOME_MINZOOM = 14.5;
// 地形は 3xx 帯が丸ごと自然地形（実測：山311/312/316・湖沼321・河川322・沢323・高原331・
// 峠火山332・山地333・岬崎343・海345・浜347・島352・礁353…）。範囲判定＝未見コードも取りこぼさない。
// （施設の大使館/郵便局等は 32xx＝番号帯が別なので誤爆しない）
const isChikei = c => c >= 300 && c <= 399;
const ROAD_CODES = new Set([2941, 2942, 2943, 2944, 2945, 412, 411, 2901, 2902, 2903, 2904]); // 道路ON：高速IC/JCT・SA/PA/SIC・都市高速JCT/路線名・国道/高速番号
const RAIL_CODES = new Set([422, 421, 431]);                  // 鉄道ON：駅名・鉄道路線名・港
const GYOSEI_CODES = new Set([130]);                          // 行政区域ON：郡（都道府県・区は地名側へ）
const SURVEY_NOISE = new Set([7101, 7102, 7103, 7201, 7711]); // 標高点・水準点・水深（常に非表示）
const isNum = t => /^\d+(\.\d+)?$/.test(t);                    // 純粋な数値（標高・水深等の計測値）は施設に出さない
// 施設＝他テーマに属さない残り全部（省庁・大学・神社・寺・大使館・郵便局・橋・トンネル…）。取りこぼし防止。
const CLAIMED = new Set([...CHIMEI_CODES, ...CHOME_CODES, ...ROAD_CODES, ...RAIL_CODES, ...GYOSEI_CODES]);
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
			|| (layerState.chikei && isChikei(c))         // 地形＝3xx帯（山/湖/川/岬/海/島…）
			|| (layerState.road && ROAD_CODES.has(c))     // 道路ON＝IC/JCT/路線番号も点火
			|| (layerState.rail && RAIL_CODES.has(c))     // 鉄道ON＝駅名/路線名も点火
			|| (layerState.admin && GYOSEI_CODES.has(c))  // 行政区域ON＝行政単位名も点火
			|| (layerState.shisetsu && !CLAIMED.has(c) && !isChikei(c) && !SURVEY_NOISE.has(c) && !isNum(L.text)); // 施設＝残り全部（数値は除く）
	});
}

// LOD選択 or テーマ状態(styleSig)が変わった時だけシーンを再結合。原点は安定化（プルプル防止）。
let zoomAtBuild = -1;
function swapScene(order) {
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);
	if (sig === readySig || !order.length) return;
	if (!sceneOrigin || Math.abs(sceneOrigin[0] - cam.center[0]) > 0.4 || Math.abs(sceneOrigin[1] - cam.center[1]) > 0.4)
		sceneOrigin = [cam.center[0], cam.center[1]];
	requestMerge("main", order, sceneOrigin, hiddenLi());   // 結合は scene worker（非同期）→ 応答で setScene
	lastLabels = filterLabels(tiles.labels(order)).map(L => {
		// 都道府県は大きく薄い背景ラベルに（コピーしてキャッシュ側を壊さない）。他はそのまま。
		const o = L.code === 140 ? { ...L, size: L.size * 1.25, color: [L.color[0], L.color[1], L.color[2], L.color[3] * 0.5] } : L;
		o.elev = sampleLabelElev(L.anchor[0], L.anchor[1]);   // 標高付与（傾き時に地物と一致）
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
	requestMerge("base", coarseOrder, [cam.center[0], cam.center[1]], hiddenLi());   // 下地も scene worker で結合
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

// 標高アトラス（altpbf 多解像度）：ズームで R90/R10/R01 を選び、視野を覆うセル群を1枚のアトラスへ。
// R01(1°・秒単位)まで寄れるので城下の地形が正確＝建物が実地形に接地する。
let atlasKey = "", loadedCells = new Set();
const r10Tiles = new Map();   // "range,cx,cy" → 解決した生タイル（ラベル標高のCPUサンプル用）
let loadTile = null;          // altpbf createTileLoader（非同期セットアップ）
createTileLoader({ apiUrl: "https://api.ortho-earth.com" })
	.then(fn => { loadTile = fn; needsDraw = true; })
	.catch(e => console.error("[tileLoader] setup failed", e));
// 地形読込インジケータ：R01 初回は JAXA から数秒かかるので「何が起きているか」を明示。
let pendingElev = 0;
const elevEl = document.createElement("div");
elevEl.style.cssText = "position:fixed;bottom:44px;left:10px;font-size:12px;color:#4a5568;background:rgba(255,255,255,.85);padding:5px 11px;border-radius:6px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:none;z-index:6;";
document.body.appendChild(elevEl);
function updateElevIndicator(range) {
	if (pendingElev > 0) { elevEl.style.display = "block"; elevEl.textContent = `⛰ 地形読込中 ${range === 1 ? "R01（秒単位・JAXA）" : range === 10 ? "R10" : "R90"} … ×${pendingElev}`; }
	else elevEl.style.display = "none";
}
function selectRange() { const z = cam.zoom; return z < 4.5 ? 90 : z < 12 ? 10 : 1; }   // R90=超広域(8×8で覆いきる手前) / R10=中 / R01=城下
async function getCell(cellLng, cellLat, range) {
	if (!loadTile) return null;
	const k = range + "," + cellLng + "," + cellLat;
	if (r10Tiles.has(k)) return r10Tiles.get(k);
	const tile = await loadTile(cellLng, cellLat, range);
	if (tile) r10Tiles.set(k, tile);
	return tile;
}
// ラベル位置の標高(m)。現在の range のセルから downsampleFlipped と同じ南上げ規約でバイリニア。
function sampleLabelElev(lon, lat) {
	const range = selectRange(), cx = Math.floor(lon / range) * range, cy = Math.floor(lat / range) * range;
	const tile = r10Tiles.get(range + "," + cx + "," + cy);
	if (!tile) return 0;
	const { data, width: w, height: h } = tile;
	const gx = Math.min(w - 1, Math.max(0, (lon - cx) / range * (w - 1)));
	const gy = Math.min(h - 1, Math.max(0, (lat - cy) / range * (h - 1)));
	const x0 = Math.min(w - 2, gx | 0), y0 = Math.min(h - 2, gy | 0), tx = gx - x0, ty = gy - y0;
	const H = (x, y) => data[(h - 1 - y) * w + x];   // y:0=南（downsampleFlippedと同規約）
	const top = H(x0, y0) + (H(x0 + 1, y0) - H(x0, y0)) * tx;
	const bot = H(x0, y0 + 1) + (H(x0 + 1, y0 + 1) - H(x0, y0 + 1)) * tx;
	const v = top + (bot - top) * ty;
	return v < 0 ? 0 : v;
}
function viewCellRange(range) {
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
	const cx0 = Math.floor(lo0 / range), cx1 = Math.floor(lo1 / range), cy0 = Math.floor(la0 / range), cy1 = Math.floor(la1 / range);
	// セル上限：R01 は近景特化で小さく高精細に（遠景まで広げると grazing で粗いメッシュの壁が出る）。
	// R10/R90 は広域カバー優先で 8。cellRes=2048/セル数で解像度は自動配分。
	const cap = range === 1 ? 4 : 8;
	const cellsX = Math.min(cap, cx1 - cx0 + 1), cellsY = Math.min(cap, cy1 - cy0 + 1);
	const ccx = Math.floor(cam.center[0] / range), ccy = Math.floor(cam.center[1] / range);
	const originCX = Math.max(cx0, Math.min(cx1 - cellsX + 1, ccx - (cellsX - 1 >> 1)));
	const originCY = Math.max(cy0, Math.min(cy1 - cellsY + 1, ccy - (cellsY - 1 >> 1)));
	const cellRes = Math.max(400, Math.floor(2048 / Math.max(cellsX, cellsY)));
	return { range, originCX, originCY, cellsX, cellsY, cellRes };
}
async function ensureElevation() {
	if (!loadTile) return;
	const range = selectRange();
	const r = viewCellRange(range);
	const key = [range, r.originCX, r.originCY, r.cellsX, r.cellsY, r.cellRes].join(",");
	if (key !== atlasKey) {
		atlasKey = key; loadedCells = new Set();
		renderer.setElevationAtlas({ originLng: r.originCX * range, originLat: r.originCY * range, cellsX: r.cellsX, cellsY: r.cellsY, cellRes: r.cellRes, cellSpan: range }, TERR_EXAG / EARTH_M);
		needsDraw = true;
	}
	for (let cy = 0; cy < r.cellsY; cy++) for (let cx = 0; cx < r.cellsX; cx++) {
		const ck = cx + "," + cy;
		if (loadedCells.has(ck)) continue;
		loadedCells.add(ck);
		pendingElev++; updateElevIndicator(range);
		getCell((r.originCX + cx) * range, (r.originCY + cy) * range, range).then(tile => {
			pendingElev--; updateElevIndicator(range);
			if (tile && atlasKey === key) { renderer.setElevationCell(cx, cy, downsampleFlipped(tile, r.cellRes), r.cellRes); needsDraw = true; }
		});
	}
}

function render() {
	ensureElevation();
	const { order, coarseOrder, total } = tiles.update(cam, canvas.width, canvas.height);
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	// パン/チルト中（ズーム不変）は詳細も再結合。ズーム中はLODポップ回避で停止まで待つ。
	const zoomStable = Math.abs(cam.zoom - zoomAtBuild) < 0.12;
	if (!moving || zoomStable) swapScene(order);
	renderer.draw(cam, { skipBase: !moving });     // 静止時は粗い下地を隠す（LOD痕/二重線を消す）。移動中だけ空白埋め
	updateCompass();                               // 3D時のみコンパス表示・針を方位に追従
	if (labelLayer.draw(cam)) needsDraw = true;    // ラベルはライブ（位置は毎フレーム、集合は間引き）
	logEl.textContent = `tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`;
}

// --- 統合スパイク：geopbf を overlay に描き、クリックで identify（mat4 が geopbf を識別込みで吸収）---
const identEl = document.createElement("div");
identEl.style.cssText = "position:fixed;top:44px;left:10px;max-width:340px;font-size:12px;color:#334;background:rgba(255,255,255,.82);padding:6px 10px;border-radius:6px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);white-space:pre-wrap;z-index:6;";
document.body.appendChild(identEl);
let overlayFeatures = null, overlayOrigin = [138, 37];
function eachCoord(g, cb) {
	if (!g || !g.coordinates) return;
	const walk = c => { if (typeof c[0] === "number") cb(c[0], c[1]); else c.forEach(walk); };
	walk(g.coordinates);
}
async function loadOverlay(name) {
	identEl.textContent = `geopbf 読込中: ${name} …`;
	const pbf = await geopbf(name, { gint: false }).catch(err => { console.warn("geopbf", err); return null; });
	if (!pbf || !pbf.features || !pbf.features.length) { identEl.textContent = `geopbf 読込失敗: ${name}`; return; }
	overlayFeatures = pbf.features;
	let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
	for (const f of overlayFeatures) eachCoord(f.geometry, (x, y) => { if (x < lo0) lo0 = x; if (x > lo1) lo1 = x; if (y < la0) la0 = y; if (y > la1) la1 = y; });
	overlayOrigin = [(lo0 + lo1) / 2, (la0 + la1) / 2];
	renderer.setOverlay(buildGeoJSONOverlay(overlayFeatures, overlayOrigin));
	renderer.setOverlayHi(null);
	identEl.textContent = `geopbf: ${name}\n${overlayFeatures.length} features — クリックで identify`;
	needsDraw = true;
}
function identifyAt(clientX, clientY) {
	if (!overlayFeatures) return;
	const st = cameraState(cam, canvas.width, canvas.height);
	const ll = unproject(st, clientX * dpr, clientY * dpr);
	if (!ll) return;
	const hit = overlayFeatures.findIndex(f => pointInFeature(ll[0], ll[1], f.geometry));
	renderer.setOverlayHi(hit >= 0 ? buildGeoJSONOverlay([overlayFeatures[hit]], overlayOrigin) : null);   // ヒット地物だけ別 stencil で強調
	if (hit >= 0) {
		const p = overlayFeatures[hit].properties || {};
		const kv = Object.entries(p).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
		identEl.textContent = `identify ✔ #${hit}\n${kv || "(no props)"}`;
	} else identEl.textContent = "identify: ヒットなし";
	needsDraw = true;
}
window.__loadOverlay = loadOverlay;        // geopbf 名から（全球等）
// e-Stat 小地域（市区町村単位の {code}.geojsonl・gzip）を直接 fetch→gunzip→parse→アダプタ。
// 小ポリゴンなので earcut でも扇なし。identify で小地域コード＝突合の種。
async function gunzipText(bytes) {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
	return new TextDecoder().decode(bytes);
}
async function loadEstat(codes) {
	identEl.textContent = `e-Stat 小地域 読込中 (${codes.length}市区町村)…`;
	const feats = [];
	await Promise.all(codes.map(async code => {
		try {
			const r = await fetch(`https://api.ortho-earth.com/bucket/estat/${code}.geojsonl`);
			if (!r.ok) return;
			const text = await gunzipText(new Uint8Array(await r.arrayBuffer()));
			for (const line of text.split("\n")) { const s = line.trim(); if (s) { try { feats.push(JSON.parse(s)); } catch { /* skip */ } } }
		} catch (e) { console.warn("estat", code, e); }
	}));
	if (!feats.length) { identEl.textContent = "e-Stat 読込失敗"; return; }
	overlayFeatures = feats;
	let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
	for (const f of feats) eachCoord(f.geometry, (x, y) => { if (x < lo0) lo0 = x; if (x > lo1) lo1 = x; if (y < la0) la0 = y; if (y > la1) la1 = y; });
	overlayOrigin = [(lo0 + lo1) / 2, (la0 + la1) / 2];
	renderer.setOverlay(buildGeoJSONOverlay(feats, overlayOrigin));
	renderer.setOverlayHi(null);
	cam.center = [(lo0 + lo1) / 2, (la0 + la1) / 2]; cam.zoom = 11; cam.pitch = 0; needsDraw = true;
	identEl.textContent = `e-Stat 小地域: ${feats.length} 地物 — クリックで identify（小地域コード＝突合の種）`;
}
window.__loadEstat = loadEstat;
window.__tokyo = () => loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域
// 初期 overlay なし（全球 land は検証用。__tokyo() や __loadOverlay(name) で任意に）

function frame() {
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
