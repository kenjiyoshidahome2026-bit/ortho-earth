// PLATEAU LOD2 建物メッシュのロード/デコードをメインスレッドから追い出す worker。
// tileset→葉タイル収集→カメラ近傍順ソート→バッチ(64タイル)ごとに b3dm/Draco解凍→ECEF→ortho単位球変換→
// 重複面dedup→RTE delta を行い、完成したバッチから順に render worker へ直結ポートで transfer 送信＝逐次表示。
// 区全体を待たず「目の前のビルが数秒で立ち始める」。被覆マスクは区単位で累積（シェーダのマスクスロットを消費しない）。
// main.js 側は複数のこの worker をプールし、base URL のハッシュで固定ルーティング（同じ地区は常に同じ worker＝内部cacheが効く）。
import { parse as loadParse } from "@loaders.gl/core";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";
import { Cache } from "native-bucket";
import { opfsStore } from "./plateaufs.js";

const EARTH_M = 6371000;   // main.js の EARTH_M と同値（建物の接地計算に使う単位球換算）
// バッチ/並行度は低メモリ端末で縮小（init lowMem で上書き）：デコードの過渡メモリ（Float64座標+BigInt dedup+
// glTFバッファ）はバッチ規模にほぼ比例＝64タイル/並行8はデスクトップ実測~2.5GB/区で、iOSのタブ予算(~1.4GB)を
// 超え jetsam（デモ上演中のタブ再読み込み＝iPhone 16 Pro 実機で確認）。16タイル/並行4＝ピーク~1/4。
let TILE_CONCURRENCY = 8;   // バッチ内のタイル並行fetch/デコード数。直列だと往復レイテンシが積み上がり支配的になる。
let BATCH_TILES = 32;       // 1バッチのタイル数。小さいほど初表示が速く（＋デコード過渡メモリも比例減）、大きいほどdraw call/RTE origin数が減る。
                            // 64→32（2026-07-27）：デモ中「メモリ14G級」の実害＝過渡~2.5GB/区の半減を優先（バッチ数は倍＝描画影響は軽微）。
const MASK_N = 256;           // 区単位の被覆マスク解像度（基図建物を伏せるセル）
const FAR_VER = 3;            // 遠景far-DB（#far）の形式版。抽出方法を変えたら上げる＝次のロードで自然再導出。v2=頂点溶接（v1は三角形単位に退化＝83k箱/区の轍）・v3=先細り塔の除外（スカイツリー箱化対策）
let FAR_MIN_H = 200;          // far-DBの高さ閾値(m)＝200m級＝真の超高層だけの星座（本人裁定2026-08-04夜「z14から+200m以上で少し綺麗にかつ軽く」・15m/50m/100mは実機比較で却下）。init(farH)/?farh=Nで上書き
const LOD_H = [0, 3, 6, 12, 24, 48];   // LOD段の高さ閾値(m)。renderer が「画面上1px未満の建物」を先頭countの打ち切りで捨てる
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
// タイムアウト付き fetch（PLATEAU API はハング接続が起きる＝タイムアウト無しだと worker 枠が数分死ぬ。
// 実測 2026-08-02：API不調時に区の並行8本が全部無応答＝70秒で0タイル「極端に遅い」の実体）。
// abort は body 読み（json/arrayBuffer）まで効かせる＝ヘッダ後の本文ストール（stalled mid-stream）も切る。
async function fetchBody(url, read, ms = 20000, retries = 1) {
	for (let a = 0; ; a++) {
		const ac = new AbortController();
		const tm = setTimeout(() => ac.abort(), ms);
		try { const r = await fetch(url, { signal: ac.signal }); return await read(r); }
		catch (e) { if (a >= retries) throw e; }
		finally { clearTimeout(tm); }
	}
}
const fetchJSON = (url) => fetchBody(url, r => r.json(), 15000);
const fetchAB = (url) => fetchBody(url, r => r.arrayBuffer(), 25000);

async function collectLeafTiles(tilesetUrl, depth = 0, onScan = null, stop = null) {
	if (stop?.()) return [];   // 協調キャンセル：視野離脱した区のカタログ走査を tileset 単位で打ち切る
	onScan && onScan();   // tileset.json 1枚fetchするたびに数える＝「準備中」の沈黙を進捗にする
	const ts = await fetchJSON(tilesetUrl);
	const tsBase = tilesetUrl.slice(0, tilesetUrl.lastIndexOf("/") + 1);
	const out = [];
	async function walk(t) {
		if (!t) return;
		const ch = t.children || [];
		if (ch.length) { for (const c of ch) await walk(c); return; }
		const uri = t.content?.uri;
		if (!uri) return;
		const abs = resolveUrl(tsBase, uri);
		if (abs.endsWith(".json") && depth < 4) out.push(...await collectLeafTiles(abs, depth + 1, onScan, stop));
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
// brid＝橋梁モード：①接地を「成分ごと」でなく「バッチ最低点」に＝桁・ケーブルが塔と非連結でも海面へ沈まない
// （成分接地だと吊橋の桁が自分の最低点で接地＝水面すれすれに落ちる。バッチ最低点＝橋脚基部≈ジオイド分を
//   一括で差し引くので、部材同士の相対高さが保たれる）②twoSided=1 を焼き込み＝FS が裏面 discard をやめる
// （ケーブル・柵など厚みゼロの開いた面は表裏2枚組で来る→dedup が1枚に潰す→片側から見えなくなるため）。
async function decodeBatch(base, leaves, wardMask, wardBbox, onTile = null, brid = false, stop = null, laneOf = null) {
	// 中間データは plain JS Array に push しない：バッチで1700万push級になり要素タグ+GCで数秒を失う。
	// プリミティブごとに頂点数が既知なので typed セグメントを作り、バッチ末尾で一括結合（memcpy）する。
	// geo(lon/lat rad)は float64 必須：float32 の相対精度~1e-7 は rad で~0.6m＝dedup の丸め(1e-8rad≈6cm)を壊す。
	const segs = [];   // { geo:Float64Array, nrm:Int8Array(xyz+pad 4B), idx:Uint32Array }（idx はバッチ通し番号で焼き込み済み）
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
				// 法線は int8 量子化（xyz+pad の4B/頂点＝float32×3 の 1/3）。FS が normalize するので精度 1/127 で十分。
				const geoSeg = new Float64Array(n * 3), nrmSeg = new Int8Array(n * 4);
				for (let i = 0; i < n; i++) {
					// local(Y-up)→ECEF：Yup→Zup(x,-z,y)＋RTC → geodetic(lon,lat,h) を一旦保持
					const ex = P[i*3] + rtc[0], ey = -P[i*3+2] + rtc[1], ez = P[i*3+1] + rtc[2];
					const g = ecef2geo(ex, ey, ez);
					if (g[2] < minH) minH = g[2];
					geoSeg[i*3] = g[0]; geoSeg[i*3+1] = g[1]; geoSeg[i*3+2] = g[2];
					// 法線：glTF(Y-up local)→ortho は方向を (nx, ny, -nz)（Yup→Zup＋ECEF→ortho軸swap の合成）。符号は FS で視線側へ。
					// 正規化してから量子化：非単位法線が混じると ×127 が ±127 を越え Int8 で符号が巻き戻る（壁が黒落ち/ちらつき）ため。
					if (NRM) {
						const nx = NRM[i*3], ny = NRM[i*3+1], nz = -NRM[i*3+2];
						const s = 127 / (Math.hypot(nx, ny, nz) || 1);
						nrmSeg[i*4] = Math.round(nx * s); nrmSeg[i*4+1] = Math.round(ny * s); nrmSeg[i*4+2] = Math.round(nz * s);
					} else { nrmSeg[i*4+1] = 127; }
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
	async function tileWorker(wi) {
		while (ti < leaves.length) {
			if (stop?.()) return;   // 協調キャンセル：離脱区の残りタイルは fetch しない（帯域を現役区へ返す）
			if (laneOf?.() === "slow") {
				// slow lane＝実働1本へ縮退。残りは「待機」＝promote(fast復帰)の瞬間に全並行が即蘇る。
				// 旧・return で降ろすと復帰後も現行バッチの末尾まで1本のまま＝復帰直後の目の前のバッチ
				//（近傍優先ソートの先頭）が直列で這う＝「必要になっても回復しない」体感（Kenji 指摘 2026-08-02）。
				if (wi > 0) { await new Promise(r => setTimeout(r, 300)); continue; }
				await new Promise(r => setTimeout(r, 250));    // 間隔を空けて帯域/CPUを現地点の fast ロードへ明け渡す
			}
			const t = leaves[ti++];
			try {
				const ab = await fetchAB(t.uri);   // 25s タイムアウト＋1リトライ＝ハング接続で worker 枠を殺さない
				// excludeExtensions: loaders.gl の流儀＝「キーを載せて値false」で当該拡張の処理を除外。
				// EXT_mesh_features/EXT_structural_metadata＝属性メタデータ用（未使用・特定構成でのassert回避）。
				// EXT_texture_webp＝webpテクスチャ版アセット（2025 re-publish以降のbrid等）が extensionsRequired に
				// 宣言するだけで preprocess が throw する（worker内はwebp判定不能）。テクスチャは不使用＝安全に除外。
				// loadImages:false: テクスチャ版しか無い区(約35)でJPEGデコードを丸ごと省く（色は使わない）。
				const tile = await loadParse(ab, Tiles3DLoader, { "3d-tiles": { loadGLTF: true }, gltf: { loadImages: false, excludeExtensions: { EXT_mesh_features: false, EXT_structural_metadata: false, EXT_texture_webp: false } } });
				mergeTile(tile);
			} catch (e) { console.warn("[plateau] tile 失敗", t.uri, e.message); }
			onTile && onTile();   // 成否に関わらず歩数は進む＝分母が縮まない
		}
	}
	await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, leaves.length) }, (_, wi) => tileWorker(wi)));
	if (!totalI) return null;
	// セグメントを一括結合（memcpy）。idx はセグメント生成時にバッチ通し番号で焼き込み済み＝コピーだけで整合。
	const geo = new Float64Array(totalV * 3), outNrm = new Int8Array(totalV * 4), rawIdx = new Uint32Array(totalI);
	{
		let vtx = 0, io = 0;
		for (const s of segs) { geo.set(s.geo, vtx * 3); outNrm.set(s.nrm, vtx * 4); rawIdx.set(s.idx, io); vtx += s.geo.length / 3; io += s.idx.length; }
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
	// bbox(deg)：renderer側フラスタムカリングに使う。geo は rad なので deg へ。
	const M = geo.length / 3;
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
	for (let i = 0; i < M; i++) { const lo = geo[i*3], la = geo[i*3+1]; if (lo<minLon) minLon=lo; if (lo>maxLon) maxLon=lo; if (la<minLat) minLat=la; if (la>maxLat) maxLat=la; }
	const bbox = [minLon*R2D, minLat*R2D, maxLon*R2D, maxLat*R2D];
	// 接地v3：建物（連結成分）単位の剛体接地＝各成分から「自分の最低頂点（基部）」の標高を差し引く。
	// v2までの「グリッド場（セル最低標高→空セル充填→平滑→バイリニア）」は、建物が疎な急斜面で
	// 空セル充填が谷側の低い値を引きずり、平滑がそれを実測セルへ混ぜて地面を過小評価＝建物が浮く
	// （京都嵯峨野で実測+19〜40m。セルを32mに細かくしても直らない＝方式の欠陥）。
	// 剛体移動なら浮きもセル境界シアーも原理的に無い。斜面の建物は基部最低点で接地＝上り側が僅かに
	// 沈む方向（浮きより無害。地形は都市帯で深度を書かない背景＝沈み込みは見えない）。
	// 連結判定＝三角形の頂点共有 ＋ 丸め座標一致の頂点同一視（壁・屋根が別プリミティブでも境界座標は
	// 厳密一致するため。vkeyBig の丸め＝dedup と同じ 6cm/0.1m）。
	const parent = new Int32Array(M);
	for (let i = 0; i < M; i++) parent[i] = i;
	const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
	const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
	{
		const firstByKey = new Map();   // 丸め座標 → 最初に現れた頂点番号（同座標の頂点を同一視）
		for (let i = 0; i < M; i++) {
			const k = vkeyBig(geo, i);
			const f = firstByKey.get(k);
			if (f === undefined) firstByKey.set(k, i); else union(f, i);
		}
	}
	for (let k = 0; k < outIdx.length; k += 3) { union(outIdx[k], outIdx[k+1]); union(outIdx[k], outIdx[k+2]); }
	const minAlt = new Float64Array(M).fill(Infinity);   // 成分代表 → 成分の最低標高（基部）
	const maxAlt = new Float64Array(M).fill(-Infinity);  // 成分代表 → 最高標高（max-min＝建物の高さ。LOD並べ替えのキー）
	for (let i = 0; i < M; i++) { const r = find(i), h = geo[i*3+2]; if (h < minAlt[r]) minAlt[r] = h; if (h > maxAlt[r]) maxAlt[r] = h; }
	// 接地v5＝v3（成分単位の剛体接地）の2つの盲点を塞ぐ。どちらも「自分の最低点を海抜0へ」が仇になるケース：
	// (a) 地下構造物の浮上：完全地下のソリッド（地下駐車場・地下街・坑体）は基部差引で地表に立ち上がる
	//     （実測: 西新宿 z17.8/75t＝新宿中央公園に地下駐車場の函体・青梅街道の坑体2本が巨大な板として並ぶ「二重」）。
	//     対策＝近傍の成分基部の中央値から局所地面を推定し、頂部がどの近傍地面よりも低い成分は「地面下へ沈める」
	//     （頂部を-0.5mへ＝基図の地面が深度で覆う。三角形は削らない＝index/LOD/マスクの再配管なし・不可視の微小オーバードロー）。
	// (b) 空中部材の落下：超高層の冠・段状屋根・塔屋が壁と頂点を共有しない別ソリッドだと、空中の基部ごと接地され
	//     頂部だけが地面に落ちる。対策＝成分中心を2D bboxに含む「8m以上低い成分」の基部を借りて接地（剛体のまま実高度へ）。
	//     閾値8m＝斜面の隣家bbox借用（数mの浮き）を防ぎつつ、冠・塔屋（基部が塔の基部から数十m上）は確実に拾う。
	{
		const roots = [], rBox = new Map();   // 成分代表 → 2D bbox [minLon,minLat,maxLon,maxLat]（rad）
		for (let i = 0; i < M; i++) {
			const r = find(i);
			let b = rBox.get(r);
			if (!b) { rBox.set(r, b = [Infinity, Infinity, -Infinity, -Infinity]); roots.push(r); }
			const lo = geo[i*3], la = geo[i*3+1];
			if (lo < b[0]) b[0] = lo; if (la < b[1]) b[1] = la;
			if (lo > b[2]) b[2] = lo; if (la > b[3]) b[3] = la;
		}
		// バッチbbox上のセルグリッド（座標は上のbbox計算と同じrad）：中心セル＝地面推定の票、bbox掛かり＝重なり候補。
		const G = 64, sLo = (maxLon - minLon) || 1e-12, sLa = (maxLat - minLat) || 1e-12;
		const cellX = v => Math.max(0, Math.min(G - 1, (v - minLon) / sLo * G | 0));
		const cellY = v => Math.max(0, Math.min(G - 1, (v - minLat) / sLa * G | 0));
		const grid = new Map();     // セル番号 → bboxが掛かる成分代表（(b)の重なり候補）
		const baseVotes = new Map();   // セル番号 → 中心がそのセルに落ちる成分の基部標高（(a)の地面票）
		const center = new Map();   // 成分代表 → [cx, cy, 中心セル番号]
		for (const r of roots) {
			const b = rBox.get(r), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, ck = cellY(cy) * G + cellX(cx);
			center.set(r, [cx, cy, ck]);
			let v = baseVotes.get(ck); if (!v) baseVotes.set(ck, v = []);
			v.push(minAlt[r]);
			for (let y = cellY(b[1]); y <= cellY(b[3]); y++) for (let x = cellX(b[0]); x <= cellX(b[2]); x++) {
				const k = y * G + x;
				let a = grid.get(k); if (!a) grid.set(k, a = []);
				a.push(r);
			}
		}
		const cellGround = new Map();   // 占有セル → 地面推定（そのセルに立つ成分基部の中央値）
		for (const [k, v] of baseVotes) { v.sort((a, b) => a - b); cellGround.set(k, v[v.length >> 1]); }
		// (a) 完全地下の判定＝二重条件（両方成立で「地中」確定・候補ゼロの孤立成分は触らない）：
		//   ①頂部 < 近傍（半径3セル）の占有セル地面の「中央値」−1 …大きな函体は自分の基部票で自セル地面を汚染する
		//     （公園の地下駐車場＝自セル−25mが唯一の票）ため、min では永遠に地中にならない。中央値は周囲の街の基部が制す。
		//   ②頂部 < 「自分のbbox外」のセル地面の最小値 −1 …崖下・谷底の実在建物は、自分達の基部が作る低いセル地面が
		//     ①の中央値を守れない事がある（急斜面）。最も低い他人の地面よりさらに低い時だけ地中と認める＝安全側の錠。
		const dead = new Set();
		for (const r of roots) {
			const [, , ck] = center.get(r), cx0 = ck % G, cy0 = (ck / G) | 0;
			const b = rBox.get(r);
			const bx0 = cellX(b[0]), bx1 = cellX(b[2]), by0 = cellY(b[1]), by1 = cellY(b[3]);   // 自分の足元セル範囲
			const gs = []; let minOut = Infinity;
			for (let y = Math.max(0, cy0 - 3); y <= Math.min(G - 1, cy0 + 3); y++)
				for (let x = Math.max(0, cx0 - 3); x <= Math.min(G - 1, cx0 + 3); x++) {
					const cg = cellGround.get(y * G + x);
					if (cg === undefined) continue;
					gs.push(cg);
					if ((x < bx0 || x > bx1 || y < by0 || y > by1) && cg < minOut) minOut = cg;
				}
			if (!gs.length || minOut === Infinity) continue;
			gs.sort((a, c) => a - c);
			const med = gs[gs.length >> 1];
			if (maxAlt[r] < med - 1 && maxAlt[r] < minOut - 1) dead.add(r);
		}
		for (const r of dead) minAlt[r] = maxAlt[r] + 0.5;   // 沈める＝頂部が-0.5m（平らな都市地面の下＝不可視）
		// (b) 借り接地：借用は全成分の判定後に一括適用＝元のminAltだけを読む（連鎖の順序依存を断つ）。地下成分は貸借対象外。
		const borrowed = new Map();
		for (const r of roots) {
			if (dead.has(r)) continue;
			const [cx, cy, ck] = center.get(r);
			let g = minAlt[r];
			for (const o of grid.get(ck) || []) {
				if (dead.has(o) || minAlt[o] >= g) continue;
				const ob = rBox.get(o);
				if (cx >= ob[0] && cx <= ob[2] && cy >= ob[1] && cy <= ob[3]) g = minAlt[o];
			}
			if (minAlt[r] - g > 8) borrowed.set(r, g);
		}
		for (const [r, g] of borrowed) minAlt[r] = g;
	}
	// LOD並べ替え＝gintのVWランクのメッシュ版：三角形を建物（連結成分）の高さ降順に並べ、描画は index 先頭 count で
	// 打ち切れる形に焼く。lodCounts[k]＝高さ LOD_H[k] 以上の建物だけ描く時の drawElements count（CPUゼロ・シェーダ変更ゼロ）。
	// キーは Float64 パック（高さ6.25cm刻み16bit + 元三角形番号32bit ＝ 48bit < 仮数53bit）＝コンパレータ無しの高速ソート。
	// 同高さは元順のまま＝同一タイル由来の三角形が隣接（頂点キャッシュの局所性を崩さない）。
	const nTri = outIdx.length / 3;
	const lodKeys = new Float64Array(nTri);
	for (let t = 0; t < nTri; t++) {
		const r = find(outIdx[t*3]);
		const hq = Math.min(65535, (maxAlt[r] - minAlt[r]) * 16 | 0);
		lodKeys[t] = (65535 - hq) * 4294967296 + t;   // 高い建物ほど小さいキー＝先頭へ
	}
	lodKeys.sort();
	const sortedIdx = new Uint32Array(outIdx.length);
	for (let t = 0; t < nTri; t++) {
		const src = (lodKeys[t] % 4294967296) * 3;
		sortedIdx[t*3] = outIdx[src]; sortedIdx[t*3+1] = outIdx[src+1]; sortedIdx[t*3+2] = outIdx[src+2];
	}
	outIdx.set(sortedIdx);
	const lodCounts = Array(LOD_H.length).fill(outIdx.length);   // 既定＝全描画（その高さ未満の建物が無いバッチ）
	for (let t = 0, li = LOD_H.length - 1; t < nTri && li > 0; t++) {
		const h = (65535 - Math.floor(lodKeys[t] / 4294967296)) / 16;
		while (li > 0 && h < LOD_H[li]) lodCounts[li--] = t * 3;
	}
	// RTE-lite：単位球の絶対座標は float32 だと建物1棟が~60段階に量子化される→重心(origin)相対の delta で精度を桁で戻す。
	const wpos = new Float64Array(geo.length);
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < M; i++) {
		const lon = geo[i*3], lat = geo[i*3+1], cb = Math.cos(lat);
		const r = 1 + (geo[i*3+2] - (brid ? minH : minAlt[find(i)])) / EARTH_M;   // 基部からの相対高さ＝剛体接地（橋梁はバッチ最低点＝部材の相対高さ保存）
		const x = cb*Math.cos(lon)*r, y = Math.sin(lat)*r, z = cb*Math.sin(lon)*r;
		wpos[i*3] = x; wpos[i*3+1] = y; wpos[i*3+2] = z; ox += x; oy += y; oz += z;
	}
	const origin = [ox / M, oy / M, oz / M];
	const outPos = new Float32Array(geo.length);
	for (let i = 0; i < M; i++) {
		outPos[i*3] = wpos[i*3] - origin[0]; outPos[i*3+1] = wpos[i*3+1] - origin[1]; outPos[i*3+2] = wpos[i*3+2] - origin[2];
	}
	// 被覆マスク：三角形が触れた wardBbox 座標系のセルを「このバッチの断片(maskCells)」として持つ。
	// 旧・区単位のwardMask累積は継続する（IDB meta 互換・ロールバック安全）が、描画へはもう送らない＝
	// renderer は届いたバッチの断片だけをOR合成する（マスクがメッシュに先行して「基図は伏せたのに
	// PLATEAUが無い」矩形の隙間を作る非対称の根治。demote/cancel/復元中断で顕在化していた）。
	let maskCells = null;
	if (wardMask && wardBbox) {
		const wLo = wardBbox[0] / R2D, wLa = wardBbox[1] / R2D;   // マスク座標系は rad で統一（geo が rad のため）
		const spanLo = (wardBbox[2] - wardBbox[0]) / R2D || 1e-12, spanLa = (wardBbox[3] - wardBbox[1]) / R2D || 1e-12;
		const bm = new Uint8Array(MASK_N * MASK_N);   // このバッチ分だけの塗り
		for (let t = 0; t < outIdx.length; t += 3) {
			const a = outIdx[t], b = outIdx[t+1], c = outIdx[t+2];
			const lo0 = geo[a*3], lo1 = geo[b*3], lo2 = geo[c*3], la0 = geo[a*3+1], la1 = geo[b*3+1], la2 = geo[c*3+1];
			let cx0 = (Math.min(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0, cx1 = (Math.max(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0;
			let cy0 = (Math.min(la0,la1,la2) - wLa) / spanLa * MASK_N | 0, cy1 = (Math.max(la0,la1,la2) - wLa) / spanLa * MASK_N | 0;
			if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N-1) cx1 = MASK_N-1; if (cy1 > MASK_N-1) cy1 = MASK_N-1;
			for (let y = cy0; y <= cy1; y++) { const row = y*MASK_N; for (let x = cx0; x <= cx1; x++) { wardMask[row+x] = 255; bm[row+x] = 1; } }
		}
		const cells = [];
		for (let i = 0; i < bm.length; i++) if (bm[i]) cells.push(i);
		maskCells = Uint32Array.from(cells);   // バッチは空間的に密＝典型数十〜数百セル（数百B）。永続化にも同乗する
	}
	return { pos: outPos, nrm: outNrm, idx: outIdx, origin, bbox, lodH: LOD_H, lodCounts, twoSided: brid ? 1 : 0, maskCells };
}

// メッシュの出口＝render worker への直結ポート（main.js が MessageChannel で配線）。
// main へ返すのは ok/失敗の ack だけ＝~160MB の typed array がメインスレッドで構造化クローンされるのを断つ。
let meshPort = null;

// クレジット式フロー制御：render worker は1フレーム1バッチしか消化しないのに、キャッシュ/IDB命中時は
// 全バッチを一斉送出していた＝完了直後に「worker内の原本＋転送コピー全量（キュー滞留）＋GPUへの積み上げ」が
// 重なり、密集区(~160MB)では一時的に約3倍＝iPhoneがタブごと落ちる（実測：読み終えた直後に落ちる）。
// render worker が消化のたびに {drained:1} を返し、未消化は最大 CREDIT_MAX 個＝滞留を数十MBで頭打ちにする。
const CREDIT_MAX = 2;
let credits = CREDIT_MAX;
const creditWaiters = [];
const takeCredit = () => credits > 0 ? (credits--, Promise.resolve()) : new Promise(r => creditWaiters.push(r));
const onDrained = () => { const w = creditWaiters.shift(); if (w) w(); else if (credits < CREDIT_MAX) credits++; };

// バッチ1個を render worker へ送出（クレジットが空くまで待つ）。cache の原本は守りたいので transfer 分はコピー。
// own=true＝この mesh はもう誰も使わない（ストリーミング復元＝送ったら手放す）＝コピー無しで transfer
// （渡した後は detached＝呼び出し側は触らない約束）。マスクは累積原本ゆえ常にコピー＝renderer 側は毎回丸ごと差し替え（冪等）。
// マスク断片：メッシュ持参の maskCells（新形式）を、無ければ**三角形bbox**からセル導出（旧焼き互換＝再焼き不要・
// decodeBatch と同じ塗り方）。⚠バッチbbox代用は禁止：バッチはカメラ近傍順ソートの塊＝空間的に広く散り得て、
// bboxが区の半分級になる（実測2026-08-04：旧焼き復元の初バッチが巨大矩形を一撃で伏せ「領域の建物が全部消える」退行）。
// ⚠頂点打ちも禁止（v1の轍・2026-08-04夜）：「セル41m級≫建物＝頂点打ちで隙間なし」は長い単純壁で嘘になる
//（大きなビルの一枚壁＝三角形2枚・頂点は角だけ→中間セルが未マーク→基図建物の壁がそこだけ生き残り
// PLATEAU壁と深度戦い＝pan/zoom中の壁面の瞬き・?nobld=1切り分けで本人特定）。
// 頂点→経緯度は world 軸（camera.js lonlatTo3D と同規約：lat=asin(y)・lon=atan2(z,x)）。
// 区bbox外に完全に出た三角形は捨てる＝失敗は常に「伏せない」側（空白でなく二重立ち）に倒れる。
function maskCellsOf(mesh, wardBbox) {
	if (!wardBbox) return null;
	if (mesh.maskCells?.length) return Uint32Array.from(mesh.maskCells);   // 常にコピー＝cache原本をtransferで壊さない
	const pos = mesh.pos, o = mesh.origin, idx = mesh.idx;
	if (!pos || !o) return null;
	const n = pos.length / 3;
	const lons = new Float64Array(n), lats = new Float64Array(n);
	const R2Dg = 180 / Math.PI;
	for (let i = 0; i < n; i++) {
		const x = pos[i * 3] + o[0], y = pos[i * 3 + 1] + o[1], z = pos[i * 3 + 2] + o[2];
		const r = Math.hypot(x, y, z) || 1;
		lats[i] = Math.asin(Math.max(-1, Math.min(1, y / r))) * R2Dg;
		lons[i] = Math.atan2(z, x) * R2Dg;
	}
	const bm = new Uint8Array(MASK_N * MASK_N);
	const wLo = wardBbox[0], wLa = wardBbox[1];
	const sx = (wardBbox[2] - wardBbox[0]) || 1e-12, sy = (wardBbox[3] - wardBbox[1]) || 1e-12;
	if (idx?.length) {
		for (let t = 0; t < idx.length; t += 3) {
			const a = idx[t], b = idx[t + 1], c = idx[t + 2];
			let cx0 = (Math.min(lons[a], lons[b], lons[c]) - wLo) / sx * MASK_N | 0, cx1 = (Math.max(lons[a], lons[b], lons[c]) - wLo) / sx * MASK_N | 0;
			let cy0 = (Math.min(lats[a], lats[b], lats[c]) - wLa) / sy * MASK_N | 0, cy1 = (Math.max(lats[a], lats[b], lats[c]) - wLa) / sy * MASK_N | 0;
			if (cx1 < 0 || cy1 < 0 || cx0 > MASK_N - 1 || cy0 > MASK_N - 1) continue;   // 区bbox外＝捨てる（伏せない側）
			if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N - 1) cx1 = MASK_N - 1; if (cy1 > MASK_N - 1) cy1 = MASK_N - 1;
			for (let y2 = cy0; y2 <= cy1; y2++) { const row = y2 * MASK_N; for (let x2 = cx0; x2 <= cx1; x2++) bm[row + x2] = 1; }
		}
	} else {   // idx無しの保険＝従来の頂点打ち（現行データは全て idx 持ち）
		for (let i = 0; i < n; i++) {
			const cx = (lons[i] - wLo) / sx * MASK_N | 0, cy = (lats[i] - wLa) / sy * MASK_N | 0;
			if (cx >= 0 && cy >= 0 && cx < MASK_N && cy < MASK_N) bm[cy * MASK_N + cx] = 1;
		}
	}
	const cells = [];
	for (let i = 0; i < bm.length; i++) if (bm[i]) cells.push(i);
	return cells.length ? Uint32Array.from(cells) : null;
}
// ── 遠景far-DB＝「いつも描くDB」の一般化（z15帯の建物の崖をPLATEAU抽出で埋める・本人裁定2026-08-04）──
// 建物単位の箱 [lonMin,latMin,lonMax,latMax,hMax(m)] をメッシュから抽出。建物分割は idx の共有頂点
// union-find（v3接地の連結成分と同じ考え）＝保存済み旧焼きメッシュからも導出できる（再焼き不要）。
// 座標逆算は maskCellsOf と同じ world→経緯度（lonlatTo3D規約）。高さ＝海面半径からの相対(m)。
function farBoxesOf(mesh) {
	const pos = mesh.pos, o = mesh.origin, idx = mesh.idx;
	if (!pos || !o || !idx) return [];
	const n = pos.length / 3;
	// 頂点溶接（0.5mグリッド）：Draco出力は建物内でも頂点非共有＝素のidx連結は三角形単位に退化する
	//（実測v1＝中野83k箱/区・三角形を数えていた）。位置量子化で同一点を1ノードに束ねてから連結する。
	// ⚠キーは数値二段（文字列キー禁止）：旧実装の頂点毎"x,y,z"文字列は数百MB/バッチの一時アロケ＝
	// v3移行の全区再導出が復元と重なった起動でヒープがGB級に膨張（本人実測「すぐ10GB近く」2026-08-04夜）。
	// pos は origin相対（|Δ|≲区対角/地球半径≈1e-2）＝×wq で ±13万格子に収まる→2^17オフセットで正整数化。
	// 外側キー= qx*2^18+qy（<2^36＝安全）・内側キー= qz。圏外はクランプ（区bbox外の断片＝far対象外の彼方）。
	const wq = 6371000 / 0.5;   // 単位球座標×wq ≈ 0.5m格子
	const weld = new Int32Array(n);
	{
		const QO = 1 << 17, QMAX = (1 << 18) - 1;
		const q = v => { const x = Math.round(v * wq) + QO; return x < 0 ? 0 : x > QMAX ? QMAX : x; };
		const first = new Map();   // 外側キー → Map(qz → 代表頂点index)
		for (let i = 0; i < n; i++) {
			const ko = q(pos[i * 3]) * 262144 + q(pos[i * 3 + 1]);   // ×2^18
			let inner = first.get(ko);
			if (!inner) { inner = new Map(); first.set(ko, inner); }
			const kz = q(pos[i * 3 + 2]);
			const f = inner.get(kz);
			if (f === undefined) { inner.set(kz, i); weld[i] = i; } else weld[i] = f;
		}
	}
	const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
	const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
	for (let t = 0; t < idx.length; t += 3) {
		const a = find(weld[idx[t]]), b = find(weld[idx[t + 1]]), c = find(weld[idx[t + 2]]);
		if (b !== a) par[b] = a; if (c !== find(a)) par[find(c)] = find(a);
	}
	const R2Dg = 180 / Math.PI, EARTH = 6371000;
	const comp = new Map();   // root → [lonMin,latMin,lonMax,latMax,hMax, hMin]（hMinは先細り判定用・保存形式は先頭5要素のまま）
	for (let i = 0; i < n; i++) {
		const x = pos[i * 3] + o[0], y = pos[i * 3 + 1] + o[1], z = pos[i * 3 + 2] + o[2];
		const r = Math.hypot(x, y, z) || 1;
		const lat = Math.asin(Math.max(-1, Math.min(1, y / r))) * R2Dg, lon = Math.atan2(z, x) * R2Dg;
		const h = (r - 1) * EARTH;
		const k = find(weld[i]);   // ⚠素の find(i) は溶接された重複頂点が孤児成分になり箱を量産（145k/区の轍）
		const b = comp.get(k);
		if (!b) comp.set(k, [lon, lat, lon, lat, h, h]);
		else {
			if (lon < b[0]) b[0] = lon; if (lat < b[1]) b[1] = lat;
			if (lon > b[2]) b[2] = lon; if (lat > b[3]) b[3] = lat;
			if (h > b[4]) b[4] = h; if (h < b[5]) b[5] = h;
		}
	}
	// 先細り判定（v3・本人裁定2026-08-04「スカイツリーが箱にならないほうがいい。出現ズームを上げていいから綺麗に出す」）：
	// 上部40%帯（h ≥ hMin+0.6×高さ）の水平広がりが全体bboxの45%未満なら「塔」（先細り＝bbox箱にすると嘘の巨箱）
	// ＝far-DBに入れない→実メッシュのPLATEAU表示（z15帯）で初めて綺麗に登場する。角柱型の超高層（都庁・ランドマーク
	// タワー・ドコモ代々木＝上部帯に本体が入る）は残る。スカイツリー(634m・上部帯=細シャフト)・東京タワー級が除外対象。
	const cand = new Map();   // root → { b, slabH, top:[lonMin,latMin,lonMax,latMax] }
	for (const [k, b] of comp) if (b[4] >= FAR_MIN_H) cand.set(k, { b, slabH: b[5] + 0.6 * (b[4] - b[5]), top: [1e9, 1e9, -1e9, -1e9] });
	if (!cand.size) return [];
	for (let i = 0; i < n; i++) {
		const c = cand.get(find(weld[i]));
		if (!c) continue;
		const x = pos[i * 3] + o[0], y = pos[i * 3 + 1] + o[1], z = pos[i * 3 + 2] + o[2];
		const r = Math.hypot(x, y, z) || 1;
		if ((r - 1) * EARTH < c.slabH) continue;
		const lat = Math.asin(Math.max(-1, Math.min(1, y / r))) * R2Dg, lon = Math.atan2(z, x) * R2Dg;
		const t = c.top;
		if (lon < t[0]) t[0] = lon; if (lat < t[1]) t[1] = lat;
		if (lon > t[2]) t[2] = lon; if (lat > t[3]) t[3] = lat;
	}
	const out = [];
	for (const { b, top } of cand.values()) {
		const fw = b[2] - b[0], fh = b[3] - b[1];
		const boxy = fw <= 0 || fh <= 0 || ((top[2] - top[0]) >= fw * 0.45 && (top[3] - top[1]) >= fh * 0.45);
		if (boxy) out.push([b[0], b[1], b[2], b[3], b[4]]);
	}
	return out;
}

// far-DB配信：#far の箱群→プリズムメッシュを既存plateauパイプへ `${ward}#far` バッチとして相乗り。
// マスク不参加（wardBbox=null）＝基図を伏せない（z15帯に基図建物は無い＝二重立ちは原理的に無い）。
// twoSided=1＝巻き向き不問の両面描画（brid と同じパイプ変種）＝生成コードを単純に保つ。
async function sendFar(base, ward) {
	const idb = await idbReady; if (!idb) { self.postMessage({ farMiss: { name: ward } }); return; }
	const far = await idb(base + "#far").catch(() => null);
	if (!far?.boxes?.length || far.ver !== FAR_VER || far.h !== FAR_MIN_H) { self.postMessage({ farMiss: { name: ward } }); return; }   // 版違い・閾値違い＝miss扱い→farBakeが新版で再導出（旧閾値の箱を一瞬も点けない）
	const boxes = far.boxes, nb = boxes.length / 5;
	const D2Rg = Math.PI / 180, EARTH = 6371000;
	const toW = (lon, lat, h) => { const a = lon * D2Rg, b = lat * D2Rg, cb = Math.cos(b), r = 1 + h / EARTH; return [cb * Math.cos(a) * r, Math.sin(b) * r, cb * Math.sin(a) * r]; };
	// origin＝先頭箱の南西角（RTE-lite・f32精度の桁を戻す）
	const org = toW(boxes[0], boxes[1], 0);
	const pos = new Float32Array(nb * 20 * 3), nrm = new Int8Array(nb * 20 * 4), idxA = new Uint32Array(nb * 30);
	let pi = 0, ni = 0, ii = 0, vbase = 0;
	const bbox = [1e9, 1e9, -1e9, -1e9];
	for (let b = 0; b < nb; b++) {
		const lo0 = boxes[b * 5], la0 = boxes[b * 5 + 1], lo1 = boxes[b * 5 + 2], la1 = boxes[b * 5 + 3], H = boxes[b * 5 + 4];
		if (lo0 < bbox[0]) bbox[0] = lo0; if (la0 < bbox[1]) bbox[1] = la0;
		if (lo1 > bbox[2]) bbox[2] = lo1; if (la1 > bbox[3]) bbox[3] = la1;
		const cl = (lo0 + lo1) / 2 * D2Rg, ct = (la0 + la1) / 2 * D2Rg;
		const up = [Math.cos(ct) * Math.cos(cl), Math.sin(ct), Math.cos(ct) * Math.sin(cl)];
		const east = [-Math.sin(cl), 0, Math.cos(cl)];
		const north = [-Math.sin(ct) * Math.cos(cl), Math.cos(ct), -Math.sin(ct) * Math.sin(cl)];
		// 4隅×(地上0/天端H)＝8点を先に作り、屋根1面＋壁4面（各4頂点・法線は面単位）
		const c00 = [lo0, la0], c10 = [lo1, la0], c11 = [lo1, la1], c01 = [lo0, la1];
		const faces = [
			[[c00, H], [c10, H], [c11, H], [c01, H], up],                              // 屋根
			[[c00, 0], [c10, 0], [c10, H], [c00, H], [-north[0], -north[1], -north[2]]],   // 南壁
			[[c10, 0], [c11, 0], [c11, H], [c10, H], east],                            // 東壁
			[[c11, 0], [c01, 0], [c01, H], [c11, H], north],                           // 北壁
			[[c01, 0], [c00, 0], [c00, H], [c01, H], [-east[0], -east[1], -east[2]]],  // 西壁
		];
		for (const [p0, p1, p2, p3, nv] of faces) {
			for (const [ll, h] of [p0, p1, p2, p3]) {
				const w = toW(ll[0], ll[1], h);
				pos[pi++] = w[0] - org[0]; pos[pi++] = w[1] - org[1]; pos[pi++] = w[2] - org[2];
				nrm[ni++] = nv[0] * 127 | 0; nrm[ni++] = nv[1] * 127 | 0; nrm[ni++] = nv[2] * 127 | 0; ni++;
			}
			idxA[ii++] = vbase; idxA[ii++] = vbase + 1; idxA[ii++] = vbase + 2;
			idxA[ii++] = vbase; idxA[ii++] = vbase + 2; idxA[ii++] = vbase + 3;
			vbase += 4;
		}
	}
	// 擬似ward `${ward}#far` として送出＝本物の区の hide/vis 状態機械と独立（常駐で隠れた区の上にも箱を出せる）。
	// freePlateauWard(ward) の prefix 一致（`ward#`）には掛かる＝区evictで箱も同時に手放す。マスク不参加。
	await takeCredit();
	meshPort.postMessage(
		{ name: `${ward}#far`, meshData: { pos, nrm, idx: idxA, origin: org, bbox, lodH: null, lodCounts: null, twoSided: 1, ward: `${ward}#far`, maskCells: null, maskN: 0, maskBbox: null } },
		[pos.buffer, nrm.buffer, idxA.buffer]);
	console.log(`[plateau] far点灯 ${ward} ${nb}棟`);
}

// far育成ジョブ：#far が無い区を、IDB/OPFSの完走焼きから「読むだけ」で導出（表示に送らない・クレジット不使用）。
// 主要区が「更新後に再訪するまで遠景に立たない」育ち待ちを埋める。main が farMiss を受けて1区ずつ直列に依頼。
// 完走焼きが無い区は perm:true＝育てられない（ネットワークからは読まない＝帯域を奪わない。次の実ロード完走が育てる）。
async function farBake(base, ward) {
	const idb = await idbReady; if (!idb) { self.postMessage({ farMiss: { name: ward, perm: true } }); return; }
	const stored = await idb(base + "#far").catch(() => null);
	if (stored?.ver === FAR_VER && stored.h === FAR_MIN_H) { self.postMessage({ farReady: { name: ward } }); return; }
	await fsReady;
	const meta = await loadMeta(base, false);
	if (!meta || meta.partial) { self.postMessage({ farMiss: { name: ward, perm: true } }); return; }
	const acc = [];
	for (let i = 0; i < meta.count; i++) {
		const mesh = await readStored(base, meta.fs, i);   // 1バッチずつ 読む→導出→手放す（滞留させない）
		if (!mesh?.pos) { self.postMessage({ farMiss: { name: ward, perm: true } }); return; }
		acc.push(...farBoxesOf(mesh));
	}
	const flat = new Float32Array(acc.length * 5);
	acc.forEach((b, i) => flat.set(b, i * 5));
	try {
		await idb(base + "#far", { ver: FAR_VER, h: FAR_MIN_H, boxes: flat, ward, ts: Date.now() });
		console.log(`[plateau] far育成 ${ward} ${acc.length}棟（焼きから導出）`);
		self.postMessage({ farReady: { name: ward } });
	} catch { self.postMessage({ farMiss: { name: ward, perm: true } }); }
}

// wardMask 引数は未使用（旧・全量スナップショット送出の名残＝呼び出し側の引数順を保つため残置）。
// マスクは maskCells（このバッチの断片）だけを送る＝renderer 側が届いた分だけOR合成（隙間根治の本体）。
async function sendBatch(ward, bi, mesh, wardMask, wardBbox, own = false) {
	await takeCredit();
	const pos = own ? mesh.pos : mesh.pos.slice(), nrm = own ? mesh.nrm : mesh.nrm.slice(), idx = own ? mesh.idx : mesh.idx.slice();
	const maskCells = maskCellsOf(mesh, wardBbox);
	const payload = { name: `${ward}#${bi}`, meshData: { pos, nrm, idx, origin: mesh.origin, bbox: mesh.bbox, lodH: mesh.lodH, lodCounts: mesh.lodCounts, twoSided: mesh.twoSided || 0, ward, maskCells, maskN: MASK_N, maskBbox: wardBbox } };
	const transfers = [pos.buffer, nrm.buffer, idx.buffer];
	if (maskCells) transfers.push(maskCells.buffer);
	meshPort.postMessage(payload, transfers);
}

const cache = new Map();   // base URL → { batches, mask, wardBbox }（このworker内のみ有効。再訪はfetch/Draco解凍を丸ごと省略）
let CACHE_MAX = 1;         // 1区あたり~100-160MB（typed array一式）＝無上限だと多区巡回でメモリが積み上がる。LRUで直近1区に制限
                           // （workerは複数本＝プール全体では ×本数。同区は base ハッシュで毎回同じ worker＝ヒット率は落ちない）。
                           // 【2→1・2026-08-03】この RAM キャッシュは OPFS 二層化（916d180）より前の設計で、当時は再訪＝IDB全読み
                           // だったから2区抱える価値があった。今の再訪は OPFS のストリーミング復元（読む→送る→手放す）＝
                           // 数秒差でしかないのに、worker 4本×2区＝最大8区~1GB が GPU常駐(1.2GB)・OPFS と三重化していた。
                           // ⚠この cache を持つと ロード中も keep[] に区の全量を積む＝コールド時ピークの主因（下の keep 参照）。
                           // 低メモリ端末（lowMem）と非力機（mid）は 0＝抱えない。再訪は OPFS が受ける

// 永続キャッシュ：GPU直行形式（pos/nrm/idx＋マスク）を区単位で保存＝ページ再読込・再起動後も
// fetch/Draco解凍/座標変換を丸ごと飛ばして数秒で復元（geopbf の PBF+GINT キャッシュと同じ発想）。
// バッチ単位（各10〜20MB。本体の置き場は下の OPFS 二層を参照）＋メタ（IDB `${base}#meta`）。メタが揃って初めて有効＝書き途中の中断は無視される。
// FMT_VER: デコードパイプライン（接地・dedup・軸変換等）を変えたら上げる＝古い形式のキャッシュを自然無効化。
// （置き場の別は ver でなく meta.fs＝形式が同じままなら旧焼きは読める）。
const IDB_FMT_VER = 5;   // v5: 空中部材の借り接地＝非連結の冠・段状屋根・塔屋が海抜0へ落ちる問題の根治（西新宿の「二重」）
                         // v4: 法線int8量子化(4B/頂点＝1/3)＋建物高さ降順のindex並べ替え+LOD表（サブピクセル建物の打ち切り描画）
                         // v3: 接地を建物（連結成分）単位の剛体方式へ＝グリッド場の過小評価による浮き（京都嵯峨野+19〜40m）を根治
// 容量上限：固定の区数でなくブラウザのクォータ（オリジン割当）連動＝デモ機のChromeなら実質制限なしに仕込める。
// 割当の半分まで（MVTタイル・gint等が同じオリジン割当を共有するため）。estimate 不能な環境は従来相当の1.2GBで保守運転。
let idbBudget = 1.2e9;
navigator.storage?.estimate?.().then(e => {
	// 旧 max(quota*0.5, 1.2G) は割当の小さい端末（iOS Safari）で予算が実割当を超え、LRU退避が
	// 発火する前に書き込みが QuotaExceeded で全滅していた＝割当の8割を天井にクランプ（床3億=最低限の仕込み）。
	if (e?.quota) idbBudget = Math.min(Math.max(e.quota * 0.5, 1.2e9), Math.max(e.quota * 0.8, 3e8));
	console.log(`[plateau] IDB budget ${(idbBudget / 1e9).toFixed(1)}GB（オリジン割当 ${((e?.quota || 0) / 1e9).toFixed(1)}GB・使用 ${((e?.usage || 0) / 1e9).toFixed(2)}GB）`);
}).catch(() => {});
const idbReady = Cache("GIS/plateau").catch(e => { console.warn("[plateau] IDB無効（メモリキャッシュのみで続行）", e); return null; });

// ── バッチ本体の置き場＝OPFS（2026-08-02・XS温走行の「読了時落ち」対策）。台帳(meta)は IDB のまま二層 ──
// 狙いは唯一「読みでピークを積まない」：旧・IDB命中は区の全バッチ(100-160MB)を配列に実体化してから送出＝
// 温読みほど同時滞留が積み上がり、読み終えた瞬間が最鋭のピーク（4GB実機で落ちる実測）。以後は
// 「1バッチ読む→transferで送る→手放す」のストリーミング＝滞留はクレジット(CREDIT_MAX)×バッチで頭打ち。
// meta.fs="opfs" が置き場の印。旧v5焼き（fs無し＝本体もIDB）はそのまま読める＝既存資産を無駄にしない。
// OPFS不能環境（プライベートブラウズ等）は ofs=null＝従来どおり本体もIDBへ。?noopfs=1 が逃げ道。
let ofs = null, fsReady = Promise.resolve();
function initFs(noOpfs) {
	if (noOpfs) { console.log("[plateau] OPFS無効化（?noopfs=1）"); return; }
	fsReady = opfsStore().then(s => { ofs = s; console.log(s ? "[plateau] OPFS有効（バッチ本体=ファイル・台帳=IDB）" : "[plateau] OPFS不可（本体もIDBで続行）"); })
		.catch(e => console.warn("[plateau] OPFS初期化失敗（本体もIDBで続行）", e?.message ?? e));   // 沈黙失敗禁止＝フォールバックした事実は必ず見える化
}
// meta を引いて検分（complete/partial 両用）。fs="opfs" 焼きなのに OPFS が使えない環境＝読めない→null（焼き直し）。
async function loadMeta(base, brid) {
	const idb = await idbReady; if (!idb) return null;
	const meta = await idb(base + "#meta").catch(() => null);
	if (!meta || meta.ver !== IDB_FMT_VER || !!meta.brid !== !!brid) return null;   // brid不一致＝接地方式が違う焼き＝無効
	if (meta.fs === "opfs" && !ofs) return null;
	return meta;
}
// バッチ1個の読み出し（置き場は ward 単位で固定＝fs 引数）。無い/壊れ＝null。
// headerOnly＝tiles/軽量メタだけ（OPFSは本体3配列を読まない。IDBは値全体クローンの仕組み上フル読みと同じ）。
// ── バッファ返却プール（本人号令の「工事」2026-08-04夜）：復元/送出の pos/nrm/idx は使い捨てで
// ヒープ高水位の主要燃料だった。render worker が GPU 登録後に ack と同便で器を返し（recycle）、
// 次の復元は poolTake で器を再利用＝OPFS 同期 read の「与えた器へ流し込む」形と噛み合う。
// キャッシュ保持(keep)時はクローン送信＝返ってくるのは renderer 側の複製＝これも器として再利用できる。
const bufPool = [];   // ArrayBuffer（サイズ混在・要求以上で最小の器を first-fit）
let POOL_MAX = 64 << 20;   // lowMem/mid は init で 16MB へ（在庫を抱えすぎない）
let poolBytes = 0;
function poolTake(need) {
	let bi = -1, best = Infinity;
	for (let i = 0; i < bufPool.length; i++) { const b = bufPool[i].byteLength; if (b >= need && b < best) { best = b; bi = i; } }
	if (bi < 0) return null;
	const b = bufPool.splice(bi, 1)[0]; poolBytes -= b.byteLength; return b;
}
function poolPut(buf) {
	if (!buf || !buf.byteLength || buf.byteLength > (32 << 20)) return;   // 巨大器・空は返さない
	if (poolBytes + buf.byteLength > POOL_MAX) return;
	bufPool.push(buf); poolBytes += buf.byteLength;
}
async function readStored(base, fs, i, headerOnly = false) {
	if (fs === "opfs") return ofs ? ofs.read(base, i, headerOnly, headerOnly ? null : poolTake) : null;
	const idb = await idbReady; if (!idb) return null;
	return idb(`${base}#${i}`).catch(() => null);
}
// プレロード時の完全性確認＝本体を読まず存在だけ見る（旧・全バッチをRAMへ読んで確認していた無駄と山を消す）。
async function storedComplete(base, meta) {
	if (meta.fs === "opfs") {
		for (let i = 0; i < meta.count; i++) if (!await ofs.has(base, i)) return false;
		return true;
	}
	const idb = await idbReady; if (!idb) return false;
	const keys = new Set((await idb()) || []);
	for (let i = 0; i < meta.count; i++) if (!keys.has(`${base}#${i}`)) return false;
	return true;
}
const touchMeta = async (base, meta) => { const idb = await idbReady; idb && idb(base + "#meta", { ...meta, ts: Date.now() }); };   // LRU touch（待たない）
// メッシュ typed array の合計バイト＝GPU頂点バッファ量のほぼ等身大の proxy（rendererはこれをbufferDataで上げる）。
// IDBの容量表示と、main の GPU常駐バイト予算LRU（ackに同乗）の両方がこの一つの物差しを使う。
const batchBytes = batches => batches.reduce((s, b) => s + Object.values(b).reduce((t, v) => t + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0), 0);
// 区のメッシュ実バイト（cache に居なくても覚えておく）＝main の GPU常駐バイト予算LRU の物差し。
// cache を持たない構成（lowMem/mid）でも 200MB の保守見積り（PLATEAU_BYTES_FALLBACK）でなく実測が返る。
const meshBytes = new Map();
// ?mem=1：過渡メモリの実測を main へ。HUDの常駐台帳（GPU常駐＋タイル＋標高）に乗らないのは
// ①この worker 内 cache ②ロード中に keep[] が抱える区の全量 ③保存失敗時の pending — の3つ。
// 既定は memOn=false＝postMessage も加算も一切走らない（計測コストゼロ）。
let memOn = false;
const memLive = new Map();   // base → 進行中ロードが RAM に抱えているバイト（完了/中断で消す）
const cacheBytes = () => [...cache.values()].reduce((s, c) => s + batchBytes(c.batches.filter(Boolean)), 0);
const memReport = () => { if (memOn) self.postMessage({ type: "membytes", cache: cacheBytes(), live: [...memLive.values()].reduce((a, b) => a + b, 0) }); };
const memAdd = (base, b) => { if (memOn && b) { memLive.set(base, (memLive.get(base) || 0) + b); memReport(); } };
const memDone = base => { if (memOn && memLive.delete(base)) memReport(); };
// LRU退避＋孤児掃除。keepBase＝いま書いている区（退避対象にしない＝budget が極端に小さい環境でも自己破壊しない）。
// force＝QuotaExceeded からの緊急退避（budget を待たず最古1区を落とす）。
// 孤児＝meta の無い base の `#i` 残骸（書き途中のクラッシュ/旧quota失敗の遺物）。台帳（meta の bytes 合計）に
// 映らないまま quota を食い、以後の保存を連鎖失敗させる＝ここで一掃する。
async function idbEvict(keepBase, force = false) {
	const idb = await idbReady; if (!idb) return;
	const keys = (await idb()) || [];
	const metaBases = new Set(), entries = [];
	let totalBytes = 0;
	for (const k of keys) if (typeof k === "string" && k.endsWith("#meta")) {
		const m = await idb(k).catch(() => null);
		const b = k.slice(0, -"#meta".length);
		metaBases.add(b);
		if (m) { entries.push({ base: b, ts: m.ts || 0, count: m.count || 0, bytes: m.bytes || 0 }); totalBytes += m.bytes || 0; }
	}
	let orphans = 0;
	for (const k of keys) {
		if (typeof k !== "string" || k.endsWith("#meta")) continue;
		const h = k.lastIndexOf("#"); if (h < 0) continue;
		if (!metaBases.has(k.slice(0, h))) { await idb(k, null); orphans++; }
	}
	// OPFS側の孤児＝meta の無い base のバッチファイル（書き途中クラッシュの遺物）。台帳外で quota を食う点はIDB孤児と同じ。
	if (ofs) for (const b of await ofs.bases().catch(() => new Set())) {
		if (!metaBases.has(b) && b !== keepBase) orphans += await ofs.delBase(b);
	}
	if (orphans) console.log("[plateau] 孤児掃除", orphans, "records");
	entries.sort((a, b) => a.ts - b.ts);
	let freed = 0;
	for (const old of entries) {
		if (!force && totalBytes <= idbBudget) break;
		if (old.base === keepBase) continue;
		await idb(old.base + "#meta", null);
		for (let i = 0; i < old.count; i++) await idb(`${old.base}#${i}`, null);
		if (ofs) await ofs.delBase(old.base);   // 置き場がどちらでも冪等に両方掃く（fs印を見ずに済む＝残骸ゼロ）
		totalBytes -= old.bytes; freed++;
		console.log("[plateau] IDB退避（LRU）", old.base);
		if (force && freed >= 1 && totalBytes <= idbBudget) break;   // 緊急時は最低1区で切り上げ（書き込み再試行が裁く）
	}
}
async function idbPurge() {
	const idb = await idbReady;
	const keys = idb ? (await idb()) || [] : [];
	for (const k of keys) await idb(k, null);
	let n = keys.length;
	if (ofs) n += await ofs.purge().catch(() => 0);
	return n;
}

// 協調キャンセル：main が「もう要らない」と確定した base を積む。worker は
// tileset走査・タイルfetch・バッチ境界の3点で旗を見て打ち切る。部分結果は描画へ送らずIDBにも書かない。
const cancelled = new Set();
// fast/slow の2レーン制：視界が確定した現地点＝fast（並行8・即送信）、視界から外れた在庫ロード＝slow
// （並行1本＋間隔空け＝帯域/CPUを現地点へ明け渡す。描画への送信も保留）。slow のまま完走したら
// IDB＋（mainが）非表示常駐へ＝「途中通ってきた区」は捨てずに、さりげなく仕込みに変わる。
// 戻ってきたら promote＝fast 復帰し送信バックログも再開。
const lane = new Map();   // base → "fast" | "slow"
// 動的再ソート用の最新カメラ位置（main が移動中に随時放送）。バッチ境界で残タイルを並べ直す＝
// 大きい区の中でも「今見ている側」から立つ。
let latestCam = null;

// ロード本体：葉タイル収集→カメラ近傍順ソート→バッチごとにデコード→完成次第 render worker へ直送（逐次表示）。
// メモリ→IDB→ネットワークの3段。IDBヒット時もバッチ逐次送信＝プログレッシブ表示のまま。
// 返り値: true=完了 / false=空データ / "cancelled"=視野離脱キャンセル（main は failed 扱いにしない）。
async function loadPlateau(base, tiles, ward, wardBbox, camCenter, preload = false, brid = false) {
	if (cache.has(base)) {
		const c = cache.get(base);
		cache.delete(base); cache.set(base, c);   // LRU touch（最近使用へ）
		console.log("[plateau] キャッシュ命中（fetch/解凍スキップ）", base);
		if (!preload) for (let bi = 0; bi < c.batches.length; bi++) await sendBatch(ward, bi, c.batches[bi], c.mask, c.wardBbox);   // クレジット待ち＝滞留を頭打ちに
		return true;
	}
	await fsReady;   // OPFS の可否が確定してから台帳を検分（init 直後の初回ロードとの競争を断つ）
	// ── far-DB導出の要否（裁定2026-08-04＝復元時にも導出・再焼き不要）：#far が無い/形式・閾値が変わった時だけ、
	// このロードのついでに各バッチへ farBoxesOf を掛けて累積し、全バッチを本体込みで見られた場合のみ保存 ──
	const idbF = await idbReady;
	const farStored = (!brid && wardBbox && idbF) ? await idbF(base + "#far").catch(() => null) : null;
	let farAcc = (!brid && wardBbox && idbF && (!farStored || farStored.ver !== FAR_VER || farStored.h !== FAR_MIN_H)) ? [] : null;
	let farOk = true;   // headerOnly読み等で本体を見ていないバッチがあれば false＝保存しない（次の完全パスが受ける）
	const farSave = async (label) => {
		if (!farAcc || !farOk) return;
		const flat = new Float32Array(farAcc.length * 5);
		farAcc.forEach((b, i) => flat.set(b, i * 5));
		try {
			await idbF(base + "#far", { ver: FAR_VER, h: FAR_MIN_H, boxes: flat, ward, ts: Date.now() });
			console.log(`[plateau] far-DB保存 ${ward} ${farAcc.length}棟 (${label})`);
			self.postMessage({ farReady: { name: ward } });   // main が farMissed を解除＝次の選抜で点灯
		} catch { /* 保存失敗＝次のロードが再試行 */ }
		farAcc = null;
	};
	// ── 完全焼きのストリーミング復元：1バッチ 読む→送る→手放す（区全量をRAMに積まない＝温読了時ピークの根治）──
	// 滞留はクレジット（CREDIT_MAX×バッチ）で頭打ち。欠け（並行退避等）はそこで打ち切り→下の部分再開が差分で受ける。
	const whole = await loadMeta(base, brid);
	if (whole && !whole.partial) {
		if (preload) {
			if (await storedComplete(base, whole)) { touchMeta(base, whole); return true; }   // 本体は読まない（存在確認のみ）
		} else {
			// 復元の「ついで導出」は数値キー溶接とセットで維持（2026-08-04夜の二転）：一度farBakeキューへ全面移管
			// したが、それは同じ区を後から全量読み直す＝flyToのたび二度読みのchurn（+1GB/飛行の一因）。メッシュが
			// 手元にある今ここで導出するのが総量最小。旧・文字列キー溶接の数百MB/バッチ一時ゴミは数値化で根治済み。
			const keep = CACHE_MAX ? [] : null;   // desktop＝worker内cache用に保持／低メモリ＝送ったら手放す
			let bi = 0;
			for (; bi < whole.count; bi++) {
				const mesh = await readStored(base, whole.fs, bi);
				if (!mesh) break;
				if (farAcc) farAcc.push(...farBoxesOf(mesh));   // transferで手放す前に導出（旧焼き→#far の育成・追加I/Oゼロ）
				if (keep) { keep.push(mesh); memAdd(base, batchBytes([mesh])); }
				await sendBatch(ward, bi, mesh, whole.mask ?? null, whole.wardBbox ?? null, !keep);   // !keep＝transferで手放す
			}
			if (bi === whole.count) {
				console.log("[plateau] 焼き命中（streaming復元・fetch/解凍/変換スキップ）", base, `(${whole.count} batches)`);
				farSave("復元");   // 待たない＝表示経路を塞がない
				touchMeta(base, whole);
				meshBytes.set(base, whole.bytes || batchBytes(keep || []));   // 常駐LRUの物差し（cache 不在構成でも実測を返す）
				if (keep) {
					cache.set(base, { batches: keep, mask: whole.mask ?? null, wardBbox: whole.wardBbox ?? null });
					if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
					memReport();
				}
				return true;
			}
			console.warn("[plateau] 焼きに欠け→差分再開へ", base, `(${bi}/${whole.count})`);   // 送信済みぶんは名前一致で再送上書き＝冪等
		}
	}
	// ここからネットワーク経路＝遅い（fetch＋Draco解凍で地区あたり数秒〜数十秒）。進捗を main へ流す。
	// scan＝カタログ(tileset.json)走査枚数、done/total＝タイル単位（バッチ単位だと1歩が数秒＝止まって見える）。
	// 完了/失敗の消灯は main が ack で行う＝消し忘れが構造的に無い。preload＝IDBに貯めるだけ（描画へ送らない）。
	const prog = p => self.postMessage({ prog: { name: ward, ...p } });
	const stop = () => !preload && cancelled.has(base);   // 協調キャンセルの旗（プレロードは見ない＝完走）
	const laneOf = () => lane.get(base) ?? "fast";   // 既定fast。demote/promote は main（autoPlateau）が視界確定時に切り替える
	prog({ scan: 0 });

	// ── 部分再開：前回の中断（タブ切替/jetsam/テーマreload）までの成果を土台に「続きから」──
	// 旧・全バッチ完走後の一括保存は「中断＝全損」＝iPhone では区が一生貯まらなかった。
	// 保存済みバッチはストリーミングで即座に描画へ（読む→送る→手放す）、残りタイルだけをネットワークから。
	// 上の streaming 復元が欠けで落ちた complete も、ここで tiles 差分の再開に化ける（meta は partial/complete 両用）。
	const part = await loadMeta(base, brid);
	const wardFs = part ? part.fs : (ofs ? "opfs" : undefined);   // 焼き途中の区は置き場を変えない（混在させない）。新規区はOPFS
	const wardMask = wardBbox
		? (part?.mask?.length === MASK_N * MASK_N ? part.mask : new Uint8Array(MASK_N * MASK_N))
		: null;   // 区単位で累積（wardBbox 無し=デバッグ直指定時はマスク無し）。再開時は保存済みマスクの上へ
	const keep = CACHE_MAX ? [] : null;   // desktop＝完走後の worker内cache 用に全量保持／低メモリ＝保持しない（保存が再送を受ける）
	const pending = new Map();   // 保存失敗(idbFail)時だけの未送信RAM退避＝「書けない環境でも表示は完走する」旧・全量RAM保持の代替
	const doneTiles = new Set();
	let batchCount = 0, sentCount = 0, idbBytes = 0;   // sentCount＝送信済みバッチ数（slow中は保留＝batchCount と乖離する）
	// 未送信バックログ（slow期間の在庫・部分再開の頭）を順に送る。保持していないぶんは保存から読み戻す＝RAMに積まない。
	// force＝完走時の送り切り（slowでも送る）。justIdx/justMesh＝直前に読み/デコードしたバッチ（保存直後の再読を省く）。
	// 命名 `${ward}#${bi}` と送信順は sentCount の単調前進が守る（lane が途中で振れても欠番・入替は出ない）。
	const flush = async (force = false, justIdx = -1, justMesh = null) => {
		if (!force && laneOf() !== "fast") return;
		while (sentCount < batchCount) {
			let m = keep ? keep[sentCount] : pending.get(sentCount);
			if (!m && sentCount === justIdx) m = justMesh;
			if (!m) m = await readStored(base, wardFs, sentCount);
			if (!m) { console.warn("[plateau] 送出欠け（保存失敗区間）", ward, sentCount); break; }
			if (keep && keep[sentCount] !== m) { keep[sentCount] = m; memAdd(base, batchBytes([m])); }   // 再読ぶんの穴埋め＝完走時の cache 一式を揃える（!==＝既に居る物の再代入は台帳に二重計上しない）
			if (pending.delete(sentCount)) memAdd(base, -batchBytes([m]));   // RAM在庫を送り切った＝過渡から降りる（transfer前に数える＝送った後は detached で 0）
			await sendBatch(ward, sentCount, m, wardMask, wardBbox, !keep);   // !keep＝transferで手放す（以後 m は触らない）
			sentCount++;
		}
	};
	if (part) {
		for (let bi = 0; bi < part.count; bi++) {
			// 差分計算に要るのは tiles だけ。fast は本体ごと読んで即送り、slow/preload はヘッダだけ＝読みの山を作らない
			const headerOnly = preload || laneOf() !== "fast";
			const mesh = await readStored(base, wardFs, bi, headerOnly);
			if (!mesh?.tiles) break;   // 欠け/旧形式＝ここまでを土台に（以降のタイルは差分fetch）
			if (farAcc) { if (mesh.pos) farAcc.push(...farBoxesOf(mesh)); else farOk = false; }   // ヘッダ読み＝本体未見＝このパスでは#far保存しない
			for (const u of mesh.tiles) doneTiles.add(u);
			idbBytes += batchBytes([mesh]) || mesh.bytes || 0;   // headerOnly(OPFS)はファイルサイズ代用＝台帳の物差しを保つ
			batchCount++;
			if (keep && !headerOnly) { keep[bi] = mesh; memAdd(base, batchBytes([mesh])); }
			if (!preload) await flush(false, bi, headerOnly ? null : mesh);
		}
		if (batchCount) console.log("[plateau] 部分再開", base, `(${batchCount} batches・${doneTiles.size} tiles 済)`);
	}

	let leaves;
	if (tiles) leaves = tiles.map(u => ({ uri: resolveUrl(base, u), center: null }));
	else {
		// REPLACE refine：親(粗)と子(詳細)が同じ場所を覆う→両方読むと重なって z-fight(マダラ)。子を持たない「葉」だけ読む。
		let scanned = 0;
		leaves = await collectLeafTiles(base + "tileset.json", 0, () => prog({ scan: ++scanned }), stop);
		console.log("[plateau] 葉タイル:", leaves.length, "枚");
	}
	if (stop()) { console.log("[plateau] キャンセル（視野離脱・走査段階）", ward); return "cancelled"; }
	const totalTiles = leaves.length;
	if (doneTiles.size) leaves = leaves.filter(t => !doneTiles.has(t.uri));   // 保存済みタイルは読まない（差分だけ）
	// カメラ近傍から遠方の順に＝最初のバッチが「目の前」になる。center 不明のタイルは末尾。
	if (camCenter) {
		const d2 = t => t.center ? (t.center[0] - camCenter[0]) ** 2 + (t.center[1] - camCenter[1]) ** 2 : Infinity;
		leaves.sort((a, b) => d2(a) - d2(b));
	}
	console.log("[plateau] 読込", leaves.length, part ? `tiles（差分。全${totalTiles}枚中）←` : "tiles ←", base);
	let tilesDone = totalTiles - leaves.length;
	prog({ done: tilesDone, total: totalTiles });

	// ── 逐次書き：バッチ完成のたび即保存（本体＝wardFs の置き場・tiles 同梱＝再開の差分計算用。台帳＝IDB）。
	// meta は partial:true で毎バッチ更新＝どこで死んでも「meta が指す範囲」は常に有効。
	// QuotaExceeded は最古区を緊急退避して1回だけ再試行、それでも駄目なら以後この区は書かない（表示は継続）。
	let idbFail = false;
	const putBatch = async (i, mesh, uris) => {
		const idb = await idbReady; if (!idb || idbFail) return;
		const nb = idbBytes + batchBytes([mesh]);
		const write = async () => {
			if (wardFs === "opfs") await ofs.put(base, i, { ...mesh, tiles: uris });   // 1ファイル=1バッチ・書いたら即close
			else await idb(`${base}#${i}`, { ...mesh, tiles: uris });
			await idb(base + "#meta", { ver: IDB_FMT_VER, partial: true, count: i + 1, mask: wardMask, wardBbox, brid: !!brid, ts: Date.now(), bytes: nb, fs: wardFs });
		};
		try { await write(); idbBytes = nb; }
		catch (e) {
			if (e?.name === "QuotaExceededError") {
				await idbEvict(base, true).catch(() => {});
				try { await write(); idbBytes = nb; return; } catch (e2) { e = e2; }
			}
			idbFail = true;
			console.warn("[plateau] IDB書込停止（この区は表示のみ継続）", e?.message ?? e);
		}
	};

	let remaining = leaves, sortedFor = null;   // 前方から消費。カメラ更新があればバッチ境界で残りを並べ直す
	while (remaining.length) {
		if (stop()) { console.log("[plateau] キャンセル（視野離脱）", ward, `${totalTiles - remaining.length}/${totalTiles} tiles で打ち切り`); return "cancelled"; }
		if (latestCam && latestCam !== sortedFor) {   // 参照比較＝放送があった時だけ再ソート。区の中でも「今見ている側」から立つ
			sortedFor = latestCam;
			const c = latestCam, d2 = t => t.center ? (t.center[0] - c[0]) ** 2 + (t.center[1] - c[1]) ** 2 : Infinity;
			remaining = remaining.slice().sort((a, b) => d2(a) - d2(b));
		}
		const slice = remaining.slice(0, BATCH_TILES);
		remaining = remaining.slice(BATCH_TILES);
		const mesh = await decodeBatch(base, slice, wardMask, wardBbox, () => prog({ done: ++tilesDone, total: totalTiles }), brid, stop, laneOf);
		if (stop()) { console.log("[plateau] キャンセル（視野離脱・部分バッチ破棄）", ward); return "cancelled"; }   // 中断バッチは歯抜け＝送らない
		if (!mesh) continue;
		if (farAcc) farAcc.push(...farBoxesOf(mesh));   // 新規デコード分もfar-DBへ累積（flushのtransferより前）
		const bi = batchCount++;
		const tris = mesh.idx.length / 3;   // ログ用に先へ退避（下の flush が transfer で手放すと detached＝0 に見える）
		await putBatch(bi, mesh, slice.map(t => t.uri));   // 失敗タイルも消費扱い＝完走時と同じ「歯抜けは再訪しない」規約
		if (keep) keep[bi] = mesh;
		else if (idbFail) pending.set(bi, mesh);   // 書けない環境の在庫だけRAM退避（書けた分は保存が再送を受ける）
		if (keep || idbFail) memAdd(base, batchBytes([mesh]));
		// fast lane のみ即送信（slow＝在庫化中は保留。promote で fast に戻った瞬間このバックログ送出が追いつく）
		if (!preload) await flush(false, bi, mesh);
		console.log(`[plateau] batch ${batchCount} (${totalTiles - remaining.length}/${totalTiles} tiles) tris=${tris}${laneOf() === "slow" ? " [slow]" : ""}`);
	}
	if (!batchCount) return false;   // 葉0枚/全バッチ失敗＝空データ。警告は main 側で一回だけ（廃止区の残骸等）
	meshBytes.set(base, idbBytes || batchBytes((keep || []).filter(Boolean)));   // 常駐LRUの物差し（cache 不在構成でも実測を返す）
	// slow のまま完走した分も含め、未送信バックログを送り切る＝GPUに全量が揃う（main は "demoted" を受けて非表示常駐へ）。
	if (!preload) await flush(true);
	if (CACHE_MAX && keep && keep.filter(Boolean).length === batchCount) {   // 穴あり（送出欠け・preloadのヘッダ読み等）は cache しない＝再訪は保存が受ける。filter＝疎配列の穴を every が素通りする罠を避ける
		cache.set(base, { batches: keep, mask: wardMask, wardBbox });   // デコード結果をこのworker内に保持＝再訪でfetch/Draco解凍を丸ごと省略
		if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // LRU: 最古を退避
		memReport();
	}
	console.log("[plateau] 完了", base, `(${batchCount} batches)`);
	await farSave("完走");   // 全バッチ本体を見た時だけ中身がある（farOk）。数十KB＝一瞬
	// 完成印＝partial を外した meta（バッチ本体は逐次書き済み）＋LRU退避・孤児掃除。表示経路は待たせない。
	const storing = (async () => {
		const idb = await idbReady; if (!idb || idbFail) return;   // idbFail＝部分metaのまま残す（次回再開が続きを試す）
		try {
			await idb(base + "#meta", { ver: IDB_FMT_VER, count: batchCount, mask: wardMask, wardBbox, brid: !!brid, ts: Date.now(), bytes: idbBytes, fs: wardFs });
			console.log("[plateau] 保存完了", base, `(${batchCount} batches)`);
			await idbEvict(base);
		} catch (e) { console.warn("[plateau] 保存失敗（表示には影響なし）", e); }
	})();
	if (preload) await storing;   // プレロードの本旨はIDB永続化＝書き終わるまで ack しない（ackより先にモーダルが一覧を引くと「済」にならない）
	if (!preload && lane.get(base) === "slow") return "demoted";   // slow のまま完走＝視界外の在庫。main が非表示常駐へ落とす（表示はしない）
	return true;
}

// 同一 base の並行要求（手動__plateau と autoPlateau の競合等）を1つのデコードに合流させる。
// onmessage は async＝先行デコードの await 中に後続メッセージが走り出し cache 未登録のまま二重デコードになるのを防ぐ。
const inflight = new Map();

self.onmessage = async (e) => {
	if (e.data.type === "init") {
		meshPort = e.data.meshPort;
		meshPort.onmessage = ev => {   // render worker の消化ack＝クレジット返却＋器の返却（バッファ返却プール）
			const d = ev.data; if (!d) return;
			if (d.recycle) for (const b of d.recycle) poolPut(b);
			if (d.drained) onDrained();
		};
		if (e.data.lowMem || e.data.mid) POOL_MAX = 16 << 20;
		initFs(e.data.noOpfs);   // バッチ本体の置き場（OPFS可否の確定は fsReady。ロード側が await して待つ）
		if (e.data.farH > 0) FAR_MIN_H = e.data.farH;   // 遠景far-DBの高さ閾値（?farh=N・既定200m）
		memOn = !!e.data.mem;   // ?mem=1＝過渡バイトの報告を有効化（既定は完全無音＝計測コストゼロ）
		if (e.data.mid) CACHE_MAX = 0;   // 非力機（内蔵GPU/低コア）＝worker内キャッシュなし＝ロード中の全量保持(keep)も同時に消える（送ったら手放す）。再訪はOPFS
		if (e.data.lowMem) { CACHE_MAX = 0; BATCH_TILES = 8; TILE_CONCURRENCY = 4; }   // 低メモリ端末＝worker内キャッシュなし（区一式の常駐がタブ落ちの下駄になる。再訪はIDB）＋バッチ8タイル＝デコード過渡・IDBレコード（1書込のcommitバースト）・送信ペイロードの粒度を半減（Kenji指定 2026-07-29「IDB書き込みの粒度を下げる」。draw call 増は LOW_MEM=同時1区で相殺）
		return;
	}
	if (e.data.type === "cancel")  { cancelled.add(e.data.base); return; }             // 協調キャンセル（旗を立てるだけ＝各ループが自分で降りる）
	if (e.data.type === "demote")  { lane.set(e.data.base, "slow"); return; }          // 視界外の在庫化＝slow lane（並行1・送信保留）
	if (e.data.type === "promote") { lane.set(e.data.base, "fast"); cancelled.delete(e.data.base); return; }   // 再訪＝キャンセル旗を降ろして即再開（メモリ上のバッチから続行）＋fast 復帰。既に降りた後なら無害（main が改めて読み直す）
	if (e.data.type === "cam")     { latestCam = e.data.center; return; }              // 動的再ソート用の最新カメラ（バッチ境界で反映）
	if (e.data.type === "far")     { sendFar(e.data.base, e.data.ward); return; }      // 遠景far-DB点灯要求（#far無し＝farMiss返信）
	if (e.data.type === "farBake") { farBake(e.data.base, e.data.ward); return; }      // far育成＝完走焼きから#farだけ導出（表示しない）
	if (e.data.type === "purge") { cache.clear(); await fsReady; const n = await idbPurge(); console.log("[plateau] キャッシュ全消去", n, "records"); return; }
	if (e.data.type === "idbList") {   // データ管理モーダル用：IDBのメタ一覧（全workerが同一DBを見る＝どの1本に聞いてもよい）
		const idb = await idbReady, items = [];
		const keys = idb ? (await idb()) || [] : [];
		for (const k of keys) if (typeof k === "string" && k.endsWith("#meta")) {
			const m = await idb(k).catch(() => null);
			if (m) items.push({ base: k.slice(0, -"#meta".length), count: m.count || 0, bytes: m.bytes || 0, ts: m.ts || 0, partial: !!m.partial });
		}
		self.postMessage({ type: "idbList", items });
		return;
	}
	if (e.data.type === "idbDelete") {   // 地区単位の削除：IDBレコード＋OPFSファイル＋この worker のメモリキャッシュ（base ルーティングで必ず持ち主に届く）
		const base = e.data.base;
		cache.delete(base);
		const idb = await idbReady;
		let n = 0;
		if (idb) for (const k of (await idb()) || []) if (typeof k === "string" && k.startsWith(base + "#")) { await idb(k, null); n++; }
		await fsReady;
		if (ofs) n += await ofs.delBase(base).catch(() => 0);
		console.log("[plateau] IDB削除", base, n, "records");
		self.postMessage({ type: "idbDeleted", base, n });
		return;
	}
	const { id, base, tiles, name, wardBbox, camCenter, preload, brid } = e.data;
	try {
		cancelled.delete(base);   // 新規要求＝キャンセル旗を降ろす（再訪はゼロから正規に読み直す）
		if (!preload) lane.set(base, "fast");   // 新規の表ロードは fast lane から

		let ent = inflight.get(base);
		if (!ent) {
			ent = { p: loadPlateau(base, tiles, name, wardBbox, camCenter, !!preload, !!brid), preload: !!preload };
			inflight.set(base, ent);
			ent.p.finally(() => inflight.delete(base)).catch(() => {});   // 掃除専用の枝＝拒否はここで握り潰す（本流の reject は下の await が受ける）
		}
		let ok = await ent.p;
		// プレロード進行中に表示要求が合流した場合、合流先は描画へ送っていない＝完了後に改めて（キャッシュ命中＝即）送る。
		if (ok === true && ent.preload && !preload) ok = await loadPlateau(base, tiles, name, wardBbox, camCenter, false, !!brid);
		// bytes＝この区のメッシュ実バイト＝main のGPU常駐バイト予算LRUの物差し。cache 命中時はその実体から、
		// cache を持たない構成（lowMem/mid）は meshBytes の記録から返す（0を返すと main は 200MB の保守見積りに落ちる）。
		self.postMessage({ id, ok, bytes: cache.has(base) ? batchBytes(cache.get(base).batches) : (meshBytes.get(base) || 0) });
	} catch (err) {
		self.postMessage({ id, ok: false, error: err.message });
	} finally {
		memDone(base);   // ?mem=1：この区の過渡（keep/pending）は完了・中断とも手を離れた
	}
};
