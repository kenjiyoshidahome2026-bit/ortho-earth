// データパイプライン境界：tile worker プール（fetch→decode→tessellation）＋ scene worker（geometry 保持＋merge）。
// main は geometry を一切持たず、結合済みバッファを GL に上げるだけ。重い処理も geometry も worker の向こう側。
// 入口＝style / tileUrl / requestDraw / scenePort(render worker直結)。出口＝tiles(LOD管理) と requestMerge。
// geometry は main を通らず scene worker → render worker へ直行（main は geometry を知らない）。
import { createTileManager } from "ortho-japan";

export function createPipeline({ style, tileUrl, requestDraw, scenePort }) {
	// scene worker：タイル geometry を保持し結合(merge)も担う。結合結果は main を経由せず
	// render worker へ直結ポートで送る（下の connect）＝main は geometry を一切知らない。
	const sceneWorker = new Worker(new URL("./sceneworker.js", import.meta.url), { type: "module" });
	sceneWorker.postMessage({ type: "connect", port: scenePort }, [scenePort]);   // scene→render 直結
	function requestMerge(slot, order, origin, hidden) {
		// 要求だけ main が出す（何を結合するか）。結果は render worker へ直行（merge同期＝要求順＝最後が最新）。
		sceneWorker.postMessage({ type: "merge", slot, order: order.map(o => ({ key: o.key, origin: o.origin, z: o.z })), origin, hidden: hidden && hidden.size ? [...hidden] : null });
	}
	function collectTileBuffers(dl, buildings) {
		const bufs = [];
		for (const op of dl.ops) { if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer); else bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer); }
		if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
		return bufs;
	}

	// タイル worker プール：geometry は scene worker へ転送し、main にはメタ＋ラベルだけ返す。
	const NW = Math.min(4, (navigator.hardwareConcurrency || 4) - 1) || 2;
	const tileWorkers = [], pending = new Map(), keyToId = new Map();
	let wIdx = 0, reqId = 0;
	for (let i = 0; i < NW; i++) {
		const w = new Worker(new URL("./tileworker.js", import.meta.url), { type: "module" });
		w.onmessage = e => {
			const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
			if (keyToId.get(p.key) === e.data.id) keyToId.delete(p.key);
			if (!e.data.ok) { p.reject(new Error(e.data.error)); return; }
			sceneWorker.postMessage({ type: "tile", key: p.key, ops: e.data.dl.ops, buildings: e.data.buildings }, collectTileBuffers(e.data.dl, e.data.buildings));
			p.resolve({ origin: e.data.origin, labels: e.data.labels, z: e.data.z });   // メタ＋ラベルのみ
		};
		w.postMessage({ type: "init", style });
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

	const tiles = createTileManager({ style, tileUrl, onChange: requestDraw, buildTile: workerBuildTile });
	return { tiles, requestMerge };
}
