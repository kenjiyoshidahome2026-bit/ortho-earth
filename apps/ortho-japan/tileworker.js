// タイル worker：fetch→decode→tessellation（earcut/capsule/建物）を worker 内で実行し、
// 結果の typed array を transfer でメインへ返す。メインは GL アップロード＋カメラだけになる。
// abort: 高速パンで視野から外れたタイルは fetch ごと中断（帯域とデコードCPUを空ける）。
import { fetchMVT, buildTileDrawList, buildLabels, buildBuildings, tileBounds } from "ortho-japan";

let style = null;
const aborts = new Map();   // id → AbortController（in-flight のみ保持）

self.onmessage = async (e) => {
	const m = e.data;
	if (m.type === "init") { style = m.style; return; }
	if (m.type === "abort") { const a = aborts.get(m.id); if (a) a.abort(); return; }
	const { id, url, z, x, y } = m;
	const ac = new AbortController();
	aborts.set(id, ac);
	try {
		const layers = await fetchMVT(url, ac.signal);
		const [w, , , n] = tileBounds(x, y, z);
		const origin = [w, n];
		const dl = buildTileDrawList({ layers, z, x, y }, style, origin);
		const { labels } = buildLabels({ layers, z, x, y }, style);
		const buildings = buildBuildings({ layers, z, x, y }, origin);
		self.postMessage({ id, ok: true, origin, dl, labels, buildings, z }, collectBuffers(dl, buildings));
	} catch (err) {
		self.postMessage({ id, ok: false, error: String(err && err.message || err) });
	} finally {
		aborts.delete(id);
	}
};

// transfer 対象の ArrayBuffer を集める（境界跨ぎのコピーを避ける）。
function collectBuffers(dl, buildings) {
	const bufs = [];
	for (const op of dl.ops) {
		if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer);
		else bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer);
	}
	if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
	return bufs;
}
