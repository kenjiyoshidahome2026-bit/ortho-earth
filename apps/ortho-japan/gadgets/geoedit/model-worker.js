// トポロジ構築/再抽出の Worker：100万頂点級で main を止めないための出島。GeoJSON FC を経由しない
// （8/20「根性で全部」＝GeoJSON追放）。スナップ基底（Mortonソート）もここで焼いて転送＝main コストゼロ。
//   mode "pbf"   : { buffer, maxVerts? }＝geopbfバイト列（取込/復元）。同期パースし1フィーチャずつ extractor へ。
//                  maxVerts＝頂点数の門：超えたら抽出を中断し { large:true, buffer } を返す（buffer は transfer で返却＝
//                  呼び手が大規模モードへ回す）。デコードはどのみち全件走る＝数える費用はゼロ・超過時点で打ち切り
//   mode "retopo": { payload }＝topoToTransfer(model,{snap:false}) の送り便。縫合→再抽出→eids 並行配列を返す
//   mode "fc"    : { fc }＝GeoJSON FC（後方互換＝小規模・試験・loadFC API）
// 返り便は常に topoToTransfer 形（snap基底込み）＋ retopo は eids。
import { GeoPBF } from "geopbf/pbf-base";
import { buildTopology, createExtractor } from "geopbf/edit/topo-extract";
import { topoToTransfer, topoFromTransfer, stitchGeometry } from "geopbf/edit/model";

const countVerts = g => {   // GeoJSON 幾何の座標数（環の閉点込み）
	if (!g) return 0;
	const c = g.coordinates;
	switch (g.type) {
		case "Point": return 1;
		case "MultiPoint": case "LineString": return c.length;
		case "MultiLineString": case "Polygon": { let n = 0; for (const r of c) n += r.length; return n; }
		case "MultiPolygon": { let n = 0; for (const p of c) for (const r of p) n += r.length; return n; }
		case "GeometryCollection": { let n = 0; for (const x of g.geometries || []) n += countVerts(x); return n; }
	}
	return 0;
};

self.onmessage = async e => {
	const { id, mode, fc, buffer, payload, gridExp, maxVerts } = e.data;
	try {
		let topo, eids = null;
		if (mode === "pbf") {
			const pbf = await new GeoPBF({}).set(buffer);
			const ex = createExtractor(gridExp);
			const n = pbf.fmap?.length ?? 0;
			let verts = 0;
			for (let i = 0; i < n; i++) {
				let g = null, p = {};
				try { g = pbf.getGeometry(i); p = pbf.getProperties(i) ?? {}; } catch { /* 壊れfeature＝skip（extractorがwarning化） */ }
				if (maxVerts > 0 && (verts += countVerts(g)) > maxVerts) {   // 頂点数の門＝ここで打ち切り（Map網を組まない）
					self.postMessage({ id, ok: true, payload: { large: true, verts, buffer } }, [buffer]);
					return;
				}
				ex.add(g, p);
			}
			topo = ex.finish();
		} else if (mode === "retopo") {
			const src = topoFromTransfer(payload);
			const ex = createExtractor(gridExp);
			eids = [...src.feats.keys()].sort((a, b) => a - b);
			for (const eid of eids) {
				const f = src.feats.get(eid);
				ex.add(stitchGeometry(src.arcs, f), f.properties);
			}
			topo = ex.finish();
		} else {
			topo = buildTopology(fc, gridExp);
		}
		const { payload: out, transfer } = topoToTransfer(topo);
		if (eids) out.eids = eids;
		self.postMessage({ id, ok: true, payload: out }, transfer);
	} catch (err) {
		self.postMessage({ id, ok: false, error: String(err?.stack || err) });
	}
};
