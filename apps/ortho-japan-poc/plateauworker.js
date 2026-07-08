// PLATEAU LOD2 建物メッシュのロード/デコードをメインスレッドから追い出す worker。
// tileset→葉タイル収集→b3dm/Draco解凍→ECEF→ortho単位球変換→重複面dedup→RTE delta+被覆マスク、まで全部ここで行い、
// 結果の typed array だけ transfer で main へ返す（重いJSループはメインスレッドに一切乗らない＝UIをブロックしない）。
// main.js 側は複数のこの worker をプールし、base URL のハッシュで固定ルーティング（同じ地区は常に同じ worker＝内部cacheが効く）。
import { parse as loadParse } from "@loaders.gl/core";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";

const EARTH_M = 6371000;   // main.js の EARTH_M と同値（建物の接地計算に使う単位球換算）
const TILE_CONCURRENCY = 8;   // 1地区あたりのタイル並行fetch/デコード数。直列だと500枚超で往復レイテンシが積み上がり支配的になる。

// content.uri は絶対URL（別ホストへの委譲）と相対（同ディレクトリ）の両方があり得る。
const resolveUrl = (base, uri) => /^https?:\/\//.test(uri) ? uri : base + uri;

// ECEF(WGS84)→geodetic(lon,lat[rad],h[m])。
// 球面近似(geocentric lat=atan2(z,p))も試したが、緯度が最大0.2°程度ズレて建物群が基図から丸ごと外れる
// （実測で本来位置より南へ約20km）ため不採用＝地表座標そのものは楕円体で正確に解かないといけない。
// 反復はNewton法。地表近傍(h<数km)では2回で高さ誤差0.2mm未満に収束する（1回だと0.1m級誤差が残りdedupの
// 丸め精度(0.1m)と衝突しうるため2回が下限）。5回反復していた旧実装は収束後も回し続けていた分を削っただけ。
function ecef2geo(x, y, z) {
	const a = 6378137, e2 = 0.00669437999014;
	const p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 2; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}

// tileset.json を辿って葉（=それ以上 children を持たないタイル）の content.uri を集める。
// 葉の content.uri 自体が別の tileset.json（外部委譲）のことがある地区があるため、拡張子で判定して再帰的に潜る。
async function collectLeafTiles(tilesetUrl, depth = 0) {
	const ts = await (await fetch(tilesetUrl)).json();
	const tsBase = tilesetUrl.slice(0, tilesetUrl.lastIndexOf("/") + 1);
	const out = [];
	async function walk(t) {
		if (!t) return;
		const ch = t.children || [];
		if (ch.length) { for (const c of ch) await walk(c); return; }
		const uri = t.content?.uri;
		if (!uri) return;
		const abs = resolveUrl(tsBase, uri);
		if (abs.endsWith(".json") && depth < 4) out.push(...await collectLeafTiles(abs, depth + 1));
		else out.push(abs);
	}
	await walk(ts.root);
	return out;
}

const cache = new Map();   // base URL → デコード済みメッシュ（このworker内のみ有効。再訪はfetch/Draco解凍を丸ごと省略）

// 三角形の頂点3つ組キー：文字列連結+配列sort+joinは1.5M三角形規模だとGC負荷が支配的になるため、
// 丸めた座標をBigIntへビット結合（各成分32bit範囲に収まる＝衝突なし）。巻き順に依存しないよう3値を数値比較でソート。
function vkeyBig(geo, i) {
	const rx = BigInt(Math.round(geo[i*3] * 1e8) >>> 0);
	const ry = BigInt(Math.round(geo[i*3+1] * 1e8) >>> 0);
	const rz = BigInt(Math.round(geo[i*3+2] * 10) >>> 0);
	return (rx << 64n) | (ry << 32n) | rz;
}
function triKey(k0, k1, k2) {
	if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
	if (k1 > k2) { const t = k1; k1 = k2; k2 = t; }
	if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
	return (k0 << 192n) | (k1 << 96n) | k2;
}

// ロード本体：tileset → 葉タイル → デコード → RTE delta + 被覆マスク。renderer には触らない（呼び出し側=mainがpostMessageで受ける）。
async function loadPlateau(base, tiles) {
	if (cache.has(base)) { console.log("[plateau] キャッシュ命中（fetch/解凍スキップ）", base); return cache.get(base); }
	if (!tiles) {
		// REPLACE refine：親(粗)と子(詳細)が同じ場所を覆う→両方読むと重なって z-fight(マダラ)。
		// 子を持たない「葉」タイルだけ読む＝最詳細 LOD2 が重なりなしで並ぶ。
		tiles = await collectLeafTiles(base + "tileset.json");
		console.log("[plateau] 葉タイル:", tiles.length, "枚");
	}
	console.log("[plateau] 読込", tiles.length, "tiles ←", base);
	const geo = [], outNrm = [], outIdx = []; let vbase = 0, minH = Infinity;
	function mergeTile(tile) {
		const rtc = tile.rtcCenter || tile.gltf?.extensions?.CESIUM_RTC?.center || [0, 0, 0];
		for (const m of (tile.gltf?.meshes || [])) for (const pr of (m.primitives || [])) {
			const P = pr.attributes?.POSITION?.value; if (!P) continue;
			const NRM = pr.attributes?.NORMAL?.value;
			const I = pr.indices?.value, n = P.length / 3, off = vbase;
			for (let i = 0; i < n; i++) {
				// local(Y-up)→ECEF：Yup→Zup(x,-z,y)＋RTC → geodetic(lon,lat,h) を一旦保持
				const ex = P[i*3] + rtc[0], ey = -P[i*3+2] + rtc[1], ez = P[i*3+1] + rtc[2];
				const g = ecef2geo(ex, ey, ez);
				if (g[2] < minH) minH = g[2];
				geo.push(g[0], g[1], g[2]);
				// 法線：glTF(Y-up local)→ortho は方向を (nx, ny, -nz)（Yup→Zup＋ECEF→ortho軸swap の合成）。符号は FS で視線側へ。
				if (NRM) outNrm.push(NRM[i*3], NRM[i*3+1], -NRM[i*3+2]); else outNrm.push(0, 1, 0);
			}
			if (I) for (let k = 0; k < I.length; k++) outIdx.push(I[k] + off);
			else for (let k = 0; k < n; k++) outIdx.push(off + k);
			vbase += n;
		}
	}
	// タイル取得+デコードを並行プールで回す（直列fetchは1枚ごとの往復レイテンシが数百枚積み上がり支配的になる）。
	// mergeTile 自体は同期処理＝JSはシングルスレッドなので複数タイルが並行fetch中でも競合しない。
	let ti = 0;
	async function tileWorker() {
		while (ti < tiles.length) {
			const t = tiles[ti++];
			try {
				const ab = await (await fetch(resolveUrl(base, t))).arrayBuffer();
				const tile = await loadParse(ab, Tiles3DLoader, { "3d-tiles": { loadGLTF: true } });
				mergeTile(tile);
			} catch (e) { console.warn("[plateau] tile 失敗", t, e.message); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, tileWorker));
	if (!outIdx.length) { console.error("[plateau] メッシュ0＝デコード/変換失敗"); return null; }
	// 重複三角形（double-sided/coincident 面）除去＝マダラ(z-fight)の元を断つ。頂点位置(丸め)の3つ組で判定＝巻き順・頂点共有に非依存。
	const seen = new Set(), dedupIdx = [];
	for (let k = 0; k < outIdx.length; k += 3) {
		const a = outIdx[k], b = outIdx[k+1], c = outIdx[k+2];
		const key = triKey(vkeyBig(geo, a), vkeyBig(geo, b), vkeyBig(geo, c));
		if (seen.has(key)) continue;
		seen.add(key); dedupIdx.push(a, b, c);
	}
	console.log("[plateau] dedup 面: %d → %d", outIdx.length/3, dedupIdx.length/3);
	outIdx.length = 0; for (const v of dedupIdx) outIdx.push(v);
	// bbox(deg)：基図建物マスクの範囲＋足元グリッドの範囲に使う。geo は rad なので deg へ。
	const M = geo.length / 3;
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
	for (let i = 0; i < M; i++) { const lo = geo[i*3], la = geo[i*3+1]; if (lo<minLon) minLon=lo; if (lo>maxLon) maxLon=lo; if (la<minLat) minLat=la; if (la>maxLat) maxLat=la; }
	const R2D = 180 / Math.PI, bbox = [minLon*R2D, minLat*R2D, maxLon*R2D, maxLat*R2D];
	// 足元の浮き対策：global minH で一律に持ち上げると ward の起伏で高地の建物が浮く／低い外れ頂点1つで全体が浮く。
	// 局所地面グリッド（セル毎の最低標高）を足元にして各頂点を置く＝建物ごとに接地。ground[cell]≤h なので radius≥1、基礎頂点は radius1。
	const GN = 256, ground = new Float32Array(GN*GN).fill(Infinity);
	const gLo = (maxLon-minLon)||1e-12, gLa = (maxLat-minLat)||1e-12;
	const cellOf = i => { let gx=(geo[i*3]-minLon)/gLo*GN|0, gy=(geo[i*3+1]-minLat)/gLa*GN|0; if(gx<0)gx=0;else if(gx>GN-1)gx=GN-1; if(gy<0)gy=0;else if(gy>GN-1)gy=GN-1; return gy*GN+gx; };
	for (let i = 0; i < M; i++) { const c = cellOf(i), h = geo[i*3+2]; if (h < ground[c]) ground[c] = h; }
	// RTE-lite：単位球の絶対座標は float32 だと建物1棟が~60段階に量子化される（半径6.37e6 vs 建物50m=8e-6、刻み~1.2e-7）
	// → 面が重なり z-fight＝淵マダラ／カメラで丸めが動き座標ちらつき。重心(origin)相対の delta を渡し精度を桁で戻す（本家Cesium と同じRTE）。
	const wpos = new Float64Array(geo.length);            // 単位球 絶対座標（float64 で正確に保持）
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < M; i++) {
		const lon = geo[i*3], lat = geo[i*3+1], cb = Math.cos(lat), r = 1 + (geo[i*3+2] - ground[cellOf(i)]) / EARTH_M;   // 局所足元からの高さ＝接地
		const x = cb*Math.cos(lon)*r, y = Math.sin(lat)*r, z = cb*Math.sin(lon)*r;
		wpos[i*3] = x; wpos[i*3+1] = y; wpos[i*3+2] = z; ox += x; oy += y; oz += z;
	}
	const origin = [ox / M, oy / M, oz / M];              // メッシュ重心＝画面上の錨（粗くて可、細部は delta が担う）
	const outPos = new Float32Array(geo.length);          // 重心相対 delta（float32 でフル精度）
	for (let i = 0; i < M; i++) {
		outPos[i*3] = wpos[i*3] - origin[0]; outPos[i*3+1] = wpos[i*3+1] - origin[1]; outPos[i*3+2] = wpos[i*3+2] - origin[2];
	}
	// 被覆マスク：bbox を N×N セルに割り、三角形が触れたセルを立てる。基図建物はこのマスクが立つ所（＝実フットプリント）
	// だけ伏せる＝矩形一枚(bbox)だと区の非矩形部や街区・公園まで伏せて空白地帯が出る問題を、セル単位で解消。
	const MASK_N = 256, mask = new Uint8Array(MASK_N * MASK_N);
	const spanLo = (maxLon - minLon) || 1e-12, spanLa = (maxLat - minLat) || 1e-12;
	for (let t = 0; t < outIdx.length; t += 3) {
		const a = outIdx[t], b = outIdx[t+1], c = outIdx[t+2];
		const lo0 = geo[a*3], lo1 = geo[b*3], lo2 = geo[c*3], la0 = geo[a*3+1], la1 = geo[b*3+1], la2 = geo[c*3+1];
		let cx0 = (Math.min(lo0,lo1,lo2) - minLon) / spanLo * MASK_N | 0, cx1 = (Math.max(lo0,lo1,lo2) - minLon) / spanLo * MASK_N | 0;
		let cy0 = (Math.min(la0,la1,la2) - minLat) / spanLa * MASK_N | 0, cy1 = (Math.max(la0,la1,la2) - minLat) / spanLa * MASK_N | 0;
		if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N-1) cx1 = MASK_N-1; if (cy1 > MASK_N-1) cy1 = MASK_N-1;
		for (let y = cy0; y <= cy1; y++) { const row = y*MASK_N; for (let x = cx0; x <= cx1; x++) mask[row+x] = 255; }
	}
	let cov = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) cov++;
	console.log("[plateau] verts=%d tris=%d minH=%sm origin=[%s] bbox=[%s] mask=%d/%d", M, outIdx.length/3, minH.toFixed(1), origin.map(v=>v.toFixed(4)).join(","), bbox.map(v=>v.toFixed(4)).join(","), cov, MASK_N*MASK_N);
	const meshData = { pos: outPos, nrm: new Float32Array(outNrm), idx: new Uint32Array(outIdx), origin, bbox, mask, maskN: MASK_N };
	cache.set(base, meshData);   // デコード結果をこのworker内に保持＝再訪でfetch/Draco解凍を丸ごと省略
	console.log("[plateau] 完了", base);
	return meshData;
}

self.onmessage = async (e) => {
	const { id, base, tiles } = e.data;
	try {
		const cached = await loadPlateau(base, tiles);
		if (!cached) { self.postMessage({ id, ok: false }); return; }   // 0三角形など soft failure（loadPlateau内でconsole.error済み）
		// cache に残す実体は守りたいので、transferする分だけコピー（cacheの原本は無傷のまま次回再利用できる）。
		const pos = cached.pos.slice(), nrm = cached.nrm.slice(), idx = cached.idx.slice(), mask = cached.mask.slice();
		self.postMessage(
			{ id, ok: true, meshData: { pos, nrm, idx, origin: cached.origin, bbox: cached.bbox, maskN: cached.maskN, mask } },
			[pos.buffer, nrm.buffer, idx.buffer, mask.buffer]
		);
	} catch (err) {
		self.postMessage({ id, ok: false, error: err.message });
	}
};
