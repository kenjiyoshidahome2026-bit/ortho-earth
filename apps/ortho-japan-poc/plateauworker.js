// PLATEAU LOD2 建物メッシュのロード/デコードをメインスレッドから追い出す worker。
// tileset→葉タイル収集→カメラ近傍順ソート→バッチ(64タイル)ごとに b3dm/Draco解凍→ECEF→ortho単位球変換→
// 重複面dedup→RTE delta を行い、完成したバッチから順に render worker へ直結ポートで transfer 送信＝逐次表示。
// 区全体を待たず「目の前のビルが数秒で立ち始める」。被覆マスクは区単位で累積（シェーダのマスクスロットを消費しない）。
// main.js 側は複数のこの worker をプールし、base URL のハッシュで固定ルーティング（同じ地区は常に同じ worker＝内部cacheが効く）。
import { parse as loadParse } from "@loaders.gl/core";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";
import { Cache } from "native-bucket";

const EARTH_M = 6371000;   // main.js の EARTH_M と同値（建物の接地計算に使う単位球換算）
const TILE_CONCURRENCY = 8;   // バッチ内のタイル並行fetch/デコード数。直列だと往復レイテンシが積み上がり支配的になる。
const BATCH_TILES = 64;       // 1バッチのタイル数。小さいほど初表示が速く、大きいほどdraw call/RTE origin数が減る。
const MASK_N = 256;           // 区単位の被覆マスク解像度（基図建物を伏せるセル）
const R2D = 180 / Math.PI;

// content.uri は絶対URL（別ホストへの委譲）と相対（同ディレクトリ）の両方があり得る。
const resolveUrl = (base, uri) => /^https?:\/\//.test(uri) ? uri : base + uri;

// ECEF(WGS84)→geodetic(lon,lat[rad],h[m])。
// 球面近似(geocentric lat=atan2(z,p))も試したが、緯度が最大0.2°程度ズレて建物群が基図から丸ごと外れる
// （実測で本来位置より南へ約20km）ため不採用＝地表座標そのものは楕円体で正確に解かないといけない。
// 反復はNewton法。地表近傍(h<数km)では2回で高さ誤差0.2mm未満に収束する（1回だと0.1m級誤差が残りdedupの
// 丸め精度(0.1m)と衝突しうるため2回が下限）。
function ecef2geo(x, y, z) {
	const a = 6378137, e2 = 0.00669437999014;
	const p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 2; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}

// tileset.json を辿って葉（=それ以上 children を持たないタイル）を { uri, center:[lon,lat]|null } で集める。
// center は boundingVolume.region から＝カメラ近傍優先ソートに使う（無い形式なら null＝末尾に回る）。
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
		else {
			const r = t.boundingVolume?.region;
			out.push({ uri: abs, center: r ? [(r[0] + r[2]) / 2 * R2D, (r[1] + r[3]) / 2 * R2D] : null });
		}
	}
	await walk(ts.root);
	return out;
}

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

// バッチ1個（タイル列の一部）をデコードして単一メッシュへ。旧・全区一括処理と同じパイプラインをバッチ範囲に適用：
// dedup（重複面は同一タイル内が支配的＝バッチ内で完結）・接地グリッド（バッチbbox基準＝むしろ細かく効く）・RTE origin。
// wardMask には三角形が触れた区単位セルを累積（wardBbox 座標系）。
async function decodeBatch(base, leaves, wardMask, wardBbox) {
	// 中間データは plain JS Array に push しない：バッチで1700万push級になり要素タグ+GCで数秒を失う。
	// プリミティブごとに頂点数が既知なので typed セグメントを作り、バッチ末尾で一括結合（memcpy）する。
	// geo(lon/lat rad)は float64 必須：float32 の相対精度~1e-7 は rad で~0.6m＝dedup の丸め(1e-8rad≈6cm)を壊す。
	const segs = [];   // { geo:Float64Array, nrm:Float32Array, idx:Uint32Array }（idx はバッチ通し番号で焼き込み済み）
	let totalV = 0, totalI = 0, minH = Infinity;
	function mergeTile(tile) {
		const tileRtc = tile.rtcCenter || tile.gltf?.extensions?.CESIUM_RTC?.center;
		// 新しめの地区(2025年生成・nusamai-gltf製)はCESIUM_RTC拡張を使わず、mesh参照ノードの translation/matrix に
		// 平行移動を持たせる。node.translation は頂点POSITIONと同じY-upローカル系＝頂点と同じYup→Zup軸入替(x,-z,y)を
		// 適用してから使う（生のまま使うと南半球の別地点へ飛ぶ）。mesh(オブジェクト参照)→translation のマップを1回だけ作る。
		const nodeTranslationByMesh = new Map();
		for (const nd of (tile.gltf?.nodes || [])) {
			if (!nd.mesh) continue;
			const t = nd.translation || (nd.matrix ? [nd.matrix[12], nd.matrix[13], nd.matrix[14]] : null);
			if (t) nodeTranslationByMesh.set(nd.mesh, [t[0], -t[2], t[1]]);
		}
		for (const m of (tile.gltf?.meshes || [])) {
			const rtc = tileRtc || nodeTranslationByMesh.get(m) || [0, 0, 0];
			// 保険：rtcが地表から明らかに外れていたら(=CESIUM_RTCもnode.translationも見つからなかった/壊れていた)
			// そのmeshは丸ごと捨てる。ローカル座標をECEF原点近くに置いたまま混ぜるとbbox・接地・マスクまで壊すため。
			const rtcR = Math.hypot(rtc[0], rtc[1], rtc[2]);
			if (rtcR < 6200000 || rtcR > 6500000) { console.warn("[plateau] mesh 破棄（rtc異常）", rtc); continue; }
			for (const pr of (m.primitives || [])) {
				const P = pr.attributes?.POSITION?.value; if (!P) continue;
				const NRM = pr.attributes?.NORMAL?.value;
				const I = pr.indices?.value, n = P.length / 3;
				const geoSeg = new Float64Array(n * 3), nrmSeg = new Float32Array(n * 3);
				for (let i = 0; i < n; i++) {
					// local(Y-up)→ECEF：Yup→Zup(x,-z,y)＋RTC → geodetic(lon,lat,h) を一旦保持
					const ex = P[i*3] + rtc[0], ey = -P[i*3+2] + rtc[1], ez = P[i*3+1] + rtc[2];
					const g = ecef2geo(ex, ey, ez);
					if (g[2] < minH) minH = g[2];
					geoSeg[i*3] = g[0]; geoSeg[i*3+1] = g[1]; geoSeg[i*3+2] = g[2];
					// 法線：glTF(Y-up local)→ortho は方向を (nx, ny, -nz)（Yup→Zup＋ECEF→ortho軸swap の合成）。符号は FS で視線側へ。
					if (NRM) { nrmSeg[i*3] = NRM[i*3]; nrmSeg[i*3+1] = NRM[i*3+1]; nrmSeg[i*3+2] = -NRM[i*3+2]; }
					else { nrmSeg[i*3+1] = 1; }
				}
				const idxSeg = new Uint32Array(I ? I.length : n);
				if (I) for (let k = 0; k < I.length; k++) idxSeg[k] = I[k] + totalV;
				else for (let k = 0; k < n; k++) idxSeg[k] = totalV + k;
				segs.push({ geo: geoSeg, nrm: nrmSeg, idx: idxSeg });
				totalV += n; totalI += idxSeg.length;
			}
		}
	}
	// タイル取得+デコードを並行プールで回す。mergeTile は同期＝JSシングルスレッドなので並行fetch中でも競合しない。
	let ti = 0;
	async function tileWorker() {
		while (ti < leaves.length) {
			const t = leaves[ti++];
			try {
				const ab = await (await fetch(t.uri)).arrayBuffer();
				// excludeExtensions: 属性メタデータ用拡張（未使用）＝loaders.glの特定構成でのassert回避。
				// loadImages:false: テクスチャ版しか無い区(約35)でJPEGデコードを丸ごと省く（色は使わない）。
				const tile = await loadParse(ab, Tiles3DLoader, { "3d-tiles": { loadGLTF: true }, gltf: { loadImages: false, excludeExtensions: { EXT_mesh_features: false, EXT_structural_metadata: false } } });
				mergeTile(tile);
			} catch (e) { console.warn("[plateau] tile 失敗", t.uri, e.message); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, leaves.length) }, tileWorker));
	if (!totalI) return null;
	// セグメントを一括結合（memcpy）。idx はセグメント生成時にバッチ通し番号で焼き込み済み＝コピーだけで整合。
	const geo = new Float64Array(totalV * 3), outNrm = new Float32Array(totalV * 3), rawIdx = new Uint32Array(totalI);
	{
		let vo = 0, io = 0;
		for (const s of segs) { geo.set(s.geo, vo); outNrm.set(s.nrm, vo); rawIdx.set(s.idx, io); vo += s.geo.length; io += s.idx.length; }
		segs.length = 0;
	}
	// 重複三角形（double-sided/coincident 面）除去＝マダラ(z-fight)の元を断つ。頂点位置(丸め)の3つ組で判定＝巻き順・頂点共有に非依存。
	// 重複は同一タイル内（nusamai両面出力等）が支配的＝バッチ内 dedup で実質すべて捕まる。
	const seen = new Set(), dedup = new Uint32Array(totalI);
	let di = 0;
	for (let k = 0; k < rawIdx.length; k += 3) {
		const a = rawIdx[k], b = rawIdx[k+1], c = rawIdx[k+2];
		const key = triKey(vkeyBig(geo, a), vkeyBig(geo, b), vkeyBig(geo, c));
		if (seen.has(key)) continue;
		dedup[di++] = a; dedup[di++] = b; dedup[di++] = c;
		seen.add(key);
	}
	const outIdx = dedup.slice(0, di);   // 実サイズへトリム（cacheに満杯バッファを残さない）
	// bbox(deg)：接地グリッドの範囲＋renderer側フラスタムカリングに使う。geo は rad なので deg へ。
	const M = geo.length / 3;
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
	for (let i = 0; i < M; i++) { const lo = geo[i*3], la = geo[i*3+1]; if (lo<minLon) minLon=lo; if (lo>maxLon) maxLon=lo; if (la<minLat) minLat=la; if (la>maxLat) maxLat=la; }
	const bbox = [minLon*R2D, minLat*R2D, maxLon*R2D, maxLat*R2D];
	// 足元の浮き対策v2：セル毎最低標高グリッド→空セル充填→3x3平滑→バイリニア補間の「連続な地面」から相対高さを取る。
	// セルは約32m固定（バッチbboxを等分すると~5-8mまで細かくなり、地下・基礎の窪みを鋭く拾って隣接セル間の最低値が
	// 数十m跳ぶ→セル境界を跨ぐ屋根/壁が別々の量だけ沈み細長い破片状に裂ける＝西新宿の超高層で顕在化した崩れの原因）。
	// 最近傍参照（区分一定）でなくバイリニア＝地面が連続関数になり、セル境界の段差シアーが原理的に消える。
	const midLat = (minLat + maxLat) / 2;
	const spanLonM = Math.max(1, (maxLon - minLon) * EARTH_M * Math.cos(midLat)), spanLatM = Math.max(1, (maxLat - minLat) * EARTH_M);
	const GX = Math.max(1, Math.min(256, Math.ceil(spanLonM / 32))), GY = Math.max(1, Math.min(256, Math.ceil(spanLatM / 32)));
	const ground = new Float32Array(GX * GY).fill(Infinity);
	const gLo = (maxLon - minLon) || 1e-12, gLa = (maxLat - minLat) || 1e-12;
	for (let i = 0; i < M; i++) {
		let gx = (geo[i*3] - minLon) / gLo * GX | 0, gy = (geo[i*3+1] - minLat) / gLa * GY | 0;
		if (gx < 0) gx = 0; else if (gx > GX - 1) gx = GX - 1;
		if (gy < 0) gy = 0; else if (gy > GY - 1) gy = GY - 1;
		const c = gy * GX + gx, h = geo[i*3+2];
		if (h < ground[c]) ground[c] = h;
	}
	// 空セル（頂点が1つも落ちないセル）を近傍最小で充填＝バイリニアが Infinity を拾わないように。
	for (let pass = 0; pass < GX + GY; pass++) {
		let changed = false;
		for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) {
			const c = y * GX + x;
			if (ground[c] !== Infinity) continue;
			let m = Infinity;
			if (x > 0 && ground[c-1] < m) m = ground[c-1];
			if (x < GX-1 && ground[c+1] < m) m = ground[c+1];
			if (y > 0 && ground[c-GX] < m) m = ground[c-GX];
			if (y < GY-1 && ground[c+GX] < m) m = ground[c+GX];
			if (m !== Infinity) { ground[c] = m; changed = true; }
		}
		if (!changed) break;
	}
	// 3x3 平滑（1パス）＝残る細かな段差もならす。
	const sm = new Float32Array(GX * GY);
	for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) {
		let s = 0, n = 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const xx = x + dx, yy = y + dy;
			if (xx < 0 || xx >= GX || yy < 0 || yy >= GY) continue;
			s += ground[yy * GX + xx]; n++;
		}
		sm[y * GX + x] = s / n;
	}
	// バイリニア地面サンプラ（セル中心基準・端はクランプ）。
	const groundAt = (lon, lat) => {
		let fx = (lon - minLon) / gLo * GX - 0.5, fy = (lat - minLat) / gLa * GY - 0.5;
		if (fx < 0) fx = 0; else if (fx > GX - 1) fx = GX - 1;
		if (fy < 0) fy = 0; else if (fy > GY - 1) fy = GY - 1;
		const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(x0 + 1, GX - 1), y1 = Math.min(y0 + 1, GY - 1);
		const tx = fx - x0, ty = fy - y0;
		const a = sm[y0 * GX + x0] + (sm[y0 * GX + x1] - sm[y0 * GX + x0]) * tx;
		const b = sm[y1 * GX + x0] + (sm[y1 * GX + x1] - sm[y1 * GX + x0]) * tx;
		return a + (b - a) * ty;
	};
	// RTE-lite：単位球の絶対座標は float32 だと建物1棟が~60段階に量子化される→重心(origin)相対の delta で精度を桁で戻す。
	const wpos = new Float64Array(geo.length);
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < M; i++) {
		const lon = geo[i*3], lat = geo[i*3+1], cb = Math.cos(lat);
		const r = 1 + Math.max(geo[i*3+2] - groundAt(lon, lat), 0) / EARTH_M;   // 連続地面からの相対高さ＝接地（地下はr=1に畳む＝従来通り地表より下へ出さない）
		const x = cb*Math.cos(lon)*r, y = Math.sin(lat)*r, z = cb*Math.sin(lon)*r;
		wpos[i*3] = x; wpos[i*3+1] = y; wpos[i*3+2] = z; ox += x; oy += y; oz += z;
	}
	const origin = [ox / M, oy / M, oz / M];
	const outPos = new Float32Array(geo.length);
	for (let i = 0; i < M; i++) {
		outPos[i*3] = wpos[i*3] - origin[0]; outPos[i*3+1] = wpos[i*3+1] - origin[1]; outPos[i*3+2] = wpos[i*3+2] - origin[2];
	}
	// 被覆マスク（区単位で累積）：三角形が触れた wardBbox 座標系のセルを立てる。基図建物はこのマスクが立つ所だけ伏せる。
	// バッチが進むほどマスクが育つ＝未ロード地帯は基図建物が残る＝逐次表示中も空白地帯が出ない。
	if (wardMask && wardBbox) {
		const wLo = wardBbox[0] / R2D, wLa = wardBbox[1] / R2D;   // マスク座標系は rad で統一（geo が rad のため）
		const spanLo = (wardBbox[2] - wardBbox[0]) / R2D || 1e-12, spanLa = (wardBbox[3] - wardBbox[1]) / R2D || 1e-12;
		for (let t = 0; t < outIdx.length; t += 3) {
			const a = outIdx[t], b = outIdx[t+1], c = outIdx[t+2];
			const lo0 = geo[a*3], lo1 = geo[b*3], lo2 = geo[c*3], la0 = geo[a*3+1], la1 = geo[b*3+1], la2 = geo[c*3+1];
			let cx0 = (Math.min(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0, cx1 = (Math.max(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0;
			let cy0 = (Math.min(la0,la1,la2) - wLa) / spanLa * MASK_N | 0, cy1 = (Math.max(la0,la1,la2) - wLa) / spanLa * MASK_N | 0;
			if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N-1) cx1 = MASK_N-1; if (cy1 > MASK_N-1) cy1 = MASK_N-1;
			for (let y = cy0; y <= cy1; y++) { const row = y*MASK_N; for (let x = cx0; x <= cx1; x++) wardMask[row+x] = 255; }
		}
	}
	return { pos: outPos, nrm: outNrm, idx: outIdx, origin, bbox };
}

// メッシュの出口＝render worker への直結ポート（main.js が MessageChannel で配線）。
// main へ返すのは ok/失敗の ack だけ＝~160MB の typed array がメインスレッドで構造化クローンされるのを断つ。
let meshPort = null;

// バッチ1個を render worker へ送出。cache の原本は守りたいので transfer 分はコピー。
// マスクは区単位の累積スナップショット＝renderer 側は毎回丸ごと差し替え（冪等）。
function sendBatch(ward, bi, mesh, wardMask, wardBbox) {
	const pos = mesh.pos.slice(), nrm = mesh.nrm.slice(), idx = mesh.idx.slice();
	const mask = wardMask ? wardMask.slice() : null;
	const payload = { name: `${ward}#${bi}`, meshData: { pos, nrm, idx, origin: mesh.origin, bbox: mesh.bbox, ward, mask, maskN: MASK_N, maskBbox: wardBbox } };
	const transfers = [pos.buffer, nrm.buffer, idx.buffer];
	if (mask) transfers.push(mask.buffer);
	meshPort.postMessage(payload, transfers);
}

const cache = new Map();   // base URL → { batches, mask, wardBbox }（このworker内のみ有効。再訪はfetch/Draco解凍を丸ごと省略）
const CACHE_MAX = 3;       // 1区あたり~100-160MB（typed array一式）＝無上限だと多区巡回でメモリが積み上がる。LRUで直近3区に制限

// IDB 永続キャッシュ：GPU直行形式（pos/nrm/idx＋マスク）を区単位で保存＝ページ再読込・再起動後も
// fetch/Draco解凍/座標変換を丸ごと飛ばして数秒で復元（geopbf の PBF+GINT キャッシュと同じ発想）。
// レコードはバッチ単位（`${base}#${i}` 各10〜20MB）＋メタ（`${base}#meta`）。メタが揃って初めて有効＝書き途中の中断は無視される。
// FMT_VER: デコードパイプライン（接地・dedup・軸変換等）を変えたら上げる＝古い形式のキャッシュを自然無効化。
const IDB_FMT_VER = 1;
const IDB_MAX_WARDS = 8;   // 1区~150MB → 上限~1.2GB。超過時は lastUsed 最古の区を丸ごと退避
const idbReady = Cache("GIS/plateau").catch(e => { console.warn("[plateau] IDB無効（メモリキャッシュのみで続行）", e); return null; });

async function idbLoad(base) {
	const idb = await idbReady; if (!idb) return null;
	const meta = await idb(base + "#meta").catch(() => null);
	if (!meta || meta.ver !== IDB_FMT_VER) return null;
	const batches = [];
	for (let i = 0; i < meta.count; i++) {
		const b = await idb(`${base}#${i}`).catch(() => null);
		if (!b) return null;   // 欠けあり＝無効（次回フルデコードで上書き）
		batches.push(b);
	}
	idb(base + "#meta", { ...meta, ts: Date.now() });   // LRU touch（待たない）
	return { batches, mask: meta.mask ?? null, wardBbox: meta.wardBbox ?? null };
}
async function idbStore(base, batches, mask, wardBbox) {
	const idb = await idbReady; if (!idb) return;
	try {
		for (let i = 0; i < batches.length; i++) await idb(`${base}#${i}`, batches[i]);
		await idb(base + "#meta", { ver: IDB_FMT_VER, count: batches.length, mask, wardBbox, ts: Date.now() });
		// 区数上限：メタ一覧から lastUsed 最古を退避（バッチレコードも道連れ）
		const keys = (await idb()) || [];
		const metas = [];
		for (const k of keys) if (typeof k === "string" && k.endsWith("#meta")) metas.push(k);
		if (metas.length > IDB_MAX_WARDS) {
			const entries = [];
			for (const mk of metas) { const m = await idb(mk).catch(() => null); if (m) entries.push({ mk, ts: m.ts || 0, count: m.count || 0 }); }
			entries.sort((a, b) => a.ts - b.ts);
			for (const old of entries.slice(0, entries.length - IDB_MAX_WARDS)) {
				const oldBase = old.mk.slice(0, -"#meta".length);
				await idb(old.mk, null);
				for (let i = 0; i < old.count; i++) await idb(`${oldBase}#${i}`, null);
				console.log("[plateau] IDB退避（LRU）", oldBase);
			}
		}
		console.log("[plateau] IDB保存", base, `(${batches.length} batches)`);
	} catch (e) { console.warn("[plateau] IDB保存失敗（表示には影響なし）", e); }
}
async function idbPurge() {
	const idb = await idbReady; if (!idb) return 0;
	const keys = (await idb()) || [];
	for (const k of keys) await idb(k, null);
	return keys.length;
}

// ロード本体：葉タイル収集→カメラ近傍順ソート→バッチごとにデコード→完成次第 render worker へ直送（逐次表示）。
// メモリ→IDB→ネットワークの3段。IDBヒット時もバッチ逐次送信＝プログレッシブ表示のまま。
async function loadPlateau(base, tiles, ward, wardBbox, camCenter) {
	if (cache.has(base)) {
		const c = cache.get(base);
		cache.delete(base); cache.set(base, c);   // LRU touch（最近使用へ）
		console.log("[plateau] キャッシュ命中（fetch/解凍スキップ）", base);
		c.batches.forEach((mesh, bi) => sendBatch(ward, bi, mesh, c.mask, c.wardBbox));
		return true;
	}
	const stored = await idbLoad(base);
	if (stored) {
		console.log("[plateau] IDB命中（fetch/解凍/変換スキップ）", base, `(${stored.batches.length} batches)`);
		stored.batches.forEach((mesh, bi) => sendBatch(ward, bi, mesh, stored.mask, stored.wardBbox));
		cache.set(base, stored);
		if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
		return true;
	}
	let leaves;
	if (tiles) leaves = tiles.map(u => ({ uri: resolveUrl(base, u), center: null }));
	else {
		// REPLACE refine：親(粗)と子(詳細)が同じ場所を覆う→両方読むと重なって z-fight(マダラ)。子を持たない「葉」だけ読む。
		leaves = await collectLeafTiles(base + "tileset.json");
		console.log("[plateau] 葉タイル:", leaves.length, "枚");
	}
	// カメラ近傍から遠方の順に＝最初のバッチが「目の前」になる。center 不明のタイルは末尾。
	if (camCenter) {
		const d2 = t => t.center ? (t.center[0] - camCenter[0]) ** 2 + (t.center[1] - camCenter[1]) ** 2 : Infinity;
		leaves.sort((a, b) => d2(a) - d2(b));
	}
	console.log("[plateau] 読込", leaves.length, "tiles ←", base);
	const wardMask = wardBbox ? new Uint8Array(MASK_N * MASK_N) : null;   // 区単位で累積（wardBbox 無し=デバッグ直指定時はマスク無し）
	const batches = [];
	for (let bi = 0; bi * BATCH_TILES < leaves.length; bi++) {
		const slice = leaves.slice(bi * BATCH_TILES, (bi + 1) * BATCH_TILES);
		const mesh = await decodeBatch(base, slice, wardMask, wardBbox);
		if (!mesh) continue;
		sendBatch(ward, batches.length, mesh, wardMask, wardBbox);   // 完成したバッチから即描画へ
		batches.push(mesh);
		console.log(`[plateau] batch ${batches.length} (${Math.min((bi + 1) * BATCH_TILES, leaves.length)}/${leaves.length} tiles) tris=${mesh.idx.length / 3}`);
	}
	if (!batches.length) { console.error("[plateau] メッシュ0＝デコード/変換失敗"); return false; }
	cache.set(base, { batches, mask: wardMask, wardBbox });   // デコード結果をこのworker内に保持＝再訪でfetch/Draco解凍を丸ごと省略
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // LRU: 最古を退避
	console.log("[plateau] 完了", base, `(${batches.length} batches)`);
	idbStore(base, batches, wardMask, wardBbox);   // 永続化はバックグラウンドで（表示を待たせない）
	return true;
}

// 同一 base の並行要求（手動__plateau と autoPlateau の競合等）を1つのデコードに合流させる。
// onmessage は async＝先行デコードの await 中に後続メッセージが走り出し cache 未登録のまま二重デコードになるのを防ぐ。
const inflight = new Map();

self.onmessage = async (e) => {
	if (e.data.type === "init") { meshPort = e.data.meshPort; return; }
	if (e.data.type === "purge") { cache.clear(); const n = await idbPurge(); console.log("[plateau] キャッシュ全消去", n, "records"); return; }
	const { id, base, tiles, name, wardBbox, camCenter } = e.data;
	try {
		let p = inflight.get(base);
		if (!p) {
			p = loadPlateau(base, tiles, name, wardBbox, camCenter);
			inflight.set(base, p);
			p.finally(() => inflight.delete(base)).catch(() => {});   // 掃除専用の枝＝拒否はここで握り潰す（本流の reject は下の await が受ける）
		}
		const ok = await p;
		self.postMessage({ id, ok });
	} catch (err) {
		self.postMessage({ id, ok: false, error: err.message });
	}
};
