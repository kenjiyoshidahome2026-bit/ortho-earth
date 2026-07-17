// 任意座標系図郭の人手ジオリファレンスツール（v2）。
// v1(筆グループの平行移動のみ)を全面刷新：任意系は図郭ごとに独立した座標系なので、
// 編集単位=図郭・変換=相似4パラメータ(移動2+回転+スケール)。平行移動だけでは原理的に合わない。
// 入力: scripts/bake-arbitrary.mjs が焼く {code}-arbitrary.json（ローカル座標メートル・図郭重心相対）。
// 疑似公共（任意ラベルだが中身が公共座標）の図郭は bake 時点でほぼ着地済み＝人手は微調整のみ。
// 出力: 図郭ID＋4パラメータの JSON＝「解けた集合」への1コミット。法的境界確定の代替ではない。

import { createGeopbf, geopbf } from "geopbf";
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（読み出しはキー不要・IDBキャッシュ込み）

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`;   // 淡色地図
const CODE = new URLSearchParams(location.search).get("code") || "01101";
const DATA_URL = `moj-local/${CODE}-arbitrary.json?v=5`;   // 相対＝vite base(/japan/)配下。?v=形式差し替え時のキャッシュバスター
const LS_KEY = `moj-arb-${CODE}`;
const M_PER_DEG_LAT = 111132;
const mPerDegLon = lat => 111320 * Math.cos(lat * D2R);

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const hoverEl = document.getElementById("hover");
const progressEl = document.getElementById("progress");
const panelEl = document.getElementById("panel");

let dpr = Math.min(2, window.devicePixelRatio || 1);
function resize() {
	if (typeof endSheetDrag === "function") endSheetDrag();   // ドラッグ合成はサイズ依存＝リサイズで無効化
	canvas.width = Math.round(innerWidth * dpr);
	canvas.height = Math.round(innerHeight * dpr);
	canvas.style.width = innerWidth + "px";
	canvas.style.height = innerHeight + "px";
	draw();
}
window.addEventListener("resize", resize);

// ---- Web Mercator（標準スリッピーマップ方式）----
function lonLatToWorld(lon, lat, z) {
	const n = 256 * Math.pow(2, z);
	const x = (lon + 180) / 360 * n;
	const latRad = lat * D2R;
	const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * n;
	return [x, y];
}
function worldToLonLat(x, y, z) {
	const n = 256 * Math.pow(2, z);
	const lon = x / n * 360 - 180;
	const lat = (2 * Math.atan(Math.exp((0.5 - y / n) * 2 * Math.PI)) - Math.PI / 2) * R2D;
	return [lon, lat];
}

// ---- カメラ（区ごとに前回位置を記憶。初回はデータ読込後にアンカー平均へ飛ぶ）----
const CAM_KEY = `moj-arb-cam-${CODE}`;
const savedCam = JSON.parse(localStorage.getItem(CAM_KEY) || "null");
const cam = savedCam ?? { z: 5.5, lon: 137.5, lat: 38 };   // 未訪問なら日本広域（別区の座標が出るのを防ぐ）
let camTimer = 0;
function saveCam() {
	clearTimeout(camTimer);
	camTimer = setTimeout(() => localStorage.setItem(CAM_KEY, JSON.stringify(cam)), 500);
}
function lonLatToScreen(lon, lat) {
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, cam.z);
	const [x, y] = lonLatToWorld(lon, lat, cam.z);
	return [x - cx + canvas.width / 2, y - cy + canvas.height / 2];
}
function screenToLonLat(sx, sy) {
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, cam.z);
	return worldToLonLat(sx + cx - canvas.width / 2, sy + cy - canvas.height / 2, cam.z);
}

// ---- タイル ----
const tileCache = new Map();
function getTile(z, x, y) {
	const n = 1 << z;
	x = ((x % n) + n) % n;
	if (y < 0 || y >= n) return null;
	const key = `${z}/${x}/${y}`;
	let e = tileCache.get(key);
	if (!e) {
		const img = new Image();
		img.crossOrigin = "anonymous";
		e = { tile: null, loaded: false };
		img.onload = () => {
			// ロード時に1回だけ彩度を落として canvas 化。毎フレーム ctx.filter を掛けると
			// 中間サーフェス強制で描画が桁で重くなる（荒川で「下地が出ない・遅い」の主因）。
			const c = document.createElement("canvas");
			c.width = c.height = 256;
			const g = c.getContext("2d");
			g.filter = "saturate(.35) brightness(1.05)";
			g.drawImage(img, 0, 0);
			e.tile = c; e.loaded = true;
			draw();
		};
		img.src = TILE_URL(z, x, y);
		tileCache.set(key, e);
	}
	return e.loaded ? e.tile : null;
}
function drawTiles() {
	const z = Math.round(cam.z);
	const zoomAdjust = Math.pow(2, cam.z - z);
	const tileScreenSize = 256 * zoomAdjust;
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, z);
	const originX = canvas.width / 2 - cx * zoomAdjust;
	const originY = canvas.height / 2 - cy * zoomAdjust;
	const x0 = Math.floor(-originX / tileScreenSize) - 1;
	const x1 = Math.ceil((canvas.width - originX) / tileScreenSize) + 1;
	const y0 = Math.floor(-originY / tileScreenSize) - 1;
	const y1 = Math.ceil((canvas.height - originY) / tileScreenSize) + 1;
	for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
		const img = getTile(z, tx, ty);
		const sx = originX + tx * tileScreenSize, sy = originY + ty * tileScreenSize;
		if (img) ctx.drawImage(img, sx, sy, tileScreenSize + 0.5, tileScreenSize + 0.5);
		else { ctx.fillStyle = "#e8e6e0"; ctx.fillRect(sx, sy, tileScreenSize, tileScreenSize); }
	}
}

// ---- データ ----
// sheet: { id, oaza[], pseudoPublic, fude[{oaza,chiban,ring[[N,E]m]}], bbox(local),
//          t:{lon,lat,s,theta(rad)}, done }
let sheets = [];
let publicFude = [];   // 変換済み（公共系）の筆＝参照レイヤ（lon/lat・非編集）
let selected = null;   // sheet reference

function ringBbox(ring) {
	let b = [Infinity, Infinity, -Infinity, -Infinity];
	for (const [x, y] of ring) {
		if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
		if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
	}
	return b;
}

// ---- 市区町村境界（深い赤・参照線）----
// admin_all は「座標→市区町村」逆引き専用の rank24 間引き＝境界誤差~20m級。
// 参照線には十分（合わせ込み自体は青い変換済み筆に対して行う）。IDBキャッシュ＝2回目から即。
let cityBoundary = [];   // rings: [[lon,lat],...][]
async function loadBoundary() {
	try {
		const pbf = await geopbf("admin_all", { gint: false });
		for (const f of pbf.geojson.features) {
			if (f.properties.code !== CODE) continue;
			const g = f.geometry;
			if (g.type === "Polygon") cityBoundary.push(...g.coordinates);
			else if (g.type === "MultiPolygon") for (const c of g.coordinates) cityBoundary.push(...c);
		}
		draw();
	} catch (e) { console.warn("[boundary]", e); }   // 境界はあくまで参考＝失敗しても編集は成立
}

async function loadData() {
	const data = await fetch(DATA_URL).then(r => r.json());
	publicFude = data.publicFude ?? [];
	for (const f of publicFude) f.bb = ringBbox(f.ring);   // [lonMin,latMin,lonMax,latMax] 視野カリング用
	const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
	sheets = data.sheets.map(sh => {
		let bb = [Infinity, Infinity, -Infinity, -Infinity];   // [Nmin,Emin,Nmax,Emax]
		for (const f of sh.fude) {
			f.bb = ringBbox(f.ring);   // 筆ローカルbbox＝カリング&ヒット判定用
			if (f.bb[0] < bb[0]) bb[0] = f.bb[0]; if (f.bb[1] < bb[1]) bb[1] = f.bb[1];
			if (f.bb[2] > bb[2]) bb[2] = f.bb[2]; if (f.bb[3] > bb[3]) bb[3] = f.bb[3];
		}
		const sv = saved[sh.id];
		return {
			...sh, bbox: bb,
			t: sv ? { lon: sv.anchor[0], lat: sv.anchor[1], s: sv.scale, theta: sv.thetaDeg * D2R }
			      : { lon: sh.anchor[0], lat: sh.anchor[1], s: 1, theta: 0 },
			done: sv?.done ?? false,
		};
	});
	// 初訪問時のみカメラをアンカー平均へ（再訪は前回位置を維持）
	if (!savedCam) {
		cam.lon = sheets.reduce((s, x) => s + x.t.lon, 0) / sheets.length;
		cam.lat = sheets.reduce((s, x) => s + x.t.lat, 0) / sheets.length;
		cam.z = 14.5;
	}
	updateHud();
	draw();
}

function persist() {
	const out = {};
	for (const sh of sheets) out[sh.id] = {
		anchor: [sh.t.lon, sh.t.lat], scale: sh.t.s, thetaDeg: sh.t.theta * R2D, done: sh.done,
	};
	localStorage.setItem(LS_KEY, JSON.stringify(out));
	invalidateSheet(selected);   // 変換・確定状態が変わった図郭のスプライトだけ焼き直し対象に
}

// ---- 相似変換：ローカル[N,E]m ⇄ lon/lat ----
function localToLonLat(sh, N, E) {
	const { s, theta, lon, lat } = sh.t;
	const c = Math.cos(theta), si = Math.sin(theta);
	const Ee = s * (E * c - N * si), Nn = s * (E * si + N * c);
	return [lon + Ee / mPerDegLon(lat), lat + Nn / M_PER_DEG_LAT];
}
function lonLatToLocal(sh, lon, lat) {
	const { s, theta } = sh.t;
	const Ee = (lon - sh.t.lon) * mPerDegLon(sh.t.lat);
	const Nn = (lat - sh.t.lat) * M_PER_DEG_LAT;
	const c = Math.cos(-theta), si = Math.sin(-theta);
	return [(Ee * si + Nn * c) / s, (Ee * c - Nn * si) / s];   // [N,E]
}
function localToScreen(sh, N, E) {
	const [lon, lat] = localToLonLat(sh, N, E);
	return lonLatToScreen(lon, lat);
}

// ---- ハンドル位置（選択図郭）：回転=重心上方の円、スケール=bbox角の四角 ----
function handlePositions(sh) {
	const [cx, cy] = localToScreen(sh, 0, 0);
	const [nx, ny] = localToScreen(sh, sh.bbox[2], 0);           // 北端＝回転ハンドル方向
	const dx = nx - cx, dy = ny - cy;
	const d = Math.hypot(dx, dy) || 1;
	const rot = [cx + dx / d * (d + 34 * dpr), cy + dy / d * (d + 34 * dpr)];
	const scl = localToScreen(sh, sh.bbox[2], sh.bbox[3]);       // 北東角＝スケールハンドル
	return { center: [cx, cy], rot, scl };
}

// ---- 公共参照レイヤ：offscreen スナップショット＋オフセット blit ----
// 57,000筆をパン/ズームの毎フレーム描き直すとカクつくので、静止後 150ms で一度だけ焼き、
// カメラ移動中はスナップショットをスケール/平行移動して貼るだけ（図郭ドラッグ中はカメラ不動＝完全一致）。
const pubCanvas = document.createElement("canvas");
let pubSnap = null;    // 焼いた時のカメラ {z, lon, lat, w, h}
let pubTimer = 0;
function renderPublic() {
	pubCanvas.width = canvas.width; pubCanvas.height = canvas.height;
	const pc = pubCanvas.getContext("2d");
	// 変換済み＝青ベタ塗り＋濃いエッジ線。線なしだと大街区（区画整理の長狭物等）が融合して
	// のっぺり長方形に見え筆の区画が読めない（本人指摘）。視野カリング済なので線コストは許容。
	pc.fillStyle = "rgba(43,108,176,.28)";
	pc.strokeStyle = "rgba(20,60,110,.85)";
	pc.lineWidth = 0.8 * dpr;
	// 視野 lon/lat bbox（1画面ぶん余白）で 57k筆→画面内のみに絞る＝再焼きを桁で軽く
	const [lo0, la0] = screenToLonLat(-canvas.width, canvas.height * 2);
	const [lo1, la1] = screenToLonLat(canvas.width * 2, -canvas.height);
	const addRing = ring => {
		for (let i = 0; i < ring.length; i++) {
			const [sx, sy] = lonLatToScreen(ring[i][0], ring[i][1]);
			if (i === 0) pc.moveTo(sx, sy); else pc.lineTo(sx, sy);
		}
		pc.closePath();
	};
	// 塗り＝通常筆のみ（noFill=長狭物等の環状筆は塗ると内包街区が潰れる）→ 線は全筆
	pc.beginPath();
	for (const f of publicFude) {
		const b = f.bb;
		if (f.noFill || b[2] < lo0 || b[0] > lo1 || b[3] < la0 || b[1] > la1) continue;
		addRing(f.ring);
		if (f.holes) for (const h of f.holes) addRing(h);
	}
	pc.fill("evenodd");   // 筆同士は非重複なので evenodd で穴だけが抜ける
	pc.beginPath();
	for (const f of publicFude) {
		const b = f.bb;
		if (b[2] < lo0 || b[0] > lo1 || b[3] < la0 || b[1] > la1) continue;
		addRing(f.ring);
		if (f.holes) for (const h of f.holes) addRing(h);
	}
	pc.stroke();
	pubSnap = { z: cam.z, lon: cam.lon, lat: cam.lat, w: canvas.width, h: canvas.height };
}
function drawPublicLayer() {
	if (!publicFude.length) return;
	// 参照レイヤは合わせ込み（高ズーム）専用。低ズームでは57k筆の線が融合して下地を覆うためフェードアウト。
	const alpha = Math.max(0, Math.min(1, (cam.z - 13.2) / 1.6));   // z13.2で消滅〜z14.8で全開
	if (alpha === 0) return;
	const dirty = !pubSnap || pubSnap.z !== cam.z || pubSnap.lon !== cam.lon || pubSnap.lat !== cam.lat
		|| pubSnap.w !== canvas.width || pubSnap.h !== canvas.height;
	if (!pubSnap) { renderPublic(); }                      // 初回だけ同期で焼く
	else if (dirty) {                                       // 移動中は再焼きを遅延
		clearTimeout(pubTimer);
		pubTimer = setTimeout(() => { renderPublic(); draw(); }, 150);
	}
	// スナップショットを現カメラへ射影して blit（同一カメラなら等倍・原点一致）
	const k = Math.pow(2, cam.z - pubSnap.z);
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, pubSnap.z);
	const [sx0, sy0] = lonLatToWorld(pubSnap.lon, pubSnap.lat, pubSnap.z);
	const ox = (sx0 - pubSnap.w / 2 - cx) * k + canvas.width / 2;
	const oy = (sy0 - pubSnap.h / 2 - cy) * k + canvas.height / 2;
	ctx.globalAlpha = alpha;
	ctx.drawImage(pubCanvas, ox, oy, pubSnap.w * k, pubSnap.h * k);
	ctx.globalAlpha = 1;
}

// ---- 図郭1枚の描画（視野カリング＋定数ホイスト済み・描画先 g を取る）----
function drawSheet(g, sh) {
	// 視野(±0.5画面マージン=スプライトのクランプ域)→図郭ローカルの bbox（逆変換はアフィン＝4隅の min/max で保守的に正しい）→筆カリング
	const W = canvas.width, H = canvas.height;
	let vN0 = Infinity, vE0 = Infinity, vN1 = -Infinity, vE1 = -Infinity;
	for (const [sx, sy] of [[-W * 0.5, -H * 0.5], [W * 1.5, -H * 0.5], [-W * 0.5, H * 1.5], [W * 1.5, H * 1.5]]) {
		const [lo, la] = screenToLonLat(sx, sy);
		const [N, E] = lonLatToLocal(sh, lo, la);
		if (N < vN0) vN0 = N; if (E < vE0) vE0 = E;
		if (N > vN1) vN1 = N; if (E > vE1) vE1 = E;
	}
	if (sh.bbox[2] < vN0 || sh.bbox[0] > vN1 || sh.bbox[3] < vE0 || sh.bbox[1] > vE1) return;

	const sel = sh === selected;
	// 確定=緑は選択中でも維持（「確定を押したのに緑にならない」を防ぐ）。選択は太さ＋塗りで示す。
	g.lineWidth = (sel ? 1.8 : 0.7) * dpr;
	g.strokeStyle = sh.done ? (sel ? "#2ea043" : "rgba(46,160,67,.75)") : sel ? "#e8622c" : "rgba(232,98,44,.55)";
	g.fillStyle = sh.done ? (sel ? "rgba(46,160,67,.12)" : "rgba(46,160,67,.05)")
	                      : sel ? "rgba(232,98,44,.10)" : "rgba(232,98,44,.05)";
	// 点ループの定数ホイスト：cos/sin・m/度・メルカトル係数を筆2.5万点ぶん再計算しない（ドラッグのカクつき対策）
	const t = sh.t, tc = Math.cos(t.theta), ts = Math.sin(t.theta);
	const lonPerM = 1 / mPerDegLon(t.lat), latPerM = 1 / M_PER_DEG_LAT;
	const wn = 256 * Math.pow(2, cam.z);
	const [ccx, ccy] = lonLatToWorld(cam.lon, cam.lat, cam.z);
	const ox = canvas.width / 2 - ccx, oy = canvas.height / 2 - ccy;
	const HPI4 = Math.PI / 4, I2PI = 1 / (2 * Math.PI);
	const addRing = ring => {
		for (let i = 0; i < ring.length; i++) {
			const N = ring[i][0], E = ring[i][1];
			const lon = t.lon + t.s * (E * tc - N * ts) * lonPerM;
			const lat = t.lat + t.s * (E * ts + N * tc) * latPerM;
			const px = (lon + 180) / 360 * wn + ox;
			const py = (0.5 - Math.log(Math.tan(HPI4 + lat * D2R * 0.5)) * I2PI) * wn + oy;
			if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
		}
		g.closePath();
	};
	g.beginPath();
	for (const f of sh.fude) {
		const b = f.bb;
		if (f.noFill || b[2] < vN0 || b[0] > vN1 || b[3] < vE0 || b[1] > vE1) continue;
		addRing(f.ring);
		if (f.holes) for (const h of f.holes) addRing(h);   // 環状道路等の穴
	}
	g.fill("evenodd");
	g.beginPath();
	for (const f of sh.fude) {
		const b = f.bb;
		if (b[2] < vN0 || b[0] > vN1 || b[3] < vE0 || b[1] > vE1) continue;
		addRing(f.ring);
		if (f.holes) for (const h of f.holes) addRing(h);
	}
	g.stroke();
}

// ---- 図郭ごとのスプライトキャッシュ：各図郭を自分の画面bboxサイズの offscreen に焼く。
// 合成は blit だけ＝パン/ズームも「掴む瞬間の背景合成」もベクタ再描画ゼロ。
// 変換や選択スタイルが変わった図郭だけ焼き直す＝pointerup 後の再描画も1枚分 ----
let shTimer = 0;
function invalidateSheet(sh) { if (sh) sh.sprite = null; }
function invalidateSheets() { for (const sh of sheets) sh.sprite = null; }
function renderSheetSprite(sh) {
	const snap = { z: cam.z, lon: cam.lon, lat: cam.lat, w: canvas.width, h: canvas.height };
	// 図郭の画面bbox（4隅＝回転安全）→ ±0.5画面のクランプ域と交差する範囲だけ焼く
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [N, E] of [[sh.bbox[0], sh.bbox[1]], [sh.bbox[0], sh.bbox[3]], [sh.bbox[2], sh.bbox[1]], [sh.bbox[2], sh.bbox[3]]]) {
		const [sx, sy] = localToScreen(sh, N, E);
		if (sx < x0) x0 = sx; if (sy < y0) y0 = sy;
		if (sx > x1) x1 = sx; if (sy > y1) y1 = sy;
	}
	const pad = 4 * dpr;
	x0 = Math.floor(Math.max(x0 - pad, -canvas.width * 0.5)); y0 = Math.floor(Math.max(y0 - pad, -canvas.height * 0.5));
	x1 = Math.ceil(Math.min(x1 + pad, canvas.width * 1.5));   y1 = Math.ceil(Math.min(y1 + pad, canvas.height * 1.5));
	if (x1 <= x0 || y1 <= y0) { sh.sprite = { empty: true, snap }; return; }   // 画面圏外
	const cnv = document.createElement("canvas");
	cnv.width = x1 - x0; cnv.height = y1 - y0;
	const g = cnv.getContext("2d");
	g.translate(-x0, -y0);
	drawSheet(g, sh);
	sh.sprite = { cnv, x0, y0, snap };
}
function spriteStale(sp) {
	return !sp || sp.snap.z !== cam.z || sp.snap.lon !== cam.lon || sp.snap.lat !== cam.lat
		|| sp.snap.w !== canvas.width || sp.snap.h !== canvas.height;
}
function blitSprite(sh) {
	const sp = sh.sprite;
	if (!sp || sp.empty) return;
	const k = Math.pow(2, cam.z - sp.snap.z);
	const [ccx, ccy] = lonLatToWorld(cam.lon, cam.lat, sp.snap.z);
	const [scx, scy] = lonLatToWorld(sp.snap.lon, sp.snap.lat, sp.snap.z);
	const ox = (sp.x0 + scx - sp.snap.w / 2 - ccx) * k + canvas.width / 2;
	const oy = (sp.y0 + scy - sp.snap.h / 2 - ccy) * k + canvas.height / 2;
	ctx.drawImage(sp.cnv, ox, oy, sp.cnv.width * k, sp.cnv.height * k);
}
function drawSheetsLayer(excludeSheet = null) {
	if (!sheets.length) return;
	let stale = false;
	for (const sh of sheets) {
		if (!sh.sprite) renderSheetSprite(sh);          // 初回のみ同期
		else if (spriteStale(sh.sprite)) stale = true;  // カメラ変化＝静止後にまとめて焼き直し
		if (sh !== excludeSheet) blitSprite(sh);
	}
	if (stale) {
		clearTimeout(shTimer);
		shTimer = setTimeout(() => {
			for (const sh of sheets) if (spriteStale(sh.sprite)) renderSheetSprite(sh);
			draw();
		}, 150);
	}
}

function drawHandles() {
	if (!selected || selected.done) return;   // 確定済み＝ロック（ハンドル非表示）
	const { center, rot, scl } = handlePositions(selected);
	ctx.strokeStyle = "#2b6cb0"; ctx.lineWidth = 1.5 * dpr;
	ctx.beginPath(); ctx.moveTo(center[0], center[1]); ctx.lineTo(rot[0], rot[1]); ctx.stroke();
	ctx.fillStyle = "#2b6cb0";
	ctx.beginPath(); ctx.arc(rot[0], rot[1], 7 * dpr, 0, Math.PI * 2); ctx.fill();       // 回転=円
	ctx.fillRect(scl[0] - 6 * dpr, scl[1] - 6 * dpr, 12 * dpr, 12 * dpr);                // スケール=四角
	ctx.beginPath(); ctx.arc(center[0], center[1], 3 * dpr, 0, Math.PI * 2); ctx.fill(); // 重心
}

// ---- ドラッグ合成：背景（タイル+青+他図郭）と選択図郭スプライトを各1枚だけ焼き、
// ドラッグ中は canvas 変換（平行移動・回転・スケール）で貼るだけ＝筆数無関係の O(1)。
// 図郭は剛体＝相似変換しか受けないので、毎フレームの再描画は原理的に不要（本人指摘）----
let dragBG = null, dragSpriteP0 = null, dragStartT = null;
function beginSheetDrag() {
	renderSheetSprite(selected);               // 選択図郭のスプライトを最新化（1枚分＝軽い。これがドラッグ用スプライトを兼ねる）
	drawScene(selected);                       // 背景合成＝タイル+青+他図郭スプライトの blit のみ（ベクタ再描画なし＝掴み即応）
	dragBG = document.createElement("canvas");
	dragBG.width = canvas.width; dragBG.height = canvas.height;
	dragBG.getContext("2d").drawImage(canvas, 0, 0);
	dragSpriteP0 = lonLatToScreen(selected.t.lon, selected.t.lat);   // アンカー（回転・スケールの支点）
	dragStartT = { ...selected.t };
	draw();
}
function endSheetDrag() { dragBG = dragSpriteP0 = dragStartT = null; }

// ---- 描画 ----
function drawScene(excludeSheet = null) {
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	drawTiles();
	drawPublicLayer();
	drawSheetsLayer(excludeSheet);
	// 市区町村境界＝深い赤（最前面の参照線）
	if (cityBoundary.length) {
		ctx.strokeStyle = "#8b1a1a";
		ctx.lineWidth = 2.5 * dpr;
		ctx.lineJoin = "round";
		ctx.beginPath();
		for (const ring of cityBoundary) {
			for (let i = 0; i < ring.length; i++) {
				const [sx, sy] = lonLatToScreen(ring[i][0], ring[i][1]);
				if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
			}
		}
		ctx.stroke();
	}
}
function draw() {
	if (dragBG && dragStartT && selected?.sprite && !selected.sprite.empty) {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(dragBG, 0, 0);
		// スプライトを相似変換で貼る。EN空間のθ+はスクリーン（y下向き）では −θ 回転。
		// 回転・スケール中は補間で僅かに甘くなるが、pointerup で即クリスプに再描画される。
		const sp = selected.sprite;
		const p1 = lonLatToScreen(selected.t.lon, selected.t.lat);
		const dth = selected.t.theta - dragStartT.theta;
		const k = selected.t.s / dragStartT.s;
		ctx.save();
		ctx.translate(p1[0], p1[1]);
		ctx.rotate(-dth);
		ctx.scale(k, k);
		ctx.drawImage(sp.cnv, sp.x0 - dragSpriteP0[0], sp.y0 - dragSpriteP0[1]);
		ctx.restore();
		drawHandles();
		return;
	}
	drawScene();
	drawHandles();
	saveCam();
}

// ---- HUD ----
function updateHud() {
	const doneN = sheets.filter(s => s.done).length;
	progressEl.textContent = `${doneN} / ${sheets.length} 図郭確定`;
	if (!selected) { panelEl.style.display = "none"; return; }
	panelEl.style.display = "block";
	panelEl.innerHTML =
		`<b>${selected.id}</b> <span class="badge">${selected.pseudoPublic ? "疑似公共" : "任意"}</span><br>` +
		`${selected.oaza.slice(0, 4).join("・")}　${selected.fude.length}筆<br>` +
		`<span id="p-stats"></span><br>` +
		`<button id="p-done">${selected.done ? "確定解除" : "この図郭を確定"}</button> ` +
		`<button id="p-reset">リセット</button> ` +
		`<button id="p-scale-all" title="この図郭で合わせた倍率を未確定の全図郭の初期値にする（確定済みには触れない）">s を未確定へ一括適用</button>`;
	updateStats();
	document.getElementById("p-done").onclick = () => { selected.done = !selected.done; persist(); updateHud(); draw(); };
	document.getElementById("p-reset").onclick = () => {
		selected.t = { lon: selected.anchor[0], lat: selected.anchor[1], s: 1, theta: 0 };
		selected.done = false; persist(); updateHud(); draw();
	};
	// 同じ縮尺系譜（例: 荒川の1/600→1/500系 s≈1.3）の図郭群へ種まき。林野図等の別系譜は個別に再調整すればよい。
	document.getElementById("p-scale-all").onclick = () => {
		if (!confirm(`s=×${selected.t.s.toFixed(3)} を未確定の全図郭に適用しますか？`)) return;
		for (const sh of sheets) if (!sh.done && sh !== selected) sh.t.s = selected.t.s;
		persist(); invalidateSheets(); updateHud(); draw();
	};
}
// ドラッグ中はDOM全再構築でなく数字だけ差し替え（毎moveのinnerHTML再構築はカクつきの元）
function updateStats() {
	const el = document.getElementById("p-stats");
	if (!el || !selected) return;
	const t = selected.t;
	// 任意系は図郭ごとに単位系が違い得る（荒川実測: 1/600→1/500系譜で s≈1.3 の図郭が多数）＝倍率で素直に表示
	el.textContent = `θ=${(t.theta * R2D).toFixed(2)}°　s=×${t.s.toFixed(3)}`;
}

// ---- ヒットテスト：筆ポリゴン精密（bbox 矩形だと図郭同士が重なり「掴めない/違うのが掴まれる」）----
function pointInRingNE(N, E, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [ni, ei] = ring[i], [nj, ej] = ring[j];
		if (((ei > E) !== (ej > E)) && (N < (nj - ni) * (E - ei) / (ej - ei) + ni)) inside = !inside;
	}
	return inside;
}
function hitSheet(sx, sy) {
	const [lon, lat] = screenToLonLat(sx, sy);
	// 選択中を最優先、以降は上に描かれた順（後勝ち）
	const order = selected ? [selected, ...sheets.filter(s => s !== selected)] : [...sheets].reverse();
	for (const sh of order) {
		const [N, E] = lonLatToLocal(sh, lon, lat);
		if (N < sh.bbox[0] || N > sh.bbox[2] || E < sh.bbox[1] || E > sh.bbox[3]) continue;
		for (const f of sh.fude) {
			const b = f.bb;
			if (N < b[0] || N > b[2] || E < b[1] || E > b[3]) continue;
			if (!pointInRingNE(N, E, f.ring)) continue;
			if (f.holes && f.holes.some(h => pointInRingNE(N, E, h))) continue;   // 穴の中＝街区内側は掴まない
			return sh;
		}
	}
	return null;
}
function hitHandle(sx, sy) {
	if (!selected || selected.done) return null;   // 確定済み＝ロック
	const { rot, scl } = handlePositions(selected);
	if (Math.hypot(sx - rot[0], sy - rot[1]) < 12 * dpr) return "rotate";
	if (Math.hypot(sx - scl[0], sy - scl[1]) < 12 * dpr) return "scale";
	return null;
}

// ---- 操作 ----
let drag = null;

canvas.addEventListener("pointerdown", e => {
	const sx = e.clientX * dpr, sy = e.clientY * dpr;
	const handle = hitHandle(sx, sy);
	if (handle) {
		const { center } = handlePositions(selected);
		drag = {
			mode: handle, center,
			startAngle: Math.atan2(sy - center[1], sx - center[0]),
			startDist: Math.hypot(sx - center[0], sy - center[1]),
			startT: { ...selected.t },
		};
		beginSheetDrag();
	} else {
		const sh = hitSheet(sx, sy);
		if (sh) {
			if (sh !== selected) { const prev = selected; selected = sh; invalidateSheet(prev); invalidateSheet(sh); updateHud(); draw(); }
			if (sh.done) {
				// 確定済み＝ロック：選択（パネルで確定解除は可能）はするがドラッグはパン扱い
				drag = { mode: "pan", startClient: [e.clientX, e.clientY], startCam: { ...cam } };
			} else {
				const [lon, lat] = screenToLonLat(sx, sy);
				drag = { mode: "move", startLonLat: [lon, lat], startT: { ...sh.t } };
				canvas.classList.add("dragging-group");
				beginSheetDrag();
			}
		} else {
			if (selected) { const prev = selected; selected = null; invalidateSheet(prev); updateHud(); draw(); }
			drag = { mode: "pan", startClient: [e.clientX, e.clientY], startCam: { ...cam } };
		}
	}
	canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", e => {
	const sx = e.clientX * dpr, sy = e.clientY * dpr;
	if (drag?.mode === "move" && selected) {
		const [lon, lat] = screenToLonLat(sx, sy);
		selected.t.lon = drag.startT.lon + (lon - drag.startLonLat[0]);
		selected.t.lat = drag.startT.lat + (lat - drag.startLonLat[1]);
		updateStats(); draw();   // persist は pointerup で（毎moveのlocalStorage書込はカクつきの元）
	} else if (drag?.mode === "rotate" && selected) {
		const ang = Math.atan2(sy - drag.center[1], sx - drag.center[0]);
		// 画面y軸は下向き＝画面上の時計回りがθ正になるよう符号反転
		selected.t.theta = drag.startT.theta - (ang - drag.startAngle);
		updateStats(); draw();
	} else if (drag?.mode === "scale" && selected) {
		const d = Math.hypot(sx - drag.center[0], sy - drag.center[1]);
		selected.t.s = Math.max(0.25, Math.min(4, drag.startT.s * d / drag.startDist));   // 単位系違い(尺/縮尺系譜)も掴めるよう広めのクランプ
		updateStats(); draw();
	} else if (drag?.mode === "pan") {
		const dxPx = (e.clientX - drag.startClient[0]) * dpr, dyPx = (e.clientY - drag.startClient[1]) * dpr;
		const [cx, cy] = lonLatToWorld(drag.startCam.lon, drag.startCam.lat, cam.z);
		const [lon, lat] = worldToLonLat(cx - dxPx, cy - dyPx, cam.z);
		cam.lon = lon; cam.lat = lat;
		draw();
	} else {
		const sh = hitSheet(sx, sy);
		if (sh) {
			hoverEl.textContent = `${sh.id}（${sh.oaza[0] ?? "?"} 他）`;
			hoverEl.style.display = "block";
		} else hoverEl.style.display = "none";
	}
});
canvas.addEventListener("pointerup", () => {
	if (drag && drag.mode !== "pan") persist();   // 変換のコミットは操作終了時に一度
	drag = null; endSheetDrag(); canvas.classList.remove("dragging-group");
	draw();
});

canvas.addEventListener("wheel", e => {
	e.preventDefault();
	const [lon0, lat0] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
	cam.z = Math.max(11, Math.min(20, cam.z - e.deltaY * 0.0025));
	const [lon1, lat1] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
	cam.lon += lon0 - lon1; cam.lat += lat0 - lat1;
	draw();
}, { passive: false });

// ---- キーボード微調整（選択図郭）：矢印=移動 / Q,E=回転 / +,-=スケール。Shiftで10倍 ----
window.addEventListener("keydown", e => {
	if (!selected || selected.done || e.target.tagName === "INPUT") return;   // 確定済み＝ロック
	const t = selected.t;
	const k = e.shiftKey ? 10 : 1;
	const stepDeg = 0.5 * k / mPerDegLon(t.lat) * 1;   // 約0.5m
	const stepLat = 0.5 * k / M_PER_DEG_LAT;
	let used = true;
	switch (e.key) {
		case "ArrowLeft":  t.lon -= stepDeg; break;
		case "ArrowRight": t.lon += stepDeg; break;
		case "ArrowUp":    t.lat += stepLat; break;
		case "ArrowDown":  t.lat -= stepLat; break;
		case "q": case "Q": t.theta += 0.05 * k * D2R; break;
		case "e": case "E": t.theta -= 0.05 * k * D2R; break;
		// 1% 刻み（Shiftで5%）＝s≈1.3 級の単位系違いにも数押しで届く（旧: 0.2‰は細かすぎて実用不能）
		case "+": case "=": t.s = Math.min(4, t.s * (e.shiftKey ? 1.05 : 1.01)); break;
		case "-": case "_": t.s = Math.max(0.25, t.s / (e.shiftKey ? 1.05 : 1.01)); break;
		default: used = false;
	}
	if (used) { e.preventDefault(); persist(); updateStats(); draw(); }
});

// ---- ツールバー ----
document.getElementById("export").addEventListener("click", () => {
	const out = {
		cityCode: CODE,
		sheets: sheets.map(sh => ({
			id: sh.id, oaza: sh.oaza, pseudoPublic: sh.pseudoPublic, done: sh.done,
			anchor: [sh.t.lon, sh.t.lat], scale: sh.t.s, thetaDeg: sh.t.theta * R2D,
		})),
	};
	const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `georef-${CODE}.json`;
	a.click();
});
document.getElementById("load").addEventListener("change", async e => {
	const file = e.target.files[0];
	if (!file) return;
	const data = JSON.parse(await file.text());
	for (const rec of data.sheets ?? []) {
		const sh = sheets.find(x => x.id === rec.id);
		if (sh) { sh.t = { lon: rec.anchor[0], lat: rec.anchor[1], s: rec.scale, theta: rec.thetaDeg * D2R }; sh.done = rec.done; }
	}
	persist(); invalidateSheets(); updateHud(); draw();
});

resize();
loadData();
loadBoundary();
