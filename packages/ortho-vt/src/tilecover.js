// LOD選択と可視タイル算出（透視カメラ）。画面をサンプリングし各点をカメラ光線でunproject→タイルへ。
import { lonLatToTile } from "./tile.js";
import { cameraState, unproject } from "./camera.js";

// cam.zoom を web-mercator ズームに丸める。
export function pickZoom(cam, minZoom = 4, maxZoom = 16) {
	return Math.max(minZoom, Math.min(maxZoom, Math.round(cam.zoom)));
}

// 可視タイル一覧 {z,x,y}。画面 grid×grid をサンプルして unproject→タイルへ。pad で外周を広げる。
export function visibleTiles(cam, W, H, z, { grid = 6, pad = 1 } = {}) {
	const st = cameraState(cam, W, H);
	const n = 1 << z;
	let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, hit = false;
	for (let iy = 0; iy <= grid; iy++) {
		for (let ix = 0; ix <= grid; ix++) {
			const ll = unproject(st, ix / grid * W, iy / grid * H);
			if (!ll) continue;                         // 球に当たらない（地平線より上/空）
			hit = true;
			const [tx, ty] = lonLatToTile(ll[0], ll[1], z);
			xmin = Math.min(xmin, tx); xmax = Math.max(xmax, tx);
			ymin = Math.min(ymin, ty); ymax = Math.max(ymax, ty);
		}
	}
	if (!hit) return [];
	xmin -= pad; xmax += pad; ymin = Math.max(0, ymin - pad); ymax = Math.min(n - 1, ymax + pad);
	if (xmax - xmin > n) { xmin = 0; xmax = n - 1; }   // 広く回り込む時は打ち切り
	const tiles = [];
	for (let ty = ymin; ty <= ymax; ty++) {
		for (let x = xmin; x <= xmax; x++) {
			const tx = ((x % n) + n) % n;              // 経度ラップ
			tiles.push({ z, x: tx, y: ty });
		}
	}
	return tiles;
}

export { unproject } from "./camera.js";
