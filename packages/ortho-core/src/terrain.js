// 標高アトラス（altpbf 多解像度）：ズームで R90/R10/R01 を選び、視野を覆うセル群を1枚のアトラスへ。
// R01(1°・秒単位)まで寄れるので城下の地形が正確＝建物が実地形に接地する。
// DOM に触れない純ロジック＝ render worker（OffscreenCanvas側）からそのまま使える。読込インジケータは
// onPending コールバックで外へ通知し、DOM を持つ側（main）が表示する。
import { unproject, cameraState, lonlatTo3D } from "./camera.js";
import { downsampleFlipped } from "./elevation.js";
import { createTileLoader } from "altpbf";

export function createTerrain({ renderer, requestDraw, exag, earthM, apiUrl, onPending }) {
	let atlasKey = "", loadedCells = new Set();
	let cellFails = new Map();   // ck → 取得失敗回数（窓の世代ごとにリセット。上限内は次の ensure で再挑戦）
	let writtenCells = new Set();   // 実際にアトラスへ書き込めたセル（検札の突合対象。世代ごとにリセット）
	let lastEnsureCam = null, lastEnsureSize = null, auditT = 0, auditTries = 0;   // 検札＝静止中の自己修復用
	let hasAtlas = false, staging = false, stagePending = new Set();   // ダブルバッファ状態（山影がパッと消えるのを防ぐ）
	// "range,cx,cy" → 解決した生タイル（アトラスセル切り出し＋ラベル標高のCPUサンプル用）。
	// 【LRUバイト予算】デコード済み標高タイルは R01(DEM10B)=1°で数十MB級。無制限だと混成窓(8×8セル)の
	// settle 毎取得×地域移動で renderer プロセスが単調成長する（z9チルト75の zoom往復で 0.9→2.2GB/20秒、
	// 実機では 13GB 到達を実測＝「drawn のたびにメモリ爆発」の正体）。ヒットで末尾へ回す挿入順 LRU。
	const r10Tiles = new Map();
	const TILE_CACHE_BYTES = 256 << 20;   // 常駐上限 256MB＝現窓の R01 一式＋R10/R90 が収まる（IDB があるので再取得は安い）
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
		// 経度は周期正規化：日付変更線を跨いだ窓のセルは cellLng が 180 や -270 になり、そのまま
		// タイル名にすると実在しない（E180等）＝空振りで陰影が欠けていた（実測: lat70の北極海チルト）。
		const lngN = ((cellLng % 360) + 540) % 360 - 180;
		const k = range + "," + lngN + "," + cellLat;
		const hit = r10Tiles.get(k);
		if (hit) { r10Tiles.delete(k); r10Tiles.set(k, hit); return hit; }   // ヒット＝LRU 末尾へ（追い出され順の更新）
		// 失敗は null に畳む＝getCell は絶対に reject しない（呼び出し側の pending デクリメントが
		// .then 購読のみのため、reject が漏れると読込インジケータが永久に残る）
		const tile = await loadTile(lngN, cellLat, range).catch(e => { console.warn("[terrain] セル取得失敗", k, e); return null; });
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
			// 全球〜大陸ビュー（z<5.5）は窓を固定＝世界8セル（4×2）常駐。窓をカメラに追従させると
			// versor回転のたびに atlasKey が変わり再構築→縁のセルが見え隠れ（没入感を壊す）。
			// R90一式は先読み/IDB常備＝8セル固定のコストは初回のみ。4×2@1024=4096×2048で予算内。
			// cellRes だけはズームの1オクターブ毎に追従（回転・パンではkey不変）。
			const radPerDevPx = 2 * Math.PI / (Math.pow(2, cam.zoom) * 512 * (cam.dpr || 1));
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
	// 検札（カメラ静止でも自己修復）：wanted なのに書き込めなかったセル（fetch失敗・worker詰まり・部分commit）を
	// 未読込へ戻して ensure を掛け直す。従来は「次の窓替え／カメラ移動」まで平らなセルが直らず、静止して
	// 眺めている限りリロードしか回復手段が無かった（実測: チルトで標高抜けの帯が残る）。
	function scheduleAudit() {
		clearTimeout(auditT);
		auditT = setTimeout(() => {
			if (staging || pendingElev > 0) return scheduleAudit();   // 取り込み中＝結果が出てから検札（tryは消費しない）
			const missing = [...loadedCells].filter(ck => !ck.endsWith("hi") && !writtenCells.has(ck));
			if (!missing.length) { auditTries = 0; return; }
			if (auditTries >= 5) return;   // データが本当に無いセル（ALOS未整備の海等）は諦める＝リフェッチのスパムをしない
			auditTries++;
			console.warn("[terrain] 検札: 未書込セルを再取得", missing.join(" "), `(${auditTries}/5)`);
			for (const ck of missing) loadedCells.delete(ck);
			if (lastEnsureCam) ensure(lastEnsureCam, lastEnsureSize);
		}, 1000);
	}
	function ensure(cam, size) {   // 戻り値 false＝ローダ未準備で何もしていない（呼び出し側はスロットル記憶を消して再試行すること）
		if (!loadTile) return false;
		// 検札の再実行用に最後の視点を控える（cam はアプリ側で毎フレーム書き換わる共有オブジェクト＝必ずコピー）
		lastEnsureCam = { center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, dpr: cam.dpr, fovy: cam.fovy };
		lastEnsureSize = { w: size.w, h: size.h };
		// 混成モード（高チルト×中ズーム）：1°グリッドで近傍3×3=R01（富士の近景ディテール）、
		// 遠方セル=R10切り出し（地平線までのカバー）。単一アトラス＝レンダラ側は無変更。
		const mixed = (cam.pitch || 0) > 0.9 && cam.zoom >= 10.5 && cam.zoom < 13;
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
			const edgeFade = range === 90 ? 0 : range === 10 ? 1.5 : 0.4;
			renderer.set(staging ? "elevAtlasStage" : "elevAtlas",
				{ originLng: r.originCX * range, originLat: r.originCY * range, cellsX: r.cellsX, cellsY: r.cellsY, cellRes: r.cellRes, cellSpan: range, exag, edgeFade }, exag / earthM);
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
		scheduleAudit();   // 取り込みの顛末を後から突合＝失敗セルを静止中でも埋め直す（リロード不要の自己修復）
		return true;
	}
	// prefetch＝視野に関係なくセルをRAM/IDBへ温める（例: 全球R90の先読み＝地球ぐるぐるが最初から途切れない）
	return { ensure, sampleElev, prefetch: getCell };
}
