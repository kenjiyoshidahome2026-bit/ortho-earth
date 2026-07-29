import { index_alos, encodeName, decodeName, bakedJapan, setApiUrl } from "./altpbf.js";
import { Cache } from "native-bucket";

// 日本域 R01 の旧 DSM(ALOS) キャッシュは失効扱い＝DTM(GSI DEM10B・bucket) へ焼き直したため。
// bucket 側は source="GSI DEM10B" で返る＝一度差し替われば以後この判定は素通り。
// 判定は「GSI 銘のあるタイルだけ信用」の向き：source フィールド導入前に焼かれた旧 ALOS タイルは
// source=undefined＝旧判定（"ALOS"で始まる時だけ失効）をすり抜けて DSM が永久に生き残っていた
//（東新橋の屋上斜面＝PLATEAU 接地リフトが旧 DSM を食った実測。札幌は初取得が bucket=DEM10B で無症状）。
const staleDSM = (name, obj) => {
	if (!obj) return false;
	if (String(obj.source || "").startsWith("GSI")) return false;   // 焼き直し済み＝信用
	const [lng, lat, range] = decodeName(name);
	if (range !== 1 || !bakedJapan(lng, lat)) return false;
	// noBake（bucket未収録の印）は bakedJapan の「外」概念だが、bbox 内の外国陸地（韓国・台湾等）にも付く。
	// bbox 内では noBake を信用しない＝毎セッション bucket を確認（load_gepco の decode 事故で日本セルに
	// noBake が毒入りした実害の自己修復。本当に未収録の外国陸地は JAXA 再取得のコスト＝レアケースとして許容）。
	return true;   // GSI 銘なし（ALOS 明記・無記名・noBake とも）＝失効 → bucket(DEM10B) を再確認
};

// ラスタタイルを返すローダー（点サンプラでなく生タイル）。ortho-japan の GPU アトラス用。
// R90/R10=bucket・R01=JAXA（ALOS）を worker で読み、IDB キャッシュ。R01 は ALOS 未整備域では null。
export async function createTileLoader(opts = {}) {
	if (opts.apiUrl) setApiUrl(opts.apiUrl);   // メイン側の bucket/JAXA fetch（index_alos 等）に必要
	// IDB 不可（プライベートブラウズ/破損）は「キャッシュ無しで続行」へ縮退＝標高システムを一発死させない
	//（旧・素の await は reject が createTileLoader ごと落とし、山が永久に平らになる＝iPhone私的モード実症状）。
	// worker 側（altpbf.js load）は元から getCache().catch(()=>null) で同じ縮退＝これで経路が揃う。
	const cache = await Cache("GIS/alt").catch(e => { console.warn("[tileLoader] IDB無効（キャッシュ無しで続行）", e?.message ?? e); return null; });
	let index = cache ? await Promise.resolve(cache("index_alos")).catch(() => null) : null;
	if (!index) { index = await index_alos(); if (cache) Promise.resolve(cache("index_alos", index)).catch(() => {}); }
	const existAlos = (lng, lat) => index[encodeName(lng, lat)];
	// worker プール：1本直列だと初訪問時に視野分のセル（R10で最大64枚）が1枚ずつ順番待ちになり
	// 地形の立ち上がりが数倍遅い。各workerは従来通り1件ずつ直列（応答FIFO＝取りこぼさない）で、
	// プール間はラウンドロビン＝並列。IDBキャッシュ後は経路無関係に即答。
	const NW = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));   // 低コア端末(タブレット)ではプールを絞る＝worker乱立でメインが飢えない
	const mkWorker = () => {
		const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
		w.onerror = e => console.error("[tileLoader] worker error:", e.message || "(opaque)", "@", e.filename || "?", "L" + (e.lineno ?? "?"), e.error || "");
		return w;
	};
	const pool = Array.from({ length: NW }, () => ({ w: mkWorker(), queue: [], busy: false }));
	const inflight = new Map();
	// 応答の看視：worker.js は失敗でも必ず null を返す作りだが、worker「自体」が死ぬと（devサーバ断・
	// モジュール取得404・GPU/メモリ起因のkill等）message も error も返らず、レーンが busy のまま永久に詰まる
	// ＝呼び出し側の pending カウンタが固着（実測:「地形読込中×1」が消えない）。要求ごとにタイムアウトを張り、
	// 発火時は worker を作り直して null で返す＝詰まりを残さない（R01初回=JAXAで数秒かかるため余裕を持つ）。
	const REQ_TIMEOUT = 45000;
	function pump(s) {
		if (s.busy || !s.queue.length) return;
		s.busy = true;
		const { name, res } = s.queue.shift();
		let done = false, tm = 0;
		const finish = obj => {
			if (done) return; done = true;
			clearTimeout(tm);
			s.w.removeEventListener("message", onmsg); s.w.removeEventListener("error", onerr);
			s.busy = false; res(obj); pump(s);
		};
		const onmsg = e => { const obj = e.data; if (obj) cache(name, obj); finish(obj); };
		const onerr = () => {   // worker死＝作り直し（次の要求は新workerで正常化）。この要求は null＝欠けは次の窓替えで再挑戦
			console.warn("[tileLoader] worker応答不能 → 作り直し:", name);
			try { s.w.terminate(); } catch { /* 既に死んでいる */ }
			s.w = mkWorker();
			finish(null);
		};
		tm = setTimeout(onerr, REQ_TIMEOUT);
		s.w.addEventListener("message", onmsg);
		s.w.addEventListener("error", onerr);
		s.w.postMessage({ name, apiUrl: opts.apiUrl });
	}
	let rr = 0;
	const loadName = name => new Promise(res => { const s = pool[rr++ % NW]; s.queue.push({ name, res }); pump(s); });
	// (lng0, lat0, range) 原点は range 刻み。tile obj | null（R01 は ALOS 無い海等で null）。
	return async function loadTile(lng0, lat0, range) {
		if (range === 1 && !existAlos(lng0, lat0)) return null;   // R01 は ALOS 未整備（海等）
		const name = encodeName(lng0, lat0, range);
		const cached = await cache(name); if (cached && !staleDSM(name, cached)) return cached;
		if (inflight.has(name)) return inflight.get(name);
		const p = loadName(name).then(t => { inflight.delete(name); return t; });
		inflight.set(name, p); return p;
	};
}

export async function createGetHeight(opts = {}) {
	const dire = `GIS/alt`;
	// createTileLoader と同じ縮退（IDB無し環境で標高取得ごと死なない）
	const cache = await Cache(dire).catch(() => null);
	const indexName = "index_alos";
	const index = (cache ? await Promise.resolve(cache(indexName)).catch(() => null) : null) || (await index_alos());
	if (cache) Promise.resolve(cache(indexName, index)).catch(() => {});
	const exist = (lng,lat) => index[encodeName(lng, lat)];
	let isLoading = null;
	const level1 = opts.level1||7, level2 = opts.level2||12;
	const {max, min, floor} = Math;
	let cname = null, current = null;
	const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
	worker.onerror = e => console.error("Worker Exception:", e);
////---------------------------------------------------------------------------------------
	return (lng, lat, zoom = Infinity) => {
		const n = (zoom < level1)? 0: (zoom < level2)? 1: 2;
		lng += lng < -180? 360: lng > 180? -360: 0;
		lat = max(min(lat, 89.999),-89.999);
		return [hgt90, hgt10, hgt01][n](lng,lat);
	};
////---------------------------------------------------------------------------------------
	async function load(lng, lat, range) {
		const name = encodeName(lng, lat, range);
		if (cname == name) return current;
		const obj = await cache(name); if (obj && !staleDSM(name, obj)) return obj;
		if (isLoading) return null;
		return new Promise(res=>{
			isLoading = performance.now();
			opts.onstart && opts.onstart(name);
			worker.postMessage({ name, apiUrl: opts.apiUrl });
			worker.onmessage = async e => { const obj = e.data;
				if (obj) {
					obj && await cache(name, obj);
					obj && console.log(`[altpbf]  📥 ${name} (${obj.width} x ${obj.height}) ${(performance.now() - isLoading).toFixed(2) } msec`);
					cname = name; current = obj;
				}
				opts.onend && opts.onend(name);
				isLoading = null;
				res(obj);
			};
			worker.onerror = e => {
				opts.onend && opts.onend(name);
				isLoading = null;
				res(null);
			}
		});
	}
	function calcHeight(x,y,v) { if (!v || !v.data) return 0;
		const a = v.data, w = v.width, h = v.height;
		const H = (x,y)=> a[(h - (y||1)) * w + ((x==w)?w-1:x)];
		const avg = (v1, v2, f) => v1 + (v2 - v1) * f;
		const [X,Y] = [x*w,y*h], [x0,y0] = [X|0,Y|0], [x1,y1] = [x0+1,y0+1];
		const [v00,v01,v10,v11] = [H(x0,y0),H(x0,y1),H(x1,y0),H(x1,y1)];
		return avg(avg(v00,v10,X-x0), avg(v01,v11,X-x0),Y-y0);
	}
	async function hgt90(lng,lat)  { const range = 90;
		const lng0 = floor(lng/range)*range, lat0 = floor(lat/range)*range;
		const v = await load(lng0, lat0, range);
		return calcHeight((lng-lng0)/range, (lat-lat0)/range, v);
	}
	async function hgt10(lng,lat)  { const range = 10;
		const lng0 = floor(lng/range)*range, lat0 = floor(lat/range)*range;
		const v = await load(lng0, lat0, range);
		return calcHeight((lng-lng0)/range, (lat-lat0)/range, v)||hgt90(lng,lat);
	}
	async function hgt01(lng,lat)  { const range = 1;
		const lng0 = floor(lng), lat0 = floor(lat); if (!exist(lng,lat)) return hgt10(lng,lat);
		const v = await load(lng0, lat0, range);
		return calcHeight((lng-lng0), (lat-lat0), v)||hgt10(lng,lat);
	}
};
