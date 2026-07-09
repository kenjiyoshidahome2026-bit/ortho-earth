// MVT（Mapbox Vector Tile）デコード。@mapbox/vector-tile + pbf を用いる。
// 返り値は source-layer 名 → { extent, features:[{type, props, geom}] }。
// geom は loadGeometry() のまま（タイルローカル座標 {x,y} のリング/ライン配列）。
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const GEOM_TYPE = { 1: "Point", 2: "LineString", 3: "Polygon" };

export function decodeMVT(buf) {
	const vt = new VectorTile(new Pbf(buf));
	const out = {};
	for (const name of Object.keys(vt.layers)) {
		const layer = vt.layers[name];
		const features = [];
		for (let i = 0; i < layer.length; i++) {
			const f = layer.feature(i);
			features.push({ type: GEOM_TYPE[f.type], props: f.properties, geom: f.loadGeometry(), id: f.id });
		}
		out[name] = { extent: layer.extent, features };
	}
	return out;
}

export async function fetchMVT(url, signal) {
	const r = await fetch(url, { signal });
	// 404/204＝「そこにタイルが無い」という正当なデータ（optimal_bvmap は日本域のみ＝広域ビューでは
	// 国外・外洋のタイルが常に404）。エラーでなく空タイルとして ready 扱い＝リトライも失敗計上もしない。
	if (r.status === 404 || r.status === 204) return {};
	if (!r.ok) throw new Error(`MVT HTTP ${r.status} ${url}`);
	return decodeMVT(new Uint8Array(await r.arrayBuffer()));
}
