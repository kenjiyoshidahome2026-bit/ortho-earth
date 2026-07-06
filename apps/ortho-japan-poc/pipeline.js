// データパイプライン境界：tile worker プール（fetch→decode→tessellation）＋ scene worker（geometry 保持＋merge）。
// main は geometry を一切持たず、結合済みバッファを GL に上げるだけ。重い処理も geometry も worker の向こう側。
// 入口＝renderer(setScene) / style / tileUrl / requestDraw。出口＝tiles(LOD管理) と requestMerge。
import { createTileManager } from "ortho-japan";

export function createPipeline({ renderer, style, tileUrl, requestDraw }) {
	// scene worker：タイル geometry を保持し結合(merge)も担う。
	const sceneWorker = new Worker(new URL("./sceneworker.js", import.meta.url), { type: "module" });
	const latestMerge = { base: 0, main: 0 };
	let mergeId = 0;
	sceneWorker.onmessage = e => {
		if (e.data.type !== "scene" || e.data.id !== latestMerge[e.data.slot]) return;   // 古い merge 結果は捨てる
		renderer.set("scene", e.data.scene, e.data.slot);
		requestDraw();
	};
	function requestMerge(slot, order, origin, hidden) {
		const id = ++mergeId; latestMerge[slot] = id;
		sceneWorker.postMessage({ type: "merge", id, slot, order: order.map(o => ({ key: o.key, origin: o.origin, z: o.z })), origin, hidden: hidden && hidden.size ? [...hidden] : null });
	}
	function collectTileBuffers(dl, buildings) {
		const bufs = [];
		for (const op of dl.ops) { if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer); else bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer); }
		if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
		return bufs;
	}

	// タイル worker プール：geometry は scene worker へ転送し、main にはメタ＋ラベルだけ返す。
	const NW = Math.min(4, (navigator.hardwareConcurrency || 4) - 1) || 2;
	const tileWorkers = [], pending = new Map();
	let wIdx = 0, reqId = 0;
	for (let i = 0; i < NW; i++) {
		const w = new Worker(new URL("./tileworker.js", import.meta.url), { type: "module" });
		w.onmessage = e => {
			const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
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
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject, key }));
	}

	const tiles = createTileManager({ style, tileUrl, onChange: requestDraw, buildTile: workerBuildTile });
	return { tiles, requestMerge };
}
