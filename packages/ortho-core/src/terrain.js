// 標高アトラス（altpbf 多解像度）：ズームで R90/R10/R01 を選び、視野を覆うセル群を1枚のアトラスへ。
// R01(1°・秒単位)まで寄れるので城下の地形が正確＝建物が実地形に接地する。
// DOM に触れない純ロジック＝ render worker（OffscreenCanvas側）からそのまま使える。読込インジケータは
// onPending コールバックで外へ通知し、DOM を持つ側（main）が表示する。
import { unproject, cameraState, lonlatTo3D, WORLD_PX } from "./camera.js";
import { downsampleFlipped } from "./elevation.js";
import { createTileLoader } from "altpbf/loader";

export function createTerrain({ renderer, requestDraw, exag, earthM, apiUrl, onPending, lowMem = false, noMixed = false, noFar = false }) {
	let atlasKey = "", loadedCells = new Set();
	let cellFails = new Map();   // ck → 取得失敗回数（窓の世代ごとにリセット。上限内は次の ensure で再挑戦）
	// 遠景層（far）＝近窓が R01 級（cap4=4°）へ縮む深ズーム×チルトで、粗い R10 を第2アトラスへ常設。
	// 特定の山の特別扱いはしない一般則：ズームインで近窓の外へ出た遠方の山（富士・アルプス・筑波…）は
	// 全てこの層が受け持ち、シェーダ elev() が近窓の縁フェードで遠層の値へ溶ける（0 へ落とさない）。
	let farKey = "", farLoaded = new Set(), farWritten = new Set(), farFails = new Map();
	console.log("[terrain] gen=far2-20260902c (R90床=世界帯z<8・R90/R10境界=5.5)");   // 版印＝タブが古い世代を掴んだままの切り分け用（HMR跨ぎ事故の実績 9/2）
	let writtenCells = new Set();   // 実際にアトラスへ書き込めたセル（検札の突合対象。世代ごとにリセット）
	let lastEnsureCam = null, lastEnsureSize = null, auditT = 0, auditTries = 0;   // 検札＝静止中の自己修復用
	let hasAtlas = false, staging = false, stagePending = new Set();   // ダブルバッファ状態（山影がパッと消えるのを防ぐ）
	// "range,cx,cy" → 解決した生タイル（アトラスセル切り出し＋ラベル標高のCPUサンプル用）。
	// 【LRUバイト予算】デコード済み標高タイルは R01(DEM10B)=1°で数十MB級。無制限だと混成窓(8×8セル)の
	// settle 毎取得×地域移動で renderer プロセスが単調成長する（z9チルト75の zoom往復で 0.9→2.2GB/20秒、
	// 実機では 13GB 到達を実測＝「drawn のたびにメモリ爆発」の正体）。ヒットで末尾へ回す挿入順 LRU。
	const r10Tiles = new Map();
	// 常駐上限：デスクトップ256MB＝現窓の R01 一式＋R10/R90 が収まる（IDB があるので再取得は安い）。
	// 低メモリ端末（iOS＝タブ~1.4GBでjetsam）は64MB＝タブ予算の2割弱を1キャッシュに渡さない（不足分はIDB再取得）。
	const TILE_CACHE_BYTES = (lowMem ? 64 : 256) << 20;
	let tileBytes = 0;
	const tileSize = t => (t?.data?.byteLength ?? 0) + 64;
	function cacheTile(k, tile) {
		const old = r10Tiles.get(k);
		if (old) { r10Tiles.delete(k); tileBytes -= tileSize(old); }   // 同キー競合（並行fetch）は差し替え＝二重計上しない
		r10Tiles.set(k, tile); tileBytes += tileSize(tile);
		for (const [ok, ot] of r10Tiles) {
			if (tileBytes <= TILE_CACHE_BYTES || ok === k) break;   // 予算内 or 自分（今入れた分）まで来たら終了
			r10Tiles.delete(ok); tileBytes -= tileSize(ot);
		}
	}
	let loadTile = null;          // altpbf createTileLoader（非同期セットアップ）
	// 【一発死の禁止】旧・単発 await＝setup が一度落ちると標高システム全体が永久沈黙（loadTile=null →
	// ensure が何もしない → トーストすら出ない → 山が平ら。借り物 iPhone13 のプライベートブラウズで実症状）。
	// IDB 起因は altpbf 側で「キャッシュ無しで続行」へ縮退済み＝ここは残る失敗（index_alos のネットワーク断）
	// を指数バックオフで再試行。成立時の requestDraw → 次の settle の ensure が自然に拾って自己回復する。
	let loaderTries = 0;
	let loaderStat = "初期化中…";   // ⛰トーストに出す自己申告（借り物端末＝インスペクタ不可でも画面から死因が読める）
	const setupLoader = () => createTileLoader({ apiUrl })
		.then(fn => { loadTile = fn; loaderStat = null; onPending && onPending(0, 0, null); requestDraw(); })   // stat トーストの残留も消す
		.catch(e => {
			const retry = loaderTries++ < 8;
			loaderStat = `初期化失敗: ${(e?.message ?? e)}${retry ? "（再試行中）" : "（打ち切り）"}`;
			console.error("[tileLoader] setup failed", e, retry ? "→ 再試行" : "→ 打ち切り");
			if (retry) setTimeout(setupLoader, Math.min(30000, 1000 * 2 ** loaderTries));
		});
	setupLoader();

	// 地形読込インジケータ：R01 初回は JAXA から数秒かかるので「何が起きているか」を明示（表示自体は呼び出し側=DOMを持つ側の責務）。
	let pendingElev = 0;
	function notifyPending(range) { onPending && onPending(pendingElev, range); }

	// R90=全球〜大陸眺め / R10=中 / R01=城下。
	// R90/R10境界=z5.5（旧6.5→9/2本人裁定「遅くはなるが海岸のギザギザが消えて綺麗」）：
	// R90(3.7km格子)はz5.5+で海岸縁に格子量子化の階段が見える（日本z5.7実測）＋陰影が磨りガラス化。
	// 代償=帯5.5-6.5はカメラ追従R10窓（z5.7で~12枚45-55MB・初回のみ、IDB再訪はタダ）。
	// z<5.5はR90固定窓のまま＝全球ぐるぐるの巡航コストゼロ設計は無傷（星空劇場z<5も内側）。
	// 高チルト(>0.9rad)の山岳帯は R10 へ落とす：R01 は cap4=4° で地平線(z13で~4°先)まで届かず、
	// 覆いの切れ目が「遠方の青い帯」になる（R10 なら広域を一括カバー＝地平線までフォグ内で連続）。
	function selectRange(cam) {
		const z = cam.zoom;
		if (z < 5.5) return 90;
		if (z < 13 || ((cam.pitch || 0) > 0.9 && z < 14)) return 10;
		return 1;
	}
	async function getCell(cellLng, cellLat, range) {
		if (!loadTile) return null;
		// 経度は周期正規化：日付変更線を跨いだ窓のセルは cellLng が 180 や -270 になり、そのまま
		// タイル名にすると実在しない（E180等）＝空振りで陰影が欠けていた（実測: lat70の北極海チルト）。
		const lngN = ((cellLng % 360) + 540) % 360 - 180;
		const k = range + "," + lngN + "," + cellLat;
		const hit = r10Tiles.get(k);
		if (hit) { r10Tiles.delete(k); r10Tiles.set(k, hit); return hit; }   // ヒット＝LRU 末尾へ（追い出され順の更新）
		// 失敗は null に畳む＝getCell は絶対に reject しない（呼び出し側の pending デクリメントが
		// .then 購読のみのため、reject が漏れると読込インジケータが永久に残る）
		const tile = await loadTile(lngN, cellLat, range).catch(e => { console.warn("[terrain] セル取得失敗", k, e); return null; });
		if (tile && !(tile.data && tile.width)) { console.warn("[terrain] 不正形のタイル（Blob混入キャッシュ？）→ null扱い", k); return null; }   // クラッシュ保険＝描画ループを絶対に落とさない（根治はローダ側の形検札）
		if (tile) cacheTile(k, tile);
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
	// R10 親タイルから 1°セルを切り出して cellRes² に再標本化（downsampleFlipped と同じ南上げ・
	// texel中心 (i+0.5)/N 規約＝シェーダ uv 直サンプルと一致。角合わせだと±0.5texelずれる）。
	// 混成アトラスの遠方セル用＝R01 の大量フェッチ（1セル数秒×数十）を避けつつ遠景の起伏を出す。
	function cropResample(tile, lng0, lat0, span, N) {
		const { data, width: w, height: h, lng: lo, lat: la, range: r } = tile;
		const out = new Float32Array(N * N);
		const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };   // y:0=南
		for (let j = 0; j < N; j++) {
			const gy = ((lat0 - la) + span * (j + 0.5) / N) / r * (h - 1);
			const y0 = Math.max(0, Math.min(h - 2, gy | 0)), fy = Math.min(1, Math.max(0, gy - y0));
			for (let i = 0; i < N; i++) {
				const gx = ((lng0 - lo) + span * (i + 0.5) / N) / r * (w - 1);
				const x0 = Math.max(0, Math.min(w - 2, gx | 0)), fx = Math.min(1, Math.max(0, gx - x0));
				const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
				const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
				out[j * N + i] = v < 0 ? 0 : v;   // row0=南
			}
		}
		return out;
	}
	// 窓縁の標高フェード幅(deg)。viewCellRange の隣セル強制包含と ensure の renderer.set で共用（値ズレ防止）。
	const EDGE_FADE = r => r === 90 ? 0 : r === 10 ? 1.5 : 0.4;
	function viewCellRange(cam, size, range, mixed) {
		if (mixed) {
			// 混成窓は決定的に：カメラセル基準＋方位ベクトルで前方（視線方向）へ2セル寄せる。
			// unproject スパンの中点は高チルトの grazing 標本に引きずられて窓が海へ飛ぶ（実測: 富士で lat19 に飛んだ）。
			const camCX = Math.floor(cam.center[0]), camCY = Math.floor(cam.center[1]);
			const fx = Math.sin(cam.bearing || 0), fy = Math.cos(cam.bearing || 0);
			const cells = 8, half = cells - 1 >> 1;
			return { range: 1, originCX: camCX - half + Math.round(fx * 2), originCY: camCY - half + Math.round(fy * 2), cellsX: cells, cellsY: cells, cellRes: 400 };
		}
		if (range === 90) {
			// 全球〜大陸ビュー（z<6.5）は窓を固定＝世界8セル（4×2）常駐。窓をカメラに追従させると
			// versor回転のたびに atlasKey が変わり再構築→縁のセルが見え隠れ（没入感を壊す）。
			// R90一式は先読み/IDB常備＝8セル固定のコストは初回のみ。4×2@1024=4096×2048で予算内。
			// cellRes だけはズームの1オクターブ毎に追従（回転・パンではkey不変）。
			const radPerDevPx = 2 * Math.PI / (Math.pow(2, cam.zoom) * WORLD_PX * (cam.dpr || 1));
			const useful = 90 * Math.PI / 180 / (radPerDevPx * 1.2);
			const usefulQ = Math.pow(2, Math.ceil(Math.log2(Math.max(1, useful))));
			return { range, originCX: -2, originCY: -1, cellsX: 4, cellsY: 2, cellRes: Math.max(512, Math.min(usefulQ, 1024)) };
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
		// フォグの彼方は票に数えない：完全に霞んだ先のセルのために窓を広げない＝解像度の守り。
		// 式は renderer の地形フォグ終端（max(camDist×5, 0.026×pfFog)）と同じ＋余白15%。
		// これがあるから下の vmin=2（見えているセルはほぼ全部must）が安全になる（旧: 総票1%閾値では
		// 広域チルトで票2-3の「見えている大地」が切り捨てられ、標高抜けの帯が残った＝シベリア実測）。
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		const fogFar = Math.max(st.camDist * 5.0, 0.026 * pfFog) * 1.15;
		const votes = new Map();   // "dx,dy"（カメラセル相対・経度は最短ラップ）→ 票
		const NX = 32, NY = 22;    // 格子は密に（terrainGate=静止時のみ実行になったので704回のunprojectは安い）
		for (let jy = 0; jy <= NY; jy++) for (let ix = 0; ix <= NX; ix++) {
			const p = unproject(st, size.w * ix / NX, size.h * jy / NY);
			if (!p) continue;
			const q = lonlatTo3D(p[0], p[1]);
			if (Math.hypot(q[0] - st.eye[0], q[1] - st.eye[1], q[2] - st.eye[2]) > fogFar) continue;
			// 緯度は極でクランプ：lat=90ちょうどは floor で「90..180」の実在しないセルを指す
			const dx = wrapDx(Math.floor(p[0] / range) - camCX), dy = Math.floor(Math.min(89.999, Math.max(-90, p[1])) / range) - camCY;
			const k = dx + "," + dy;
			votes.set(k, (votes.get(k) || 0) + 1);
		}
		votes.set("0,0", (votes.get("0,0") || 0) + 1);   // カメラセルは錨（全サンプル空振りでも1×1が立つ）
		// カメラ近傍の縁フェード対策：カメラがセル境界から edgeFade+α 以内なら隣セルを必ず窓へ（票ブースト＝must化）。
		// 窓の縁＝標高が0へ落ちるフェード帯が視界のど真ん中へ来るのを防ぐ。実測: z15 R01 で窓が1セルに縮み、
		// カメラが南縁から0.014°＝視界(1-2km)全域がフェード帯(0.4°)内＝「z~15で高度が消える」（札幌 2026-07-26）。
		const fadeFrac = EDGE_FADE(range) / range + 0.05;
		if (fadeFrac < 0.5) {
			const fx = cam.center[0] / range - camCX, fy = cam.center[1] / range - camCY;
			if (fx < fadeFrac)     votes.set("-1,0", (votes.get("-1,0") || 0) + 999);
			if (fx > 1 - fadeFrac) votes.set("1,0",  (votes.get("1,0")  || 0) + 999);
			if (fy < fadeFrac)     votes.set("0,-1", (votes.get("0,-1") || 0) + 999);
			if (fy > 1 - fadeFrac) votes.set("0,1",  (votes.get("0,1")  || 0) + 999);
		}
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
		const radPerDevPx = 2 * Math.PI / (Math.pow(2, cam.zoom) * WORLD_PX * (cam.dpr || 1));
		const useful = range * Math.PI / 180 / (radPerDevPx * 1.2);   // 画面が使い切れる密度（生値＝スコア用）
		const edgeBudget = lowMem ? 2048 : 4096;   // 低メモリ端末＝アトラス総辺半分（面積1/4＝GPU+アップロード過渡も1/4。アトラスは R16F＝2B/texel）
		const resOf = (cx, cy) => Math.min(srcMax, useful, Math.max(512, Math.floor(edgeBudget / Math.max(cx, cy))));
		// 0を含む窓 [a..b]（幅≤cap）の全組合せから「票×√解像度」最大を選ぶ。候補は高々 cap²×cap² 程度＝安い。
		// 解像度は useful（画面が使い切れる密度）で頭打ち。√＝解像度の知覚は平方根程度の効きで、
		// カバー欠けは「陰影が死ぬ継ぎ目」の崖＝僅差の精細のために画面の一部を切り捨てない
		//（実例: ハドソン湾チルトで90°セル境界を跨ぐ西側18%が、2700vs2048の僅差で落ちた）。
		// ただし√の傾斜だけでは境界ケースを守り切れない（実測: z9.6チルト39°×1920x1080で票7%の東隣セルが
		// 2400vs2048の0.4%僅差で落ちた）＝「確実に見えているセル（票≥総数の1%）は必ず覆う」を制約に格上げし、
		// 覆える窓の中からスコア最良を選ぶ。cap内に収まらない時だけ従来スコアへ退避。掠り（1-2票）は制約にしない。
		// must の閾値は票2固定：フォグ内で確実に見えているセルは必ず覆う（1票＝サンプリングノイズだけ除外）。
		// 旧 max(2, 総票1%) は広域ビューで実質3-4票となり、見えている遠方セルを落としていた。
		const vmin = 2;
		const must = [...votes.entries()].filter(([, v]) => v >= vmin).map(([k]) => k.split(",").map(Number));
		let best = null;
		for (let ax = Math.max(lox, -cap + 1); ax <= 0; ax++) for (let bx = 0; bx <= Math.min(hix, ax + cap - 1); bx++)
			for (let ay = Math.max(loy, -cap + 1); ay <= 0; ay++) for (let by = 0; by <= Math.min(hiy, ay + cap - 1); by++) {
				let s = 0;
				for (const [k, v] of votes) { const [dx, dy] = k.split(",").map(Number); if (dx >= ax && dx <= bx && dy >= ay && dy <= by) s += v; }
				const coversAll = must.every(([dx, dy]) => dx >= ax && dx <= bx && dy >= ay && dy <= by);
				const score = s * Math.sqrt(resOf(bx - ax + 1, by - ay + 1));
				if (!best || (coversAll && !best.coversAll) || (coversAll === best.coversAll && score > best.score)) best = { ax, bx, ay, by, score, coversAll };
			}
		const cellsX = best.bx - best.ax + 1, cellsY = best.by - best.ay + 1;
		const originCX = camCX + best.ax, originCY = camCY + best.ay;
		// 割当は useful を2の冪へ量子化＝ズーム微動で atlasKey が揺れて再構築が頻発しない（1オクターブ1回）。
		// 実確保も edgeBudget（lowMem=2048）に従う：従来ここだけ 4096 直書きで「lowMem はアトラス総辺半分」が
		// スコア計算にしか効いていなかった（far/R10 窓が 3GB 機でも最大 33.5MB 確保）＝意図どおり面積1/4へ。
		const usefulQ = Math.pow(2, Math.ceil(Math.log2(Math.max(1, useful))));
		const allocRes = Math.max(512, Math.min(srcMax, usefulQ, Math.max(512, Math.floor(edgeBudget / Math.max(cellsX, cellsY)))));
		// 窓の中でも票ゼロのセル（対角ビューの角など画面に映らないセル）はフェッチしない＝必要なタイルだけ払う。
		const wanted = new Set();
		for (const [k, v] of votes) {
			const [dx, dy] = k.split(",").map(Number);
			if (v > 0 && dx >= best.ax && dx <= best.bx && dy >= best.ay && dy <= best.by) wanted.add((dx - best.ax) + "," + (dy - best.ay));
		}
		return { range, originCX, originCY, cellsX, cellsY, cellRes: allocRes, wanted };
	}
	// 検札（カメラ静止でも自己修復）：wanted なのに書き込めなかったセル（fetch失敗・worker詰まり・部分commit）を
	// 未読込へ戻して ensure を掛け直す。従来は「次の窓替え／カメラ移動」まで平らなセルが直らず、静止して
	// 眺めている限りリロードしか回復手段が無かった（実測: チルトで標高抜けの帯が残る）。
	function scheduleAudit() {
		clearTimeout(auditT);
		auditT = setTimeout(() => {
			if (staging || pendingElev > 0) return scheduleAudit();   // 取り込み中＝結果が出てから検札（tryは消費しない）
			const missing = [...loadedCells].filter(ck => !ck.endsWith("hi") && !writtenCells.has(ck));
			const missingFar = [...farLoaded].filter(ck => !farWritten.has(ck));   // 遠景層も同じ検札（失敗セル＝遠方が平らなまま静止、を自己修復）
			if (!missing.length && !missingFar.length) { auditTries = 0; return; }
			if (auditTries >= 5) return;   // データが本当に無いセル（ALOS未整備の海等）は諦める＝リフェッチのスパムをしない
			auditTries++;
			console.warn("[terrain] 検札: 未書込セルを再取得", [...missing, ...missingFar.map(k => "F" + k)].join(" "), `(${auditTries}/5)`);
			for (const ck of missing) loadedCells.delete(ck);
			for (const ck of missingFar) farLoaded.delete(ck);
			if (lastEnsureCam) ensure(lastEnsureCam, lastEnsureSize);
		}, 1000);
	}
	function ensure(cam, size) {   // 戻り値 false＝ローダ未準備で何もしていない（呼び出し側はスロットル記憶を消して再試行すること）
		if (!loadTile) {
			// 沈黙禁止：ローダ未成立のまま地形が要求されている＝状態をトーストへ（stat 付き onPending）。
			// 旧・黙って false は「山が平ら・トーストも出ない・理由は誰にも見えない」を生んだ（借り物iPhone13実症状）。
			onPending && onPending(1, 0, loaderStat ?? "初期化中…");
			return false;
		}
		// 検札の再実行用に最後の視点を控える（cam はアプリ側で毎フレーム書き換わる共有オブジェクト＝必ずコピー）
		lastEnsureCam = { center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, dpr: cam.dpr, fovy: cam.fovy };
		lastEnsureSize = { w: size.w, h: size.h };
		// 混成モード（高チルト×中ズーム）：1°グリッドで近傍3×3=R01（富士の近景ディテール）、
		// 遠方セル=R10切り出し（地平線までのカバー）。単一アトラス＝レンダラ側は無変更。
		// 旧・低メモリ端末は混成OFF＝全面R10だった：R01近傍9枚（1°タイル=数十MB級デコード）＋R32Fアトラス二重化の
		// +1GBスパイクが富士3Dで iOSタブ予算(~1.4GB)を突破していた（80170b8）。→ アトラスR16F化（2B/texel＝半減）＋
		// iOS 4GB実機で peak 84MB・完走を実測して安全確認＝lowMemでも既定ON（全端末で近景R01）。
		// 逃げ道＝?nor01=1（過渡デコードで落ちる端末が出たら無効化＝全面R10へ）。
		const mixed = !noMixed && (cam.pitch || 0) > 0.9 && cam.zoom >= 11.5 && cam.zoom < 14;
		const range = mixed ? 1 : selectRange(cam);
		const r = viewCellRange(cam, size, range, mixed);
		const key = [mixed ? "M" : range, r.originCX, r.originCY, r.cellsX, r.cellsY, r.cellRes].join(",");
		if (key !== atlasKey) {
			atlasKey = key; loadedCells = new Set(); cellFails = new Map(); writtenCells = new Set(); auditTries = 0;
			// 2枚目以降はダブルバッファ：舞台裏(stage)で構築し、初回分のセルが揃ったら一括スワップ。
			// 直接張り替えるとゼロ初期化の瞬間に山影が全画面で消える（ズーム静止・R01/R10切替のたびに発症していた）。
			staging = hasAtlas; stagePending = new Set();
			// edgeFade＝窓の縁で標高を滑らかに0へ落とす幅(deg)。R90全球窓は縁が極/±180のみ＝無効(0)。
			// R10/R01窓は「窓の外＝標高0」との崖と陰影の切れ目（地球の淵の標高抜け）をこの幅で馴染ませる。
			// 窓選定（票×√解像度・掠りは制約外）はそのまま＝中心の解像度は犠牲にしない、見た目だけの解。
			const edgeFade = EDGE_FADE(range);
			// liftBounds＝「DTM(裸地=DEM10B)が保証される経緯度域」。PLATEAU 接地リフトはこの中でだけ有効：
			// R10/R90=ALOS(DSM=ビル天端込み)でリフトすると屋根が斜面に裂ける（東新橋/汐留 z<13 高チルトで実測）。
			// 純R01窓=全域 / 混成窓=近傍3×3（nearCam=camセル±1）のみ / R10・R90窓=なし(null)。
			// ※混成の近傍セルは R01 到着までの数秒だけ R10 切り出しが入る＝過渡の歪みは許容（すぐ直る）。
			const c1x = Math.floor(cam.center[0]), c1y = Math.floor(cam.center[1]);
			const liftBounds = mixed ? [c1x - 1, c1y - 1, 3, 3]
				: range === 1 ? [r.originCX, r.originCY, r.cellsX, r.cellsY] : null;
			// gMax＝地形メッシュ格子の上限（renderer が窓形状から G を決める時の天井）。lowMem=1024 で
			// 頂点+index を 75MB→33.5MB（-42MB）。メッシュは GPU 固定常駐の最大項＝3GB 機の一番効く一枠。
			// 見た目の代償＝quad が 1.5 倍粗くなるが、スマホ/タブレットの画面密度では絵の破綻はない側。
			renderer.set(staging ? "elevAtlasStage" : "elevAtlas",
				{ originLng: r.originCX * range, originLat: r.originCY * range, cellsX: r.cellsX, cellsY: r.cellsY, cellRes: r.cellRes, cellSpan: range, exag, edgeFade, liftBounds, gMax: lowMem ? 1024 : 1536 }, exag / earthM);
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
			// 票ゼロ（画面に映らない）セルは取りに行かない。ただし「読込済み」には記録しない：wanted は
			// ensure のたびに現視点の票で作り直されるので、同じ窓のままパン/回転で映り込めば次の ensure で
			// 普通にフェッチされる。ここで loadedCells に入れると「窓は生きている・セルは未読込・二度と
			// 取りに行かない」が成立し、回転後に標高が平らな帯として残る（実測: z7/チルト46°/回転-25°）。
			if (r.wanted && !r.wanted.has(ck)) continue;
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
						writtenCells.add(ck);
					}
					if (!parent && atlasKey === key) {   // 親R10失敗も未読込へ戻す（非mixed経路と同じ再挑戦則）
						const n = (cellFails.get(ck) || 0) + 1; cellFails.set(ck, n);
						if (n <= 3) loadedCells.delete(ck);
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
							writtenCells.add(ck);
							renderer.set(cellSlot(), downsampleFlipped(tile, r.cellRes), { cx, cy, cellRes: r.cellRes }); requestDraw();
						}
					});
				}
			} else {
				getCell(cellLng, cellLat, range).then(tile => {
					pendingElev--; notifyPending(range);
					if (tile && atlasKey === key) { renderer.set(cellSlot(), downsampleFlipped(tile, r.cellRes), { cx, cy, cellRes: r.cellRes }); writtenCells.add(ck); }
					// 取得失敗は「未読込」へ戻す（上限3回）＝次の ensure（カメラが動けば必ず来る）で再挑戦。
					// 従来は窓替えまで平らなセルが直らなかった。上限は恒久欠損セル（データ無し域）への
					// 毎移動リフェッチのスパム防止。
					if (!tile && atlasKey === key) {
						const n = (cellFails.get(ck) || 0) + 1; cellFails.set(ck, n);
						if (n <= 3) loadedCells.delete(ck);
					}
					if (atlasKey === key) doneOne(ck);
					requestDraw();
				});
			}
		}
		// ── 遠景層（far）＝第2アトラス。二形態（elev()は近窓外→far参照＝カバーの床）──────
		//   A) 深ズーム（近窓がR01級×チルト>0.9）＝R10視界窓（従来）：真俯瞰は近窓(4°)が視界を覆う＝
		//      遠層は見えないのに 10-16MB のアトラスと遠景メッシュ2度描きを払わない。
		//   B) 世界帯（近窓がR10・z<8）＝R90全球固定窓(4×2)：R10窓はcap=8(80°角)＝広域・高緯度・回転で
		//      視界を覆い切れず、窓外の陸が標高0＝ハイプソが海色に落ちて国境だけ海に浮く
		//      （ウクライナ #5.71/48/29/-17r 実測 9/2＝R90/R10境界を5.5へ下げて顕在化。旧6.5の隠れた
		//      安全根拠がこれ＝R90全球固定窓はカバー欠けの原理が無い）。R90をfarの床に敷けば根治。
		//      R90一式はworld下地用に先読み/IDB常備＝追加はGPU 16MB(lowMem 4MB)のみ。z≥8は近窓80°で十分。
		const farSpan = noFar ? 0 : range === 1 && (cam.pitch || 0) > 0.9 ? 10 : range === 10 && cam.zoom < 8 ? 90 : 0;
		if (farSpan) {
			const fr = farSpan === 90
				? { originCX: -2, originCY: -1, cellsX: 4, cellsY: 2, cellRes: lowMem ? 512 : 1024, wanted: null }
				: viewCellRange(cam, size, 10, false);
			// 低メモリ端末＝R10遠層は 256/セル（926m/texel）へクランプ：遠層の仕事はフォグ越しの山のシルエット＝
			// 精細は近窓の領分。8セル窓は 512 下限で edgeBudget が効かないため、ここで直接絞る
			//（例 8×4 窓 16.8MB→4.2MB。3GB 機の飛行中 jetsam 対策の一部）。
			if (farSpan === 10 && lowMem) fr.cellRes = Math.min(fr.cellRes, 256);
			const fkey = ["F", farSpan, fr.originCX, fr.originCY, fr.cellsX, fr.cellsY, fr.cellRes].join(",");
			if (fkey !== farKey) {
				farKey = fkey; farLoaded = new Set(); farWritten = new Set(); farFails = new Map();
				// ダブルバッファ無し（近窓の staging と違い）：R10/R90 は LRU・IDB に居ることが多く、
				// ゼロ初期化→同フレーム内のキャッシュヒット書込で埋まる。コールドはセル到着順にせり上がる（許容）。
				renderer.set("elevAtlasFar", { originLng: fr.originCX * farSpan, originLat: fr.originCY * farSpan, cellsX: fr.cellsX, cellsY: fr.cellsY, cellRes: fr.cellRes, cellSpan: farSpan, edgeFade: EDGE_FADE(farSpan) });
				requestDraw();
			}
			for (let cy = 0; cy < fr.cellsY; cy++) for (let cx = 0; cx < fr.cellsX; cx++) {
				const ck = cx + "," + cy;
				if (farLoaded.has(ck)) continue;
				if (fr.wanted && !fr.wanted.has(ck)) continue;   // 票ゼロ（画面に映らない）セルは取りに行かない（近窓と同じ規約＝映り込めば次の ensure で拾う）
				farLoaded.add(ck);
				const cellLng = (fr.originCX + cx) * farSpan, cellLat = (fr.originCY + cy) * farSpan;
				pendingElev++; notifyPending(farSpan);
				getCell(cellLng, cellLat, farSpan).then(tile => {
					pendingElev--; notifyPending(farSpan);
					if (tile && farKey === fkey) { renderer.set("elevCellFar", downsampleFlipped(tile, fr.cellRes), { cx, cy, cellRes: fr.cellRes }); farWritten.add(ck); }
					if (!tile && farKey === fkey) {   // 取得失敗は未読込へ戻す（上限3回）＝近窓と同じ再挑戦則
						const n = (farFails.get(ck) || 0) + 1; farFails.set(ck, n);
						if (n <= 3) farLoaded.delete(ck);
					}
					requestDraw();
				});
			}
		} else if (farKey) {   // 深ズーム離脱／真俯瞰・世界帯離脱へ＝遠層を畳んで GPU メモリを返す
			farKey = ""; farLoaded = new Set(); farWritten = new Set(); farFails = new Map();
			renderer.set("elevAtlasFarOff");
			requestDraw();
		}
		scheduleAudit();   // 取り込みの顛末を後から突合＝失敗セルを静止中でも埋め直す（リロード不要の自己修復）
		return true;
	}
	// prefetch＝視野に関係なくセルをRAM/IDBへ温める（例: 全球R90の先読み＝地球ぐるぐるが最初から途切れない）
	// debug()＝内部状態の覗き穴（__terr()＝dev実地の遠隔診断用 2026-09-02。雫形残留の追跡で必要になった）
	const debug = () => ({
		gen: "far2-20260902c", loader: loadTile ? "ready" : loaderStat,
		atlasKey, staging, stagePending: stagePending.size, pendingElev,
		loaded: loadedCells.size, written: writtenCells.size, fails: [...cellFails.entries()],
		farKey, farLoaded: farLoaded.size, farWritten: farWritten.size, farFails: [...farFails.entries()],
		lru: r10Tiles.size, bytes: tileBytes,
		lastCam: lastEnsureCam ? { z: +lastEnsureCam.zoom.toFixed(2), c: [+lastEnsureCam.center[0].toFixed(2), +lastEnsureCam.center[1].toFixed(2)], p: +(lastEnsureCam.pitch || 0).toFixed(2) } : null,
		lastSize: lastEnsureSize });
	return { ensure, sampleElev, prefetch: getCell, bytes: () => tileBytes, debug };   // bytes: 標高LRU の常駐実バイト（?mem=1 HUD が render worker 経由で吸い上げる）
}
