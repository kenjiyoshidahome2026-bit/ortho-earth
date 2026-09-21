import { spawnWorker } from "./workerFactory.js";
import { builtinWorker } from "./builtinWorkers.js";
import { index_alos, encodeName, decodeName, inBbox, setApiUrl } from "./altpbf.js";
import { Cache } from "native-bucket";

// 焼き直し前の古い表層(DSM)キャッシュを失効させる判定。**どの域のどの段を裸地(DTM)へ焼き直したかは
// 呼び出し側の申告（opts.dtm）**＝このパッケージは地域を知らない（2026-09-17 に日本の bbox を撤去）。
//   dtm = { bbox:[西,南,東,北], range, brand } ／ 未申告(null)＝失効させない＝素の全球データのまま。
// 判定は「brand 銘のあるタイルだけ信用」の向き：source フィールド導入前に焼かれた旧タイルは
// source=undefined＝旧判定（"ALOS"で始まる時だけ失効）をすり抜けて DSM が永久に生き残っていた
//（東新橋の屋上斜面＝PLATEAU 接地リフトが旧 DSM を食った実測。札幌は初取得が bucket 側で無症状）。
export const staleDSM = (name, obj, dtm) => {
	if (!obj || !dtm) return false;
	if (String(obj.source || "").startsWith(dtm.brand)) return false;   // 焼き直し済み＝信用
	const [lng, lat, range] = decodeName(name);
	if (range !== dtm.range || !inBbox(dtm.bbox, lng, lat)) return false;
	// noBake（bucket未収録の印）は申告域の「外」概念だが、域内の収録外の土地（韓国・台湾等）にも付く。
	// 域内では noBake を信用しない＝毎セッション bucket を確認（load_gepco の decode 事故で日本セルに
	// noBake が毒入りした実害の自己修復。本当に未収録の外国陸地は再取得のコスト＝レアケースとして許容）。
	return true;   // brand 銘なし（旧 DSM 明記・無記名・noBake とも）＝失効 → bucket を再確認
};

// AW3D30 一覧（index_alos）の取得＝JAXA が落ちていても標高系を止めない。IDB 命中はそれを使い、取れなければ空の一覧で続行
//（日本域は bucket の DEM10B、海外は R90/R10 のまま・R01 だけ一覧到着まで無し）し、裏で指数バックオフ再取得＝届いたら差し替え。
// IDB には成功した一覧だけ保存。旧＝一覧の 503 が createTileLoader/createGetHeight ごと reject＝terrain は 8 回再試行の末に打ち切り、
// profile 等は未捕捉例外＝JAXA 停止中（2026-09-16 実測 503）は日本の山まで平らになっていた。
async function loadAlosIndex(cache, onUpdate) {
	const cached = cache ? await Promise.resolve(cache("index_alos")).catch(() => null) : null;
	if (cached) return cached;
	const fetchAndStore = async () => { const idx = await index_alos(); if (cache) Promise.resolve(cache("index_alos", idx)).catch(() => {}); return idx; };
	try { return await fetchAndStore(); }
	catch (e) {
		console.warn(`[altpbf] AW3D30 index unavailable (${e?.message ?? e}) = continuing without index, refetching in background`);
		let wait = 30000, tries = 0;
		const again = () => setTimeout(async () => {
			try { onUpdate(await fetchAndStore()); }
			catch { if (++tries < 8) { wait = Math.min(wait * 2, 600000); again(); } }
		}, wait);
		again();
		return {};
	}
}

// ラスタタイルを返すローダー（点サンプラでなく生タイル）。ortho-japan の GPU アトラス用。
// R90/R10=bucket・R01=JAXA（ALOS）を worker で読み、IDB キャッシュ。R01 は ALOS 未整備域では null。
export async function createTileLoader(opts = {}) {
	const dtm = opts.dtm || null;   // 地域の申告（jp/dtm.js 等）。未指定＝失効判定なし
	if (opts.apiUrl) setApiUrl(opts.apiUrl);   // メイン側の bucket/JAXA fetch（index_alos 等）に必要
	// IDB 不可（プライベートブラウズ/破損）は「キャッシュ無しで続行」へ縮退＝標高システムを一発死させない
	//（旧・素の await は reject が createTileLoader ごと落とし、山が永久に平らになる＝iPhone私的モード実症状）。
	// worker 側（altpbf.js load）は元から getCache().catch(()=>null) で同じ縮退＝これで経路が揃う。
	const cache = await Cache("GIS/alt").catch(e => { console.warn("[tileLoader] IDB disabled (continuing without cache)", e?.message ?? e); return null; });
	let index = await loadAlosIndex(cache, i => { index = i; });
	const existAlos = (lng, lat) => index[encodeName(lng, lat)];
	// worker プール：1本直列だと初訪問時に視野分のセル（R10で最大64枚）が1枚ずつ順番待ちになり
	// 地形の立ち上がりが数倍遅い。各workerは従来通り1件ずつ直列（応答FIFO＝取りこぼさない）で、
	// プール間はラウンドロビン＝並列。IDBキャッシュ後は経路無関係に即答。
	const NW = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));   // 低コア端末(タブレット)ではプールを絞る＝worker乱立でメインが飢えない
	// 入れ子 worker が無い環境への退避（2026-09-21）：このローダは ortho-japan では render worker の中で動く＝worker から
	// worker を立てる。入れ子 worker を持たない実行環境（Claude デスクトップの内蔵ブラウザ＝Electron・iOS Safari 15.5 未満 等）
	// では 1 本も立たず、毎回 opaque な error を吐いて地形が出なかった。worker.js の中身は load(name) 一発＝同じ load を
	// この場で呼べば結果は同じ。最初の 1 本がメッセージを返す前に落ちたら（＝環境として立たない）その場実行へ切り替える。
	// 一度でも動いた worker の後の死は従来どおり「作り直し」（実環境の一過性の死と区別する）。
	let inline = typeof Worker === "undefined";   // worker 内に Worker コンストラクタが無い環境（古い Safari）
	let everOk = false;                            // どれかの worker が一度でも返事をした
	const inlineLoad = async name => {
		try { const { load } = await import("./altpbf.js"); return await load(name); } catch { return null; }   // worker.js と同じ＝失敗は null
	};
	const goInline = why => {
		if (inline) return;
		inline = true;
		console.info(`[tileLoader] workers unavailable in this context (${why}) -> decoding in-thread`);
		for (const s of pool) { try { s.w?.terminate(); } catch { /* 立っていない */ } s.w = null; }
		for (const s of pool) s.abort?.();   // 止めた worker に預けていた要求＝その場実行でやり直す（terminate は error を出さない）
	};
	const mkWorker = () => {
		if (inline) return null;
		let w;
		try { w = spawnWorker("altpbf:height", () => builtinWorker("altpbf:height")); if (!w) throw new Error("no worker"); }
		catch (e) { goInline(String(e?.message || e)); return null; }
		// 起動の失敗は要求より先に起きる（要求ごとの error 受け口が間に合わない＝45 秒のタイムアウト待ちになる）＝ここで即座に退避へ
		w.onerror = e => {
			if (!everOk) return goInline("nested worker failed to start");
			console.error("[tileLoader] worker error:", e.message || "(opaque)", "@", e.filename || "?", "L" + (e.lineno ?? "?"), e.error || "");
		};
		return w;
	};
	const pool = Array.from({ length: NW }, () => ({ w: null, queue: [], busy: false }));
	for (const s of pool) s.w = mkWorker();
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
		const settle = obj => { if (obj && cache) cache(name, obj); s.busy = false; res(obj); pump(s); };
		if (inline || !s.w) { inlineLoad(name).then(settle); return; }
		const w = s.w;
		let done = false, tm = 0;
		const detach = () => { clearTimeout(tm); w.removeEventListener("message", onmsg); w.removeEventListener("error", onerr); if (s.abort === onerr) s.abort = null; };
		const onmsg = e => { if (done) return; done = true; everOk = true; detach(); settle(e.data); };
		const onerr = () => {
			if (done) return; done = true; detach();
			if (!everOk) { goInline("nested worker failed to start"); inlineLoad(name).then(settle); return; }   // 環境として立たない＝この要求からその場実行
			// worker死＝作り直し（次の要求は新workerで正常化）。この要求は null＝欠けは次の窓替えで再挑戦
			console.warn("[tileLoader] worker unresponsive -> recreating:", name);
			try { w.terminate(); } catch { /* 既に死んでいる */ }
			s.w = mkWorker();
			s.busy = false; res(null); pump(s);
		};
		tm = setTimeout(onerr, REQ_TIMEOUT);
		s.abort = onerr;   // goInline がこのレーンの預け物を回収する口
		w.addEventListener("message", onmsg);
		w.addEventListener("error", onerr);
		w.postMessage({ name, apiUrl: opts.apiUrl });
	}
	let rr = 0;
	const loadName = name => {   // 同名の並行要求は 1 本に併合（loadTile / byName 共通）
		if (inflight.has(name)) return inflight.get(name);
		const p = new Promise(res => { const s = pool[rr++ % NW]; s.queue.push({ name, res }); pump(s); }).then(t => { inflight.delete(name); return t; });
		inflight.set(name, p); return p;
	};
	// (lng0, lat0, range) 原点は range 刻み。tile obj | null（R01 は ALOS 無い海等で null）。
	const loadTile = async (lng0, lat0, range) => {
		if (range === 1 && !existAlos(lng0, lat0)) return null;   // R01 は ALOS 未整備（海等）
		const name = encodeName(lng0, lat0, range);
		// 形の検札（2026-08-04夜）：同じIDBキーに worker側=圧縮Blob（load_gepco）と外側=デコード済みobj（下のonmsg）の
		// 二者が非awaitで書く＝別コネクションでコミット順不定＝Blobが最後に勝ったセルが生まれ得る。それを素通しすると
		// downsampleFlipped が blob.data=undefined を踏み描画ループごと毎フレーム例外（Mac実機実測・マシン/セル依存の地雷）。
		// data/width を持つ「デコード済みタイル」だけ信用＝Blob なら worker 経路へ（worker はキャッシュBlobをデコードして返す＝自己修復）。
		const cached = cache ? await cache(name) : null; if (cached && cached.data && cached.width && !staleDSM(name, cached, dtm)) return cached;
		return loadName(name);
	};
	// 名前直指定（WORLD_ATLAS 等＝段の規約外のオブジェクト）：同じ worker プール・IDB・inflight 併合。失効判定（staleDSM）は掛けない。
	loadTile.byName = async name => {
		const cached = cache ? await cache(name) : null; if (cached && cached.data && cached.width) return cached;
		return loadName(name);
	};
	return loadTile;
}

export async function createGetHeight(opts = {}) {
	const dire = `GIS/alt`;
	const dtm = opts.dtm || null;   // 地域の申告（createTileLoader と同じ物を渡すこと）
	// createTileLoader と同じ縮退（IDB無し環境で標高取得ごと死なない）
	const cache = await Cache(dire).catch(() => null);
	let index = await loadAlosIndex(cache, i => { index = i; });
	const exist = (lng,lat) => index[encodeName(lng, lat)];
	let isLoading = null;
	let inflight = null;   // 進行中の読込（wait 呼びが順番待ちに使う）＝return より前に宣言（load は hoist されるが let は TDZ）
	const level1 = opts.level1||7, level2 = opts.level2||12;
	const {max, min, floor} = Math;
	let cname = null, current = null;
	const worker = spawnWorker("altpbf:height", () => builtinWorker("altpbf:height"));
	worker.onerror = e => console.error("Worker Exception:", e);
////---------------------------------------------------------------------------------------
	// o.wait=true＝他のタイル読込中でも（描画側の「到着まで 0」縮退でなく）順番を待って値を返す＝公開 API map.getHeight 用（2026-09-10）
	return (lng, lat, zoom = Infinity, o = {}) => {
		const n = (zoom < level1)? 0: (zoom < level2)? 1: 2;
		lng += lng < -180? 360: lng > 180? -360: 0;
		lat = max(min(lat, 89.999),-89.999);
		return [hgt90, hgt10, hgt01][n](lng,lat, !!o.wait);
	};
////---------------------------------------------------------------------------------------
	async function load(lng, lat, range, wait = false) {
		const name = encodeName(lng, lat, range);
		if (cname == name) return current;
		const obj = await cache(name); if (obj && obj.data && obj.width && !staleDSM(name, obj, dtm)) return obj;   // 形の検札＝Blob混入（loadTile側と同じ地雷）は worker 経路へ
		if (isLoading) return wait && inflight ? inflight.then(() => load(lng, lat, range, wait)) : null;   // 描画側＝落とす（到着まで0）／wait＝待って再試行
		return inflight = new Promise(res=>{
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
	async function hgt90(lng,lat,wait)  { const range = 90;
		const lng0 = floor(lng/range)*range, lat0 = floor(lat/range)*range;
		const v = await load(lng0, lat0, range, wait);
		return calcHeight((lng-lng0)/range, (lat-lat0)/range, v);
	}
	async function hgt10(lng,lat,wait)  { const range = 10;
		const lng0 = floor(lng/range)*range, lat0 = floor(lat/range)*range;
		const v = await load(lng0, lat0, range, wait);
		return calcHeight((lng-lng0)/range, (lat-lat0)/range, v)||hgt90(lng,lat,wait);
	}
	async function hgt01(lng,lat,wait)  { const range = 1;
		const lng0 = floor(lng), lat0 = floor(lat); if (!exist(lng,lat)) return hgt10(lng,lat,wait);
		const v = await load(lng0, lat0, range, wait);
		return calcHeight((lng-lng0), (lat-lat0), v)||hgt10(lng,lat,wait);
	}
};
