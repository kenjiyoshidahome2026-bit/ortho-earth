// LOD選択と可視タイル算出（正射球面）。画面をサンプリングし各点を経緯度へ逆投影してタイルを被覆する。
import { lonLatToTile } from "./tile.js";
const D2R = Math.PI / 180, R2D = 180 / Math.PI, TILE = 512;

// 正射逆投影：screen(device px) → [lon,lat] または null（球の外/裏）。
export function invert(cam, sx, sy) {
	const x = (sx - cam.translate[0]) / cam.scale;
	const y = -(sy - cam.translate[1]) / cam.scale;
	const rho = Math.hypot(x, y);
	if (rho > 1) return null;                       // 球外
	const c = Math.asin(Math.max(-1, Math.min(1, rho)));
	const cc = Math.cos(c), sc = Math.sin(c);
	const lat0 = cam.center[1] * D2R, lon0 = cam.center[0] * D2R;
	const clat0 = Math.cos(lat0), slat0 = Math.sin(lat0);
	const lat = rho === 0 ? lat0 : Math.asin(cc * slat0 + y * sc * clat0 / rho);
	const lon = lon0 + Math.atan2(x * sc, rho * clat0 * cc - y * slat0 * sc);
	return [((lon * R2D + 540) % 360) - 180, lat * R2D];
}

// カメラ scale から web-mercator ズームを選ぶ（中心での解像度一致、緯度補正）。
export function pickZoom(cam, minZoom = 4, maxZoom = 16) {
	const lat = cam.center[1] * D2R;
	const z = Math.log2(cam.scale * 2 * Math.PI / TILE / Math.max(0.05, Math.cos(lat)));
	return Math.max(minZoom, Math.min(maxZoom, Math.round(z)));
}

// 可視タイル一覧 {z,x,y}。画面を grid×grid サンプルして逆投影→タイルへ。pad で外周を1タイル広げる。
export function visibleTiles(cam, W, H, z, { grid = 6, pad = 1 } = {}) {
	const n = 1 << z;
	let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, hit = false;
	for (let iy = 0; iy <= grid; iy++) {
		for (let ix = 0; ix <= grid; ix++) {
			const ll = invert(cam, ix / grid * W, iy / grid * H);
			if (!ll) continue;
			hit = true;
			const [tx, ty] = lonLatToTile(ll[0], ll[1], z);
			xmin = Math.min(xmin, tx); xmax = Math.max(xmax, tx);
			ymin = Math.min(ymin, ty); ymax = Math.max(ymax, ty);
		}
	}
	if (!hit) return [];
	xmin -= pad; xmax += pad; ymin = Math.max(0, ymin - pad); ymax = Math.min(n - 1, ymax + pad);
	// 経度方向のタイル数が異常に多い時（球を広く見て回り込む）は打ち切り
	if (xmax - xmin > n) { xmin = 0; xmax = n - 1; }
	const tiles = [];
	for (let ty = ymin; ty <= ymax; ty++) {
		for (let x = xmin; x <= xmax; x++) {
			const tx = ((x % n) + n) % n;             // 経度ラップ
			tiles.push({ z, x: tx, y: ty });
		}
	}
	return tiles;
}
