// 全球ハイプソの材料＝japan と同じ出所：
//   標高＝altpbf の R90（90° セル×8＝全球・GEBCO/ALOS 系・IDB キャッシュ）＝ortho-core terrain.js の「世界帯 R90 固定窓 4×2」と同じ窓
//   気候場＝koppen-clim.png（Köppen-Geiger / Beck et al. CC BY を 720×360 へ焼き縮め・japan public と同一ファイル）
// 等経緯度 1 枚のアトラス（行0=南）へ再標本化してレンダラへ渡す。
import { createTileLoader, WORLD_ATLAS, WORLD_ATLAS_CELL, worldAtlasCell } from "@ortho-earth/core/elevation";

// ortho-core elevation.js downsampleFlipped と同規約：texel 中心標本・ALOS の最外周 2px（縁の fill 値）を読まない・異常値と負値は 0
function resampleCell(tile, N, out, W, ox, oy) {
	const { data, width: w, height: h } = tile;
	const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };
	const M = 2;
	for (let j = 0; j < N; j++) {
		const gy = Math.min(Math.max((j + 0.5) / N * (h - 1), M), h - 1 - M), y0 = Math.min(gy | 0, h - 2), fy = gy - y0;
		for (let i = 0; i < N; i++) {
			const gx = Math.min(Math.max((i + 0.5) / N * (w - 1), M), w - 1 - M), x0 = Math.min(gx | 0, w - 2), fx = gx - x0;
			const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
			const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
			out[(oy + j) * W + ox + i] = v < 0 ? 0 : v;
		}
	}
}

let loaderP = null;
const getLoader = apiUrl => (loaderP ??= createTileLoader({ apiUrl }));

// cellRes＝90° あたりの texel（1024 で 4096×2048 ≈ 9.8km/texel・R90 の実力 2700 には届かないが近景は R10 窓が受け持つ）
// 届いたセルから順に onUpdate（部分でも出す）。取れなかったセル（初回の激遅回線・worker タイムアウト）は裏で指数バックオフ再試行
//＝一度の失敗で世界が平らなまま固まらない（japan terrain.js「一発死の禁止」と同じ流儀）。
export async function loadWorldElevation({ apiUrl, cellRes = 1024, onUpdate } = {}) {
	const loadTile = await getLoader(apiUrl);
	const N = cellRes, W = 4 * N, H = 2 * N, out = new Float32Array(W * H);
	const atlas = { data: out, width: W, height: H };
	// 本線＝焼き済みの全球アトラス 1 本（uploader「world hypso atlas」・bucket GIS/alt・3.25MB・復号 1 回）。
	// 無い/壊れている/セル寸法が割り切れない時だけ下の 8 枚経路（55MB・復号 8 回）へ退避＝出力は同じ物（Int16 丸め ±0.5m）。
	const baked = await loadTile.byName(WORLD_ATLAS).catch(() => null);
	if (baked?.data && baked.width === 4 * WORLD_ATLAS_CELL && baked.height === 2 * WORLD_ATLAS_CELL && WORLD_ATLAS_CELL % N === 0) {
		for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 4; cx++) worldAtlasCell(baked, cx, cy, N, out, W, cx * N, cy * N);
		onUpdate?.(atlas);
		return atlas;
	}
	console.warn(`[hypso] ${WORLD_ATLAS} unavailable -> falling back to 8×R90`);
	const cells = [];
	for (const cy of [-90, 0]) for (const cx of [-180, -90, 0, 90]) cells.push([cx, cy]);
	const fetchCell = async ([cx, cy]) => {
		const t = await loadTile(cx, cy, 90).catch(() => null);
		if (!(t?.data && t.width)) return false;
		resampleCell(t, N, out, W, (cx + 180) / 90 * N, (cy + 90) / 90 * N);
		onUpdate?.(atlas);
		return true;
	};
	const ok = await Promise.all(cells.map(fetchCell));
	const missing = cells.filter((_, i) => !ok[i]);
	if (missing.length) {
		console.warn(`[hypso] R90 cells missing: ${missing.map(c => c.join(",")).join(" ")} -> retrying in background`);
		let wait = 5000, tries = 0;
		const retry = () => setTimeout(async () => {
			for (let i = missing.length - 1; i >= 0; i--) if (await fetchCell(missing[i])) missing.splice(i, 1);
			if (missing.length && ++tries < 8) { wait = Math.min(wait * 2, 120000); retry(); }
		}, wait);
		retry();
	}
	return atlas;
}

export function loadClimate(url) {
	return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = url; });
}

// ── 近景 R10（10° セル・約 460m 格子）＝視野を覆うセルだけの窓アトラス ──
// ortho-core terrain.js の二層（近 R10 窓＋遠 R90 床）と同じ考え方。窓の外・読込前は R90 が受け持つ（シェーダで縁フェード）。
// 生タイル（2400²×int16≈11MB/枚）は窓へ再標本化したら捨てる＝常駐はセル単位の Float32（解像度つき）の LRU だけ。
export const NEAR_MIN_ZOOM = 5.5;   // これ未満は R90 だけ（japan の R90/R10 境界と同じ。5 だと 1280px 幅で 6×4 セル×11MB≈260MB を初回に落とす＝重すぎる・2026-09-18）
const CAP = 10;                   // 窓の最大セル数（片辺）
export function createNearElevation({ apiUrl, maxTex = 4096, onAtlas, onBusy }) {
	const cellCache = new Map();   // "cx,cy,res" → Float32Array(res²)（行0=南）
	const CACHE_BYTES = 192 << 20;
	let cacheBytes = 0, key = "", gen = 0, timer = 0, inflight = 0;
	const remember = (k, a) => {
		cellCache.set(k, a); cacheBytes += a.byteLength;
		for (const [ok, oa] of cellCache) { if (cacheBytes <= CACHE_BYTES || ok === k) break; cellCache.delete(ok); cacheBytes -= oa.byteLength; }
	};
	async function cell(cx, cy, res) {
		const lngN = ((cx % 360) + 540) % 360 - 180, k = `${lngN},${cy},${res}`;
		const hit = cellCache.get(k);
		if (hit) { cellCache.delete(k); cellCache.set(k, hit); return hit; }
		const loadTile = await getLoader(apiUrl);
		const t = await loadTile(lngN, cy, 10).catch(() => null);
		const out = new Float32Array(res * res);
		if (t?.data && t.width) resampleCell(t, res, out, res, 0, 0);   // 無い（海など）＝0
		remember(k, out);
		return out;
	}
	// view＝{lon,lat,zoom}・unprojectFn(sx,sy)→[lon,lat]|null・W,H＝CSS px
	function ensure(view, W, H, unprojectFn) {
		clearTimeout(timer);
		if (view.zoom < NEAR_MIN_ZOOM) { if (key) { key = ""; gen++; onAtlas(null); } return; }
		timer = setTimeout(() => build(view, W, H, unprojectFn), 180);   // 静止してから（ドラッグ中に窓を作り直さない）
	}
	async function build(view, W, H, unprojectFn) {
		const camCX = Math.floor(view.lon / 10);
		let lox = 0, hix = 0, loy = 99, hiy = -99;
		for (let j = 0; j <= 12; j++) for (let i = 0; i <= 16; i++) {
			const ll = unprojectFn(W * (i / 16 - 0.5), H * (j / 12 - 0.5)); if (!ll) continue;
			let dx = Math.floor(ll[0] / 10) - camCX; if (dx > 18) dx -= 36; else if (dx < -18) dx += 36;   // 経度は中心セルからの最短
			const cy = Math.floor(Math.min(89.999, ll[1]) / 10);
			lox = Math.min(lox, dx); hix = Math.max(hix, dx); loy = Math.min(loy, cy); hiy = Math.max(hiy, cy);
		}
		if (loy > hiy) return;
		// 大きすぎる窓は中心寄りに切り詰める（残りは R90 が受け持つ）
		while (hix - lox + 1 > CAP) { if (-lox > hix) lox++; else hix--; }
		const cy0 = Math.floor(Math.min(89.999, view.lat) / 10);
		while (hiy - loy + 1 > CAP) { if (cy0 - loy > hiy - cy0) loy++; else hiy--; }
		const nx = hix - lox + 1, ny = hiy - loy + 1;
		// 解像度：画面が使い切れる密度（2 の冪に量子化＝ズーム微動で作り直さない）・ソース 2400・テクスチャ辺の予算
		const pxPerCell = 256 * Math.pow(2, view.zoom) * Math.min(devicePixelRatio || 1, 2) / 36;
		const useful = Math.pow(2, Math.ceil(Math.log2(Math.max(64, pxPerCell))));
		const res = Math.max(128, Math.min(2048, useful, Math.floor(Math.min(4096, maxTex) / Math.max(nx, ny))));
		const x0 = (camCX + lox) * 10, y0 = loy * 10;
		const k = `${x0},${y0},${nx},${ny},${res}`;
		if (k === key) return;
		key = k; const my = ++gen;
		inflight++; onBusy?.(true);
		const W2 = nx * res, H2 = ny * res, atlas = new Float32Array(W2 * H2);
		await Promise.all(Array.from({ length: nx * ny }, async (_, n) => {
			const i = n % nx, j = (n / nx) | 0;
			const a = await cell(x0 + i * 10, y0 + j * 10, res);
			if (my !== gen) return;
			for (let r = 0; r < res; r++) atlas.set(a.subarray(r * res, (r + 1) * res), (j * res + r) * W2 + i * res);
		}));
		if (--inflight === 0) onBusy?.(false);   // 重なった作り直しは最後の 1 本が終わるまで「読込中」
		if (my !== gen) return;   // 途中で窓が替わった＝古い窓は出さない（出来上がるまで前の窓/R90 のまま）
		onAtlas({ data: atlas, width: W2, height: H2, bounds: [x0, y0, nx * 10, ny * 10] });
	}
	// stop＝静止待ちのタイマーを捨て、作りかけの窓を無効にする（部品の destroy から・2026-09-19）
	function stop() { clearTimeout(timer); gen++; }
	return { ensure, stop };
}
