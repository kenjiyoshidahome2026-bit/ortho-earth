// MVT（Mapbox Vector Tile）デコード。@mapbox/vector-tile + pbf を用いる。
// 返り値は source-layer 名 → { extent, features:[{type, props, geom}] }。
// geom は loadGeometry() のまま（タイルローカル座標 {x,y} のリング/ライン配列）。
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

const GEOM_TYPE = { 1: "Point", 2: "LineString", 3: "Polygon" };

// style が実際に参照する source-layer 集合（fill/line/symbol の source-layer ∪ 建物の BldA）。
// これ以外の層（等高線 Cntr・未使用注記など optimal_bvmap は層が多い）は decode 時に loadGeometry を
// 丸ごと省ける＝デコードCPUの節約。build/labels/buildings はこの集合の層しか触らない＝出力は不変。
export function neededSourceLayers(style) {
	const set = new Set(["BldA"]);   // buildings.js は layers.BldA を直接参照
	for (const L of style.layers) {
		if ((L.type === "fill" || L.type === "line" || L.type === "symbol") && L["source-layer"]) set.add(L["source-layer"]);
	}
	return set;
}

// need（Set）を渡すと未参照層をスキップ。未指定なら従来どおり全層デコード（後方互換）。
export function decodeMVT(buf, need) {
	const vt = new VectorTile(new Pbf(buf));
	const out = {};
	for (const name of Object.keys(vt.layers)) {
		if (need && !need.has(name)) continue;   // style 非参照の層は features 展開(loadGeometry)ごと省略
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

export async function fetchMVT(url, signal, need) {
	const r = await fetch(url, { signal });
	// 404/204＝「そこにタイルが無い」という正当なデータ（optimal_bvmap は日本域のみ＝広域ビューでは
	// 国外・外洋のタイルが常に404）。エラーでなく空タイルとして ready 扱い＝リトライも失敗計上もしない。
	if (r.status === 404 || r.status === 204) return {};
	if (!r.ok) throw new Error(`MVT HTTP ${r.status} ${url}`);
	return decodeMVT(new Uint8Array(await r.arrayBuffer()), need);
}
