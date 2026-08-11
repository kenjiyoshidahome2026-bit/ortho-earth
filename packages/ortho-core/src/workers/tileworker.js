// タイル worker：fetch→decode→tessellation（earcut/capsule/建物）を worker 内で実行し、
// 結果の typed array を transfer でメインへ返す。メインは GL アップロード＋カメラだけになる。
// abort: 高速パンで視野から外れたタイルは fetch ごと中断（帯域とデコードCPUを空ける）。
// index.js（全部入り）でなく実装ファイル直参照：index は pipeline（worker生成）を含むため、
// worker から index を引くと vite が「循環worker」と誤認してビルドが落ちる
import { fetchMVT, neededSourceLayers } from "../decode.js";
import { buildTileDrawList, buildEmptySeaOps } from "../build.js";
import { buildLabels } from "../labels.js";
import { buildBuildings } from "../buildings.js";
import { tileBounds, tileOutsideCoverage } from "../tile.js";
import { setEllipsoid } from "../camera.js";

let style = null, need = null, coverage = null;   // need＝styleが参照する source-layer 集合（未参照層は decode 省略）。coverage＝配信圏 bbox
const aborts = new Map();   // id → AbortController（in-flight のみ保持）

self.onmessage = async (e) => {
	const m = e.data;
	if (m.type === "init") { style = m.style; need = neededSourceLayers(style); coverage = m.coverage || null; setEllipsoid(!!m.ell); return; }   // ell＝buildings の世界単位（m→単位）を a 基準へ
	if (m.type === "setStyle") { style = m.style; need = neededSourceLayers(style); return; }   // 配色テーマ生き替え＝色を焼き直す新style。以降のビルドは新styleで（coverage は据置）
	if (m.type === "abort") { const a = aborts.get(m.id); if (a) a.abort(); return; }
	const { id, url, z, x, y } = m;
	const ac = new AbortController();
	aborts.set(id, ac);
	try {
		// 配信圏外（日本域外の外洋・国外）は fetch を省いて空タイル扱い＝提供側の 404 への無駄打ちを断つ。
		// 描画は 404 と同一（fetchMVT が 404 で返すのと同じ {__empty:true}）＝下の buildEmptySeaOps が全面水域を敷く。
		const layers = tileOutsideCoverage(x, y, z, coverage) ? { __empty: true } : await fetchMVT(url, ac.signal, need);
		const [w, , , n] = tileBounds(x, y, z);
		const origin = [w, n];
		const dl = buildTileDrawList({ layers, z, x, y }, style, origin);
		// 図郭外（404/図郭縁の WA スライバ）＝標高ゲート付き全面水域を敷く（詳細は buildEmptySeaOps。style.emptySea 未設定なら不発）
		const seaOps = buildEmptySeaOps(layers, { z, x, y }, style, origin); if (seaOps) dl.ops.unshift(...seaOps);
		const { labels } = buildLabels({ layers, z, x, y }, style);
		const buildings = buildBuildings({ layers, z, x, y }, origin);
		const bufs = collectBuffers(dl, buildings);
		let bytes = 0; for (const b of bufs) bytes += b.byteLength;   // scene worker が保持する geometry の実バイト＝main のメモリ予算/退避の基準
		self.postMessage({ id, ok: true, origin, dl, labels, buildings, z, bytes }, bufs);
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
		if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer, op.idx.buffer);
		else bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer);
	}
	if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
	return bufs;
}
