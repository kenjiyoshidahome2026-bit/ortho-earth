// PLATEAU バッチデコードの実体（②区内デコード並列化・2026-08-28 に plateauworker.js から切り出し）。
// 「バッチ＝タイル列の一部」を単一メッシュへ煮る自己完結パイプラインだけを持つ：
// fetch→b3dm/Draco解凍→ECEF→世界座標→重複面dedup→剛体接地→LOD焼き→RTE→被覆マスク断片。
// 呼び出し元は2系統＝plateauworker（従来の直列経路・lowMem/mid/slow/preload）と plateaudecoder（ハイスペック機の
// 並列プール経路）。経路差はゼロ＝同じ関数を別コアで回すだけ。区単位の状態（IDB/OPFS・far-DB・クレジット・
// レーン）は一切持たない。環境（楕円体・タイル並行数）は setDecodeEnv で注入＝各workerのinitが責任を持つ。
import { parse as loadParse } from "@loaders.gl/core";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";

const R2D = 180 / Math.PI;
export const MASK_N = 256;           // 区単位の被覆マスク解像度（基図建物を伏せるセル）
const LOD_H = [0, 3, 6, 12, 24, 48];   // LOD段の高さ閾値(m)。renderer が「画面上1px未満の建物」を先頭countの打ち切りで捨てる
let TILE_CONCURRENCY = 8;   // バッチ内のタイル並行fetch/デコード数。直列だと往復レイテンシが積み上がり支配的になる。
let ELL = false, EARTH_W = 6371000;   // 楕円体モード（?ell=1）＝β単位球×a（plateauworker と同じ分解）。既定は球
const ELL_RAX = 1 - 1 / 298.257223563;   // b/a
export function setDecodeEnv({ ell, tileConcurrency } = {}) {
	if (ell !== undefined) { ELL = !!ell; EARTH_W = ELL ? 6378137 : 6371000; }
	if (tileConcurrency) TILE_CONCURRENCY = tileConcurrency;
}

// ECEF(WGS84)→geodetic(lon,lat[rad],h[m])。
// 球面近似(geocentric lat=atan2(z,p))も試したが、緯度が最大0.2°程度ズレて建物群が基図から丸ごと外れる
// （実測で本来位置より南へ約20km）ため不採用＝地表座標そのものは楕円体で正確に解かないといけない。
// 反復はNewton法。地表近傍(h<数km)では2回で高さ誤差0.2mm未満に収束する（1回だと0.1m級誤差が残りdedupの
// 丸め精度(0.1m)と衝突しうるため2回が下限）。
export function ecef2geo(x, y, z) {
	const a = 6378137, e2 = 0.00669437999014;
	const p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 2; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}

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
export const fetchJSON = (url) => fetchBody(url, r => r.json(), 15000);
export const fetchAB = (url) => fetchBody(url, r => r.arrayBuffer(), 25000);

// GLB 修復（EXT_meshopt_compression を使う配信のみ・PLATEAU は非該当＝素通り）：
// 3DBAG（オランダ）の glb は、インデックス用と頂点用の bufferView が どちらも byteOffset 省略(=0) のまま
// 同じ fallback バッファ（長さは両者の合計ぴったり）を指す。CesiumJS/three.js は各 view を個別バッファへ
// 展開するので平気だが、loaders.gl は fallback バッファの実体へ byteOffset で書き戻すため、後から展開された
// 頂点データがインデックス領域を上書きする＝頂点は正しいのにインデックスだけ壊れる（実測：最大index 42.9億／
// 頂点10.9万＝画面いっぱいの破片）。fallback バッファ内で積み上げオフセットを振り直せば衝突しない。
function fixMeshoptGlb(ab) {
	const dv = new DataView(ab);
	if (ab.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) return ab;   // "glTF" でなければ b3dm 等＝触らない
	const jsonLen = dv.getUint32(12, true);
	let json;
	try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jsonLen))); } catch { return ab; }
	if (!(json.extensionsUsed || []).includes("EXT_meshopt_compression")) return ab;
	const next = new Map();
	let patched = 0;
	for (const bv of json.bufferViews || []) {
		if (!bv.extensions?.EXT_meshopt_compression) continue;
		const at = next.get(bv.buffer) || 0;
		if ((bv.byteOffset || 0) !== at) { bv.byteOffset = at; patched++; }
		next.set(bv.buffer, at + bv.byteLength);
	}
	if (!patched) return ab;
	let s = JSON.stringify(json);
	while (s.length % 4) s += " ";   // JSONチャンクは4B整列（末尾は空白詰めが仕様）
	const jb = new TextEncoder().encode(s);
	const rest = ab.byteLength - (20 + jsonLen);
	const out = new ArrayBuffer(20 + jb.length + rest);
	const o8 = new Uint8Array(out), odv = new DataView(out);
	o8.set(new Uint8Array(ab, 0, 20));
	odv.setUint32(8, out.byteLength, true); odv.setUint32(12, jb.length, true);
	o8.set(jb, 20);
	o8.set(new Uint8Array(ab, 20 + jsonLen, rest), 20 + jb.length);
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
// wardMask には三角形が触れた区単位セルを累積（wardBbox 座標系・null可＝プール経路は maskCells だけ返し発注元が累積）。
// brid＝橋梁モード：①接地を「成分ごと」でなく「バッチ最低点」に＝桁・ケーブルが塔と非連結でも海面へ沈まない
// （成分接地だと吊橋の桁が自分の最低点で接地＝水面すれすれに落ちる。バッチ最低点＝橋脚基部≈ジオイド分を
//   一括で差し引くので、部材同士の相対高さが保たれる）②twoSided=1 を焼き込み＝FS が裏面 discard をやめる
// （ケーブル・柵など厚みゼロの開いた面は表裏2枚組で来る→dedup が1枚に潰す→片側から見えなくなるため）。
export async function decodeBatch(base, leaves, wardMask, wardBbox, onTile = null, brid = false, stop = null, laneOf = null) {
	// 中間データは plain JS Array に push しない：バッチで1700万push級になり要素タグ+GCで数秒を失う。
	// プリミティブごとに頂点数が既知なので typed セグメントを作り、バッチ末尾で一括結合（memcpy）する。
	// geo(lon/lat rad)は float64 必須：float32 の相対精度~1e-7 は rad で~0.6m＝dedup の丸め(1e-8rad≈6cm)を壊す。
	const segs = [];   // { geo:Float64Array, nrm:Int8Array(xyz+pad 4B), idx:Uint32Array }（idx はバッチ通し番号で焼き込み済み）
	let totalV = 0, totalI = 0, minH = Infinity;
	function mergeTile(tile) {
		const tileRtc = tile.rtcCenter || tile.gltf?.extensions?.CESIUM_RTC?.center;
		// 新しめの地区(2025年生成・nusamai-gltf製)はCESIUM_RTC拡張を使わず、mesh参照ノードの translation/matrix に
		// 平行移動を持たせる。node.translation/matrix は頂点POSITIONと同じY-upローカル系＝頂点と一緒に最後に
		// Yup→Zup軸入替(x,-z,y)を通す（生のまま使うと南半球の別地点へ飛ぶ）。
		// 行列は平行移動だけ拾うのでなく丸ごと使う：3DBAG（オランダ）は node.matrix に「量子化された[-1,1]立方体
		// →タイルbbox」の非等方スケール（実測 497×324×3267m）が入っており、平行移動だけだと66kmの塊になる。
		// PLATEAU は線形部が単位行列＝同じ道を通って従来と1ビットも変わらない。mesh(オブジェクト参照)→変換のマップ。
		const xfByMesh = new Map();
		for (const nd of (tile.gltf?.nodes || [])) {
			if (!nd.mesh) continue;
			const M = nd.matrix;
			if (M) xfByMesh.set(nd.mesh, { m: [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]], t: [M[12], M[13], M[14]] });
			else if (nd.translation) xfByMesh.set(nd.mesh, { m: null, t: nd.translation });
		}
		for (const m of (tile.gltf?.meshes || [])) {
			// 2つの原点は座標系が違う＝足す場所も違う（ここを取り違えると建物が世界中に散り、bboxが巨大化して
			// フラスタムカリングが効かなくなる＝日本が丸ごと重くなる。2026-08-11 に一度やった）：
			//   CESIUM_RTC（b3dm の RTC_CENTER）＝既に ECEF ＝ 軸入替の「後」に足す
			//   node の matrix/translation ＝頂点と同じ Y-up ローカル系 ＝ 軸入替の「前」に掛けて足す
			const xf = xfByMesh.get(m) || { m: null, t: [0, 0, 0] };
			const lin = tileRtc ? null : xf.m, tr = tileRtc ? [0, 0, 0] : xf.t;
			const rtcE = tileRtc || [0, 0, 0];
			// 保険：実効原点が地表から明らかに外れていたら(=CESIUM_RTCもnodeの変換も見つからなかった/壊れていた)
			// そのmeshは丸ごと捨てる。ローカル座標をECEF原点近くに置いたまま混ぜるとbbox・接地・マスクまで壊すため。
			const rtcR = Math.hypot(tr[0] + rtcE[0], -tr[2] + rtcE[1], tr[1] + rtcE[2]);
			if (rtcR < 6200000 || rtcR > 6500000) { console.warn("[plateau] mesh dropped (bad rtc origin)", tr, rtcE); continue; }
			// 法線は行列の余因子（=逆転置の定数倍。列ごとに c1×c2, c2×c0, c0×c1）で送る＝非等方スケールでも
			// 面の向きが狂わない。長さは後段で正規化するので定数倍は無害。線形部なし（PLATEAU）なら素通し。
			const cof = lin && [
				lin[4] * lin[8] - lin[5] * lin[7], lin[5] * lin[6] - lin[3] * lin[8], lin[3] * lin[7] - lin[4] * lin[6],
				lin[7] * lin[2] - lin[8] * lin[1], lin[8] * lin[0] - lin[6] * lin[2], lin[6] * lin[1] - lin[7] * lin[0],
				lin[1] * lin[5] - lin[2] * lin[4], lin[2] * lin[3] - lin[0] * lin[5], lin[0] * lin[4] - lin[1] * lin[3]];
			for (const pr of (m.primitives || [])) {
				const acc = pr.attributes?.POSITION; const P = acc?.value; if (!P) continue;
				const NRM = pr.attributes?.NORMAL?.value;
				// KHR_mesh_quantization：normalized な整数配列は [-1,1]（符号付き）/[0,1] へ戻してから行列へ。
				// 3DBAG は int16 normalized。PLATEAU は float32 のメートル＝q=1 で素通し。
				const q = acc.normalized ? (P instanceof Int8Array ? 1 / 127 : P instanceof Uint8Array ? 1 / 255
					: P instanceof Int16Array ? 1 / 32767 : P instanceof Uint16Array ? 1 / 65535 : 1) : 1;
				const qLo = (P instanceof Int8Array || P instanceof Int16Array) ? -1 : 0;   // 符号付き normalized の下限クランプ（仕様）
				const I = pr.indices?.value, n = P.length / 3;
				// 法線は int8 量子化（xyz+pad の4B/頂点＝float32×3 の 1/3）。FS が normalize するので精度 1/127 で十分。
				const geoSeg = new Float64Array(n * 3), nrmSeg = new Int8Array(n * 4);
				// 分岐はループの外で決める（頂点は1タイル10万個級＝ここに三項演算子を置くと素の日本経路まで重くなる）。
				// simple＝PLATEAU 経路（メートルのfloat＋平行移動のみ）＝式は改修前と1文字も変わらない足し算3本。
				// ox/oy/oz＝実効ECEFオフセット（node平行移動は軸入替を先に済ませ、CESIUM_RTC はそのまま足す）。
				const simple = q === 1 && !lin;
				const ox = tr[0] + rtcE[0], oy = -tr[2] + rtcE[1], oz = tr[1] + rtcE[2];
				for (let i = 0; i < n; i++) {
					// local(Y-up)→ECEF：量子化解除 → 変換行列（線形部＋平行移動）→ Yup→Zup(x,-z,y) → geodetic(lon,lat,h)
					let ex, ey, ez;
					if (simple) { ex = P[i*3] + ox; ey = -P[i*3+2] + oy; ez = P[i*3+1] + oz; }
					else {
						const px = q === 1 ? P[i*3] : Math.max(P[i*3] * q, qLo);
						const py = q === 1 ? P[i*3+1] : Math.max(P[i*3+1] * q, qLo);
						const pz = q === 1 ? P[i*3+2] : Math.max(P[i*3+2] * q, qLo);
						const gx = lin ? lin[0] * px + lin[3] * py + lin[6] * pz + tr[0] : px + tr[0];
						const gy = lin ? lin[1] * px + lin[4] * py + lin[7] * pz + tr[1] : py + tr[1];
						const gz = lin ? lin[2] * px + lin[5] * py + lin[8] * pz + tr[2] : pz + tr[2];
						ex = gx + rtcE[0]; ey = -gz + rtcE[1]; ez = gy + rtcE[2];
					}
					const g = ecef2geo(ex, ey, ez);
					if (g[2] < minH) minH = g[2];
					geoSeg[i*3] = g[0]; geoSeg[i*3+1] = g[1]; geoSeg[i*3+2] = g[2];
					// 法線：glTF(Y-up local)→ortho は方向を (nx, ny, -nz)（Yup→Zup＋ECEF→ortho軸swap の合成）。符号は FS で視線側へ。
					// 正規化してから量子化：非単位法線が混じると ×127 が ±127 を越え Int8 で符号が巻き戻る（壁が黒落ち/ちらつき）ため。
					if (NRM) {
						let ax = NRM[i*3], ay = NRM[i*3+1], az = NRM[i*3+2];
						if (cof) { const a = ax, b = ay, c = az;   // 余因子行列で局所→世界（非等方スケール対応。PLATEAUは cof=null＝素通り）
							ax = cof[0] * a + cof[3] * b + cof[6] * c; ay = cof[1] * a + cof[4] * b + cof[7] * c; az = cof[2] * a + cof[5] * b + cof[8] * c; }
						const nx = ax, ny = ay, nz = -az;
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
				const tile = await loadParse(fixMeshoptGlb(ab), Tiles3DLoader, { "3d-tiles": { loadGLTF: true }, gltf: { loadImages: false, excludeExtensions: { EXT_mesh_features: false, EXT_structural_metadata: false, EXT_texture_webp: false } } });
				mergeTile(tile);
			} catch (e) { console.warn("[plateau] tile failed", t.uri, e.message); }
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
		const lon = geo[i*3], lat = geo[i*3+1], cb = Math.cos(lat), sp = Math.sin(lat);
		const hr = (geo[i*3+2] - (brid ? minH : minAlt[find(i)])) / EARTH_W;   // 基部からの相対高さ＝剛体接地（橋梁はバッチ最低点＝部材の相対高さ保存）
		let x, y, z;
		if (!ELL) { const r = 1 + hr; x = cb*Math.cos(lon)*r; y = sp*r; z = cb*Math.sin(lon)*r; }
		else {   // β単位球の面点 u(β) ＋ 測地法線の β空間像 m=(cbcosλ, sinφ/r, cbsinλ) に沿うリフト（S は renderer の mvp が畳む）
			const w = Math.hypot(cb, ELL_RAX * sp), horiz = cb / w + hr * cb;
			x = horiz * Math.cos(lon); y = ELL_RAX * sp / w + hr * sp / ELL_RAX; z = horiz * Math.sin(lon);
		}
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
	if (wardBbox) {   // wardMask=null（デコーダプール経路）でも断片は導出＝累積ORは発注元が maskCells で行う
		const wLo = wardBbox[0] / R2D, wLa = wardBbox[1] / R2D;   // マスク座標系は rad で統一（geo が rad のため）
		const spanLo = (wardBbox[2] - wardBbox[0]) / R2D || 1e-12, spanLa = (wardBbox[3] - wardBbox[1]) / R2D || 1e-12;
		const bm = new Uint8Array(MASK_N * MASK_N);   // このバッチ分だけの塗り
		for (let t = 0; t < outIdx.length; t += 3) {
			const a = outIdx[t], b = outIdx[t+1], c = outIdx[t+2];
			const lo0 = geo[a*3], lo1 = geo[b*3], lo2 = geo[c*3], la0 = geo[a*3+1], la1 = geo[b*3+1], la2 = geo[c*3+1];
			let cx0 = (Math.min(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0, cx1 = (Math.max(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0;
			let cy0 = (Math.min(la0,la1,la2) - wLa) / spanLa * MASK_N | 0, cy1 = (Math.max(la0,la1,la2) - wLa) / spanLa * MASK_N | 0;
			if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N-1) cx1 = MASK_N-1; if (cy1 > MASK_N-1) cy1 = MASK_N-1;
			for (let y = cy0; y <= cy1; y++) { const row = y*MASK_N; for (let x = cx0; x <= cx1; x++) { if (wardMask) wardMask[row+x] = 255; bm[row+x] = 1; } }
		}
		const cells = [];
		for (let i = 0; i < bm.length; i++) if (bm[i]) cells.push(i);
		maskCells = Uint32Array.from(cells);   // バッチは空間的に密＝典型数十〜数百セル（数百B）。永続化にも同乗する
	}
	return { pos: outPos, nrm: outNrm, idx: outIdx, origin, bbox, lodH: LOD_H, lodCounts, twoSided: brid ? 1 : 0, maskCells };
}
