// PLATEAU LOD2 建物メッシュのロード/デコードをメインスレッドから追い出す worker。
// tileset→葉タイル収集→カメラ近傍順ソート→バッチ(64タイル)ごとに b3dm/Draco解凍→ECEF→ortho単位球変換→
// 重複面dedup→RTE delta を行い、完成したバッチから順に render worker へ直結ポートで transfer 送信＝逐次表示。
// 区全体を待たず「目の前のビルが数秒で立ち始める」。被覆マスクは区単位で累積（シェーダのマスクスロットを消費しない）。
// main.js 側は複数のこの worker をプールし、base URL のハッシュで固定ルーティング（同じ地区は常に同じ worker＝内部cacheが効く）。
import { parse as loadParse } from "@loaders.gl/core";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";
import { Cache } from "native-bucket";

const EARTH_M = 6371000;   // main.js の EARTH_M と同値（建物の接地計算に使う単位球換算）
// バッチ/並行度は低メモリ端末で縮小（init lowMem で上書き）：デコードの過渡メモリ（Float64座標+BigInt dedup+
// glTFバッファ）はバッチ規模にほぼ比例＝64タイル/並行8はデスクトップ実測~2.5GB/区で、iOSのタブ予算(~1.4GB)を
// 超え jetsam（デモ上演中のタブ再読み込み＝iPhone 16 Pro 実機で確認）。16タイル/並行4＝ピーク~1/4。
let TILE_CONCURRENCY = 8;   // バッチ内のタイル並行fetch/デコード数。直列だと往復レイテンシが積み上がり支配的になる。
let BATCH_TILES = 32;       // 1バッチのタイル数。小さいほど初表示が速く（＋デコード過渡メモリも比例減）、大きいほどdraw call/RTE origin数が減る。
                            // 64→32（2026-07-27）：デモ中「メモリ14G級」の実害＝過渡~2.5GB/区の半減を優先（バッチ数は倍＝描画影響は軽微）。
const MASK_N = 256;           // 区単位の被覆マスク解像度（基図建物を伏せるセル）
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
async function collectLeafTiles(tilesetUrl, depth = 0, onScan = null, stop = null) {
	if (stop?.()) return [];   // 協調キャンセル：視野離脱した区のカタログ走査を tileset 単位で打ち切る
	onScan && onScan();   // tileset.json 1枚fetchするたびに数える＝「準備中」の沈黙を進捗にする
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
				if (wi > 0) return;                            // slow lane＝並行1本へ縮退（残りの worker は降りる）
				await new Promise(r => setTimeout(r, 250));    // 間隔を空けて帯域/CPUを現地点の fast ロードへ明け渡す
			}
			const t = leaves[ti++];
			try {
				const ab = await (await fetch(t.uri)).arrayBuffer();
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
	return { pos: outPos, nrm: outNrm, idx: outIdx, origin, bbox, lodH: LOD_H, lodCounts, twoSided: brid ? 1 : 0 };
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
// マスクは区単位の累積スナップショット＝renderer 側は毎回丸ごと差し替え（冪等）。
async function sendBatch(ward, bi, mesh, wardMask, wardBbox) {
	await takeCredit();
	const pos = mesh.pos.slice(), nrm = mesh.nrm.slice(), idx = mesh.idx.slice();
	const mask = wardMask ? wardMask.slice() : null;
	const payload = { name: `${ward}#${bi}`, meshData: { pos, nrm, idx, origin: mesh.origin, bbox: mesh.bbox, lodH: mesh.lodH, lodCounts: mesh.lodCounts, twoSided: mesh.twoSided || 0, ward, mask, maskN: MASK_N, maskBbox: wardBbox } };
	const transfers = [pos.buffer, nrm.buffer, idx.buffer];
	if (mask) transfers.push(mask.buffer);
	meshPort.postMessage(payload, transfers);
}

const cache = new Map();   // base URL → { batches, mask, wardBbox }（このworker内のみ有効。再訪はfetch/Draco解凍を丸ごと省略）
let CACHE_MAX = 2;         // 1区あたり~100-160MB（typed array一式）＝無上限だと多区巡回でメモリが積み上がる。LRUで直近2区に制限
                           // （workerは同時4本＝プール全体で最大8区~1GB。同区は base ハッシュで毎回同じ worker＝ヒット率は落ちない）。
                           // 低メモリ端末（init の lowMem）は1区＝スマホのタブ強制終了対策。再訪はIDBが受けるので体感は数秒差

// IDB 永続キャッシュ：GPU直行形式（pos/nrm/idx＋マスク）を区単位で保存＝ページ再読込・再起動後も
// fetch/Draco解凍/座標変換を丸ごと飛ばして数秒で復元（geopbf の PBF+GINT キャッシュと同じ発想）。
// レコードはバッチ単位（`${base}#${i}` 各10〜20MB）＋メタ（`${base}#meta`）。メタが揃って初めて有効＝書き途中の中断は無視される。
// FMT_VER: デコードパイプライン（接地・dedup・軸変換等）を変えたら上げる＝古い形式のキャッシュを自然無効化。
const IDB_FMT_VER = 5;   // v5: 空中部材の借り接地＝非連結の冠・段状屋根・塔屋が海抜0へ落ちる問題の根治（西新宿の「二重」）
                         // v4: 法線int8量子化(4B/頂点＝1/3)＋建物高さ降順のindex並べ替え+LOD表（サブピクセル建物の打ち切り描画）
                         // v3: 接地を建物（連結成分）単位の剛体方式へ＝グリッド場の過小評価による浮き（京都嵯峨野+19〜40m）を根治
// 容量上限：固定の区数でなくブラウザのクォータ（オリジン割当）連動＝デモ機のChromeなら実質制限なしに仕込める。
// 割当の半分まで（MVTタイル・gint等が同じオリジン割当を共有するため）。estimate 不能な環境は従来相当の1.2GBで保守運転。
let idbBudget = 1.2e9;
navigator.storage?.estimate?.().then(e => {
	if (e?.quota) idbBudget = Math.max(e.quota * 0.5, 1.2e9);
	console.log(`[plateau] IDB budget ${(idbBudget / 1e9).toFixed(1)}GB（オリジン割当 ${((e?.quota || 0) / 1e9).toFixed(1)}GB・使用 ${((e?.usage || 0) / 1e9).toFixed(2)}GB）`);
}).catch(() => {});
const idbReady = Cache("GIS/plateau").catch(e => { console.warn("[plateau] IDB無効（メモリキャッシュのみで続行）", e); return null; });

async function idbLoad(base, brid) {
	const idb = await idbReady; if (!idb) return null;
	const meta = await idb(base + "#meta").catch(() => null);
	if (!meta || meta.ver !== IDB_FMT_VER || !!meta.brid !== !!brid) return null;   // brid不一致＝接地方式が違う焼き＝無効（橋梁だけ選択的に作り直せる）
	const batches = [];
	for (let i = 0; i < meta.count; i++) {
		const b = await idb(`${base}#${i}`).catch(() => null);
		if (!b) return null;   // 欠けあり＝無効（次回フルデコードで上書き）
		batches.push(b);
	}
	idb(base + "#meta", { ...meta, ts: Date.now() });   // LRU touch（待たない）
	return { batches, mask: meta.mask ?? null, wardBbox: meta.wardBbox ?? null };
}
// メッシュ typed array の合計バイト＝GPU頂点バッファ量のほぼ等身大の proxy（rendererはこれをbufferDataで上げる）。
// IDBの容量表示と、main の GPU常駐バイト予算LRU（ackに同乗）の両方がこの一つの物差しを使う。
const batchBytes = batches => batches.reduce((s, b) => s + Object.values(b).reduce((t, v) => t + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0), 0);
async function idbStore(base, batches, mask, wardBbox, brid) {
	const idb = await idbReady; if (!idb) return;
	try {
		for (let i = 0; i < batches.length; i++) await idb(`${base}#${i}`, batches[i]);
		// bytes＝データ管理モーダルの容量表示用（概算。旧レコードは未記録＝0）
		const bytes = batchBytes(batches);
		await idb(base + "#meta", { ver: IDB_FMT_VER, count: batches.length, mask, wardBbox, brid: !!brid, ts: Date.now(), bytes });
		// 容量上限：合計バイトが idbBudget（クォータ連動）を超えたら lastUsed 最古の区から丸ごと退避（バッチレコードも道連れ）。
		// いま書いた区は退避対象にしない＝budget が極端に小さい環境でも自己破壊しない。
		const keys = (await idb()) || [];
		const entries = [];
		let totalBytes = 0;
		for (const k of keys) if (typeof k === "string" && k.endsWith("#meta")) {
			const m = await idb(k).catch(() => null);
			if (m) { entries.push({ mk: k, ts: m.ts || 0, count: m.count || 0, bytes: m.bytes || 0 }); totalBytes += m.bytes || 0; }
		}
		entries.sort((a, b) => a.ts - b.ts);
		for (const old of entries) {
			if (totalBytes <= idbBudget) break;
			if (old.mk === base + "#meta") continue;
			const oldBase = old.mk.slice(0, -"#meta".length);
			await idb(old.mk, null);
			for (let i = 0; i < old.count; i++) await idb(`${oldBase}#${i}`, null);
			totalBytes -= old.bytes;
			console.log("[plateau] IDB退避（LRU・容量超過）", oldBase);
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
	const stored = await idbLoad(base, brid);
	if (stored) {
		console.log("[plateau] IDB命中（fetch/解凍/変換スキップ）", base, `(${stored.batches.length} batches)`);
		if (!preload) for (let bi = 0; bi < stored.batches.length; bi++) await sendBatch(ward, bi, stored.batches[bi], stored.mask, stored.wardBbox);
		if (CACHE_MAX) {   // 低メモリ端末(CACHE_MAX=0)はメモリ常駐しない＝IDBが再訪を受ける
			cache.set(base, stored);
			if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
		}
		return true;
	}
	// ここからネットワーク経路＝遅い（fetch＋Draco解凍で地区あたり数秒〜数十秒）。進捗を main へ流す。
	// scan＝カタログ(tileset.json)走査枚数、done/total＝タイル単位（バッチ単位だと1歩が数秒＝止まって見える）。
	// 完了/失敗の消灯は main が ack で行う＝消し忘れが構造的に無い。preload＝IDBに貯めるだけ（描画へ送らない）。
	const prog = p => self.postMessage({ prog: { name: ward, ...p } });
	const stop = () => !preload && cancelled.has(base);   // 協調キャンセルの旗（プレロードは見ない＝完走）
	const laneOf = () => lane.get(base) ?? "fast";   // 既定fast。demote/promote は main（autoPlateau）が視界確定時に切り替える
	prog({ scan: 0 });
	let leaves;
	if (tiles) leaves = tiles.map(u => ({ uri: resolveUrl(base, u), center: null }));
	else {
		// REPLACE refine：親(粗)と子(詳細)が同じ場所を覆う→両方読むと重なって z-fight(マダラ)。子を持たない「葉」だけ読む。
		let scanned = 0;
		leaves = await collectLeafTiles(base + "tileset.json", 0, () => prog({ scan: ++scanned }), stop);
		console.log("[plateau] 葉タイル:", leaves.length, "枚");
	}
	if (stop()) { console.log("[plateau] キャンセル（視野離脱・走査段階）", ward); return "cancelled"; }
	// カメラ近傍から遠方の順に＝最初のバッチが「目の前」になる。center 不明のタイルは末尾。
	if (camCenter) {
		const d2 = t => t.center ? (t.center[0] - camCenter[0]) ** 2 + (t.center[1] - camCenter[1]) ** 2 : Infinity;
		leaves.sort((a, b) => d2(a) - d2(b));
	}
	console.log("[plateau] 読込", leaves.length, "tiles ←", base);
	let tilesDone = 0;
	prog({ done: 0, total: leaves.length });
	const wardMask = wardBbox ? new Uint8Array(MASK_N * MASK_N) : null;   // 区単位で累積（wardBbox 無し=デバッグ直指定時はマスク無し）
	const batches = [];
	let sentCount = 0;                          // render worker へ送信済みのバッチ数（slow中は保留＝batches.length と乖離する）
	let remaining = leaves, sortedFor = null;   // 前方から消費。カメラ更新があればバッチ境界で残りを並べ直す
	while (remaining.length) {
		if (stop()) { console.log("[plateau] キャンセル（視野離脱）", ward, `${leaves.length - remaining.length}/${leaves.length} tiles で打ち切り`); return "cancelled"; }
		if (latestCam && latestCam !== sortedFor) {   // 参照比較＝放送があった時だけ再ソート。区の中でも「今見ている側」から立つ
			sortedFor = latestCam;
			const c = latestCam, d2 = t => t.center ? (t.center[0] - c[0]) ** 2 + (t.center[1] - c[1]) ** 2 : Infinity;
			remaining = remaining.slice().sort((a, b) => d2(a) - d2(b));
		}
		const slice = remaining.slice(0, BATCH_TILES);
		remaining = remaining.slice(BATCH_TILES);
		const mesh = await decodeBatch(base, slice, wardMask, wardBbox, () => prog({ done: ++tilesDone, total: leaves.length }), brid, stop, laneOf);
		if (stop()) { console.log("[plateau] キャンセル（視野離脱・部分バッチ破棄）", ward); return "cancelled"; }   // 中断バッチは歯抜け＝送らない
		if (!mesh) continue;
		batches.push(mesh);
		// fast lane のみ即送信（slow＝在庫化中は保留。promote で fast に戻った瞬間このバックログ送出が追いつく）
		if (!preload && laneOf() === "fast") {
			while (sentCount < batches.length) { await sendBatch(ward, sentCount, batches[sentCount], wardMask, wardBbox); sentCount++; }
		}
		console.log(`[plateau] batch ${batches.length} (${leaves.length - remaining.length}/${leaves.length} tiles) tris=${mesh.idx.length / 3}${laneOf() === "slow" ? " [slow]" : ""}`);
	}
	if (!batches.length) return false;   // 葉0枚/全バッチ失敗＝空データ。警告は main 側で一回だけ（廃止区の残骸等）
	// slow のまま完走した分も含め、未送信バックログを送り切る＝GPUに全量が揃う（main は "demoted" を受けて非表示常駐へ）。
	if (!preload) {
		while (sentCount < batches.length) { await sendBatch(ward, sentCount, batches[sentCount], wardMask, wardBbox); sentCount++; }
	}
	if (CACHE_MAX) {   // 低メモリ端末(CACHE_MAX=0)は完了後に区一式(~100-160MB)をworker RAMへ残さない（IDBが再訪を受ける）
		cache.set(base, { batches, mask: wardMask, wardBbox });   // デコード結果をこのworker内に保持＝再訪でfetch/Draco解凍を丸ごと省略
		if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);   // LRU: 最古を退避
	}
	console.log("[plateau] 完了", base, `(${batches.length} batches)`);
	const storing = idbStore(base, batches, wardMask, wardBbox, brid);   // 永続化（表示経路はバックグラウンド＝待たせない）
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
		meshPort.onmessage = ev => { if (ev.data && ev.data.drained) onDrained(); };   // render worker の消化ack＝クレジット返却
		if (e.data.lowMem) { CACHE_MAX = 0; BATCH_TILES = 16; TILE_CONCURRENCY = 4; }   // 低メモリ端末＝worker内キャッシュなし（区一式の常駐がタブ落ちの下駄になる。再訪はIDB）＋デコード過渡を~1/4に縮小（iOS jetsam対策）
		return;
	}
	if (e.data.type === "cancel")  { cancelled.add(e.data.base); return; }             // 協調キャンセル（旗を立てるだけ＝各ループが自分で降りる）
	if (e.data.type === "demote")  { lane.set(e.data.base, "slow"); return; }          // 視界外の在庫化＝slow lane（並行1・送信保留）
	if (e.data.type === "promote") { lane.set(e.data.base, "fast"); return; }          // 再訪＝fast 復帰（バッチ境界でバックログ送出が追いつく）
	if (e.data.type === "cam")     { latestCam = e.data.center; return; }              // 動的再ソート用の最新カメラ（バッチ境界で反映）
	if (e.data.type === "purge") { cache.clear(); const n = await idbPurge(); console.log("[plateau] キャッシュ全消去", n, "records"); return; }
	if (e.data.type === "idbList") {   // データ管理モーダル用：IDBのメタ一覧（全workerが同一DBを見る＝どの1本に聞いてもよい）
		const idb = await idbReady, items = [];
		const keys = idb ? (await idb()) || [] : [];
		for (const k of keys) if (typeof k === "string" && k.endsWith("#meta")) {
			const m = await idb(k).catch(() => null);
			if (m) items.push({ base: k.slice(0, -"#meta".length), count: m.count || 0, bytes: m.bytes || 0, ts: m.ts || 0 });
		}
		self.postMessage({ type: "idbList", items });
		return;
	}
	if (e.data.type === "idbDelete") {   // 地区単位の削除：IDBレコード＋この worker のメモリキャッシュ（base ルーティングで必ず持ち主に届く）
		const base = e.data.base;
		cache.delete(base);
		const idb = await idbReady;
		let n = 0;
		if (idb) for (const k of (await idb()) || []) if (typeof k === "string" && k.startsWith(base + "#")) { await idb(k, null); n++; }
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
		// bytes＝この区のメッシュ実バイト（成功時は3経路とも cache に居る）。main のGPU常駐バイト予算LRUの実測値。
		// 低メモリ端末(CACHE_MAX=0)は cache 不在＝0 → main側も常駐なしなので使われない。
		self.postMessage({ id, ok, bytes: cache.has(base) ? batchBytes(cache.get(base).batches) : 0 });
	} catch (err) {
		self.postMessage({ id, ok: false, error: err.message });
	}
};
