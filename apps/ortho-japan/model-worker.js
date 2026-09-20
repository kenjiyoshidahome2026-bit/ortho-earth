// glTF/GLB 直読みの worker（gadgets/model.js の相方・2026-09-20）。ArrayBuffer を受け、plateaudecode の decodeModel
// （loaders.gl の遅延チャンク＋PLATEAU と同じ後段）で建物メッシュにして返す＝main は解析で塞がない。
// PLATEAU の worker/デコーダプールとは独立＝建物 3D が停止（opts.plateau=false）でも模型は立つ。
// 返すのはマテリアルごとのバッチ列（uv・頂点色・テクスチャ画像つき）＝ImageBitmap も transfer で渡す（コピーしない）。
import { decodeModel, setDecodeEnv } from "./plateaudecode.js";

self.onmessage = async e => {
	const { id, ab, at, heading, scale, baseUri, ell, textures } = e.data;
	try {
		setDecodeEnv({ ell: !!ell });   // 楕円体表示（?ell=1）は後段（finishMesh の RTE）が見る＝app と揃える
		const r = await decodeModel(ab, { at, heading, scale, baseUri, textures: textures !== false });
		if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
		const tr = new Set();
		for (const b of r.batches) { for (const k of ["pos", "nrm", "idx", "uv", "col"]) if (b.mesh[k]?.buffer) tr.add(b.mesh[k].buffer); if (b.tex?.bitmap) tr.add(b.tex.bitmap); if (b.tex?.rgba) tr.add(b.tex.rgba.buffer); }
		self.postMessage({ id, batches: r.batches, stats: r.stats }, [...tr]);
	} catch (err) { self.postMessage({ id, error: err?.message || String(err) }); }
};
