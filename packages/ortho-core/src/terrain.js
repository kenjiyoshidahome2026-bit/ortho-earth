// 標高アトラス（altpbf 多解像度）：ズームで R90/R10/R01 を選び、視野を覆うセル群を1枚のアトラスへ。
// R01(1°・秒単位)まで寄れるので城下の地形が正確＝建物が実地形に接地する。
// DOM に触れない純ロジック＝ render worker（OffscreenCanvas側）からそのまま使える。読込インジケータは
// onPending コールバックで外へ通知し、DOM を持つ側（main）が表示する。
import { unproject, cameraState } from "./camera.js";
import { downsampleFlipped } from "./elevation.js";
import { createTileLoader } from "altpbf";

export function createTerrain({ renderer, requestDraw, exag, earthM, apiUrl, onPending }) {
	let atlasKey = "", loadedCells = new Set();
	let hasAtlas = false, staging = false, stagePending = new Set();   // ダブルバッファ状態（山影がパッと消えるのを防ぐ）
	const r10Tiles = new Map();   // "range,cx,cy" → 解決した生タイル（ラベル標高のCPUサンプル用）
	let loadTile = null;          // altpbf createTileLoader（非同期セットアップ）
	createTileLoader({ apiUrl })
		.then(fn => { loadTile = fn; requestDraw(); })
		.catch(e => console.error("[tileLoader] setup failed", e));

	// 地形読込インジケータ：R01 初回は JAXA から数秒かかるので「何が起きているか」を明示（表示自体は呼び出し側=DOMを持つ側の責務）。
	let pendingElev = 0;
	function notifyPending(range) { onPending && onPending(pendingElev, range); }

	// R90=超広域(8×8で覆いきる手前) / R10=中 / R01=城下。
	// 高チルト(>0.9rad)の山岳帯は R10 へ落とす：R01 は cap4=4° で地平線(z12で~4°先)まで届かず、
	// 覆いの切れ目が「遠方の青い帯」になる（R10 なら広域を一括カバー＝地平線までフォグ内で連続）。
	function selectRange(cam) {
		const z = cam.zoom;
		if (z < 4.5) return 90;
		if (z < 12 || ((cam.pitch || 0) > 0.9 && z < 13)) return 10;
		return 1;
	}
	async function getCell(cellLng, cellLat, range) {
		if (!loadTile) return null;
		const k = range + "," + cellLng + "," + cellLat;
		if (r10Tiles.has(k)) return r10Tiles.get(k);
		const tile = await loadTile(cellLng, cellLat, range);
		if (tile) r10Tiles.set(k, tile);
		return tile;
	}
	// ラベル位置の標高(m)。キャッシュ済みの最も細かいセルから（R01→R10→R90 フォールバック）
	// downsampleFlipped と同じ南上げ規約でバイリニア。R10(約900m格子)だけだと谷の街に隣の山の標高が
	// 滲み、チルト時にラベルが浮く。
	function sampleElev(lon, lat) {
		let tile = null;
		for (const range of [1, 10, 90]) {
			const cx0 = Math.floor(lon / range) * range, cy0 = Math.floor(lat / range) * range;
			tile = r10Tiles.get(range + "," + cx0 + "," + cy0);
			if (tile) break;
		}
		if (!tile) return 0;
		const cx = tile.lng, cy = tile.lat, range = tile.range;
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
	// R10 親タイルから 1°セルを切り出して cellRes² に再標本化（downsampleFlipped と同じ南上げ規約）。
	// 混成アトラスの遠方セル用＝R01 の大量フェッチ（1セル数秒×数十）を避けつつ遠景の起伏を出す。
	function cropResample(tile, lng0, lat0, span, N) {
		const { data, width: w, height: h, lng: lo, lat: la, range: r } = tile;
		const out = new Float32Array(N * N);
		const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };   // y:0=南
		for (let j = 0; j < N; j++) {
			const gy = ((lat0 - la) + span * j / (N - 1)) / r * (h - 1);
			const y0 = Math.max(0, Math.min(h - 2, gy | 0)), fy = Math.min(1, Math.max(0, gy - y0));
			for (let i = 0; i < N; i++) {
				const gx = ((lng0 - lo) + span * i / (N - 1)) / r * (w - 1);
				const x0 = Math.max(0, Math.min(w - 2, gx | 0)), fx = Math.min(1, Math.max(0, gx - x0));
				const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
				const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
				out[j * N + i] = v < 0 ? 0 : v;   // row0=南
			}
		}
		return out;
	}
	function viewCellRange(cam, size, range, mixed) {
		if (mixed) {
			// 混成窓は決定的に：カメラセル基準＋方位ベクトルで前方（視線方向）へ2セル寄せる。
			// unproject スパンの中点は高チルトの grazing 標本に引きずられて窓が海へ飛ぶ（実測: 富士で lat19 に飛んだ）。
			const camCX = Math.floor(cam.center[0]), camCY = Math.floor(cam.center[1]);
			const fx = Math.sin(cam.bearing || 0), fy = Math.cos(cam.bearing || 0);
			const cells = 8, half = cells - 1 >> 1;
			return { range: 1, originCX: camCX - half + Math.round(fx * 2), originCY: camCY - half + Math.round(fy * 2), cellsX: cells, cellsY: cells, cellRes: 400 };
		}
		const st = cameraState(cam, size.w, size.h);
		// 画面を密にサンプル（傾き時、地平線直下の"遠い地面"まで拾う）。宇宙に外れた点はnull→無視。
		let lo0 = cam.center[0], la0 = cam.center[1], lo1 = lo0, la1 = la0;
		const NX = 9, NY = 12;
		for (let jy = 0; jy < NY; jy++) for (let ix = 0; ix < NX; ix++) {
			const p = unproject(st, size.w * ix / (NX - 1), size.h * jy / (NY - 1));
			if (!p) continue;
			lo0 = Math.min(lo0, p[0]); lo1 = Math.max(lo1, p[0]);
			la0 = Math.min(la0, p[1]); la1 = Math.max(la1, p[1]);
		}
		const cx0 = Math.floor(lo0 / range), cx1 = Math.floor(lo1 / range), cy0 = Math.floor(la0 / range), cy1 = Math.floor(la1 / range);
		// セル上限：R01 は近景特化で小さく高精細に（遠景まで広げると grazing で粗いメッシュの壁が出る）。
		// R10/R90 は広域カバー優先で 8。混成（高チルト）は 1°×8 を視線方向へ寄せて地平線まで届かせる。
		const cap = mixed ? 8 : range === 1 ? 4 : 8;
		const cellsX = Math.min(cap, cx1 - cx0 + 1), cellsY = Math.min(cap, cy1 - cy0 + 1);
		// センタリング：通常はカメラ中心／混成は視野スパンの中点＝見ている方向へ窓を寄せる
		const ccx = Math.floor((mixed ? (lo0 + lo1) / 2 : cam.center[0]) / range), ccy = Math.floor((mixed ? (la0 + la1) / 2 : cam.center[1]) / range);
		const originCX = Math.max(cx0, Math.min(cx1 - cellsX + 1, ccx - (cellsX - 1 >> 1)));
		const originCY = Math.max(cy0, Math.min(cy1 - cellsY + 1, ccy - (cellsY - 1 >> 1)));
		const cellRes = Math.max(400, Math.floor(2048 / Math.max(cellsX, cellsY)));
		return { range, originCX, originCY, cellsX, cellsY, cellRes };
	}
	function ensure(cam, size) {   // 戻り値 false＝ローダ未準備で何もしていない（呼び出し側はスロットル記憶を消して再試行すること）
		if (!loadTile) return false;
		// 混成モード（高チルト×中ズーム）：1°グリッドで近傍3×3=R01（富士の近景ディテール）、
		// 遠方セル=R10切り出し（地平線までのカバー）。単一アトラス＝レンダラ側は無変更。
		const mixed = (cam.pitch || 0) > 0.9 && cam.zoom >= 10.5 && cam.zoom < 13;
		const range = mixed ? 1 : selectRange(cam);
		const r = viewCellRange(cam, size, range, mixed);
		const key = [mixed ? "M" : range, r.originCX, r.originCY, r.cellsX, r.cellsY, r.cellRes].join(",");
		if (key !== atlasKey) {
			atlasKey = key; loadedCells = new Set();
			// 2枚目以降はダブルバッファ：舞台裏(stage)で構築し、初回分のセルが揃ったら一括スワップ。
			// 直接張り替えるとゼロ初期化の瞬間に山影が全画面で消える（ズーム静止・R01/R10切替のたびに発症していた）。
			staging = hasAtlas; stagePending = new Set();
			renderer.set(staging ? "elevAtlasStage" : "elevAtlas",
				{ originLng: r.originCX * range, originLat: r.originCY * range, cellsX: r.cellsX, cellsY: r.cellsY, cellRes: r.cellRes, cellSpan: range, exag }, exag / earthM);
			hasAtlas = true;
			if (staging) {   // 保険：セルの一部が失敗しても4秒で必ずスワップ（古いアトラスが永久に残らない）
				const k0 = key;
				setTimeout(() => { if (staging && atlasKey === k0) { staging = false; renderer.set("elevAtlasCommit"); requestDraw(); } }, 4000);
			}
			requestDraw();
		}
		// セル書き込み先：staging 中は舞台裏へ。全セル解決で commit（スワップ）し、以降は表アトラスへ直書き。
		const cellSlot = () => staging ? "elevCellStage" : "elevCell";
		const doneOne = ck2 => {
			if (!staging) return;
			stagePending.delete(ck2);
			if (!stagePending.size) { staging = false; renderer.set("elevAtlasCommit"); }
		};
		const camCX = Math.floor(cam.center[0] / range), camCY = Math.floor(cam.center[1] / range);
		for (let cy = 0; cy < r.cellsY; cy++) for (let cx = 0; cx < r.cellsX; cx++) {
			const ck = cx + "," + cy;
			if (loadedCells.has(ck)) continue;
			loadedCells.add(ck);
			if (staging) stagePending.add(ck);
			const cellLng = (r.originCX + cx) * range, cellLat = (r.originCY + cy) * range;
			const nearCam = Math.abs(r.originCX + cx - camCX) <= 1 && Math.abs(r.originCY + cy - camCY) <= 1;
			pendingElev++; notifyPending(range);
			if (mixed) {
				// 全セルまず R10 切り出しで即座に埋める（近傍も）＝R01 初回フェッチ(数秒×9)の間の平坦を防ぐ。
				getCell(Math.floor(cellLng / 10) * 10, Math.floor(cellLat / 10) * 10, 10).then(parent => {
					pendingElev--; notifyPending(range);
					if (parent && atlasKey === key && !(loadedCells.has(ck + "hi"))) {
						renderer.set(cellSlot(), cropResample(parent, cellLng, cellLat, range, r.cellRes), { cx, cy, cellRes: r.cellRes });
					}
					if (atlasKey === key) doneOne(ck);
					requestDraw();
				});
				if (nearCam) {   // 近傍3×3は R01 が届き次第上書き（富士の近景ディテール）。commit は待たせない
					pendingElev++; notifyPending(range);
					getCell(cellLng, cellLat, 1).then(tile => {
						pendingElev--; notifyPending(range);
						if (tile && atlasKey === key) {
							loadedCells.add(ck + "hi");   // 以降 R10 切り出しで上書きさせない
							renderer.set(cellSlot(), downsampleFlipped(tile, r.cellRes), { cx, cy, cellRes: r.cellRes }); requestDraw();
						}
					});
				}
			} else {
				getCell(cellLng, cellLat, range).then(tile => {
					pendingElev--; notifyPending(range);
					if (tile && atlasKey === key) renderer.set(cellSlot(), downsampleFlipped(tile, r.cellRes), { cx, cy, cellRes: r.cellRes });
					if (atlasKey === key) doneOne(ck);
					requestDraw();
				});
			}
		}
		return true;
	}
	return { ensure, sampleElev };
}
