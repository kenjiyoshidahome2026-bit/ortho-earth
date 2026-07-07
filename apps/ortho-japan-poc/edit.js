// 筆グループ（大字+丁目単位）のドラッグ位置合わせプロトタイプ。
// gint(WebGL2/トポロジー)は大量データ描画向けの複雑な構成なので、編集用は素の Canvas2D + GSI標準地図タイルで独立させる。
// あくまで「表示用近似」を人手で微調整するツール。法的境界確定の代替ではない（disclaimer参照）。

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/pale/${z}/${x}/${y}.png`;   // 淡色地図（標準より控えめ）
const DATA_URL = "/moj-local/13118-rubbersheet.geojson";
const BOUNDARY_URL = "/moj-local/13118-ward-boundary.geojson";   // 荒川区の外周（e-Stat小地域の共有されない辺から抽出）

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const hoverEl = document.getElementById("hover");
const progressEl = document.getElementById("progress");

let dpr = Math.min(2, window.devicePixelRatio || 1);
function resize() {
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

// ---- カメラ：z(ズーム) + 中心lon/lat ----
const cam = { z: 16, lon: 139.782, lat: 35.740 };
function worldToScreen(x, y) {
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, cam.z);
	return [x - cx + canvas.width / 2, y - cy + canvas.height / 2];
}
function screenToWorld(sx, sy) {
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, cam.z);
	return [sx + cx - canvas.width / 2, sy + cy - canvas.height / 2];
}
function lonLatToScreen(lon, lat) {
	const [x, y] = lonLatToWorld(lon, lat, cam.z);
	return worldToScreen(x, y);
}
function screenToLonLat(sx, sy) {
	const [x, y] = screenToWorld(sx, sy);
	return worldToLonLat(x, y, cam.z);
}

// ---- タイル読み込み・キャッシュ ----
const tileCache = new Map();
function getTile(z, x, y) {
	const n = 1 << z;
	x = ((x % n) + n) % n;
	if (y < 0 || y >= n) return null;
	const key = `${z}/${x}/${y}`;
	let e = tileCache.get(key);
	if (!e) {
		const img = new Image();
		e = { img, loaded: false };
		img.onload = () => { e.loaded = true; draw(); };
		img.src = TILE_URL(z, x, y);
		tileCache.set(key, e);
	}
	return e.loaded ? e.img : null;
}
function drawTiles() {
	const z = Math.round(cam.z);
	const zoomAdjust = Math.pow(2, cam.z - z); // 整数ズームとの差はスケールで吸収（簡易）
	const tileScreenSize = 256 * zoomAdjust;
	const [cx, cy] = lonLatToWorld(cam.lon, cam.lat, z);
	const originX = canvas.width / 2 - cx * zoomAdjust;
	const originY = canvas.height / 2 - cy * zoomAdjust;
	const x0 = Math.floor(-originX / tileScreenSize) - 1;
	const x1 = Math.ceil((canvas.width - originX) / tileScreenSize) + 1;
	const y0 = Math.floor(-originY / tileScreenSize) - 1;
	const y1 = Math.ceil((canvas.height - originY) / tileScreenSize) + 1;
	for (let ty = y0; ty <= y1; ty++) {
		for (let tx = x0; tx <= x1; tx++) {
			const img = getTile(z, tx, ty);
			const sx = originX + tx * tileScreenSize, sy = originY + ty * tileScreenSize;
			if (img) ctx.drawImage(img, sx, sy, tileScreenSize + 0.5, tileScreenSize + 0.5);
			else { ctx.fillStyle = "#e8e6e0"; ctx.fillRect(sx, sy, tileScreenSize, tileScreenSize); }
		}
	}
}

// ---- データ読み込み・グループ化 ----
function groupKey(p) { return `${p.daiji}::${p.chome ?? ""}`; }
let groups = new Map(); // key -> { features: [...], offset: {dx,dy} in degrees }
let groupOrder = [];
let wardBoundary = []; // LineString座標配列の配列

async function loadData() {
	const [geo, boundary] = await Promise.all([
		fetch(DATA_URL).then(r => r.json()),
		fetch(BOUNDARY_URL).then(r => r.json()),
	]);
	for (const f of geo.features) {
		const k = groupKey(f.properties);
		if (!groups.has(k)) { groups.set(k, { features: [], offset: { dx: 0, dy: 0 } }); groupOrder.push(k); }
		groups.get(k).features.push(f);
	}
	wardBoundary = boundary.features.map(f => f.geometry.coordinates);
	updateProgress();
	draw();
}

function updateProgress() {
	let touched = 0;
	for (const g of groups.values()) if (g.offset.dx !== 0 || g.offset.dy !== 0) touched++;
	progressEl.textContent = `${touched} / ${groups.size} グループ調整済み`;
}

// ---- 描画 ----
function draw() {
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	drawTiles();

	for (const [key, g] of groups) {
		const adjusted = g.offset.dx !== 0 || g.offset.dy !== 0;
		const hovered = key === hoveredKey;
		// 淡色地図の下の道路・地名を殺さないよう、通常時はごく薄く細く。ホバー/調整済みだけ目立たせる。
		// 65,000筆分の線が重なるとα値を下げても合成で濃くなる＝線そのものを細くするのが効く。
		ctx.lineWidth = (hovered ? 2 : adjusted ? 1.4 : 0.5) * dpr;
		ctx.strokeStyle = hovered ? "#ffcc33" : adjusted ? "#3aa5e0" : "rgba(232,98,44,.25)";
		ctx.fillStyle = hovered ? "rgba(255,204,51,.18)" : adjusted ? "rgba(58,165,224,.08)" : "rgba(232,98,44,.03)";
		for (const f of g.features) {
			const ring = f.geometry.coordinates[0];
			ctx.beginPath();
			ring.forEach(([lon, lat], i) => {
				const [sx, sy] = lonLatToScreen(lon + g.offset.dx, lat + g.offset.dy);
				if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
			});
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		}
	}

	// 荒川区の外周（e-Stat小地域から抽出）を太線で参照表示
	ctx.strokeStyle = "#8b1a1a";
	ctx.lineWidth = 3 * dpr;
	ctx.lineJoin = "round";
	for (const seg of wardBoundary) {
		ctx.beginPath();
		seg.forEach(([lon, lat], i) => {
			const [sx, sy] = lonLatToScreen(lon, lat);
			if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
		});
		ctx.stroke();
	}
}

// ---- ヒットテスト（point-in-polygon）----
function pointInRing(lon, lat, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i], [xj, yj] = ring[j];
		if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
	}
	return inside;
}
function hitTest(lon, lat) {
	for (const [key, g] of groups) {
		for (const f of g.features) {
			const ring = f.geometry.coordinates[0].map(([x, y]) => [x + g.offset.dx, y + g.offset.dy]);
			if (pointInRing(lon, lat, ring)) return key;
		}
	}
	return null;
}

// ---- 操作 ----
let drag = null; // { mode: 'pan'|'group', key?, startLonLat, startOffset, startCam }
let hoveredKey = null;

canvas.addEventListener("pointerdown", e => {
	const [lon, lat] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
	const key = hitTest(lon, lat);
	if (key) {
		drag = { mode: "group", key, startLonLat: [lon, lat], startOffset: { ...groups.get(key).offset } };
		canvas.classList.add("dragging-group");
	} else {
		drag = { mode: "pan", startClient: [e.clientX, e.clientY], startCam: { ...cam } };
	}
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", e => {
	if (drag?.mode === "group") {
		const [lon, lat] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
		const g = groups.get(drag.key);
		g.offset.dx = drag.startOffset.dx + (lon - drag.startLonLat[0]);
		g.offset.dy = drag.startOffset.dy + (lat - drag.startLonLat[1]);
		updateProgress();
		draw();
	} else if (drag?.mode === "pan") {
		const dxPx = (e.clientX - drag.startClient[0]) * dpr, dyPx = (e.clientY - drag.startClient[1]) * dpr;
		const [cx, cy] = lonLatToWorld(drag.startCam.lon, drag.startCam.lat, cam.z);
		const [lon, lat] = worldToLonLat(cx - dxPx, cy - dyPx, cam.z);
		cam.lon = lon; cam.lat = lat;
		draw();
	} else {
		const [lon, lat] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
		const key = hitTest(lon, lat);
		if (key !== hoveredKey) {
			hoveredKey = key;
			if (key) {
				const [daiji, chome] = key.split("::");
				hoverEl.textContent = daiji + (chome ? chome + "丁目" : "");
				hoverEl.style.display = "block";
			} else hoverEl.style.display = "none";
			draw();
		}
	}
});
canvas.addEventListener("pointerup", () => { drag = null; canvas.classList.remove("dragging-group"); });
canvas.addEventListener("pointerleave", () => { if (drag?.mode !== "group") drag = null; });

canvas.addEventListener("wheel", e => {
	e.preventDefault();
	const [lon0, lat0] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
	cam.z = Math.max(12, Math.min(20, cam.z - e.deltaY * 0.0025));
	const [lon1, lat1] = screenToLonLat(e.clientX * dpr, e.clientY * dpr);
	cam.lon += lon0 - lon1; cam.lat += lat0 - lat1;
	draw();
}, { passive: false });

// ---- ツールバー ----
document.getElementById("reset-all").addEventListener("click", () => {
	if (!confirm("全グループの位置調整をリセットしますか？")) return;
	for (const g of groups.values()) { g.offset.dx = 0; g.offset.dy = 0; }
	updateProgress(); draw();
});
document.getElementById("export").addEventListener("click", () => {
	const out = {};
	for (const [key, g] of groups) out[key] = g.offset;
	const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "13118-offsets.json";
	a.click();
});
document.getElementById("load").addEventListener("change", async e => {
	const file = e.target.files[0];
	if (!file) return;
	const offsets = JSON.parse(await file.text());
	for (const [key, off] of Object.entries(offsets)) {
		if (groups.has(key)) groups.get(key).offset = off;
	}
	updateProgress(); draw();
});

resize();
loadData();
