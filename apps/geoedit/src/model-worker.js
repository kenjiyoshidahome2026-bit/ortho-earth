// トポロジ構築/再抽出の Worker：100万頂点級で main を止めないための出島。
// 入力＝{id, fc, gridExp}（fc は構築時そのまま／再抽出時は __eid 入り）、出力＝topoToTransfer の payload。
// eid の付け替え（adoptRebuilt）は main 側＝ここは純粋に buildTopology を回すだけ。
import { buildTopology } from "./topo-extract.js";
import { topoToTransfer } from "./model.js";

self.onmessage = e => {
	const { id, fc, gridExp } = e.data;
	try {
		const topo = buildTopology(fc, gridExp);
		const { payload, transfer } = topoToTransfer(topo);
		self.postMessage({ id, ok: true, payload }, transfer);
	} catch (err) {
		self.postMessage({ id, ok: false, error: String(err?.stack || err) });
	}
};
