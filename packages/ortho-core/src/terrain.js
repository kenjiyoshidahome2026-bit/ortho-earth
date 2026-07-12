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

	// R90=全球〜大陸眺め / R10=中 / R01=城下。
	// R90/R10境界=z5.5：R90(3.7km格子)は~z5.3まで画素以下＝十分。R10は1枚3.5-4.5MBで
	// 広域だと6-8枚=25-35MBを一瞥の大陸に払う浪費（本人裁定「この倍率ならR90で十分」）。
	// R90は90°角1-2枚=一度きり＝全球ぐるぐるの巡航コストがほぼゼロになる。
	// 高チルト(>0.9rad)の山岳帯は R10 へ落とす：R01 は cap4=4° で地平線(z12で~4°先)まで届かず、
	// 覆いの切れ目が「遠方の青い帯」になる（R10 なら広域を一括カバー＝地平線までフォグ内で連続）。
	function selectRange(cam) {
		const z = cam.zoom;
		if (z < 5.5) return 90;
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
		// 「必要なセル」は画素の実需で計算する：画面を等間隔サンプルし、各サンプル（＝等しい画面面積の代表）が
		// 落ちるセルへ1票。旧実装の min/max 窓は、地球の縁の掠りサンプル（1pxに数十km）や視界に入った極が
		// 窓を全球規模に爆発させ、セル予算を縁へ浪費して中心の解像度を潰していた（高緯度×チルトで顕著）。
		// 窓は「カバーした票 × セル解像度」を最大化する連続矩形（cap以内・カメラセルを必ず含む）＝
		// 画素が多い場所ほど細かく塗られ、掠りしか見えないセルは票が少なく自然に切り捨てられる。
		const cellsPerWorld = Math.round(360 / range);
		const camCX = Math.floor(cam.center[0] / range), camCY = Math.floor(cam.center[1] / range);
		const wrapDx = d => { d %= cellsPerWorld; return d > cellsPerWorld / 2 ? d - cellsPerWorld : d < -cellsPerWorld / 2 ? d + cellsPerWorld : d; };
		const votes = new Map();   // "dx,dy"（カメラセル相対・経度は最短ラップ）→ 票
		const NX = 24, NY = 16;
		for (let jy = 0; jy <= NY; jy++) for (let ix = 0; ix <= NX; ix++) {
			const p = unproject(st, size.w * ix / NX, size.h * jy / NY);
			if (!p) continue;
			const dx = wrapDx(Math.floor(p[0] / range) - camCX), dy = Math.floor(p[1] / range) - camCY;
			const k = dx + "," + dy;
			votes.set(k, (votes.get(k) || 0) + 1);
		}
		votes.set("0,0", (votes.get("0,0") || 0) + 1);   // カメラセルは錨（全サンプル空振りでも1×1が立つ）
		// セル上限：R01 は近景特化で小さく高精細に（遠景まで広げると grazing で粗いメッシュの壁が出る）。
		const cap = range === 1 ? 4 : 8;
		let lox = 0, hix = 0, loy = 0, hiy = 0;
		for (const k of votes.keys()) { const [dx, dy] = k.split(",").map(Number); lox = Math.min(lox, dx); hix = Math.max(hix, dx); loy = Math.min(loy, dy); hiy = Math.max(hiy, dy); }
		// アトラス解像度の予算：総テクスチャ辺≤4096（実用機のMAX_TEXTURE_SIZE下限）・下限512・
		// 上限①ソース密度（R90=2700/90°(3.7km)・R10=2400/10°(463m)・R01=1024運用）＝水増しのぼけをしない。
		// 上限②画面が使い切れる密度（≈1.2 device px/texel）＝過剰割当でGPUメモリと票を浪費しない。
		// ②は2の冪へ量子化＝ズーム微動で atlasKey が揺れて再構築が頻発しない（1オクターブ1回）。
		// 旧予算(2048/一律400)はR90を8.8km/texelに潰し「R90の実力=3.7km」すら出ていなかった。
		const srcMax = range === 90 ? 2700 : range === 10 ? 2400 : 1024;
		const radPerDevPx = 2 * Math.PI / (Math.pow(2, cam.zoom) * 512 * (cam.dpr || 1));
		const useful = range * Math.PI / 180 / (radPerDevPx * 1.2);   // 画面が使い切れる密度（生値＝スコア用）
		const resOf = (cx, cy) => Math.min(srcMax, useful, Math.max(512, Math.floor(4096 / Math.max(cx, cy))));
		// 0を含む窓 [a..b]（幅≤cap）の全組合せから「票×解像度」最大を選ぶ。候補は高々 cap²×cap² 程度＝安い。
		// 解像度は useful（画面が使い切れる密度）で頭打ち＝それ以上の精細に票を売らない→カバー率が効く。
		let best = null;
		for (let ax = Math.max(lox, -cap + 1); ax <= 0; ax++) for (let bx = 0; bx <= Math.min(hix, ax + cap - 1); bx++)
			for (let ay = Math.max(loy, -cap + 1); ay <= 0; ay++) for (let by = 0; by <= Math.min(hiy, ay + cap - 1); by++) {
				let s = 0;
				for (const [k, v] of votes) { const [dx, dy] = k.split(",").map(Number); if (dx >= ax && dx <= bx && dy >= ay && dy <= by) s += v; }
				const score = s * resOf(bx - ax + 1, by - ay + 1);
				if (!best || score > best.score) best = { ax, bx, ay, by, score };
			}
		const cellsX = best.bx - best.ax + 1, cellsY = best.by - best.ay + 1;
		const originCX = camCX + best.ax, originCY = camCY + best.ay;
		// 割当は useful を2の冪へ量子化＝ズーム微動で atlasKey が揺れて再構築が頻発しない（1オクターブ1回）。
		const usefulQ = Math.pow(2, Math.ceil(Math.log2(Math.max(1, useful))));
		const allocRes = Math.max(512, Math.min(srcMax, usefulQ, Math.max(512, Math.floor(4096 / Math.max(cellsX, cellsY)))));
		// 窓の中でも票ゼロのセル（対角ビューの角など画面に映らないセル）はフェッチしない＝必要なタイルだけ払う。
		const wanted = new Set();
		for (const [k, v] of votes) {
			const [dx, dy] = k.split(",").map(Number);
			if (v > 0 && dx >= best.ax && dx <= best.bx && dy >= best.ay && dy <= best.by) wanted.add((dx - best.ax) + "," + (dy - best.ay));
		}
		return { range, originCX, originCY, cellsX, cellsY, cellRes: allocRes, wanted };
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
			if (r.wanted && !r.wanted.has(ck)) { loadedCells.add(ck); continue; }   // 画面に映らないセルは取りに行かない（票ゼロ＝窓の角）
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
