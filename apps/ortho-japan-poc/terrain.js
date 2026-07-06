// 標高アトラス（altpbf 多解像度）：ズームで R90/R10/R01 を選び、視野を覆うセル群を1枚のアトラスへ。
// R01(1°・秒単位)まで寄れるので城下の地形が正確＝建物が実地形に接地する。自前の読込インジケータを持つ。
// 必要な物は入口で受ける：renderer(アトラス書込) / cam(視野) / canvas(寸法) / requestDraw / exag,earthM(標高スケール)。
import { unproject, cameraState, downsampleFlipped } from "ortho-japan";
import { createTileLoader } from "altpbf";

export function createTerrain({ renderer, cam, canvas, requestDraw, exag, earthM, apiUrl }) {
	let atlasKey = "", loadedCells = new Set();
	const r10Tiles = new Map();   // "range,cx,cy" → 解決した生タイル（ラベル標高のCPUサンプル用）
	let loadTile = null;          // altpbf createTileLoader（非同期セットアップ）
	createTileLoader({ apiUrl })
		.then(fn => { loadTile = fn; requestDraw(); })
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
	function sampleElev(lon, lat) {
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
	async function ensure() {
		if (!loadTile) return;
		const range = selectRange();
		const r = viewCellRange(range);
		const key = [range, r.originCX, r.originCY, r.cellsX, r.cellsY, r.cellRes].join(",");
		if (key !== atlasKey) {
			atlasKey = key; loadedCells = new Set();
			renderer.set("elevAtlas", { originLng: r.originCX * range, originLat: r.originCY * range, cellsX: r.cellsX, cellsY: r.cellsY, cellRes: r.cellRes, cellSpan: range, exag }, exag / earthM);
			requestDraw();
		}
		for (let cy = 0; cy < r.cellsY; cy++) for (let cx = 0; cx < r.cellsX; cx++) {
			const ck = cx + "," + cy;
			if (loadedCells.has(ck)) continue;
			loadedCells.add(ck);
			pendingElev++; updateElevIndicator(range);
			getCell((r.originCX + cx) * range, (r.originCY + cy) * range, range).then(tile => {
				pendingElev--; updateElevIndicator(range);
				if (tile && atlasKey === key) { renderer.set("elevCell", downsampleFlipped(tile, r.cellRes), { cx, cy, cellRes: r.cellRes }); requestDraw(); }
			});
		}
	}
	return { ensure, sampleElev };
}
