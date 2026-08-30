// データパイプライン境界：tile worker プール（fetch→decode→tessellation）＋ scene worker（geometry 保持＋merge）。
// main は geometry を一切持たず、結合済みバッファを GL に上げるだけ。重い処理も geometry も worker の向こう側。
// 入口＝style / tileUrl / requestDraw / scenePort(render worker直結)。出口＝tiles(LOD管理) と requestMerge。
// geometry は main を通らず scene worker → render worker へ直行（main は geometry を知らない）。
import { createTileManager } from "./tilemanager.js";

export function createPipeline({ style, tileUrl, requestDraw, scenePort, onMerged, onTile, lodFloor, memBudgetMB, coverage, ell, minZ }) {
	// scene worker：タイル geometry を保持し結合(merge)も担う。結合結果は main を経由せず
	// render worker へ直結ポートで送る（下の connect）＝main は geometry を一切知らない。
	const sceneWorker = new Worker(new URL("./workers/sceneworker.js", import.meta.url), { type: "module" });
	sceneWorker.postMessage({ type: "connect", port: scenePort }, [scenePort]);   // scene→render 直結
	// iOS WebKit の轍（2026-08-02）：WebGPU を作った worker はページからの受信が全チャネル死ぬ。
	// 生きている「page→scene worker→（scenePort）→render worker」で制御メッセージを中継する口。
	const relayCtl = (msg, transfer) => sceneWorker.postMessage({ type: "relayCtl", msg }, transfer || []);
	// ack：merge 成功時に sig が返る＝main はこれを見て readySig を確定（投げっぱなし＋楽観確定だと
	// 一度の失敗が「静止中は永遠に欠けたタイル」になる）。失敗時は ack が来ない→main がタイムアウト再要求。
	sceneWorker.onmessage = e => {
		if (e.data.type === "relayCtlN") { globalThis.__relayCtlN = e.data.n; return; }   // iOS診断：hop1受信数
		if (e.data.type === "merged" && onMerged) onMerged(e.data.slot, e.data.sig);
	};
	function requestMerge(slot, order, origin, hidden, sig) {
		// 要求だけ main が出す（何を結合するか）。結果は render worker へ直行（merge同期＝要求順＝最後が最新）。
		sceneWorker.postMessage({ type: "merge", slot, sig, order: order.map(o => ({ key: o.key, origin: o.origin, z: o.z })), origin, hidden: hidden && hidden.size ? [...hidden] : null });
	}
	requestMerge.debugFail = () => sceneWorker.postMessage({ type: "debugFailNext" });   // テスト用：次の merge を故意に失敗させる
	requestMerge.stats = () => sceneWorker.postMessage({ type: "stats" });   // 観測用：GPU常駐プールの占有を scene worker が console に出す
	function collectTileBuffers(dl, buildings) {
		const bufs = [];
		for (const op of dl.ops) { if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer, op.idx.buffer); else bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer); }
		if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
		return bufs;
	}

	// タイル worker プール：geometry は scene worker へ転送し、main にはメタ＋ラベルだけ返す。
	const NW = Math.min(4, (navigator.hardwareConcurrency || 4) - 1) || 2;
	const tileWorkers = [], pending = new Map(), keyToId = new Map();
	let wIdx = 0, reqId = 0;
	for (let i = 0; i < NW; i++) {
		const w = new Worker(new URL("./workers/tileworker.js", import.meta.url), { type: "module" });
		w.onmessage = e => {
			const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
			if (keyToId.get(p.key) === e.data.id) keyToId.delete(p.key);
			// 成否を外へ通知（abort=視野外中断は失敗に数えない）＝main が「通信断トースト」の判断材料にする
			if (onTile && (e.data.ok || !/abort/i.test(String(e.data.error)))) onTile(!!e.data.ok);
			if (!e.data.ok) { p.reject(new Error(e.data.error)); return; }
			sceneWorker.postMessage({ type: "tile", key: p.key, ops: e.data.dl.ops, buildings: e.data.buildings }, collectTileBuffers(e.data.dl, e.data.buildings));
			p.resolve({ origin: e.data.origin, labels: e.data.labels, z: e.data.z, bytes: e.data.bytes });   // メタ＋ラベル＋geometry実バイト（退避予算用）
		};
		w.postMessage({ type: "init", style, coverage, ell });   // coverage＝配信圏 bbox（圏外タイルは worker が fetch せず空タイル扱い）。ell＝楕円体ノブ（buildings の世界単位）
		tileWorkers.push(w);
	}
	function workerBuildTile(t) {
		const id = ++reqId, key = `${t.z}/${t.x}/${t.y}`, w = tileWorkers[wIdx = (wIdx + 1) % NW];
		w.postMessage({ id, url: tileUrl(t.z, t.x, t.y), z: t.z, x: t.x, y: t.y });
		keyToId.set(key, id);
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject, key, w }));
	}
	// 視野から外れた in-flight タイルの中断（tilemanager が update 毎に呼ぶ）。
	// main側の pending を即 "aborted" で解決＝呼び出し元(ensure)がエントリを消して再訪時に再取得可能にする。
	// worker へも abort を送り fetch を実キャンセル（帯域とデコードCPUを空ける）。
	workerBuildTile.abort = key => {
		const id = keyToId.get(key); if (id == null) return;
		keyToId.delete(key);
		const p = pending.get(id); if (!p) return;
		pending.delete(id);
		p.w.postMessage({ type: "abort", id });
		p.reject(new Error("aborted"));
	};

	// onEvict：main のタイルキャッシュから消えたら scene worker の geometry も同時に消す＝両者は常に鏡。
	// scene worker 側に独自の上限退避を持たせない（mainがreadyのタイルを勝手に捨てると merge で黙って穴になる）。
	const tiles = createTileManager({
		style, tileUrl, onChange: requestDraw, buildTile: workerBuildTile, lodFloor, memBudgetMB, coverage, minZ,
		onEvict: keys => sceneWorker.postMessage({ type: "evict", keys }),
	});
	// 配色テーマの生き替え（reload無し restyle）：tile worker 群へ新styleを配り、既存タイルを全て捨てる。
	// 色は dl.ops に焼き込まれるため、次の update() 群で可視タイルが新styleで再ビルドされる（生バイトは
	// fetchMVT のIDB/HTTP温間キャッシュ命中で速い）。scene worker の geom/GPU常駐は tiles.reset の onEvict で
	// 同時解放＝ピーク約1倍（次テーマの先組みはしない＝GPUメモリ2倍を避ける）。
	function setStyle(newStyle) {
		for (const w of tileWorkers) w.postMessage({ type: "setStyle", style: newStyle });
		tiles.reset();
	}
	// 後片付け：worker を全て terminate（SPA等で地図を剥がす時＝アプリ側 map.destroy() から）。
	// in-flight の pending は reject＝呼び出し元の await を宙吊りにしない。
	function destroy() {
		for (const p of pending.values()) p.reject(new Error("destroyed"));
		pending.clear(); keyToId.clear();
		sceneWorker.terminate();
		tileWorkers.forEach(w => w.terminate());
	}
	return { relayCtl,
 tiles, requestMerge, setStyle, destroy };
}
