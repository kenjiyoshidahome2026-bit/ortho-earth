// scene worker：タイルの geometry(ops/buildings) を保持し、merge 要求で結合してメインへ返す。
// メインは geometry を一切保持せず、結合済みバッファを GL に上げるだけ。
import { mergeTiles } from "ortho-japan";

const geom = new Map();   // key → { ops, buildings }
const CAP = 512;
const geomOf = k => geom.get(k) || null;

self.onmessage = (e) => {
	const m = e.data;
	if (m.type === "tile") {
		geom.set(m.key, { ops: m.ops, buildings: m.buildings });
		if (geom.size > CAP) { const it = geom.keys().next(); if (!it.done) geom.delete(it.value); }   // 古い順に退避
		return;
	}
	if (m.type === "evict") { for (const k of m.keys) geom.delete(k); return; }
	if (m.type === "merge") {
		// LRU touch：この merge で使うタイルを最近使用へ移す（古い順退避で現用タイルの geometry が消えるのを防ぐ）
		for (const o of m.order) { const g = geom.get(o.key); if (g) { geom.delete(o.key); geom.set(o.key, g); } }
		const scene = mergeTiles(m.order, geomOf, { origin: m.origin, hidden: m.hidden ? new Set(m.hidden) : null });
		self.postMessage({ type: "scene", id: m.id, slot: m.slot, scene }, collectSceneBuffers(scene));
	}
};

function collectSceneBuffers(scene) {
	const bufs = [];
	for (const L of scene.layers) {
		if (L.kind === "fill") bufs.push(L.pos.buffer, L.col.buffer);
		else bufs.push(L.P1.buffer, L.P2.buffer, L.col.buffer, L.half.buffer);
	}
	if (scene.buildings) bufs.push(scene.buildings.pos.buffer, scene.buildings.shade.buffer, scene.buildings.anchor.buffer);
	return bufs;
}
