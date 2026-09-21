// glTF/GLB 直読みの worker（gadgets/model.js の相方・2026-09-20）。ArrayBuffer を受け、meshdecode の decodeModel
// （loaders.gl の遅延チャンク＋PLATEAU と同じ後段）で建物メッシュにして返す＝main は解析で塞がない。
// PLATEAU の worker/デコーダプールとは独立＝建物 3D が停止（opts.mesh=false）でも模型は立つ。
// 返すのはマテリアルごとのバッチ列（uv・頂点色・テクスチャ画像つき）＝ImageBitmap も transfer で渡す（コピーしない）。
// kind:"extrude"＝任意ポリゴンの押し出し（extrude.js・2026-09-21）。返す形は模型と同じ（バッチ 1 本・テクスチャ無し）。
import { decodeModel, setDecodeEnv } from "./meshdecode.js";
import { extrudeMesh } from "./extrude.js";

const transferOf = batches => {
	const tr = new Set();
	for (const b of batches) { for (const k of ["pos", "nrm", "idx", "uv", "col"]) if (b.mesh[k]?.buffer) tr.add(b.mesh[k].buffer); if (b.tex?.bitmap) tr.add(b.tex.bitmap); if (b.tex?.rgba) tr.add(b.tex.rgba.buffer); }
	return [...tr];
};

self.onmessage = async e => {
	const { id, kind, ab, at, heading, scale, baseUri, ell, textures, ground, mask, polys } = e.data;
	try {
		setDecodeEnv({ ell: !!ell });   // 楕円体表示（?ell=1）は後段（finishMesh の RTE）が見る＝app と揃える
		if (kind === "extrude") {
			const r = extrudeMesh(polys, { mask: mask !== false, refine: e.data.refine ?? 1500 });   // refine＝屋根の細分の刻み(m)（沿わせる=1500・平面=20000）
			if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
			const batches = [{ mesh: r.mesh, tex: null, alphaMode: "OPAQUE", alphaCutoff: 0.5 }];
			self.postMessage({ id, batches, mask: r.mask, stats: r.stats }, transferOf(batches));
			return;
		}
		const r = await decodeModel(ab, { at, heading, scale, baseUri, textures: textures !== false, ground, mask });
		if (!r) { self.postMessage({ id, error: "no-triangles" }); return; }
		self.postMessage({ id, batches: r.batches, mask: r.mask, stats: r.stats }, transferOf(r.batches));
	} catch (err) { self.postMessage({ id, error: err?.message || String(err) }); }
};
